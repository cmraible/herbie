import assert from 'node:assert/strict';
import test from 'node:test';
import {createGoalNamer} from '../src/goal-name.js';

const completion=(text:string)=>({status:'completed',output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text}]}]});

test('names summarize the prompt with a bounded server-side model request',async()=>{
  const prompt='Add validation to the signup form and cover invalid email addresses with tests.';
  const name=await createGoalNamer('fixture-key','fixture-model',async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(options?.method,'POST');
    assert.equal(new Headers(options?.headers).get('authorization'),'Bearer fixture-key');
    assert.ok(options?.signal instanceof AbortSignal);
    const body=JSON.parse(String(options?.body));
    assert.equal(body.model,'fixture-model');
    assert.equal(body.input,prompt);
    assert.equal(body.store,false);
    assert.equal(body.max_output_tokens,1024);
    return Response.json(completion('“Signup validation tests”'));
  })(prompt);
  assert.equal(name,'Signup validation tests');
});

test('missing credentials use the Unicode-safe fallback without calling a model',async()=>{
  const nameGoal=createGoalNamer(undefined,undefined,async()=>{throw new Error('Must not call fetch');});
  assert.equal(await nameGoal('[demo:fail] '+ '🥁'.repeat(150)),'🥁'.repeat(120));
  assert.equal(await nameGoal('[demo:fail]'),'Untitled goal');
});

test('failed, incomplete, empty, and invalid model responses preserve goal creation',async()=>{
  const responses=[
    new Response('private provider diagnostics',{status:429}),
    new Response('not JSON'),
    Response.json({status:'incomplete',output:[]}),
    Response.json(completion('   ')),
    Response.json(completion('x'.repeat(121))),
    Response.json(completion('one two three four five six seven')),
    Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}),
  ];
  for(const response of responses){
    assert.equal(await createGoalNamer('fixture-key',undefined,async()=>response)('Fix arithmetic'),'Fix arithmetic');
  }
  for(const error of [new Error('Network failure'),new DOMException('Timed out','TimeoutError')]){
    assert.equal(await createGoalNamer('fixture-key',undefined,async()=>{throw error;})('Fix arithmetic'),'Fix arithmetic');
  }
});
