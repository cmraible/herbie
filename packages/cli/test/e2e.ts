import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {goalSchema,eventSchema,sessionSchema} from '@herbie/contracts';
import {z} from 'zod';

// Explicitly targets the running local deterministic service, never a live worker.
const run=promisify(execFile);
const baseUrl=process.env.HERBIE_E2E_URL??'http://127.0.0.1:8787';
const service=new URL(baseUrl);
if(!['127.0.0.1','localhost','[::1]'].includes(service.hostname))throw new Error('CLI E2E requires a loopback demo service');
const directory=await mkdtemp(join(tmpdir(),'herbie-cli-e2e-'));
const configPath=join(directory,'session.json');
const entry=fileURLToPath(new URL('../src/index.ts',import.meta.url));
const environment={...process.env,HERBIE_CONFIG:configPath};
async function cli(args:string[]):Promise<unknown>{
  const result=await run(process.execPath,['--import','tsx',entry,...args],{env:environment});
  return JSON.parse(result.stdout);
}

await test('real CLI processes share durable goals, preserve retry identity, and report stopped work',async()=>{
  try{
    const health:unknown=await(await fetch(`${baseUrl}/api/health`)).json();
    assert.equal(z.object({mode:z.literal('demo')}).parse(health).mode,'demo');
    assert.equal(sessionSchema.parse(await cli(['login','--demo','--url',baseUrl])).mode,'demo');
    assert.equal((await stat(configPath)).mode&0o777,0o600);
    const existing=z.array(goalSchema).parse(await cli(['status']));
    for(const goal of existing){if(!['completed','cancelled','failed'].includes(goal.state))await cli(['cancel',goal.id]);}
    const requestId=randomUUID();
    const args=['start','--repo','demo/example','--prompt','CLI process boundary smoke','--test','["npm","test"]','--request-id',requestId];
    const started=goalSchema.parse(await cli(args));
    const repeated=goalSchema.parse(await cli(args));
    assert.equal(started.id,repeated.id);
    const status=goalSchema.parse(await cli(['status',started.id]));
    assert.equal(status.repository,'demo/example');
    for(let count=0;count<50;count++){
      if(goalSchema.parse(await cli(['status',started.id])).state==='awaiting_review')break;
      await setTimeout(100);
    }
    assert.equal(goalSchema.parse(await cli(['status',started.id])).state,'awaiting_review');
    assert.equal(goalSchema.parse(await cli(['pause',started.id])).state,'paused');
    assert.ok(['queued','running','awaiting_review'].includes(goalSchema.parse(await cli(['resume',started.id])).state));
    const cancelled=goalSchema.parse(await cli(['cancel',started.id]));
    assert.ok(cancelled.state==='cancelled'||cancelled.stopRequested==='cancel');
    assert.equal(goalSchema.parse(await cli(['cancel',started.id])).state,'cancelled');
    const events=z.array(eventSchema).parse(await cli(['logs',started.id]));
    assert.ok(events.some(event=>event.type==='queued'));
    assert.ok(events.some(event=>event.type==='cancel'));
    const cursor=events[0]?.id;if(cursor===undefined)throw new Error('Expected goal events');
    const later=z.array(eventSchema).parse(await cli(['logs',started.id,'--after',String(cursor)]));
    assert.ok(later.every(event=>event.id>cursor));
    assert.deepEqual(await cli(['logout']),{ok:true});
    await assert.rejects(cli(['status']),/No valid session/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
