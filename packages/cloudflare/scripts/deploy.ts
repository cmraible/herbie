import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DeploymentConfigurationError,DeploymentHealthError,prepareDeployment,waitForDeployment} from './deployment.js';
import {DeploymentCommandError,runDeploymentCommand,terminateOnAbort,deploymentDeadline} from './diagnostics.js';

const directory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const deadline=deploymentDeadline();
const controller=deadline.controller;
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());

// Only these values reach child tools. Runtime credentials stay in a 0600 file,
// outside the Docker context; neither subprocess output nor production logs are archived.
const childEnvironment:Record<string,string|undefined>={CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG:'info'};
for(const name of ['PATH','HOME','TMPDIR','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS']){
  if(process.env[name])childEnvironment[name]=process.env[name];
}
async function command(binary:string,args:string[],environment=childEnvironment):Promise<string>{
  return new Promise((resolveCommand,reject)=>{
    const child=spawn(binary,args,{cwd:directory,env:environment,detached:true,stdio:['ignore','pipe','ignore']});
    const stop=terminateOnAbort(child,controller.signal);
    let output='';
    child.stdout.on('data',(chunk:Buffer)=>{if(output.length<4096)output+=chunk.toString();});
    child.once('error',()=>reject(new Error('Deployment subprocess failed')));
    child.once('close',code=>{stop();code===0&&!controller.signal.aborted?resolveCommand(output):reject(new Error('Deployment subprocess failed'));});
  });
}
let temporary:string|undefined;
let phase='configuration validation';
try{
  const input:unknown=JSON.parse(await readFile(join(directory,'wrangler.jsonc'),'utf8'));
  const prepared=prepareDeployment(process.env,input,directory);
  phase='serving-container preservation';
  // Preserve the existing application exactly: changing its image would still
  // trigger a stop/start rollout before the readiness-gated handoff.
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/containers/applications`,{
    headers:{authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]),redirect:'error'});
  const applications:unknown=await response.json();
  if(!response.ok||!applications||typeof applications!=='object'||!('result' in applications)||!Array.isArray(applications.result))throw new Error('Could not preserve serving application');
  const serving:unknown=applications.result.find((app:unknown)=>!!app&&typeof app==='object'&&'name' in app&&app.name==='herbie-service-herbiecontainer');
  if(!serving||typeof serving!=='object'||!('configuration' in serving)||!serving.configuration||typeof serving.configuration!=='object'||!('image' in serving.configuration))throw new Error('Serving application missing');
  const servingImage=serving.configuration.image;
  if(typeof servingImage!=='string'||!new RegExp(`^registry\\.cloudflare\\.com/${process.env.CLOUDFLARE_ACCOUNT_ID}/[a-z0-9-]+@sha256:[a-f0-9]{64}$`).test(servingImage))throw new Error('Serving image identity unavailable');
  prepared.config.containers[0].image=servingImage;
  delete prepared.config.containers[0].image_build_context;
  delete prepared.config.containers[0].image_vars;
  phase='current-main verification';
  const latest=(await command('git',['ls-remote',prepared.repositoryUrl,'refs/heads/main'])).split(/\s+/)[0];
  if(latest!==process.env.GITHUB_SHA)throw new Error('Refusing a stale deployment; run the workflow on current main');
  temporary=await mkdtemp(join(tmpdir(),'herbie-deploy-'));
  const configPath=join(temporary,'wrangler.json'),secretsPath=join(temporary,'secrets.json');
  await writeFile(configPath,JSON.stringify(prepared.config),{mode:0o600});
  await writeFile(secretsPath,prepared.secrets,{mode:0o600});
  if(controller.signal.aborted||deadline.expired())throw new Error('Deployment interrupted');
  phase='Worker and container deployment';
  console.log(`Deploying the verified main revision with live execution ${prepared.executionEnabled?'enabled':'disabled'}.`);
  const healthController=new AbortController();
  const healthSignal=AbortSignal.any([controller.signal,healthController.signal]);
  const health=waitForDeployment(prepared.origin,prepared.revision,{executionEnabled:prepared.executionEnabled,signal:healthSignal,timeoutMs:deadline.remaining(),report:message=>console.log(message)})
    .then(()=>({ok:true as const}),error=>({ok:false as const,error}));
  try{
    await runDeploymentCommand('pnpm',['exec','wrangler','deploy','--config',configPath,'--secrets-file',secretsPath],
      {cwd:directory,signal:controller.signal,report:message=>console.log(message),logPath:join(temporary,'wrangler.log'),env:{...childEnvironment,CLOUDFLARE_API_TOKEN:process.env.CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID:process.env.CLOUDFLARE_ACCOUNT_ID,
        DOCKER_CONFIG:join(temporary,'docker'),WRANGLER_LOG_PATH:join(temporary,'wrangler.log')}});
  }catch(error){healthController.abort();await health;throw error;}
  phase='new-container health verification';
  const verification=await health;
  if(!verification.ok)throw verification.error;
  console.log(`Verified production release ${prepared.revision}.`);
}catch(error){
  if(deadline.expired())console.error('Deployment exceeded the shared 20-minute deadline; subprocess groups were terminated (up to 2 seconds termination grace).');
  if(error instanceof DeploymentCommandError)console.error(error.message);
  if(error instanceof DeploymentConfigurationError||error instanceof DeploymentHealthError)console.error(error.message);
  console.error(`Production ${phase} failed or was refused. Check approved inputs, current main and Cloudflare deployment state. No raw tool output was logged.`);
  process.exitCode=1;
}finally{
  deadline.dispose();
  if(temporary)await rm(temporary,{recursive:true,force:true});
}
