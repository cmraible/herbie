import {generateKeyPairSync} from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readConfig} from '../src/config.js';

const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
const live = {
  HERBIE_MODE:'live',HERBIE_ALLOWED_GITHUB_USER_ID:'7',HERBIE_HOST:'0.0.0.0',HERBIE_PUBLIC_URL:'https://herbie.example',
  DATABASE_URL:'postgresql://fixture:fixture@database.example/postgres',HERBIE_CREDENTIAL_KEY:Buffer.alloc(32,1).toString('base64'),
  GITHUB_APP_ID:'fixture',GITHUB_CLIENT_ID:'fixture',GITHUB_CLIENT_SECRET:'fixture',
  GITHUB_PRIVATE_KEY:privateKey,GITHUB_WEBHOOK_SECRET:'fixture',
};

test('hosted live configuration accepts an injected private key and leaves execution disabled by default',async()=>{
  const config=await readConfig({...live,HERBIE_DEPLOYMENT_ID:'config-revision',HERBIE_IMAGE_REVISION:'image-revision'});
  assert.equal(config.executionEnabled,false);
  assert.equal(config.github?.privateKey,privateKey.trim());
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

test('reports multiple configuration problems without including their values',async()=>{
  await assert.rejects(readConfig({...live,HERBIE_PORT:'99999',HERBIE_CREDENTIAL_KEY:'secret-canary',DAYTONA_API_URL:'secret-canary'}),error=>{
    assert.ok(error instanceof Error);
    assert.match(error.message,/HERBIE_PORT/);assert.match(error.message,/HERBIE_CREDENTIAL_KEY/);assert.match(error.message,/DAYTONA_API_URL/);
    assert.doesNotMatch(error.message,/secret-canary/);return true;
  });
});

test('validates live execution credentials before creating a runtime',async()=>{
  await assert.rejects(readConfig({...live,HERBIE_EXECUTION_ENABLED:'true'}),error=>{
    assert.ok(error instanceof Error);assert.match(error.message,/DAYTONA_API_KEY/);assert.match(error.message,/HERBIE_DAYTONA_OPENAI_SECRET/);return true;
  });
  const config=await readConfig({...live,HERBIE_EXECUTION_ENABLED:'true',DAYTONA_API_KEY:'key',HERBIE_DAYTONA_OPENAI_SECRET:'secret'});
  assert.equal(config.daytona.apiKey,'key');
});

test('rejects invalid origins, database URLs, conflicting sources, and unreadable files',async()=>{
  for(const overrides of [
    {HERBIE_PUBLIC_URL:'ftp://herbie.example'}, {HERBIE_PUBLIC_URL:'https://herbie.example/path'},
    {DATABASE_URL:'https://example.com'}, {GITHUB_PRIVATE_KEY:'not-a-private-key'}, {HERBIE_DATABASE_CA:'ca',HERBIE_DATABASE_CA_FILE:'file'},
    {GITHUB_PRIVATE_KEY_FILE:'/missing/key.pem'}, {GITHUB_PRIVATE_KEY:undefined,GITHUB_PRIVATE_KEY_FILE:'/missing/key.pem'},
  ])await assert.rejects(readConfig({...live,...overrides}));
});

test('missing database configuration is rejected by the schema',async()=>{
  await assert.rejects(readConfig({}),/DATABASE_URL: Must be a PostgreSQL URL/);
});

test('OpenAI credentials are optional, validated, and only used in live mode',async()=>{
  assert.equal((await readConfig(live)).openaiApiKey,undefined);
  assert.equal((await readConfig({...live,OPENAI_API_KEY:'fixture-key'})).openaiApiKey,'fixture-key');
  assert.equal((await readConfig({DATABASE_URL:live.DATABASE_URL,OPENAI_API_KEY:'fixture-key'})).openaiApiKey,undefined);
  for(const value of ['', '   '])await assert.rejects(readConfig({...live,OPENAI_API_KEY:value}),/OPENAI_API_KEY/);
});
