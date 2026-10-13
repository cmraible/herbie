import test from 'node:test';
import assert from 'node:assert/strict';
import {sortRepositories} from '../src/repositories.js';

test('repository names sort case-insensitively with deterministic ties across refresh order',()=>{
  const names=['zebra/App','alpha/zebra','Beta/repo','alpha/Repo','Alpha/repo','alpha/apple'];
  const repos=names.map(fullName=>({fullName,defaultBranch:'main',installationId:1}));
  const expected=['alpha/apple','Alpha/repo','alpha/Repo','alpha/zebra','Beta/repo','zebra/App'];
  assert.deepEqual(sortRepositories(repos).map(repo=>repo.fullName),expected);
  assert.deepEqual(sortRepositories([...repos].reverse()).map(repo=>repo.fullName),expected);
  assert.deepEqual(repos.map(repo=>repo.fullName),names);
});
