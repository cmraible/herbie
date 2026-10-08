import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import {pathToFileURL} from 'node:url';
import {createRuntime} from './runtime.js';
import {createApiServer} from './http.js';
import {runWorker} from './worker.js';

type Runtime = Awaited<ReturnType<typeof createRuntime>>;
export type HostedRuntime = Pick<Runtime,'store'|'auth'|'adapters'|'github'> & {
  config:{host:string;port:number;publicUrl:string;executionEnabled:boolean};
};
export type HostedService = {server:Server;close:()=>Promise<void>};

/** The API and worker are trusted peers. Generated code still runs only in Daytona. */
export async function startHostedService(injected?:HostedRuntime):Promise<HostedService>{
  const {config,store,auth,adapters,github}=injected??await createRuntime();
  const server=createApiServer({store,auth,adapters,publicUrl:config.publicUrl,executionEnabled:config.executionEnabled,verifyWebhook:github?.verifyWebhook});
  try{
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject);
      server.listen(config.port,config.host,()=>{server.off('error',reject);resolve();});
    });
  }catch{
    await store.close();
    throw new Error('Hosted API could not start');
  }
  const controller=new AbortController();
  const worker=config.executionEnabled?runWorker(store,adapters,randomUUID(),controller.signal):Promise.resolve();
  let closing:Promise<void>|undefined;
  function close():Promise<void>{
    if(closing)return closing;
    controller.abort();
    closing=(async()=>{
      const httpClosed=new Promise<void>((resolve,reject)=>{
        server.close(error=>error?reject(error):resolve());
        server.closeIdleConnections();
      });
      // Abort stops new claims. The active bounded attempt must finish its cleanup
      // and fenced database writes before the shared pool is closed.
      const results=await Promise.allSettled([httpClosed,worker]);
      await store.close();
      if(results.some(result=>result.status==='rejected'))throw new Error('Hosted shutdown did not complete cleanly');
    })();
    return closing;
  }
  return {server,close};
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{
    const service=await startHostedService();
    console.log('Herbie hosted API ready. Execution follows the configured operator gate.');
    const shutdown=()=>{void service.close().catch(()=>{console.error('Herbie shutdown failed; inspect durable state before restarting work.');process.exitCode=1;});};
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  }catch{
    // Startup errors can include connection strings, private keys, or SDK details.
    console.error('Herbie startup failed. Check configuration and database availability.');
    process.exitCode=1;
  }
}
