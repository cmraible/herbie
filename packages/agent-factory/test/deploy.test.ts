import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Standalone Node Actions script has no runtime dependency on TypeScript.
import {preflight,resolveDatabase} from '../scripts/deploy.mjs';
test('deployment preflight rejects missing configuration and any execution enablement',()=>{
 assert.throws(()=>preflight({}),/Missing/);
 const env={CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'fake',BETTER_AUTH_SECRET:'x'.repeat(32),MAILGUN_API_KEY:'fake',MAILGUN_DOMAIN:'company.example',MAILGUN_REGION:'us',EMAIL_FROM:'login@company.example',ALLOWED_EMAIL_DOMAINS:'company.example'};
 assert.equal(preflight(env).account,env.CLOUDFLARE_ACCOUNT_ID);
 assert.throws(()=>preflight({...env,FACTORY_ENABLED:'true'}),/only supports/);
 assert.throws(()=>preflight({...env,GITHUB_APP_ID:'123'}),/together/);
});
test('deployment D1 provisioning reuses existing resources and creates only when missing',async()=>{
 let creates=0;const existing={name:'agent-factory',uuid:'db-id'};
 const api=async(_path:string,init?:{method:string})=>{if(init?.method==='POST'){creates++;return existing;}return creates?[existing]:[];};
 assert.equal(await resolveDatabase(api,'agent-factory'),'db-id');
 assert.equal(await resolveDatabase(api,'agent-factory'),'db-id');assert.equal(creates,1);
});
