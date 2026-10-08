import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {goalSchema,sessionSchema} from '@herbie/contracts';
import {Store} from '../src/store.js';
import {PgAuthStore,migrateAuth} from '../src/auth-store.js';
import {createAuth} from '../src/auth.js';
import {createDemoAdapters} from '../src/demo.js';
import {createApiServer} from '../src/http.js';

test('execution-disabled HTTP blocks creation and resume before authorization while reads and stop controls remain usable',async t=>{
  const database=process.env.HERBIE_TEST_DATABASE_URL;
  if(!database)return t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL integration');
  const schema=`execution_disabled_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:database});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
  const store=new Store(pool);await store.migrate();await migrateAuth(pool);
  const origin='http://localhost:8787';
  const auth=createAuth({mode:'demo',publicUrl:origin,credentialKey:Buffer.alloc(32,7).toString('base64')},new PgAuthStore(pool));
  const demo=createDemoAdapters();
  let authorizationCalls=0;
  const adapters={...demo,authorize:async(userId:string,repository:string)=>{
    authorizationCalls++;return demo.authorize(userId,repository);
  }};
  const server=createApiServer({store,auth,adapters,publicUrl:origin,executionEnabled:false,verifyWebhook:(_body,signature)=>signature==='local-fixture'});
  t.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');
  const base=`http://127.0.0.1:${address.port}`;
  const login=await fetch(`${base}/api/demo/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'});
  assert.equal(login.status,200);const session=sessionSchema.parse(await login.json());
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  const headers={cookie,origin,'content-type':'application/json','idempotency-key':randomUUID()};
  const input={repository:'demo/example',prompt:'Do not execute this goal',testCommand:['node','--test'],maxAttempts:1};
  for(let request=0;request<2;request++){
    const response=await fetch(`${base}/api/goals`,{method:'POST',headers,body:JSON.stringify(input)});
    assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{error:'Live execution is disabled by the operator'});
  }
  assert.equal(authorizationCalls,0);
  assert.deepEqual(await (await fetch(`${base}/api/goals`,{headers:{cookie}})).json(),[]);
  assert.equal(await store.claim('disabled-http-test',30_000,'demo'),null);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(),{mode:'demo',executionEnabled:false});
  assert.equal((await fetch(`${base}/api/session`,{headers:{cookie}})).status,200);
  assert.equal((await fetch(`${base}/api/repositories`,{headers:{cookie}})).status,200);

  // Existing work can still be observed and stopped while execution is disabled.
  const {goal}=await store.createGoal(session.user.id,input,'demo',randomUUID());
  const control=(action:string)=>fetch(`${base}/api/goals/${goal.id}/${action}`,{method:'POST',headers});
  const pause=await control('pause');assert.equal(pause.status,200);
  assert.equal(goalSchema.parse(await pause.json()).state,'paused');
  for(let request=0;request<2;request++){
    const resume=await control('resume');assert.equal(resume.status,503);
    assert.deepEqual(await resume.json(),{error:'Live execution is disabled by the operator'});
  }
  assert.equal(authorizationCalls,0);
  assert.equal(await store.claim('disabled-http-test',30_000,'demo'),null);
  const status=await fetch(`${base}/api/goals/${goal.id}`,{headers:{cookie}});
  assert.equal(goalSchema.parse(await status.json()).state,'paused');
  assert.equal((await fetch(`${base}/api/goals/${goal.id}/events`,{headers:{cookie}})).status,200);
  const cancel=await control('cancel');assert.equal(cancel.status,200);
  assert.equal(goalSchema.parse(await cancel.json()).state,'cancelled');
  const webhook=await fetch(`${base}/api/webhooks/github`,{method:'POST',headers:{'x-hub-signature-256':'local-fixture','x-github-event':'ping'},body:'{}'});
  assert.equal(webhook.status,200);assert.deepEqual(await webhook.json(),{ok:true});
});
