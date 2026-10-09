import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,URL} from 'node:url';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import test from 'node:test';
import {prepareDeployment,waitForDeployment} from '../scripts/deployment.js';

const privateKey=generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
// These identifiers are synthetic fixtures, unrelated to any deployed account.
const context={HERBIE_DEPLOY_REPOSITORY:'example/herbie',GITHUB_REPOSITORY:'example/herbie',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_SHA:'1111111111111111111111111111111111111111',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',HERBIE_DEPLOY_ENABLED:'true',
  CLOUDFLARE_ACCOUNT_ID:'00000000000000000000000000000000',CLOUDFLARE_API_TOKEN:'test-only-token',
  HERBIE_PUBLIC_URL:'https://herbie-service.synthetic-fixture.workers.dev',HERBIE_SUPABASE_PROJECT_REF:'aaaaaaaaaaaaaaaaaaaa',
  HERBIE_SUPABASE_POOLER_HOST:'aws-0-test-region.pooler.supabase.com',
  HERBIE_DATABASE_URL:'postgresql://postgres.aaaaaaaaaaaaaaaaaaaa:test-only-password@aws-0-test-region.pooler.supabase.com:5432/postgres',
  HERBIE_CREDENTIAL_KEY:Buffer.alloc(32,42).toString('base64'),HERBIE_GITHUB_APP_ID:'12345',HERBIE_GITHUB_CLIENT_ID:'Iv1.example',
  HERBIE_GITHUB_CLIENT_SECRET:'test-only-client-secret',HERBIE_GITHUB_PRIVATE_KEY:privateKey,HERBIE_GITHUB_WEBHOOK_SECRET:'test-only-webhook-secret'};
const config={name:'herbie-service',main:'src/index.ts',
  vars:{HERBIE_PUBLIC_URL:'https://herbie.example.invalid',HERBIE_EXECUTION_ENABLED:'false'},
  assets:{directory:'../web/dist'},containers:[{image:'../../Dockerfile',image_build_context:'../..',instance_type:'basic',max_instances:1}]};

test('configuration failures report every missing or malformed field without echoing supplied values',()=>{
  assert.throws(()=>prepareDeployment({...context,CLOUDFLARE_API_TOKEN:'',HERBIE_GITHUB_CLIENT_SECRET:undefined,
    CLOUDFLARE_ACCOUNT_ID:'private-canary-account',HERBIE_DATABASE_URL:'private-canary-database',
    HERBIE_GITHUB_PRIVATE_KEY:'private-canary-key'},config,'/repo/packages/cloudflare'),error=>{
    assert.ok(error instanceof Error);
    for(const name of ['CLOUDFLARE_API_TOKEN','HERBIE_GITHUB_CLIENT_SECRET','CLOUDFLARE_ACCOUNT_ID','HERBIE_DATABASE_URL','HERBIE_GITHUB_PRIVATE_KEY']){
      assert.match(error.message,new RegExp(name));
    }
    assert.doesNotMatch(error.message,/private-canary|synthetic-fixture|test-only-password/);
    return true;
  });
});

test('deployment refuses PRs, forks, other branches and a disabled operator gate before producing secrets',()=>{
  for(const invalid of [{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_REPOSITORY:'fork/herbie'},{GITHUB_REF:'refs/heads/feature'},{HERBIE_DEPLOY_ENABLED:'false'}]){
    assert.throws(()=>prepareDeployment({...context,...invalid},config,'/repo/packages/cloudflare'),/Deployment is not authorized/);
  }
});

test('deployment requires private target inputs and refuses account data in the public template',()=>{
  for(const name of ['HERBIE_DEPLOY_REPOSITORY','CLOUDFLARE_ACCOUNT_ID','HERBIE_PUBLIC_URL','HERBIE_SUPABASE_PROJECT_REF','HERBIE_SUPABASE_POOLER_HOST']){
    assert.throws(()=>prepareDeployment({...context,[name]:undefined},config,'/repo/packages/cloudflare'));
  }
  assert.throws(()=>prepareDeployment(context,{...config,account_id:context.CLOUDFLARE_ACCOUNT_ID},'/repo/packages/cloudflare'));
  assert.throws(()=>prepareDeployment(context,{...config,vars:{...config.vars,HERBIE_PUBLIC_URL:context.HERBIE_PUBLIC_URL}},'/repo/packages/cloudflare'));
});

