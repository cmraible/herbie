import assert from 'node:assert/strict';
import test from 'node:test';
import {authStartSchema,authPollSchema} from '@herbie/contracts';
import {startCliConsentFixture} from './fixtures/cli-consent.js';

test('CLI callback shows an explicit consent form without releasing a bearer and rejects foreign origins',async t=>{
  const database=process.env.HERBIE_TEST_DATABASE_URL;if(!database)return t.skip('Set HERBIE_TEST_DATABASE_URL for real PostgreSQL');
  const fixture=await startCliConsentFixture(database);t.after(()=>fixture.close());
  const started=await fetch(`${fixture.origin}/api/auth/start`,{method:'POST',headers:{origin:fixture.origin,'content-type':'application/json'},body:JSON.stringify({client:'cli'})});
  const flow=authStartSchema.parse(await started.json());assert.ok(flow.pollToken);
  const callbackUrl=new URL('/api/auth/callback',fixture.origin);callbackUrl.searchParams.set('code','fixture');callbackUrl.searchParams.set('state',new URL(flow.url).searchParams.get('state')??'');
  const callback=await fetch(callbackUrl,{redirect:'manual'});
  assert.equal(callback.status,303);
  assert.equal(callback.headers.get('location'),'/api/auth/cli');
  const approvalCookie=callback.headers.get('set-cookie')?.split(';')[0];assert.ok(approvalCookie);
  const confirmation=await fetch(`${fixture.origin}/api/auth/cli`,{headers:{cookie:approvalCookie}});
  const html=await confirmation.text();
  assert.match(html,/Approve a CLI sign-in/);assert.match(html,/alice/);assert.match(html,/name="userCode"/);assert.match(html,/Reject request/);
  assert.doesNotMatch(html,/login complete|ghu_local_fixture_only/);
  assert.deepEqual(authPollSchema.parse(await(await fetch(`${fixture.origin}/api/auth/poll?token=${flow.pollToken}`)).json()),{status:'pending'});
  const hostile=await fetch(`${fixture.origin}/api/auth/cli`,{method:'POST',headers:{origin:'https://attacker.example',authorization:'Bearer untrusted',cookie:approvalCookie,'content-type':'application/x-www-form-urlencoded'},body:'decision=approve&userCode=AAAA-BBBB'});
  assert.equal(hostile.status,403);
  const missingCsrf=await fetch(`${fixture.origin}/api/auth/cli`,{method:'POST',headers:{origin:fixture.origin,cookie:approvalCookie,'content-type':'application/x-www-form-urlencoded'},body:'decision=approve&userCode=AAAA-BBBB'});
  assert.equal(missingCsrf.status,400);
  const otherBrowser=await fetch(`${fixture.origin}/api/auth/cli`);assert.equal(otherBrowser.status,400);
});
