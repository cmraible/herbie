import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAuthorizationClient } from '../src/adapters/github-onboarding.js';
test('GitHub discovery requires organization admin or personal ownership, correct app, active installation and matching repo owner',async()=>{
  const transport:typeof fetch=async(input,init)=>{
    const url=String(input);
    if(url.endsWith('/access_token')){assert.equal(JSON.parse(String(init?.body)).code_verifier,'verifier');return Response.json({access_token:'test-transient-token'});}
    if(url.endsWith('/user'))return Response.json({id:7});
    if(url.includes('/user/installations?'))return Response.json({installations:[
      {id:1,app_id:42,account:{id:10,login:'admin-org',type:'Organization'},suspended_at:null},
      {id:2,app_id:42,account:{id:20,login:'member-org',type:'Organization'},suspended_at:null},
      {id:3,app_id:99,account:{id:7,login:'wrong-app',type:'User'},suspended_at:null},
      {id:4,app_id:42,account:{id:7,login:'me',type:'User'},suspended_at:null},
    ]});
    if(url.endsWith('/admin-org'))return Response.json({role:'admin',state:'active'});
    if(url.endsWith('/member-org'))return Response.json({role:'member',state:'active'});
    if(url.includes('/installations/1/'))return Response.json({repositories:[{full_name:'admin-org/repo',owner:{id:10}},{full_name:'other/stolen',owner:{id:123}}]});
    if(url.includes('/installations/4/'))return Response.json({repositories:[{full_name:'me/repo',owner:{id:7}}]});
    throw new Error('Unexpected or unauthorized provider request');
  };
  const provider=new GitHubAuthorizationClient({clientId:'client',secret:'test',redirect:'https://app/auth/github/callback',appId:'42'},transport);
  const auth=new URL(provider.authorizationUrl('state','challenge'));assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
  assert.deepEqual((await provider.repositories('code','verifier')).map(g=>g.repo),['admin-org/repo','me/repo']);
});
test('GitHub missing organization authority reports the required app permission',async()=>{
  const provider=new GitHubAuthorizationClient({clientId:'client',secret:'test',redirect:'https://app/auth/github/callback',appId:'42'},async(input)=>{
    const url=String(input);
    if(url.endsWith('/access_token'))return Response.json({access_token:'test'});
    if(url.endsWith('/user'))return Response.json({id:7});
    if(url.includes('/user/installations?'))return Response.json({installations:[{id:1,app_id:42,account:{id:10,login:'org',type:'Organization'},suspended_at:null}]});
    return new Response('',{status:403});
  });
  await assert.rejects(provider.repositories('code','verifier'),/Members: read/);
});