test('rollout verification rejects a new configuration on an old image and waits for both revisions',async t=>{
  let revision='expected',imageRevision='previous',requests=0,promoteImage=false;
  const server=createServer((_request,response)=>{
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({mode:'live',executionEnabled:false,deploymentId:revision,imageRevision}));
    requests++;
    if(promoteImage)imageRevision='expected';
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`;
  await assert.rejects(waitForDeployment(origin,'expected',{timeoutMs:100,intervalMs:5}),/requested revision/);
  imageRevision='expected';revision='previous';
  await assert.rejects(waitForDeployment(origin,'expected',{timeoutMs:100,intervalMs:5}),/requested revision/);
  revision='expected';imageRevision='previous';promoteImage=true;
  const beforeRollout=requests;
  await waitForDeployment(origin,'expected',{timeoutMs:5000,intervalMs:5});
  assert.ok(requests>=beforeRollout+2);
  await assert.rejects(waitForDeployment(origin,'never-deployed',{timeoutMs:100,intervalMs:5}),/requested revision/);
});

test('approved preparation bundles only runtime secrets and forces a unique disabled rollout',()=>{
  const prepared=prepareDeployment(context,config,'/repo/packages/cloudflare');
  const secrets:unknown=JSON.parse(prepared.secrets);
  assert.ok(secrets&&typeof secrets==='object'&&'HERBIE_RUNTIME_SECRETS' in secrets);
  assert.equal(typeof secrets.HERBIE_RUNTIME_SECRETS,'string');
  assert.ok(typeof secrets.HERBIE_RUNTIME_SECRETS==='string');
  const runtime:unknown=JSON.parse(secrets.HERBIE_RUNTIME_SECRETS);
  assert.deepEqual(runtime,{DATABASE_URL:context.HERBIE_DATABASE_URL,HERBIE_CREDENTIAL_KEY:context.HERBIE_CREDENTIAL_KEY,
    GITHUB_APP_ID:'12345',GITHUB_CLIENT_ID:'Iv1.example',GITHUB_CLIENT_SECRET:'test-only-client-secret',
    GITHUB_PRIVATE_KEY:privateKey,GITHUB_WEBHOOK_SECRET:'test-only-webhook-secret'});
  assert.equal(prepared.revision,`${context.GITHUB_SHA}-123-1`);
  assert.equal(prepared.config.account_id,context.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(prepared.config.vars.HERBIE_PUBLIC_URL,context.HERBIE_PUBLIC_URL);
  assert.equal(prepared.repositoryUrl,'https://github.com/example/herbie.git');
  assert.equal(prepared.origin,context.HERBIE_PUBLIC_URL);
  assert.equal(prepared.config.vars.HERBIE_EXECUTION_ENABLED,'false');
  assert.equal(prepared.config.vars.HERBIE_DEPLOYMENT_ID,prepared.revision);
  assert.equal(prepared.config.containers[0]?.image_vars.HERBIE_RUNTIME_REVISION,prepared.revision);
  assert.equal(prepared.config.containers[0]?.image,'/repo/Dockerfile');
  assert.ok(!JSON.stringify(prepared.config).includes('test-only-password'));
});

test('deployment rejects incomplete secrets, another account or project, and unsafe rollout settings without revealing values',()=>{
  for(const change of [{HERBIE_GITHUB_PRIVATE_KEY:'secret-canary-invalid-pem'},{HERBIE_CREDENTIAL_KEY:'secret-canary-invalid-key'},
    {HERBIE_DATABASE_URL:'postgresql://other:secret-canary@other.example:5432/db'},{CLOUDFLARE_API_TOKEN:''},
    {CLOUDFLARE_ACCOUNT_ID:'another-account'},{HERBIE_DEPLOY_REPOSITORY:'another/repository'},
    {HERBIE_SUPABASE_PROJECT_REF:'bbbbbbbbbbbbbbbbbbbb'},{HERBIE_SUPABASE_POOLER_HOST:'aws-1-test-region.pooler.supabase.com'},
    {HERBIE_PUBLIC_URL:'https://wrong-worker.synthetic-fixture.workers.dev'},{GITHUB_SHA:'stale-or-untrusted-value'}]){
    assert.throws(()=>prepareDeployment({...context,...change},config,'/repo/packages/cloudflare'),error=>{
      assert.ok(error instanceof Error);assert.doesNotMatch(error.message,/secret-canary/);return true;
    });
  }
  assert.throws(()=>prepareDeployment(context,{...config,vars:{...config.vars,HERBIE_EXECUTION_ENABLED:'true'}},'/repo/packages/cloudflare'));
  assert.throws(()=>prepareDeployment(context,{...config,containers:[{...config.containers[0],max_instances:2}]},'/repo/packages/cloudflare'));
});


test('native dependency-free preflight reports all missing credentials and fails without raw diagnostics',()=>{
  const environment:Record<string,string|undefined>={PATH:process.env.PATH};
  const result=spawnSync(process.execPath,['packages/cloudflare/scripts/preflight.ts'],{
    cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',env:environment});
  assert.equal(result.status,1);
  for(const name of Object.keys(context).filter(name=>!['GITHUB_REPOSITORY','GITHUB_REF','GITHUB_EVENT_NAME','HERBIE_DEPLOY_ENABLED'].includes(name))){
    assert.ok(result.stderr.includes(`${name}: required`),name);
  }
  assert.doesNotMatch(result.stderr,/Error:| at |HERBIE_DATABASE_CA/);
  assert.equal(result.stdout,'');
});

test('optional CA may be empty, but supplied malformed fields are collected with safe diagnostics',()=>{
  assert.doesNotThrow(()=>prepareDeployment({...context,HERBIE_DATABASE_CA:''},config,'/repo/packages/cloudflare'));
  const changes={HERBIE_DATABASE_CA:'canary-invalid-cert',HERBIE_GITHUB_APP_ID:'0',HERBIE_CREDENTIAL_KEY:'canary-bad-base64',
    HERBIE_GITHUB_CLIENT_ID:' canary-client',HERBIE_GITHUB_WEBHOOK_SECRET:'canary\nsecret',HERBIE_PUBLIC_URL:context.HERBIE_PUBLIC_URL+'/',
    HERBIE_SUPABASE_PROJECT_REF:'canary-project',HERBIE_SUPABASE_POOLER_HOST:'canary-host',GITHUB_SHA:'canary-sha'};
  assert.throws(()=>prepareDeployment({...context,...changes},config,'/repo/packages/cloudflare'),error=>{
    assert.ok(error instanceof Error);
    for(const name of Object.keys(changes))assert.ok(error.message.includes(name),name);
    assert.doesNotMatch(error.message,/canary|synthetic-fixture/);
    return true;
  });
});


test('native preflight accepts current main and rejects stale or failed lookups without leaking subprocess output',t=>{
  const directory=mkdtempSync(join(tmpdir(),'herbie-preflight-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  for(const [output,status,expected] of [[context.GITHUB_SHA,0,0],['stale-canary',0,1],['private-canary',1,1]] as const){
    writeFileSync(join(directory,'git'),`#!/bin/sh\nprintf '%s' '${output}'\nexit ${status}\n`,{mode:0o700});
    const result=spawnSync(process.execPath,['packages/cloudflare/scripts/preflight.ts'],{
      cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',env:{...context,PATH:directory}});
    assert.equal(result.status,expected);
    assert.doesNotMatch(result.stdout+result.stderr,/canary|test-only|synthetic-fixture/);
    if(expected===0)assert.match(result.stdout,/passed for current main/);
    else assert.match(result.stderr,/preflight refused/);
  }
});
