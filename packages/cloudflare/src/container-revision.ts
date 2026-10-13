const revisionStorageKey='containerStartedRevision';

interface RevisionStorage {
  get<T>(key:string):Promise<T|undefined>;
  put<T>(key:string,value:T):Promise<void>;
}

interface ManagedContainer {
  readonly running:boolean;
  destroy(reason?:string):Promise<void>;
}

/** Restart a running container when its startup environment belongs to an older Worker release. */
export async function ensureContainerRevision(container:ManagedContainer,storage:RevisionStorage,revision:string,start:()=>void,waitForReady:()=>Promise<void>):Promise<void>{
  const startedRevision=await storage.get<string>(revisionStorageKey);
  const restart=container.running&&startedRevision!==revision;
  if(restart)await container.destroy('Worker deployment changed');
  const started=!container.running;
  if(started){
    start();
    // Record the process identity before waiting for readiness. A slow start can
    // outlast one readiness window; retries must keep waiting on this process.
    await storage.put(revisionStorageKey,revision);
  }
  await waitForReady();
}

export function containerHealthMatchesRevision(value:unknown,revision:string):boolean{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const health=value as {deploymentId?:unknown;imageRevision?:unknown};
  return health.deploymentId===revision&&health.imageRevision===revision;
}
