import assert from 'node:assert/strict';
import test from 'node:test';
import {readConfig} from '../src/config.js';

const live = {
  HERBIE_MODE:'live',HERBIE_HOST:'0.0.0.0',HERBIE_PUBLIC_URL:'https://herbie.example',
  DATABASE_URL:'postgresql://fixture:fixture@database.example/postgres',HERBIE_CREDENTIAL_KEY:Buffer.alloc(32,1).toString('base64'),
  GITHUB_APP_ID:'fixture',GITHUB_CLIENT_ID:'fixture',GITHUB_CLIENT_SECRET:'fixture',
  GITHUB_PRIVATE_KEY:'fixture-pem-not-used',GITHUB_WEBHOOK_SECRET:'fixture',
};

test('hosted live configuration accepts an injected private key and leaves execution disabled by default',async()=>{
  const config=await readConfig(live);
  assert.equal(config.executionEnabled,false);
  assert.equal(config.github?.privateKey,'fixture-pem-not-used');
  assert.equal(config.host,'0.0.0.0');
});
