import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeploymentProgress,deploymentDeadline,runDeploymentCommand} from '../scripts/diagnostics.js';
import {DeploymentHealthError,waitForDeployment} from '../scripts/deployment.js';

const canary='private-canary-account-token-project.invalid';
test('progress emits only fixed observations once and a heartbeat every 30 seconds',()=>{
  const output:string[]=[];const progress=new DeploymentProgress(message=>output.push(message),0);
  progress.observe([`Building image ${canary}\nUploaded ${canary}\n/registries/${canary}\nDeploy a container application ${canary}`],1000);
  const first=output.length;
  progress.observe([`Uploaded ${canary}`],29999);assert.equal(output.length,first);
  progress.observe([],30000);assert.match(output.at(-1)!,/elapsed=30s; last-observed=container-provisioning/);
  progress.observe([],59999);assert.equal(output.length,first+1);
  progress.observe([],60000);assert.equal(output.length,first+2);
  assert.doesNotMatch(output.join('\n'),/private-canary|completed|https:/);
});

test('health reports cadence, readiness booleans and success without private response fields',async t=>{
  let now=0,calls=0;const output:string[]=[];
  t.mock.method(performance,'now',()=>now);
  t.mock.method(globalThis,'fetch',async()=>{
    calls++;now+=1000;
    return new Response(JSON.stringify({mode:'live',executionEnabled:false,deploymentId:canary,imageRevision:calls>=40?canary:'old-'+canary,private:canary}),{status:200});
  });
  await waitForDeployment('https://'+canary,canary,{timeoutMs:100000,intervalMs:0,report:message=>output.push(message)});
  assert.equal(output.filter(line=>line.startsWith('Health verification waiting')).length,2);
  assert.match(output[1],/http=200; category=not-ready; live=true; execution-disabled=true; execution-mode-ready=true; worker-revision-ready=true; image-revision-ready=false/);
  assert.match(output.at(-1)!,/Health verification passed:.*image-revision-ready=true/);
  assert.doesNotMatch(output.join('\n'),/private-canary|https:|old-/);
});

for(const failure of ['http','json','network','enabled','abort'] as const){
  test(`health ${failure} failure keeps diagnostics private and fails closed`,async t=>{
    let now=0;const output:string[]=[];const controller=new AbortController();
    t.mock.method(performance,'now',()=>now);
    t.mock.method(globalThis,'fetch',async()=>{
      now+=30;
      if(failure==='abort')controller.abort();
      if(failure==='network')throw new Error(canary);
      if(failure==='json')return new Response(canary,{status:502});
      return new Response(JSON.stringify({mode:'live',executionEnabled:failure==='enabled',deploymentId:canary,imageRevision:canary,detail:canary}),{status:failure==='http'?503:200});
    });
    await assert.rejects(waitForDeployment('https://'+canary,canary,{timeoutMs:20,intervalMs:0,signal:controller.signal,report:message=>output.push(message)}),error=>{
      assert.ok(error instanceof DeploymentHealthError);output.push(error.message);
      assert.match(error.message,/outcome=(timed-out|aborted)/);return true;
    });
    assert.doesNotMatch(output.join('\n'),/private-canary|https:|passed/);
  });
}

test('subprocess progress succeeds without publishing raw stdout or stderr',async()=>{
  const output:string[]=[];
  await runDeploymentCommand(process.execPath,['-e',`process.stdout.write('Building image ${canary}\\n');process.stderr.write('Uploaded ${canary}\\n');`],{
    cwd:process.cwd(),env:{},logPath:'/nonexistent/'+canary,report:message=>output.push(message)});
  assert.ok(output.some(line=>line.includes('container-image-build')));
  assert.match(output.at(-1)!,/command completed; application health is not yet verified/);
  assert.doesNotMatch(output.join('\n'),/private-canary/);
});

test('one deadline spans phases and kills a subprocess group that ignores termination',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'herbie-deadline-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const pidPath=join(directory,'child.pid');
  const deadline=deploymentDeadline(250);t.after(()=>deadline.dispose());
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(deadline.remaining()<240);
  const start=performance.now();const output:string[]=[];
  await assert.rejects(runDeploymentCommand(process.execPath,['-e',`
    const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
    writeFileSync(${JSON.stringify(pidPath)},String(child.pid));setInterval(()=>{},1000);
  `],{cwd:directory,env:{},signal:deadline.controller.signal,logPath:join(directory,'missing'),report:message=>output.push(message)}),/subprocess-interrupted/);
  assert.ok(deadline.expired());assert.equal(deadline.remaining(),0);
  assert.ok(performance.now()-start<4000,'termination grace must be bounded');
  const pid=Number(readFileSync(pidPath,'utf8'));
  try{assert.match(readFileSync(`/proc/${pid}/stat`,'utf8'),/^\d+ \(.*\) Z /,'grandchild must no longer be running');}
  catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;}
  assert.doesNotMatch(output.join('\n'),/private-canary/);
});
