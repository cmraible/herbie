import {resolve} from 'node:path';
import {createPrivateKey,X509Certificate} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

type Environment=Record<string,string|undefined>;
function isRecord(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function object(value:unknown){if(!isRecord(value))throw new Error('Invalid deployment configuration');return value;}
function required(values:Record<string,unknown>,name:string){
  const value=values[name];
  if(typeof value!=='string'||!value.trim())throw new Error(`Missing deployment input: ${name}`);
  return value;
}

export async function waitForDeployment(origin:string,revision:string,options:{timeoutMs?:number;intervalMs?:number;signal?:AbortSignal}={}){
  const deadline=Date.now()+(options.timeoutMs??600_000);
  while(Date.now()<deadline&&!options.signal?.aborted){
    try{
      const signal=AbortSignal.any([AbortSignal.timeout(10_000),...(options.signal?[options.signal]:[])]);
      const response=await fetch(`${origin}/api/health`,{signal,redirect:'error'});
      const health:unknown=await response.json();
      if(response.ok&&isRecord(health)&&health.mode==='live'&&health.executionEnabled===false
        &&health.deploymentId===revision&&health.imageRevision===revision)return;
    }catch{/* Responses can contain credentials or platform details; never print them. */}
    await delay(options.intervalMs??5000,undefined,{signal:options.signal}).catch(()=>undefined);
  }
  throw new Error('Deployment did not become ready for the requested revision');
}

export function prepareDeployment(environment:Environment,input:unknown,directory:string){
  validateDeploymentEnvironment(environment);
  const repository=required(environment,'HERBIE_DEPLOY_REPOSITORY');
  if(!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository)||environment.GITHUB_REPOSITORY!==repository||environment.GITHUB_REF!=='refs/heads/main'
    ||!['push','workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME??'')||environment.HERBIE_DEPLOY_ENABLED!=='true'){
    throw new Error('Deployment is not authorized for this workflow context');
  }
  const config=object(input),vars=object(config.vars),assets=object(config.assets);
  const containers=config.containers;
  if(!Array.isArray(containers)||containers.length!==1)throw new Error('Invalid deployment configuration');
  const container=object(containers[0]);
  if(config.account_id!==undefined||config.name!=='herbie-service'||vars.HERBIE_PUBLIC_URL!=='https://herbie.example.invalid'
    ||vars.HERBIE_EXECUTION_ENABLED!=='false'||container.instance_type!=='basic'||container.max_instances!==1){
    throw new Error('Deployment target or disabled execution configuration does not match the approved service');
  }
  const account=required(environment,'CLOUDFLARE_ACCOUNT_ID'),origin=required(environment,'HERBIE_PUBLIC_URL');
  const revision=`${required(environment,'GITHUB_SHA')}-${required(environment,'GITHUB_RUN_ID')}-${required(environment,'GITHUB_RUN_ATTEMPT')}`;
  const runtime={DATABASE_URL:required(environment,'HERBIE_DATABASE_URL'),HERBIE_CREDENTIAL_KEY:required(environment,'HERBIE_CREDENTIAL_KEY'),
    GITHUB_APP_ID:required(environment,'HERBIE_GITHUB_APP_ID'),GITHUB_CLIENT_ID:required(environment,'HERBIE_GITHUB_CLIENT_ID'),
    GITHUB_CLIENT_SECRET:required(environment,'HERBIE_GITHUB_CLIENT_SECRET'),GITHUB_PRIVATE_KEY:required(environment,'HERBIE_GITHUB_PRIVATE_KEY'),
    GITHUB_WEBHOOK_SECRET:required(environment,'HERBIE_GITHUB_WEBHOOK_SECRET'),
    ...(environment.HERBIE_DATABASE_CA?{HERBIE_DATABASE_CA:environment.HERBIE_DATABASE_CA}:{})};
  return {revision,origin,repositoryUrl:`https://github.com/${repository}.git`,secrets:JSON.stringify({HERBIE_RUNTIME_SECRETS:JSON.stringify(runtime)}),
    config:{...config,account_id:account,main:resolve(directory,required(config,'main')),
      vars:{...vars,HERBIE_PUBLIC_URL:origin,HERBIE_EXECUTION_ENABLED:'false',HERBIE_DEPLOYMENT_ID:revision},
      assets:{...assets,directory:resolve(directory,required(assets,'directory'))},
      containers:[{...container,image:resolve(directory,required(container,'image')),image_build_context:resolve(directory,required(container,'image_build_context')),
        image_vars:{HERBIE_RUNTIME_REVISION:revision}}]}};
}

// Dependency-free schema: collect only static field names/reasons, never parser errors or values.
export class DeploymentConfigurationError extends Error {}
export function validateDeploymentEnvironment(environment:Environment){
  const failures:string[]=[];
  const check=(name:string,valid:(value:string)=>boolean,reason:string,optional=false)=>{
    const value=environment[name];
    if(value===undefined||value===''){
      if(!optional)failures.push(`${name}: required`);
      return;
    }
    try{if(!value.trim()||!valid(value))throw new Error();}
    catch{failures.push(`${name}: ${reason}`);}
  };
  const line=(value:string)=>value.trim()===value&&!/[\r\n\0]/.test(value);
  check('HERBIE_DEPLOY_REPOSITORY',v=>/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(v),'expected owner/repository');
  check('CLOUDFLARE_ACCOUNT_ID',v=>/^[a-f0-9]{32}$/.test(v),'expected 32 lowercase hex characters');
  check('HERBIE_SUPABASE_PROJECT_REF',v=>/^[a-z0-9]{20}$/.test(v),'expected 20 lowercase alphanumeric characters');
  check('HERBIE_SUPABASE_POOLER_HOST',v=>/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(v),'expected session pooler hostname');
  check('HERBIE_PUBLIC_URL',v=>{
    const url=new URL(v);
    return url.origin===v&&url.protocol==='https:'&&!url.port&&!url.username&&!url.password
      &&/^herbie-service\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname);
  },'expected exact HTTPS herbie-service Worker origin');
  for(const name of ['CLOUDFLARE_API_TOKEN','HERBIE_GITHUB_CLIENT_ID','HERBIE_GITHUB_CLIENT_SECRET','HERBIE_GITHUB_WEBHOOK_SECRET']){
    check(name,line,'expected nonempty single-line value without surrounding whitespace');
  }
  check('HERBIE_DATABASE_URL',v=>{
    const url=new URL(v);
    return line(v)&&url.protocol==='postgresql:'&&url.username===`postgres.${environment.HERBIE_SUPABASE_PROJECT_REF}`&&!!url.password
      &&url.hostname===environment.HERBIE_SUPABASE_POOLER_HOST&&url.port==='5432'&&url.pathname==='/postgres'
      &&!url.hash&&[...url.searchParams].every(([name,value])=>name==='sslmode'&&value==='verify-full');
  },'expected session URL matching HERBIE_SUPABASE_PROJECT_REF and HERBIE_SUPABASE_POOLER_HOST, port 5432, database postgres');
  check('HERBIE_CREDENTIAL_KEY',v=>{const key=Buffer.from(v,'base64');return key.length===32&&key.toString('base64')===v;},'expected canonical base64 for 32 bytes');
  check('HERBIE_GITHUB_APP_ID',v=>/^[1-9]\d*$/.test(v),'expected positive numeric App ID');
  check('HERBIE_GITHUB_PRIVATE_KEY',v=>v.includes('-----BEGIN ')&&createPrivateKey(v).asymmetricKeyType==='rsa','expected RSA private-key PEM with actual newlines');
  check('HERBIE_DATABASE_CA',v=>{new X509Certificate(v);return true;},'expected certificate PEM',true);
  check('GITHUB_SHA',v=>/^[a-f0-9]{40}$/.test(v),'expected workflow commit SHA');
  for(const name of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])check(name,v=>/^[1-9]\d*$/.test(v),'expected positive workflow run number');
  if(failures.length)throw new DeploymentConfigurationError(`Invalid deployment configuration:\n${failures.join('\n')}`);
}
