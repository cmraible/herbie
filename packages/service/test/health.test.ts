import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {Store} from '../src/store.js';
import {createAuth} from '../src/auth.js';
import {PgAuthStore} from '../src/auth-store.js';
import {createApiServer} from '../src/http.js';
import {createDemoAdapters} from '../src/demo.js';

test('readiness reports a database failure without exposing connection details',async t=>{
  const database=process.env.HERBIE_TEST_DATABASE_URL;if(!database)return t.skip('Set HERBIE_TEST_DATABASE_URL');
  const pool=new Pool({connectionString:database});
  const store=new Store(pool);
  let closed=false;t.after(async()=>{if(!closed)await store.close();});
  const auth=createAuth({mode:'demo',publicUrl:'http://127.0.0.1',credentialKey:Buffer.alloc(32,7).toString('base64')},new PgAuthStore(pool));
  const server=createApiServer({store,auth,adapters:createDemoAdapters(),publicUrl:'http://127.0.0.1',executionEnabled:false});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/api/health`;
  assert.equal((await fetch(url)).status,200);
  await store.close();closed=true;
  const unhealthy=await fetch(url);
  assert.equal(unhealthy.status,503);
  assert.deepEqual(await unhealthy.json(),{error:'Database unavailable'});
});
