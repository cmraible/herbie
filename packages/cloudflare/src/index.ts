import {DurableObject} from 'cloudflare:workers';
import {scheduler} from 'node:timers/promises';
import {blocksExecution,containerEnvironment,executionEnabled} from './configuration.js';
import {containerHealthMatchesRevision,ensureContainerRevision} from './container-revision.js';

const port=8787;
const inactivityMs=30*60*1000;
const unavailable=()=>Response.json({error:'Herbie service is unavailable. Check operator configuration and supervisor logs.'},{status:503,headers:{'cache-control':'no-store'}});
type Launch={revision:string;image:string;environment:Record<string,string>};
type Retired={revision:string;signalAt:number;destroyAt:number};

/** Retained during migration. Its image is pinned by the deployment helper. */
export class HerbieContainer extends DurableObject<Env>{
  private starting:Promise<void>|undefined;
  async ensureRunning():Promise<void>{
    if(await this.ctx.storage.get<boolean>('retired'))throw new Error('Release retired');
    this.starting??=this.startAndWait().finally(()=>{this.starting=undefined;});
    return this.starting;
  }
  protected async startAndWait():Promise<void>{
    const container=this.ctx.container;
    if(!container)throw new Error('Container binding unavailable');
    // Never replace the serving process merely because Worker code changed.
    await ensureContainerRevision(container,this.ctx.storage,this.env.HERBIE_DEPLOYMENT_ID,()=>{
      container.start({env:containerEnvironment(this.env.HERBIE_RUNTIME_SECRETS,this.env.HERBIE_PUBLIC_URL,executionEnabled(this.env.HERBIE_EXECUTION_ENABLED),this.env.HERBIE_DEPLOYMENT_ID),enableInternet:true});
    },()=>this.waitForReady());
  }
  protected async waitForReady(revision?:string,enabled?:boolean):Promise<void>{
    const container=this.ctx.container;
    if(!container)throw new Error('Container binding unavailable');
    await container.setInactivityTimeout(inactivityMs);
    const deadline=Date.now()+25_000;
    while(Date.now()<deadline){
      try{
        const health=await container.getTcpPort(port).fetch('http://container/api/health',{signal:AbortSignal.timeout(5000)});
        if(health.ok){
          const value:unknown=await health.json();
          if(value&&typeof value==='object'&&'mode' in value&&value.mode==='live'&&
            (!revision||(containerHealthMatchesRevision(value,revision)&&'executionEnabled' in value&&value.executionEnabled===enabled)))return;
        }else await health.body?.cancel();
      }catch{/* Keep diagnostics free of network errors and runtime secrets. */}
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
  async retire(force=false):Promise<void>{
    const container=this.ctx.container;
    if(!container?.running)return;
    if(force)await container.destroy('Retired release exceeded shutdown grace');
    else if(!await this.ctx.storage.get<boolean>('retired')){
      await container.setInactivityTimeout(inactivityMs);
      await this.ctx.storage.put('retired',true);
      container.signal(15);
    }
  }
}

/** One immutable image and environment per release, independent of app rollouts. */
export class ReleaseContainer extends HerbieContainer{
  async prepare(revision:string):Promise<void>{
    const launch=await this.ctx.storage.get<Launch>('launch');
    if(launch){if(launch.revision!==revision)throw new Error('Release identity mismatch');}
    else{
      const image=this.ctx.container?.images.release;
      if(revision!==this.env.HERBIE_DEPLOYMENT_ID||!image)throw new Error('Release image unavailable');
      await this.ctx.storage.put<Launch>('launch',{revision,image,environment:containerEnvironment(this.env.HERBIE_RUNTIME_SECRETS,this.env.HERBIE_PUBLIC_URL,executionEnabled(this.env.HERBIE_EXECUTION_ENABLED),revision)});
    }
    await this.ensureRunning();
  }
  protected override async startAndWait():Promise<void>{
    const launch=await this.ctx.storage.get<Launch>('launch');
    const container=this.ctx.container;
    if(!launch||!container)throw new Error('Release is not prepared');
    if(!container.running)container.start({image:launch.image,instance:'standard-1',env:launch.environment,enableInternet:true});
    await this.waitForReady(launch.revision,launch.environment.HERBIE_EXECUTION_ENABLED==='true');
  }
  override async retire(force=false):Promise<void>{
    await super.retire(force);
    if(force||!this.ctx.container?.running){await this.ctx.storage.delete('launch');await this.ctx.storage.put('retired',true);}
  }
}

/** The active pointer is durable. Candidate startup never blocks serving it. */
export class ReleaseRouter extends DurableObject<Env>{
  private promoting:Promise<void>|undefined;
  async prepareCurrent():Promise<void>{
    this.promoting??=this.promote().finally(()=>{this.promoting=undefined;});
    return this.promoting;
  }
  private async promote():Promise<void>{
    const revision=this.env.HERBIE_DEPLOYMENT_ID;
    const expectedPrevious=await this.ctx.storage.get<string>('active');
    if(expectedPrevious===revision)return;
    await this.env.RELEASES.getByName(revision).prepare(revision);
    // Storage transaction commits the route and cleanup schedule together. No
    // network call holds the storage lock or pauses reads of the old route.
    const promoted=await this.ctx.storage.transaction(async storage=>{
      const previous=await storage.get<string>('active');
      if(previous===revision||previous!==expectedPrevious)return false;
      const retired=await storage.get<Retired[]>('retired')??[];
      retired.push({revision:previous??'legacy',signalAt:Date.now()+60_000,destroyAt:Date.now()+16*60_000});
      await storage.put('retired',retired);
      await storage.put('active',revision);
      await storage.setAlarm(Date.now()+60_000);
      return true;
    });
    if(promoted)console.log('Herbie ready release promoted');
  }
  async fetch(request:Request):Promise<Response>{
    const active=await this.ctx.storage.get<string>('active');
    return active?this.env.RELEASES.getByName(active).fetch(request):this.env.HERBIE.getByName('herbie').fetch(request);
  }
  async ensureRunning():Promise<void>{
    const active=await this.ctx.storage.get<string>('active');
    if(active)await this.env.RELEASES.getByName(active).ensureRunning();
    else await this.env.HERBIE.getByName('herbie').ensureRunning();
  }
  async alarm():Promise<void>{
    const retired=await this.ctx.storage.get<Retired[]>('retired')??[];
    const remaining:Retired[]=[];
    for(const release of retired){
      if(release.revision===await this.ctx.storage.get<string>('active'))continue;
      if(Date.now()<release.signalAt){remaining.push(release);continue;}
      const force=Date.now()>=release.destroyAt;
      const stub=release.revision==='legacy'?this.env.HERBIE.getByName('herbie'):this.env.RELEASES.getByName(release.revision);
      try{
        if(Date.now()>=release.signalAt)await stub.retire(force);
        if(!force)remaining.push(release);
      }catch{
        console.error('Herbie retired release cleanup will retry');
        remaining.push({...release,signalAt:Date.now()+60_000});
      }
    }
    // Serialize cleanup with promotion so a new retirement cannot be lost.
    await this.ctx.storage.transaction(async storage=>{
      const latest=await storage.get<Retired[]>('retired')??[];
      const processed=new Set(retired.map(release=>release.revision));
      const next=[...remaining,...latest.filter(release=>!processed.has(release.revision))];
      await storage.put('retired',next);
      if(next.length)await storage.setAlarm(Math.min(...next.map(release=>Math.max(Date.now()+1000,release.signalAt>Date.now()?release.signalAt:release.destroyAt))));
    });
  }
}

export default {
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const path=new URL(request.url).pathname;
    if(path!=='/api'&&!path.startsWith('/api/'))return env.ASSETS.fetch(request);
    if(blocksExecution(request.method,path,executionEnabled(env.HERBIE_EXECUTION_ENABLED)))return Response.json({error:'Live execution is disabled by the operator'},{status:503,headers:{'cache-control':'no-store'}});
    const router=env.ROUTER.getByName('herbie');
    ctx.waitUntil(router.prepareCurrent().catch(()=>{console.error('Herbie candidate is not ready; retaining serving release');}));
    try{return await router.fetch(request);}
    catch{console.error('Herbie API container unavailable');return unavailable();}
  },
  async scheduled(_event:ScheduledController,env:Env,ctx:ExecutionContext):Promise<void>{
    const router=env.ROUTER.getByName('herbie');
    ctx.waitUntil(router.prepareCurrent().catch(()=>{console.error('Herbie candidate is not ready; retaining serving release');}));
    // Keep the serving API warm even when execution is disabled.
    try{await router.ensureRunning();}
    catch{console.error('Herbie supervisor readiness failed');throw new Error('Herbie supervisor readiness failed');}
  },
} satisfies ExportedHandler<Env>;
