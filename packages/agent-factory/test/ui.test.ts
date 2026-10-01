import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { html, script } from '../src/cloudflare/ui.js';

// Run the shipped UI script against a minimal DOM and HTTP boundary.
function ui() {
  const nodes = new Map<string,any>();
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1],{hidden:match[1]!=='signin',disabled:false,value:'',textContent:'',replaceChildren(){},append(){}});
  let workspaces:unknown[]=[];
  let resolveCreate!:(response:Response)=>void;
  const calls:string[]=[];
  const context={document:{getElementById:(id:string)=>{assert.ok(nodes.has(id),'Unknown UI node: '+id);return nodes.get(id);},createElement:()=>({append(){}})},fetch:async(path:string,options?:{body?:string})=>{
    calls.push(path);
    if(path==='/api/onboarding/workspace') {
      assert.deepEqual(JSON.parse(options!.body!),{name:'My workspace'});
      return new Promise<Response>(resolve=>{resolveCreate=resolve;});
    }
    if(path==='/api/workspaces') return Response.json(workspaces);
    if(path.endsWith('/goals') || path.endsWith('/repositories')) return Response.json([]);
    throw new Error('Unexpected UI request: '+path);
  }};
  runInNewContext(script,context);
  return {nodes,calls,finish(ok:boolean){if(ok) workspaces=[{id:'private-test',name:'My workspace',role:'member'}];resolveCreate(Response.json(ok?{workspace:'private-test'}:{error:'Please retry'},{status:ok?200:503}));}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('workspace UI offers private creation, suppresses duplicate clicks and selects the created workspace',async()=>{
  const app=ui();await flush();
  assert.equal(app.nodes.get('onboarding').hidden,false);
  app.nodes.get('workspace-name').value='My workspace';
  const submit=()=>app.nodes.get('workspace-form').onsubmit({preventDefault(){}});
  const pending=submit();await submit();
  assert.equal(app.nodes.get('create-workspace').disabled,true);
  assert.equal(app.calls.filter(p=>p==='/api/onboarding/workspace').length,1);
  app.finish(true);await pending;
  assert.equal(app.nodes.get('workspace').value,'private-test');
  assert.equal(app.nodes.get('onboarding').hidden,true);
  assert.equal(app.nodes.get('workspace-content').hidden,false);
  assert.equal(app.nodes.get('create-workspace').disabled,false);
});
test('workspace UI displays a failed creation and allows a retry',async()=>{
  const app=ui();await flush();app.nodes.get('workspace-name').value='My workspace';
  const pending=app.nodes.get('workspace-form').onsubmit({preventDefault(){}});
  app.finish(false);await pending;
  assert.equal(app.nodes.get('error').textContent,'Please retry');
  assert.equal(app.nodes.get('onboarding').hidden,false);
  assert.equal(app.nodes.get('create-workspace').disabled,false);
});
