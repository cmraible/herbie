import assert from 'node:assert/strict';
import test from 'node:test';
import {readConfig} from '../src/config.js';

const live = {
  HERBIE_MODE:'live',HERBIE_ALLOWED_GITHUB_USER_ID:'7',HERBIE_HOST:'0.0.0.0',HERBIE_PUBLIC_URL:'https://herbie.example',
  DATABASE_URL:'postgresql://fixture:fixture@database.example/postgres',HERBIE_CREDENTIAL_KEY:Buffer.alloc(32,1).toString('base64'),
  GITHUB_APP_ID:'fixture',GITHUB_CLIENT_ID:'fixture',GITHUB_CLIENT_SECRET:'fixture',
  GITHUB_PRIVATE_KEY:'fixture-pem-not-used',GITHUB_WEBHOOK_SECRET:'fixture',
};

test('hosted live configuration accepts an injected private key and leaves execution disabled by default',async()=>{
  const config=await readConfig({...live,HERBIE_DEPLOYMENT_ID:'config-revision',HERBIE_IMAGE_REVISION:'image-revision'});
  assert.equal(config.executionEnabled,false);
  assert.equal(config.github?.privateKey,'fixture-pem-not-used');
  assert.equal(config.host,'0.0.0.0');
  assert.equal(config.deploymentId,'config-revision');
  assert.equal(config.imageRevision,'image-revision');
});


test('live startup requires one canonical immutable owner ID; demo does not',async()=>{
  for(const id of [undefined,'','owner-login','0','01','7,8',' 7','7\n']){
    await assert.rejects(readConfig({...live,HERBIE_ALLOWED_GITHUB_USER_ID:id}));
  }
  assert.equal((await readConfig(live)).allowedGithubUserId,'7');
  assert.equal((await readConfig({HERBIE_MODE:'demo',DATABASE_URL:'postgresql://fixture:fixture@localhost/db'})).allowedGithubUserId,undefined);
});
