const revisionStorageKey='containerDeploymentRevision';

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
  if(started)start();
  await waitForReady();
  if(restart||started)await storage.put(revisionStorageKey,revision);
}
