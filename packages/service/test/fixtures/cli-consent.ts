import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {Pool} from 'pg';
import {createGithub} from '../../src/github.js';
import {createAuth} from '../../src/auth.js';
import {migrateAuth,PgAuthStore} from '../../src/auth-store.js';
import {Store} from '../../src/store.js';
import {createDemoAdapters} from '../../src/demo.js';
import {createApiServer} from '../../src/http.js';

// OAuth exists only at this local HTTP fixture boundary. No real grants, App
// keys, or provider calls. The production runtime uses one consistent HTTPS origin.
export async function startCliConsentFixture(database:string){
  const schema=`cli_consent_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:database});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:database,options:`-c search_path=${schema}`});
  const store=new Store(pool);await store.migrate();await migrateAuth(pool);
  let application:Server|undefined;
  const server=createServer((request,response)=>{
    if(application)application.emit('request',request,response);
    else{response.writeHead(503);response.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Expected local HTTP address');
  const origin=`http://127.0.0.1:${address.port}`;
  const githubServer=createServer((request,response)=>{
    const url=new URL(request.url??'/','http://fixture.invalid');
    if(url.pathname==='/login/oauth/authorize'){
      response.writeHead(302,{location:`${origin}/api/auth/callback?code=local-fixture&state=${encodeURIComponent(url.searchParams.get('state')??'')}`});response.end();
    }else{
      response.setHeader('content-type','application/json');
      if(url.pathname==='/login/oauth/access_token')response.end(JSON.stringify({access_token:'ghu_local_fixture_only',expires_in:28800}));
      else if(url.pathname==='/user')response.end(JSON.stringify({id:7,login:'alice'}));
      else{response.writeHead(404);response.end('{}');}
    }
  });
  await new Promise<void>(resolve=>githubServer.listen(0,'127.0.0.1',resolve));
  const githubAddress=githubServer.address();if(!githubAddress||typeof githubAddress==='string')throw new Error('Expected local GitHub fixture address');
  const githubOrigin=`http://127.0.0.1:${githubAddress.port}`;
  const github=createGithub({appId:'fixture',clientId:'fixture',clientSecret:'fixture',privateKey:'never-used-by-OAuth-fixture',callbackUrl:'https://herbie.example/api/auth/callback',webhookSecret:'fixture'}, {api:githubOrigin,oauth:githubOrigin});
  const auth=createAuth({mode:'live',publicUrl:'https://herbie.example',credentialKey:Buffer.alloc(32,3).toString('base64')},new PgAuthStore(pool),github);
  application=createApiServer({store,auth,adapters:{...createDemoAdapters(),mode:'live'},publicUrl:origin});
  return {origin,async close(){
    await Promise.all([server,githubServer].map(active=>new Promise<void>((resolve,reject)=>active.close(error=>error?reject(error):resolve()))));
    await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  }};
}
