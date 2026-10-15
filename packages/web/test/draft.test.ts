import test from 'node:test';
import assert from 'node:assert/strict';
import { draftSchema, newDraft, parseDraft } from '../src/draft.js';

test('a new goal needs only a repository and prompt, with bounded attempts', () => {
  const draft = {...newDraft('demo/example'),prompt:'Add regression coverage',maxAttempts:'2'};
  assert.deepEqual(parseDraft(draft), {repository:'demo/example',prompt:'Add regression coverage',maxAttempts:2});
  assert.throws(() => parseDraft({...draft,maxAttempts:'6'}), /maxAttempts/);
});

test('saved drafts from before test-command removal still restore', () => {
  const draft = {...newDraft('demo/example'),prompt:'Fix arithmetic'};
  assert.deepEqual(draftSchema.parse({...draft,test:'["npm","test"]'}),draft);
});

test('names are trimmed and bounded while pre-name drafts still restore', () => {
  const draft = {...newDraft('demo/example'),prompt:'Fix arithmetic',name:'  Arithmetic cleanup  '};
  assert.equal(parseDraft(draft).name,'Arithmetic cleanup');
  assert.throws(() => parseDraft({...draft,name:'x'.repeat(121)}), /name/);
  const {name,...oldDraft} = draft;
  assert.equal(draftSchema.parse(oldDraft).name,'');
  assert.equal(parseDraft({...draft,name:'   '}).name,undefined);
});
