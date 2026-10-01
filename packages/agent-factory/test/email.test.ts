import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MailgunLoginEmail} from '../src/adapters/email.js';
test('Mailgun uses region-specific domain endpoint, sending-key auth, TLS and disabled tracking',async()=>{
 for(const region of ['us','eu']) {
  const transport:typeof fetch=async(url,init)=>{
   assert.equal(String(url),'https://'+(region==='eu'?'api.eu.mailgun.net':'api.mailgun.net')+'/v3/mail.company.example/messages');
   assert.equal(new Headers(init?.headers).get('authorization'),'Basic '+btoa('api:test-only-key'));
   const body=init?.body as FormData;
   for(const option of ['o:tracking','o:tracking-clicks','o:tracking-opens']) assert.equal(body.get(option),'no');
   assert.equal(body.get('o:require-tls'),'yes');assert.equal(body.get('to'),'person@company.example');
   assert.match(String(body.get('text')),/https:\/\/herbie.test\/magic/);return Response.json({id:'test'});
  };
  await new MailgunLoginEmail('test-only-key','mail.company.example',region,'Herbie <login@mail.company.example>',transport).send('person@company.example','https://herbie.test/magic');
 }
});
test('Mailgun rejects misconfiguration and sanitizes delivery failure without leaking provider content',async()=>{
 await assert.rejects(new MailgunLoginEmail('key','evil.example/path','us','from',async()=>{throw new Error('must not send');}).send('a@b.example','test'),/not configured/);
 await assert.rejects(new MailgunLoginEmail('key','mail.example','us','from',async()=>new Response('sensitive provider detail',{status:401})).send('a@b.example','test'),{message:'Email delivery failed'});
});
