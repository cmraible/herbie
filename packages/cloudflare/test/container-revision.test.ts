import assert from 'node:assert/strict';
import test from 'node:test';
import {containerHealthMatchesRevision,ensureContainerRevision} from '../src/container-revision.js';

class MemoryStorage {
  values=new Map<string,unknown>();
  async get<T>(key:string):Promise<T|undefined>{return this.values.get(key) as T|undefined;}
  async put<T>(key:string,value:T):Promise<void>{this.values.set(key,value);}
}

class FakeContainer {
  running:boolean;
  calls:string[]=[];
  constructor(running:boolean){this.running=running;}
  async destroy(reason?:string):Promise<void>{this.calls.push(`destroy:${reason}`);this.running=false;}
}

test('a running container stays up when its startup revision matches the Worker',async()=>{
  const storage=new MemoryStorage();await storage.put('containerStartedRevision','release-a');
  const container=new FakeContainer(true);let starts=0;
  await ensureContainerRevision(container,storage,'release-a',()=>{starts++;},async()=>{});
  assert.equal(container.running,true);assert.deepEqual(container.calls,[]);assert.equal(starts,0);
});

test('a deployment revision change restarts the container with current Worker configuration',async()=>{
  const storage=new MemoryStorage();await storage.put('containerStartedRevision','release-a');
  const container=new FakeContainer(true);let starts=0;
  await ensureContainerRevision(container,storage,'release-b',()=>{starts++;container.running=true;},async()=>{});
  assert.deepEqual(container.calls,['destroy:Worker deployment changed']);
  assert.equal(starts,1);assert.equal(container.running,true);
  assert.equal(await storage.get('containerStartedRevision'),'release-b');
});

test('a stopped or previously untracked container starts once and records its configuration revision',async()=>{
  for(const running of [false,true]){
    const storage=new MemoryStorage();const container=new FakeContainer(running);let starts=0;
    await ensureContainerRevision(container,storage,'release-new',()=>{starts++;container.running=true;},async()=>{});
    assert.deepEqual(container.calls,running?['destroy:Worker deployment changed']:[]);
    assert.equal(starts,1);assert.equal(container.running,true);
    assert.equal(await storage.get('containerStartedRevision'),'release-new');
  }
});

test('a failed container destroy does not start or record a new revision',async()=>{
  const storage=new MemoryStorage();await storage.put('containerStartedRevision','release-a');
  const container=new FakeContainer(true);container.destroy=async()=>{throw new Error('destroy failed');};let starts=0;
  await assert.rejects(ensureContainerRevision(container,storage,'release-b',()=>{starts++;},async()=>{}),/destroy failed/);
  assert.equal(starts,0);assert.equal(await storage.get('containerStartedRevision'),'release-a');
});

test('a readiness timeout records the started revision so the next request can reuse the process',async()=>{
  const storage=new MemoryStorage();await storage.put('containerStartedRevision','release-a');
  const container=new FakeContainer(false);let starts=0,readinessChecks=0;
  const start=()=>{starts++;container.running=true;};
  const firstReadiness=async()=>{readinessChecks++;throw new Error('readiness timed out');};
  await assert.rejects(ensureContainerRevision(container,storage,'release-b',start,firstReadiness),/readiness timed out/);
  assert.equal(await storage.get('containerStartedRevision'),'release-b');

  await ensureContainerRevision(container,storage,'release-b',start,async()=>{readinessChecks++;});
  assert.equal(container.running,true);
  assert.deepEqual(container.calls,[]);
  assert.equal(starts,1);
  assert.equal(readinessChecks,2);
});

test('readiness requires both the Worker and image revisions to match',()=>{
  assert.equal(containerHealthMatchesRevision({deploymentId:'release-b',imageRevision:'release-b'},'release-b'),true);
  assert.equal(containerHealthMatchesRevision({deploymentId:'release-b',imageRevision:'release-a'},'release-b'),false);
  assert.equal(containerHealthMatchesRevision({deploymentId:'release-a',imageRevision:'release-b'},'release-b'),false);
  assert.equal(containerHealthMatchesRevision({deploymentId:'release-b'},'release-b'),false);
  assert.equal(containerHealthMatchesRevision(null,'release-b'),false);
});
