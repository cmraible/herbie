import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import test from 'node:test';
import {configurationPage,serveConfigurationError} from '../src/configuration-page.js';
import {ConfigurationError} from '../src/config.js';

const error=new ConfigurationError([{variable:'DATABASE_URL',message:'Must be a PostgreSQL URL'}]);

test('development page escapes diagnostic text',()=>{
  const page=configurationPage([{variable:'<script>',message:'<img src=x onerror=alert(1)>'}]);
  assert.ok(page.includes('&lt;script&gt;'));assert.ok(!page.includes('<img'));assert.match(page,/restart the service/);
});

test('production never starts the diagnostic listener',async()=>{
  assert.equal(await serveConfigurationError(error,{NODE_ENV:'production'}),false);
});

for(const mode of ['development','production'])test(`${mode} entrypoint handles invalid configuration before connecting to the database`,async t=>{
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const address=socket.address();assert.ok(address&&typeof address==='object');
  await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const child=spawn(process.execPath,['--import','tsx',new URL('../src/index.ts',import.meta.url).pathname],{
    env:{PATH:process.env.PATH,NODE_ENV:mode,HERBIE_MODE:'demo',HERBIE_HOST:'127.0.0.1',HERBIE_PORT:String(address.port),DATABASE_URL:'secret-canary'},
    stdio:['ignore','pipe','pipe'],
  });
  const closed=once(child,'close');let output='';
  child.stderr.on('data',chunk=>{output+=chunk;});
  t.after(async()=>{if(child.exitCode===null)child.kill();await closed;});
  if(mode==='production'){
    const [code]=await closed;assert.equal(code,1);assert.doesNotMatch(output,/secret-canary/);return;
  }
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error(`No diagnostic listener: ${output}`)),10000);
    child.stderr.on('data',()=>{if(output.includes('Fix the environment')){clearTimeout(timeout);resolve();}});
  });
  const response=await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
  const page=await response.text();assert.match(page,/DATABASE_URL/);assert.match(page,/Invalid environment configuration/);assert.doesNotMatch(page,/secret-canary/);
});
