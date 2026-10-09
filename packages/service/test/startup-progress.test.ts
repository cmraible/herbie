import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import pg from 'pg';
import {StartupProgress,safeStartupCauses} from '../src/startup-progress.js';
import {prepareDatabase} from '../src/database.js';
import {StartupConfigurationError} from '../src/startup-diagnostic.js';

test('real PostgreSQL handshake timeout is reported as a database connection failure despite code-less causes',async t=>{
  const sockets=new Set<import('node:net').Socket>();
  const server=createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const pool=new pg.Pool({host:'127.0.0.1',port:address.port,user:'synthetic',password:'private-canary',database:'synthetic',connectionTimeoutMillis:100});
  const lines:string[]=[];const startup=new StartupProgress(line=>lines.push(line),()=>assert.fail('unexpected timeout'));
  t.after(async()=>{startup.dispose();await pool.end();for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  startup.begin('database-connect');
  await assert.rejects(pool.connect(),error=>{startup.failure(error);return true;});
  assert.match(lines.at(-1)!,/phase=database-connect; elapsed-ms=\d+; phase-elapsed-ms=\d+;.*category=database-connection/);
  assert.doesNotMatch(lines.join('\n'),/private-canary|127\.0\.0\.1|synthetic/);
});

test('preserves allowlisted causes and rejects arbitrary codes/messages with bounded traversal',()=>{
  const error=new StartupConfigurationError(Object.assign(new Error('private-canary-host-password'),{code:'EACCES'}));
  assert.equal(safeStartupCauses(error),'none>EACCES');
  assert.equal(safeStartupCauses(Object.assign(new Error('private-canary'),{code:'private-canary'})),'other');
  const cycle=new Error('private-canary');cycle.cause=cycle;
  assert.equal(safeStartupCauses(cycle),'none>none>none>none');
});

test('schema protection failure retains its structured cause even if rollback fails',async()=>{
  const phases:string[]=[];const original=Object.assign(new Error('private-canary'),{code:'42501'});
  let released=false;
  const pool={connect:async()=>({query:async(sql:string)=>{
    if(sql==='BEGIN')return {rows:[]};
    if(sql==='ROLLBACK')throw new Error('private-canary-cleanup');
    throw original;
  },release(){released=true;}})} as unknown as pg.Pool;
  await assert.rejects(prepareDatabase(pool,'live',phase=>phases.push(phase)),error=>error===original);
  assert.deepEqual(phases,['schema-protection']);assert.ok(released);
});

test('startup watchdog exits a stuck process and names the pending phase without raw data',async()=>{
  const module=fileURLToPath(new URL('../src/startup-progress.ts',import.meta.url));
  const script=`import {StartupProgress} from ${JSON.stringify(module)};const p=new StartupProgress(line=>console.error(line),()=>process.exit(1),30);p.begin('application-migrations');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const result=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(result,1);assert.match(output,/startup timed out: phase=application-migrations;.*pending-phase=application-migrations/);
});
