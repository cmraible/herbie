import assert from 'node:assert/strict';
import test from 'node:test';

const origin=process.env.HERBIE_EDGE_TEST_URL??'http://127.0.0.1:8790';
if(new URL(origin).hostname!=='127.0.0.1')throw new Error('Edge smoke must use a local Wrangler server');

test('local Worker serves the built React application without starting its unavailable backend',async()=>{
  const response=await fetch(origin);
  assert.equal(response.status,200);
  assert.match(await response.text(),/Herbie/);
});
test('local Worker denies new execution and resume while preserving a safe unavailable-backend response',async()=>{
  for(const path of ['/api/goals','/api/goals/00000000-0000-4000-8000-000000000001/resume']){
    const response=await fetch(`${origin}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{error:'Live execution is disabled by the operator'});
  }
  const health=await fetch(`${origin}/api/health`);
  assert.equal(health.status,503);
  assert.deepEqual(await health.json(),{error:'Herbie service is unavailable. Check operator configuration and supervisor logs.'});
});
test('disabled local scheduled handler completes without starting a container or requiring execution secrets',async()=>{
  const scheduled=await fetch(`${origin}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('* * * * *')}`);
  assert.equal(scheduled.status,200);
});

test('enabled local supervisor reports an unavailable container as a failed scheduled invocation',async t=>{
  const enabled=process.env.HERBIE_EDGE_ENABLED_TEST_URL;
  if(!enabled)return t.skip('Start a second local Worker with execution enabled and no credentials');
  if(new URL(enabled).hostname!=='127.0.0.1')throw new Error('Supervisor smoke must use a local Wrangler server');
  const scheduled=await fetch(`${enabled}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('* * * * *')}`);
  assert.equal(scheduled.status,500);
  assert.equal(await scheduled.text(),'exception');
});
