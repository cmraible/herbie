import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {ApiError,createClient} from '../src/client.js';

async function withServer(handler:(request:IncomingMessage,response:ServerResponse)=>void,check:(client:ReturnType<typeof createClient>)=>Promise<void>){
  const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();if(!address||typeof address==='string')throw new Error('No TCP address');
  const baseUrl=`http://127.0.0.1:${address.port}`;
  try{await check(createClient({baseUrl,origin:baseUrl}));}finally{server.close();await once(server,'close');}
}

test('an invalid service response cannot masquerade as a valid session',async()=>{
  await withServer((_request,response)=>{response.end(JSON.stringify({user:{id:'u',login:'octocat'},mode:'pretend-live'}));},async client=>{
    await assert.rejects(client.session());
  });
});

test('HTTP failures preserve status and actionable service messages',async()=>{
  await withServer((_request,response)=>{response.writeHead(409,{'content-type':'application/json'});response.end(JSON.stringify({error:'One active goal per repository'}));},async client=>{
    await assert.rejects(client.goals(),error=>error instanceof ApiError&&error.status===409&&error.message==='One active goal per repository');
  });
});

test('a non-JSON service failure retains HTTP status without exposing its body',async()=>{
  await withServer((_request,response)=>{response.writeHead(502,{'content-type':'text/html'});response.end('<html>upstream private diagnostics</html>');},async client=>{
    await assert.rejects(client.goals(),error=>error instanceof ApiError&&error.status===502&&!error.message.includes('private diagnostics'));
  });
});
