import assert from 'node:assert/strict';
import test from 'node:test';
import {z} from 'zod';
import {startupDiagnostic,StartupConfigurationError} from '../src/startup-diagnostic.js';
const canary='private-canary:password@private-canary-host.invalid/private-canary-project';
test('startup classification emits fixed categories from types and structured codes only',()=>{
  const validation=z.string().safeParse({secret:canary});assert.ok(!validation.success);
  for(const [error,category] of [
    [new StartupConfigurationError(),'configuration'],[validation.error,'configuration'],
    [Object.assign(new Error(canary),{code:'28P01'}),'database-authentication'],
    [Object.assign(new Error(canary),{code:'28000'}),'database-authentication'],
    [Object.assign(new Error(canary),{code:'SELF_SIGNED_CERT_IN_CHAIN'}),'tls'],
    [Object.assign(new Error(canary),{code:'ETIMEDOUT'}),'connection-timeout'],
    [new Error(canary,{cause:Object.assign(new Error(canary),{code:'CERT_HAS_EXPIRED'})}),'tls'],
    [Object.assign(new Error(canary+' password authentication failed ETIMEDOUT'),{code:canary}),'unknown'],
    [{code:'28P01',message:canary},'unknown'],
  ] as const){
    const result=startupDiagnostic(error);
    assert.equal(result,`Herbie startup diagnostic: category=${category}.`);
    assert.doesNotMatch(result,/private-canary|password@|28P01|ETIMEDOUT/);
  }
});
test('startup classification bounds cyclic error causes and stays unknown',()=>{
  const error=new Error(canary);error.cause=error;
  assert.equal(startupDiagnostic(error),'Herbie startup diagnostic: category=unknown.');
});
