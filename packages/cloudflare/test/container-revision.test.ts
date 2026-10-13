import assert from 'node:assert/strict';
import test from 'node:test';
import {ensureContainerRevision} from '../src/container-revision.js';

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
  const storage=new MemoryStorage();await storage.put('containerDeploymentRevision','release-a');
  const container=new FakeContainer(true);let starts=0;
  await ensureContainerRevision(container,storage,'release-a',()=>{starts++;},async()=>{});
  assert.equal(container.running,true);assert.deepEqual(container.calls,[]);assert.equal(starts,0);
});

test('a deployment revision change restarts the container with current Worker configuration',async()=>{
  const storage=new MemoryStorage();await storage.put('containerDeploymentRevision','release-a');
  const container=new FakeContainer(true);let starts=0;
  await ensureContainerRevision(container,storage,'release-b',()=>{starts++;container.running=true;},async()=>{});
  assert.deepEqual(container.calls,['destroy:Worker deployment changed']);
  assert.equal(starts,1);assert.equal(container.running,true);
  assert.equal(await storage.get('containerDeploymentRevision'),'release-b');
});

test('a stopped or previously untracked container starts once and records its configuration revision',async()=>{
  for(const running of [false,true]){
    const storage=new MemoryStorage();const container=new FakeContainer(running);let starts=0;
    await ensureContainerRevision(container,storage,'release-new',()=>{starts++;container.running=true;},async()=>{});
    assert.deepEqual(container.calls,running?['destroy:Worker deployment changed']:[]);
    assert.equal(starts,1);assert.equal(container.running,true);
    assert.equal(await storage.get('containerDeploymentRevision'),'release-new');
  }
});

test('a failed container destroy does not start or record a new revision',async()=>{
  const storage=new MemoryStorage();await storage.put('containerDeploymentRevision','release-a');
  const container=new FakeContainer(true);container.destroy=async()=>{throw new Error('destroy failed');};let starts=0;
  await assert.rejects(ensureContainerRevision(container,storage,'release-b',()=>{starts++;},async()=>{}),/destroy failed/);
  assert.equal(starts,0);assert.equal(await storage.get('containerDeploymentRevision'),'release-a');
});

test('a failed startup does not mark the new deployment as ready',async()=>{
  const storage=new MemoryStorage();await storage.put('containerDeploymentRevision','release-a');
  const container=new FakeContainer(true);
  await assert.rejects(ensureContainerRevision(container,storage,'release-b',()=>{container.running=true;},async()=>{throw new Error('not ready');}),/not ready/);
  assert.equal(await storage.get('containerDeploymentRevision'),'release-a');
});
