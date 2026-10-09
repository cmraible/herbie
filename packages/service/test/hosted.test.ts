import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import {createClient} from '@herbie/contracts/client';
import {Store} from '../src/store.js';
import {createDemoAdapters} from '../src/demo.js';
import {createAuth} from '../src/auth.js';
import {PgAuthStore,migrateAuth} from '../src/auth-store.js';
import {startHostedService,type HostedRuntime} from '../src/hosted.js';

async function fixture(database:string){
  const schema=`hosted_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:database});
  await admin.query(`CREATE SCHEMA ${schema}`);
  async function runtime(executionEnabled:boolean):Promise<HostedRuntime>{
    const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
    const store=new Store(pool);await store.migrate();await migrateAuth(pool);
    const publicUrl='http://127.0.0.1:8787';
    const auth=createAuth({mode:'demo',publicUrl,credentialKey:Buffer.alloc(32,7).toString('base64')},new PgAuthStore(pool));
    return {config:{host:'127.0.0.1',port:0,publicUrl,executionEnabled},store,auth,adapters:createDemoAdapters(),github:undefined};
  }
  return {runtime,async close(){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}};
}
function clientFor(service:Awaited<ReturnType<typeof startHostedService>>,token?:string){
  const address=service.server.address();assert.ok(address&&typeof address==='object');
  return createClient({baseUrl:`http://127.0.0.1:${address.port}`,origin:'http://127.0.0.1:8787',token});
}

test('hosted API leaves queued work untouched when execution is disabled',async t=>{
  const database=process.env.HERBIE_TEST_DATABASE_URL;
  if(!database)return t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration');
  const app=await fixture(database);
  const runtime=await app.runtime(false);
  const {goal}=await runtime.store.createGoal('demo-user',{repository:'demo/example',prompt:'Queued for an operator to enable execution',testCommand:['node','--test'],maxAttempts:1},'demo',randomUUID());
  const service=await startHostedService(runtime);
  t.after(async()=>{await service.close();await app.close();});
  const token=(await clientFor(service).demoCliLogin()).token;
  const client=clientFor(service,token);
  assert.equal((await client.health()).mode,'demo');
  await delay(1100);
  assert.equal((await client.goal(goal.id)).state,'queued');
  await service.close();
  await service.close();
  await assert.rejects(client.health());
});

test('hosted shutdown stops HTTP first and lets the active bounded attempt persist before closing Postgres',async t=>{
  const database=process.env.HERBIE_TEST_DATABASE_URL;
  if(!database)return t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration');
  const app=await fixture(database);
  const runtime=await app.runtime(true);
  const started=Promise.withResolvers<void>();
  const release=Promise.withResolvers<void>();
  const demo=runtime.adapters;
  runtime.adapters={...demo,async attempt(execution,report){started.resolve();await release.promise;return demo.attempt(execution,report);}};
  const service=await startHostedService(runtime);
  t.after(async()=>{release.resolve();await service.close();await app.close();});
  const token=(await clientFor(service).demoCliLogin()).token;
  const client=clientFor(service,token);
  const goal=await client.start({repository:'demo/example',prompt:'Finish cleanup even when deployment stops',testCommand:['node','--test'],maxAttempts:1},randomUUID());
  await started.promise;
  let closed=false;
  const closing=service.close().then(()=>{closed=true;});
  await assert.rejects(client.health());
  await delay(25);assert.equal(closed,false);
  release.resolve();await closing;
  const restarted=await startHostedService(await app.runtime(false));
  try{
    const after=await clientFor(restarted,token).goal(goal.id);
    assert.equal(after.state,'awaiting_review');
    assert.equal(after.attemptCount,1);
    assert.ok(after.pullRequest);
  }finally{await restarted.close();}
});


test('hosted process sanitizes startup failure output before exiting',async()=>{
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/hosted.ts',import.meta.url))],{
    env:{...process.env,HERBIE_MODE:'demo',HERBIE_HOST:'127.0.0.1',HERBIE_PUBLIC_URL:'http://127.0.0.1:8787',DATABASE_URL:'postgres://secret-canary@:invalid'},
    stdio:['ignore','pipe','pipe'],
  });
  let stdout='';let stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',(chunk:string)=>{stdout+=chunk;});
  child.stderr.on('data',(chunk:string)=>{stderr+=chunk;});
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,1);
  assert.equal(stdout,'');
  assert.equal(stderr,'Herbie startup diagnostic: category=configuration.\nHerbie startup failed. Check configuration and database availability.\n');
});
