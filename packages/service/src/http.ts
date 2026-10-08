import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {actionSchema,goalInput} from '@herbie/contracts';
import {Store,StoreError} from './store.js';
import {AuthError,type createAuth} from './auth.js';
import {GithubError} from './github.js';
import type {Adapters} from './adapters.js';
import {reconcileReviews} from './worker.js';
import {cliConsentPage,cliConsentResult,consentCsp} from './cli-consent-page.js';

type Auth = ReturnType<typeof createAuth>;
interface ApiOptions {store:Store;auth:Auth;adapters:Adapters;publicUrl:string;executionEnabled?:boolean;verifyWebhook?:(body:Buffer,signature:string)=>boolean;webDirectory?:string;}
class HttpError extends Error {constructor(readonly status:number,message:string){super(message);}}
const clientInput=z.object({client:z.enum(['web','cli']).default('web')});
function cookie(request:IncomingMessage,name:string):string|undefined {
  return request.headers.cookie?.split(';').map(part=>part.trim()).find(part=>part.startsWith(`${name}=`))?.slice(name.length+1);
}
function json(response:ServerResponse,status:number,value:unknown):void {
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(value));
}
async function body(request:IncomingMessage):Promise<Buffer>{
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of request){
    const data:unknown=chunk;
    if(!Buffer.isBuffer(data)) throw new HttpError(400,'Invalid request body');
    length+=data.length;if(length>65_536)throw new HttpError(413,'Request body too large');chunks.push(data);
  }
  return Buffer.concat(chunks);
}
async function readJson(request:IncomingMessage):Promise<unknown>{
  const raw=await body(request);if(!raw.length)return {};
  if(!request.headers['content-type']?.startsWith('application/json'))throw new HttpError(415,'Use application/json');
  try{return JSON.parse(raw.toString('utf8'));}catch{throw new HttpError(400,'Invalid JSON');}
}
export function createApiServer(options:ApiOptions){
  const {store,auth,adapters}=options;
  const executionEnabled=options.executionEnabled??true;
  function requireExecution(){if(!executionEnabled)throw new HttpError(503,'Live execution is disabled by the operator');}
  const origin=new URL(options.publicUrl).origin;
  const secure=new URL(origin).protocol==='https:'?'; Secure':'';
  const approvalCookie=(token:string,maxAge=600)=>`herbie_cli_approval=${token}; HttpOnly; SameSite=Lax; Path=/api/auth/cli; Max-Age=${maxAge}${secure}`;
  const sessionCookie=(token:string)=>`herbie_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`;
  const web=options.webDirectory??fileURLToPath(new URL('../../web/dist/',import.meta.url));
  async function handle(request:IncomingMessage,response:ServerResponse):Promise<void>{
    response.setHeader('x-content-type-options','nosniff');
    response.setHeader('referrer-policy','no-referrer');
    response.setHeader('content-security-policy',"default-src 'self'; style-src 'self'; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url=new URL(request.url??'/',origin);
    const method=request.method??'GET';
    const bearer=request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    if(method!=='GET'&&method!=='HEAD'&&url.pathname!=='/api/webhooks/github'&&(!bearer||url.pathname==='/api/auth/cli')){
      // SameSite does not protect against another port on localhost or compromised sibling origins.
      if(request.headers.origin!==origin)throw new HttpError(403,'Request origin is not allowed');
    }
    if(method==='GET'&&url.pathname==='/api/health'){json(response,200,{mode:adapters.mode,executionEnabled});return;}
    if(method==='POST'&&url.pathname==='/api/auth/start'){
      const {client}=clientInput.parse(await readJson(request));const flow=await auth.start(client);
      if(client==='web')response.setHeader('set-cookie',`herbie_auth=${flow.browserState}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=600${secure}`);
      json(response,200,{url:flow.url,...(flow.pollToken?{pollToken:flow.pollToken,userCode:flow.userCode}:{})});return;
    }
    if(method==='GET'&&url.pathname==='/api/auth/callback'){
      const result=await auth.callback(z.string().min(1).parse(url.searchParams.get('code')),z.string().min(1).parse(url.searchParams.get('state')),cookie(request,'herbie_auth'));
      response.setHeader('cache-control','no-store');
      if(result.client==='web'){response.setHeader('set-cookie',[sessionCookie(result.token),`herbie_auth=; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=0${secure}`]);response.writeHead(303,{location:'/'});response.end();}
      else {response.setHeader('set-cookie',approvalCookie(result.approvalToken));response.writeHead(303,{location:'/api/auth/cli'});response.end();}return;
    }
    if(url.pathname==='/api/auth/cli'&&(method==='GET'||method==='POST')){
      const approvalToken=cookie(request,'herbie_cli_approval')??'';
      let html:string;
      if(method==='GET')html=cliConsentPage({...await auth.pendingCli(approvalToken),origin});
      else{
        if(!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))throw new HttpError(415,'Use form submission');
        const fields=new URLSearchParams((await body(request)).toString('utf8'));
        const decision=z.enum(['approve','reject']).parse(fields.get('decision'));
        const csrfToken=z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(fields.get('csrfToken'));
        const userCode=z.string().max(20).optional().parse(fields.get('userCode')??undefined);
        const result=await auth.decideCli(approvalToken,csrfToken,decision,userCode);
        response.setHeader('set-cookie',approvalCookie('',0));
        html=cliConsentResult(result.status==='approved');
      }
      response.setHeader('content-security-policy',consentCsp);
      // Preserve Origin on same-origin form POSTs while suppressing cross-origin referrers.
      response.setHeader('referrer-policy','same-origin');
      response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(html);return;
    }
    if(method==='GET'&&url.pathname==='/api/auth/poll'){json(response,200,await auth.poll(z.string().min(20).max(200).parse(url.searchParams.get('token'))));return;}
    if(method==='POST'&&url.pathname==='/api/demo/login'){
      if(adapters.mode!=='demo')throw new HttpError(404,'Not found');
      const {client}=clientInput.parse(await readJson(request));const result=await auth.demoLogin();
      if(client==='web'){response.setHeader('set-cookie',sessionCookie(result.token));json(response,200,result.session);}else json(response,200,result);return;
    }
    if(method==='POST'&&url.pathname==='/api/webhooks/github'){
      const payload=await body(request);const signature=request.headers['x-hub-signature-256'];
      if(typeof signature!=='string'||!options.verifyWebhook?.(payload,signature))throw new HttpError(401,'Invalid webhook signature');
      // Only trusted API reads drive transitions. Duplicate/out-of-order webhook bodies are harmless.
      if(request.headers['x-github-event']==='pull_request')await reconcileReviews(store,adapters);
      json(response,200,{ok:true});return;
    }
    if(url.pathname.startsWith('/api/')){
      const token=bearer??cookie(request,'herbie_session');const session=token?await auth.session(token):null;
      if(!session)throw new HttpError(401,'Login required');
      const userId=session.user.id;
      if(method==='GET'&&url.pathname==='/api/session'){json(response,200,session);return;}
      if(method==='POST'&&url.pathname==='/api/auth/logout'){if(token)await auth.logout(token);response.setHeader('set-cookie',`herbie_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);json(response,200,{ok:true});return;}
      if(method==='GET'&&url.pathname==='/api/repositories'){json(response,200,await adapters.repositories(userId));return;}
      if(method==='GET'&&url.pathname==='/api/goals'){json(response,200,await store.listGoals(userId));return;}
      if(method==='POST'&&url.pathname==='/api/goals'){
        requireExecution();
        const input=goalInput.parse(await readJson(request));
        const key=z.string().uuid().parse(request.headers['idempotency-key']);
        await adapters.authorize(userId,input.repository);
        const result=await store.createGoal(userId,input,adapters.mode,key);json(response,result.created?201:200,result.goal);return;
      }
      const goalPath=url.pathname.match(/^\/api\/goals\/([^/]+)(?:\/(events|pause|resume|cancel))?$/);
      if(goalPath){
        const id=z.string().uuid().parse(goalPath[1]);const goal=await store.getGoal(id,userId);
        if(!goal)throw new HttpError(404,'Goal not found');
        if(method==='GET'&&!goalPath[2]){json(response,200,goal);return;}
        if(method==='GET'&&goalPath[2]==='events'){const after=z.coerce.number().int().min(0).safe().parse(url.searchParams.get('after')??0);json(response,200,await store.events(id,after));return;}
        if(method==='POST'&&goalPath[2]&&goalPath[2]!=='events'){
          const action=actionSchema.parse(goalPath[2]);if(action==='resume')requireExecution();
          json(response,200,await store.control(id,userId,action));return;
        }
      }
      const demoPath=url.pathname.match(/^\/api\/demo\/goals\/([^/]+)\/(merge|close)$/);
      if(method==='POST'&&adapters.mode==='demo'&&demoPath){
        const id=z.string().uuid().parse(demoPath[1]);const goal=await store.getGoal(id,userId);if(!goal)throw new HttpError(404,'Goal not found');
        if(goal.mode!=='demo')throw new HttpError(409,'Only demo goals support simulated reviews');
        const job=(await store.reviewJobs()).find(job=>job.goal.id===id);
        if(!job){json(response,200,goal);return;}
        json(response,200,await store.reconcile(job.id,demoPath[2]==='merge'?'merged':'closed'));return;
      }
      throw new HttpError(404,'Not found');
    }
    if(method!=='GET'&&method!=='HEAD')throw new HttpError(404,'Not found');
    const pathname=decodeURIComponent(url.pathname);
    const file=resolve(web,pathname.replace(/^\/+/,''));
    if(!file.startsWith(`${resolve(web)}/`)&&file!==resolve(web))throw new HttpError(404,'Not found');
    const requested=extname(file)?file:resolve(web,'index.html');
    let data:Buffer;try{data=await readFile(requested);}catch{throw new HttpError(404,'Web UI not built. Run pnpm build.');}
    const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
    response.writeHead(200,{'content-type':`${mime[extname(requested)]??'application/octet-stream'}; charset=utf-8`,'cache-control':'no-cache'});response.end(method==='HEAD'?undefined:data);
  }
  return createServer((request,response)=>{void handle(request,response).catch(error=>{
    if(response.headersSent){response.destroy();return;}
    if(error instanceof HttpError||error instanceof StoreError||error instanceof AuthError||error instanceof GithubError)json(response,error.status,{error:error.message});
    else if(error instanceof z.ZodError||error instanceof URIError)json(response,400,{error:'Invalid request'});
    else json(response,500,{error:'Request failed. Check service configuration and try again.'});
  });});
}
