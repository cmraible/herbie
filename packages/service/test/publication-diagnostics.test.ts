import assert from 'node:assert/strict';
import test from 'node:test';
import {PatchPublicationError} from '@herbie/loop/publish-patch';
import {GithubError} from '../src/github.js';
import {publicationDiagnostic,publicationDiagnosticMessage} from '../src/publication-diagnostics.js';
import {StoreError} from '../src/store.js';

test('publication diagnostics retain a safe publisher stage without exposing raw errors or repository identifiers',()=>{
  const error=new PatchPublicationError([new Error('Authorization: synthetic-secret')],{
    repository:'synthetic-owner/synthetic-project',branch:'herbie/synthetic-goal/synthetic-job',stage:'pushing',commit:'a'.repeat(40),
  });
  const diagnostic=publicationDiagnostic(error,'preflight_reconciliation');
  assert.deepEqual(diagnostic,{phase:'branch_push',cause:'git_push_uncertain'});
  const message=publicationDiagnosticMessage(diagnostic);
  assert.match(message,/branch_push/);
  assert.match(message,/git_push_uncertain/);
  assert.doesNotMatch(message,/synthetic|secret|Authorization/);
});

test('publication diagnostics classify safe GitHub status codes and network failures',()=>{
  assert.deepEqual(publicationDiagnostic(new GithubError(403,'private response text'),'preflight_reconciliation'),{phase:'preflight_reconciliation',cause:'github_forbidden'});
  assert.deepEqual(publicationDiagnostic(new GithubError(502,'private response text'),'installation_token'),{phase:'installation_token',cause:'github_unavailable'});
  assert.deepEqual(publicationDiagnostic(new TypeError('synthetic private URL'),'preflight_reconciliation'),{phase:'preflight_reconciliation',cause:'network_failure'});
  assert.doesNotMatch(publicationDiagnosticMessage(publicationDiagnostic(new GithubError(403,'private response text'),'preflight_reconciliation')),/private response/);
});

test('publication diagnostics classify lease conflicts without exposing database errors',()=>{
  const diagnostic=publicationDiagnostic(new StoreError(409,'private SQL details'),'state_persistence');
  assert.deepEqual(diagnostic,{phase:'state_persistence',cause:'lease_conflict'});
  assert.doesNotMatch(publicationDiagnosticMessage(diagnostic),/SQL details/);
});
