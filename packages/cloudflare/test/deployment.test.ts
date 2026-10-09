import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,URL} from 'node:url';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import test from 'node:test';
import {prepareDeployment,waitForDeployment} from '../scripts/deployment.js';
import {DeploymentCommandError,DiagnosticTail,diagnosticLimit,deploymentDiagnostic,readDiagnosticTail,runDeploymentCommand} from '../scripts/diagnostics.js';

const privateKey=generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
// These identifiers are synthetic fixtures, unrelated to any deployed account.
const context={HERBIE_ALLOWED_GITHUB_USER_ID:'7',HERBIE_DEPLOY_REPOSITORY:'example/herbie',GITHUB_REPOSITORY:'example/herbie',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',
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
  assert.deepEqual(runtime,{HERBIE_ALLOWED_GITHUB_USER_ID:'7',DATABASE_URL:context.HERBIE_DATABASE_URL,HERBIE_CREDENTIAL_KEY:context.HERBIE_CREDENTIAL_KEY,
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
  const changes={HERBIE_ALLOWED_GITHUB_USER_ID:'canary-owner',HERBIE_DATABASE_CA:'canary-invalid-cert',HERBIE_GITHUB_APP_ID:'0',HERBIE_CREDENTIAL_KEY:'canary-bad-base64',
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


test('manual mode validation rejects missing and malformed settings without echoing their values',()=>{
  for(const mode of [undefined,'','Automatic',' automatic','canary-invalid-mode','canary\n::error::injected']){
    const environment:Record<string,string|undefined>={HERBIE_DEPLOY_MODE:mode};
    const result=spawnSync('bash',['scripts/check-deploy-mode.sh'],{
      cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',env:environment});
    assert.equal(result.status,1);
    assert.match(result.stderr,/::error::HERBIE_DEPLOY_MODE is missing or invalid/);
    assert.doesNotMatch(result.stdout+result.stderr,/canary|injected/);
  }
});

test('explicitly disabled manual mode succeeds with a clear no-deployment notice and no secrets',()=>{
  const result=spawnSync('bash',['scripts/check-deploy-mode.sh'],{
    cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',env:{HERBIE_DEPLOY_MODE:'disabled'}});
  assert.equal(result.status,0);
  assert.match(result.stdout,/::notice::.*explicitly disabled.*deployment will be skipped/);
  assert.equal(result.stderr,'');
});

test('manual and automatic modes allow a manual run to continue to its remaining gates',()=>{
  for(const mode of ['manual','automatic']){
    const result=spawnSync('bash',['scripts/check-deploy-mode.sh'],{
      cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',env:{HERBIE_DEPLOY_MODE:mode}});
    assert.equal(result.status,0);
    assert.match(result.stdout,/preflight and full Verify are still required/);
    assert.equal(result.stderr,'');
  }
});

test('diagnostic tails retain at most 64 KiB across large chunks and split markers',()=>{
  const tail=new DiagnosticTail();
  tail.append(Buffer.from('discard-canary'.repeat(diagnosticLimit)));
  assert.equal(tail.byteLength,65536);
  tail.append(Buffer.alloc(diagnosticLimit,120));
  tail.append(Buffer.from('Uploaded private-canary\nLogin failed with co'));
  tail.append(Buffer.from('de: 1\n-----BEGIN PRIVATE KEY-----\nprivate-canary-body\n-----END PRIVATE KEY-----'));
  assert.equal(tail.byteLength,65536);
  assert.ok(!tail.text().includes('discard-canary'));
  assert.equal(deploymentDiagnostic([tail.text()],1,null),
    'Deployment diagnostic: stage=container-registry-login; category=registry-login; exit=1; signal=none; codes=none.');
});

test('unknown diagnostic content never reaches public output, even with injected annotations or nonallowlisted codes',()=>{
  const text='secret-canary\n::error::https://private-canary.invalid/path\n'+
    '-----BEGIN PRIVATE KEY-----\nprivate-canary-body\n-----END PRIVATE KEY-----\n'+
    '{"account":"private-canary-account","project":"private-canary-project"} [code: 1234567890]';
  assert.equal(deploymentDiagnostic([text],987654321,'private-canary-signal'),
    'Deployment diagnostic: stage=unknown; category=unclassified; exit=unknown; signal=other; codes=none.');
});

test('recognized API diagnostics report only fixed labels and exact allowlisted code tokens',()=>{
  const text='Uploaded private-canary\n\u001b[31m[ERROR] A request to the Cloudflare API (https://private-canary.invalid) failed.\u001b[0m\n'+
    'private-canary-token [code: 10000] [code: 10021] [code: 100146] [code: 100000] [code: 987654321]';
  assert.equal(deploymentDiagnostic([text],7,null),
    'Deployment diagnostic: stage=worker-upload-complete; category=cloudflare-api; exit=7; signal=none; codes=10000,10021,100146.');
});

test('private log reads use a bounded tail and tolerate missing logs without echoing paths',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'herbie-diagnostic-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'private-canary.log');
  writeFileSync(path,'discard-canary\n'+'x'.repeat(2*diagnosticLimit)+'\nError creating application: private-canary');
  const text=await readDiagnosticTail(path);
  assert.equal(Buffer.byteLength(text),65536);
  assert.ok(!text.includes('discard-canary'));
  assert.equal(deploymentDiagnostic([text],1,null),
    'Deployment diagnostic: stage=container-application-create; category=application-create; exit=1; signal=none; codes=none.');
  assert.equal(await readDiagnosticTail(join(directory,'private-canary-missing')),'');
});

test('deployment subprocess drains stdout and stderr while retaining only bounded diagnostic tails',async()=>{
  const script=`process.stdout.write('discard-canary'.repeat(20000)+'\\nUploaded private-canary\\n');
    process.stderr.write('discard-canary'.repeat(20000)+'\\nError creating application: private-canary-token\\n',()=>{process.exitCode=13;});`;
  await assert.rejects(runDeploymentCommand(process.execPath,['-e',script],{
    cwd:process.cwd(),env:{},logPath:'/nonexistent/private-canary.log'}),error=>{
    assert.ok(error instanceof DeploymentCommandError);
    assert.equal(error.message,'Deployment diagnostic: stage=container-application-create; category=application-create; exit=13; signal=none; codes=none.');
    assert.doesNotMatch(error.stack??'',/discard-canary|private-canary/);
    return true;
  });
});

test('deployment subprocess reports spawn failure and termination without raw errors',async()=>{
  await assert.rejects(runDeploymentCommand('/nonexistent/private-canary-binary',[],{
    cwd:process.cwd(),env:{},logPath:'/nonexistent/private-canary.log'}),
    /stage=unknown; category=subprocess-start; exit=unknown; signal=none; codes=none/);
  await assert.rejects(runDeploymentCommand(process.execPath,['-e',"process.kill(process.pid,'SIGTERM')"],{
    cwd:process.cwd(),env:{},logPath:'/nonexistent/private-canary.log'}),
    /stage=unknown; category=unclassified; exit=unknown; signal=SIGTERM; codes=none/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(runDeploymentCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{
    cwd:process.cwd(),env:{},signal:controller.signal,logPath:'/nonexistent/private-canary.log'}),/category=subprocess-interrupted/);
});

test('deploy entrypoint classifies private Wrangler log before cleaning all temporary secrets and diagnostics',t=>{
  const directory=mkdtempSync(join(tmpdir(),'herbie-diagnostic-test-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const bin=join(directory,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'git'),`#!/bin/sh\nprintf '%s' '${context.GITHUB_SHA}'\n`,{mode:0o700});
  writeFileSync(join(bin,'pnpm'),`#!/bin/sh
printf '%s\\n' 'Uploaded private-canary-worker' 'Exceeded account limits: private-canary-account' > "$WRANGLER_LOG_PATH"
printf '%s\\n' 'private-canary-stdout'
printf '%s\\n' '-----BEGIN PRIVATE KEY-----' 'private-canary-body' '-----END PRIVATE KEY-----' >&2
exit 9
`,{mode:0o700});
  const result=spawnSync(process.execPath,['--import','tsx','packages/cloudflare/scripts/deploy.ts'],{
    cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8',env:{...context,PATH:bin,TMPDIR:directory}});
  assert.equal(result.status,1);
  assert.match(result.stderr,/Deployment diagnostic: stage=container-limits; category=account-limit; exit=9; signal=none; codes=none/);
  assert.doesNotMatch(result.stdout+result.stderr,/private-canary|BEGIN PRIVATE|test-only|synthetic-fixture/);
  assert.deepEqual(readdirSync(directory).filter(name=>name.startsWith('herbie-deploy-')),[]);
});
