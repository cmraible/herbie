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

test('empty credentials fail when constructing the namer',()=>{
  for(const key of ['', '   '])assert.throws(()=>createGoalNamer(key),/OPENAI_API_KEY is required/);
});

test('the default naming model uses the supported Luna model',async()=>{
  assert.equal(await createGoalNamer('fixture-key',undefined,async(_url,options)=>{
    assert.equal(JSON.parse(String(options?.body)).model,'gpt-6-luna');
    return Response.json(completion('Improve signup validation'));
  })('Improve the signup form'),'Improve signup validation');
});

test('failed, incomplete, empty, and invalid model responses reject naming',async()=>{
  const responses=[
    new Response('private provider diagnostics',{status:429}),
    new Response('not JSON'),
    Response.json({status:'incomplete',output:[]}),
    Response.json(completion('   ')),
    Response.json(completion('Refactor')),
    Response.json(completion('Fix signup')),
    Response.json(completion('x'.repeat(121))),
    Response.json(completion('one two three four five six seven')),
    Response.json({status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}),
  ];
  for(const response of responses){
    await assert.rejects(createGoalNamer('fixture-key',undefined,async()=>response)('Fix arithmetic'));
  }
  for(const error of [new Error('Network failure'),new DOMException('Timed out','TimeoutError')]){
    await assert.rejects(createGoalNamer('fixture-key',undefined,async()=>{throw error;})('Fix arithmetic'),error);
  }
});
