import assert from 'node:assert/strict';
import test from 'node:test';
import {containerEnvironment,executionEnabled,blocksExecution} from '../src/configuration.js';

const credentials={DATABASE_URL:'postgresql://fixture',HERBIE_CREDENTIAL_KEY:'fixture',GITHUB_APP_ID:'fixture',GITHUB_CLIENT_ID:'fixture',GITHUB_CLIENT_SECRET:'fixture',GITHUB_PRIVATE_KEY:'fixture',GITHUB_WEBHOOK_SECRET:'fixture'};
test('disabled deployment passes only allowlisted server configuration and needs no paid execution secrets',()=>{
  const environment=containerEnvironment(JSON.stringify(credentials),'https://herbie.example',false);
  assert.equal(environment.HERBIE_EXECUTION_ENABLED,'false');
  assert.equal(environment.HERBIE_MODE,'live');
  assert.equal(environment.HERBIE_HOST,'0.0.0.0');
  assert.equal(environment.DAYTONA_API_KEY,undefined);
  assert.throws(()=>containerEnvironment(JSON.stringify({...credentials,OPENAI_API_KEY:'unexpected'}),'https://herbie.example',false));
});

test('execution opt-in requires exact true and the execution credentials',()=>{
  assert.equal(executionEnabled('true'),true);
  for(const value of ['false','','yes','TRUE'])assert.equal(executionEnabled(value),false);
  assert.throws(()=>containerEnvironment(JSON.stringify(credentials),'https://herbie.example',true));
  assert.equal(containerEnvironment(JSON.stringify({...credentials,DAYTONA_API_KEY:'fixture',HERBIE_DAYTONA_OPENAI_SECRET:'fixture-name'}),'https://herbie.example',true).HERBIE_EXECUTION_ENABLED,'true');
});

test('edge gate blocks new goals and resume even while an old container has its previous environment',()=>{
  assert.equal(blocksExecution('POST','/api/goals',false),true);
  assert.equal(blocksExecution('POST','/api/goals/goal-id/resume',false),true);
  assert.equal(blocksExecution('POST','/api/goals/goal-id/cancel',false),false);
  assert.equal(blocksExecution('GET','/api/goals',false),false);
  assert.equal(blocksExecution('POST','/api/goals',true),false);
});
