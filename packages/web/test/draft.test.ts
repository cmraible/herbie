import test from 'node:test';
import assert from 'node:assert/strict';
import { draftSchema, newDraft, parseDraft } from '../src/draft.js';

test('a new goal needs only a repository and prompt', () => {
  const draft = {...newDraft('demo/example'),prompt:'Add regression coverage'};
  assert.deepEqual(parseDraft(draft), {repository:'demo/example',prompt:'Add regression coverage'});
});

test('saved drafts from before test-command and attempt-limit removal still restore', () => {
  const draft = {...newDraft('demo/example'),prompt:'Fix arithmetic'};
  assert.deepEqual(draftSchema.parse({...draft,test:'["npm","test"]',maxAttempts:'2'}),draft);
});

test('legacy named drafts preserve the original request for idempotent retries', () => {
  const draft = {...newDraft('demo/example'),prompt:'Fix arithmetic'};
  const restored = draftSchema.parse({...draft,name:'Old custom name'});
  assert.equal(restored.requestId,draft.requestId);
  assert.deepEqual(parseDraft(restored),{repository:'demo/example',name:'Old custom name',prompt:'Fix arithmetic'});
});
