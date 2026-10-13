const revisionStorageKey='containerStartedRevision';

interface RevisionStorage {
  get<T>(key:string):Promise<T|undefined>;
  put<T>(key:string,value:T):Promise<void>;
}

interface ManagedContainer {
  readonly running:boolean;
}

/** Preserve a serving process; release replacement belongs to the router. */
export async function ensureContainerRevision(container:ManagedContainer,storage:RevisionStorage,revision:string,start:()=>void,waitForReady:()=>Promise<void>):Promise<void>{
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
