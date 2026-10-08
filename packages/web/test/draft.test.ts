import test from 'node:test';
import assert from 'node:assert/strict';
import { newDraft, parseDraft } from '../src/draft.js';

test('a new goal form passes literal arguments through the shared contract', () => {
  const draft = {...newDraft('demo/example'),prompt:'Add regression coverage',test:'["node","--test","literal; $(whoami)"]',maxAttempts:'2'};
  assert.deepEqual(parseDraft(draft), {repository:'demo/example',prompt:'Add regression coverage',testCommand:['node','--test','literal; $(whoami)'],maxAttempts:2});
});

test('a form cannot create unbounded attempts or a shell command string', () => {
  const draft = {...newDraft('demo/example'),prompt:'Add regression coverage'};
  assert.throws(() => parseDraft({...draft,maxAttempts:'6'}), /maxAttempts/);
  assert.throws(() => parseDraft({...draft,test:'npm test'}), /JSON array/);
  assert.throws(() => parseDraft({...draft,test:'"npm test"'}), /testCommand/);
});
