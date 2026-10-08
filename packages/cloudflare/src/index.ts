import {DurableObject} from 'cloudflare:workers';
import {scheduler} from 'node:timers/promises';
import {blocksExecution,containerEnvironment,executionEnabled} from './configuration.js';

const port=8787;
const inactivityMs=10*60*1000;
const unavailable=()=>Response.json({error:'Herbie service is unavailable. Check operator configuration and supervisor logs.'},{status:503,headers:{'cache-control':'no-store'}});

export class HerbieContainer extends DurableObject<Env>{
  private starting:Promise<void>|undefined;
  constructor(ctx:DurableObjectState,env:Env){
    super(ctx,env);
    const container=ctx.container;
    if(container?.running)void ctx.blockConcurrencyWhile(()=>container.setInactivityTimeout(inactivityMs));
  }
  async ensureRunning():Promise<void>{
    this.starting??=this.startAndWait().finally(()=>{this.starting=undefined;});
    return this.starting;
  }
  private async startAndWait():Promise<void>{
    const container=this.ctx.container;
    if(!container)throw new Error('Container binding unavailable');
    if(!container.running){
      const env=containerEnvironment(this.env.HERBIE_RUNTIME_SECRETS,this.env.HERBIE_PUBLIC_URL,executionEnabled(this.env.HERBIE_EXECUTION_ENABLED));
      container.start({env,enableInternet:true});
    }
    await container.setInactivityTimeout(inactivityMs);
    const deadline=Date.now()+30_000;
    while(Date.now()<deadline){
      try{
        const health=await container.getTcpPort(port).fetch('http://container/api/health',{signal:AbortSignal.timeout(5000)});
        if(health.ok){await health.body?.cancel();return;}
        await health.body?.cancel();
      }catch{/* Startup is asynchronous; never log raw network/configuration errors. */}
      await scheduler.wait(500);
    }
    throw new Error('Container readiness timed out');
  }
  async fetch(request:Request):Promise<Response>{
    await this.ensureRunning();
    const container=this.ctx.container;
    if(!container)throw new Error('Container binding unavailable');
    const url=new URL(request.url);url.protocol='http:';url.host='container';
    const forwarded=new Request(url,request);forwarded.headers.delete('host');
    return container.getTcpPort(port).fetch(forwarded);
  }
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(path!=='/api'&&!path.startsWith('/api/'))return env.ASSETS.fetch(request);
    if(blocksExecution(request.method,path,executionEnabled(env.HERBIE_EXECUTION_ENABLED)))return Response.json({error:'Live execution is disabled by the operator'},{status:503,headers:{'cache-control':'no-store'}});
    try{return await env.HERBIE.getByName('herbie').fetch(request);}
    catch{console.error('Herbie API container unavailable');return unavailable();}
  },
  async scheduled(_event:ScheduledController,env:Env):Promise<void>{
    if(!executionEnabled(env.HERBIE_EXECUTION_ENABLED))return;
    try{await env.HERBIE.getByName('herbie').ensureRunning();}
    catch{console.error('Herbie supervisor readiness failed');throw new Error('Herbie supervisor readiness failed');}
  },
} satisfies ExportedHandler<Env>;
