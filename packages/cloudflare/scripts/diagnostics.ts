import {spawn} from 'node:child_process';
import {open} from 'node:fs/promises';
import {stripVTControlCharacters} from 'node:util';

export const diagnosticLimit=64*1024;

// Retain copies of bounded tails, not slices keeping an arbitrarily large chunk alive.
export class DiagnosticTail {
  private value:Buffer=Buffer.alloc(0);
  append(chunk:Buffer){
    const tail=chunk.subarray(Math.max(0,chunk.length-diagnosticLimit));
    const previous=this.value.subarray(Math.max(0,this.value.length-(diagnosticLimit-tail.length)));
    this.value=Buffer.concat([previous,tail],previous.length+tail.length);
  }
  get byteLength(){return this.value.length;}
  text(){return this.value.toString('utf8');}
}

export async function readDiagnosticTail(path:string){
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
    file=await open(path,'r');
    const {size}=await file.stat();
    const buffer=Buffer.alloc(Math.min(size,diagnosticLimit));
    const {bytesRead}=await file.read(buffer,0,buffer.length,Math.max(0,size-buffer.length));
    return buffer.subarray(0,bytesRead).toString('utf8');
  }catch{return '';}
  finally{await file?.close().catch(()=>undefined);}
}

// Source text is evidence for fixed labels only. Never interpolate matches, raw
// errors, paths, URLs or responses into output, even after attempted redaction.
const stages=[
  ['Building image ','container-image-build'],
  ['Uploaded ','worker-upload-complete'],
  ['Image does not exist remotely, pushing:','container-image-push'],
  ['Image already exists remotely, skipping push','container-image-available'],
  ['Deploy a container application','container-application'],
  ['Created application ','container-application-created'],
  ['Current Version ID:','deployment-complete'],
] as const;
const failures=[
  ['Exceeded account limits:','container-limits','account-limit'],
  ['Image too large: needs ','container-limits','image-size-limit'],
  ['failed inspecting image locally:','container-image-inspect','docker-image-inspect'],
  ['Login failed with code:','container-registry-login','registry-login'],
  ['unauthorized: authentication required','unknown','registry-authentication'],
  ['denied: requested access to the resource is denied','unknown','registry-access-denied'],
  ['Could not deploy container configuration as durable object was not found','container-namespace-resolution','namespace-missing'],
  ['Error creating application due to a misconfiguration:','container-application-create','application-configuration'],
  ['Error creating application:','container-application-create','application-create'],
  ['A request to the Cloudflare API','unknown','cloudflare-api'],
  ['failed to solve:','container-image-build','docker-build'],
  ['error during connect:','unknown','docker-connect'],
] as const;
const allowedCodes=['10000','10021','100146'] as const;
const allowedSignals=['SIGTERM','SIGKILL','SIGINT','SIGHUP','SIGABRT','SIGSEGV','SIGPIPE','SIGQUIT','SIGILL','SIGBUS','SIGFPE','SIGXCPU','SIGXFSZ'] as const;

export function deploymentDiagnostic(sources:readonly string[],exitCode:number|null,signal:string|null,interruption:'none'|'spawn'|'abort'='none'){
  const texts=sources.map(source=>stripVTControlCharacters(source));
  let stage:string='unknown',category:string='unclassified';
  // Ordered milestones supply the furthest observed stage, not proof of success.
  for(const [marker,label] of stages)if(texts.some(text=>text.includes(marker)))stage=label;
  for(const [marker,errorStage,label] of failures){
    if(texts.some(text=>text.includes(marker))){
      if(errorStage!=='unknown')stage=errorStage;
      category=label;
      break;
    }
  }
  if(interruption==='spawn')category='subprocess-start';
  if(interruption==='abort')category='subprocess-interrupted';
  const codes=allowedCodes.filter(code=>texts.some(text=>text.includes(`[code: ${code}]`)));
  const exit=Number.isInteger(exitCode)&&exitCode!==null&&exitCode>=0&&exitCode<=255?String(exitCode):'unknown';
  const safeSignal=signal===null?'none':allowedSignals.find(allowed=>allowed===signal)??'other';
  return `Deployment diagnostic: stage=${stage}; category=${category}; exit=${exit}; signal=${safeSignal}; codes=${codes.join(',')||'none'}.`;
}

export class DeploymentCommandError extends Error {}

export async function runDeploymentCommand(binary:string,args:string[],options:{cwd:string;env:Record<string,string|undefined>;signal?:AbortSignal;logPath:string}){
  const stdout=new DiagnosticTail(),stderr=new DiagnosticTail();
  let spawnFailed=false;
  const result=await new Promise<{code:number|null;signal:string|null}>(resolve=>{
    try{
      const child=spawn(binary,args,{cwd:options.cwd,env:options.env,signal:options.signal,stdio:['ignore','pipe','pipe']});
      child.stdout.on('data',(chunk:Buffer)=>stdout.append(chunk));
      child.stderr.on('data',(chunk:Buffer)=>stderr.append(chunk));
      child.once('error',()=>{spawnFailed=true;});
      // close waits for both streams to drain; exit can precede their final bytes.
      child.once('close',(code,signal)=>resolve({code,signal}));
    }catch{spawnFailed=true;resolve({code:null,signal:null});}
  });
  if(result.code===0&&!spawnFailed&&!options.signal?.aborted)return;
  const log=await readDiagnosticTail(options.logPath);
  throw new DeploymentCommandError(deploymentDiagnostic([stdout.text(),stderr.text(),log],result.code,result.signal,
    options.signal?.aborted?'abort':spawnFailed?'spawn':'none'));
}
