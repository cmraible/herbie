import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareDeployment,waitForDeployment} from './deployment.js';

const directory=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const controller=new AbortController();
process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());

// Only these values reach child tools. Runtime credentials stay in a 0600 file,
// outside the Docker context; neither subprocess output nor production logs are archived.
const childEnvironment:Record<string,string|undefined>={CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG:'error'};
for(const name of ['PATH','HOME','TMPDIR','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_EXTRA_CA_CERTS']){
  if(process.env[name])childEnvironment[name]=process.env[name];
}
async function command(binary:string,args:string[],environment=childEnvironment):Promise<string>{
  return new Promise((resolveCommand,reject)=>{
    const child=spawn(binary,args,{cwd:directory,env:environment,signal:controller.signal,stdio:['ignore','pipe','ignore']});
    let output='';
    child.stdout.on('data',(chunk:Buffer)=>{if(output.length<4096)output+=chunk.toString();});
    child.once('error',()=>reject(new Error('Deployment subprocess failed')));
    child.once('exit',code=>code===0?resolveCommand(output):reject(new Error('Deployment subprocess failed')));
  });
}
let temporary:string|undefined;
let phase='configuration validation';
try{
  const input:unknown=JSON.parse(await readFile(join(directory,'wrangler.jsonc'),'utf8'));
  const prepared=prepareDeployment(process.env,input,directory);
  phase='current-main verification';
  const latest=(await command('git',['ls-remote','https://github.com/cmraible/herbie.git','refs/heads/main'])).split(/\s+/)[0];
  if(latest!==process.env.GITHUB_SHA)throw new Error('Refusing a stale deployment; run the workflow on current main');
  temporary=await mkdtemp(join(tmpdir(),'herbie-deploy-'));
  const configPath=join(temporary,'wrangler.json'),secretsPath=join(temporary,'secrets.json');
  await writeFile(configPath,JSON.stringify(prepared.config),{mode:0o600});
  await writeFile(secretsPath,prepared.secrets,{mode:0o600});
  phase='Worker and container deployment';
  console.log('Deploying the verified main revision with live execution disabled.');
  await command('pnpm',['exec','wrangler','deploy','--config',configPath,'--secrets-file',secretsPath,'--containers-rollout=immediate'],
    {...childEnvironment,CLOUDFLARE_API_TOKEN:process.env.CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID:process.env.CLOUDFLARE_ACCOUNT_ID,
      DOCKER_CONFIG:join(temporary,'docker'),WRANGLER_LOG_PATH:join(temporary,'wrangler.log')});
  phase='new-container health verification';
  await waitForDeployment('https://herbie-service.cmraible1.workers.dev',prepared.revision,{signal:controller.signal});
  console.log(`Verified disabled production release ${prepared.revision}.`);
}catch{
  console.error(`Production ${phase} failed or was refused. Check approved inputs, current main and Cloudflare deployment state. No raw tool output was logged.`);
  process.exitCode=1;
}finally{
  if(temporary)await rm(temporary,{recursive:true,force:true});
}
