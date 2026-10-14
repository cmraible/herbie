import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseResources } from './build-release-artifact.mjs';

test('release metadata contains only the image, revision and fixed resource identities', () => {
  const sha = 'a'.repeat(40);
  const image = 'ghcr.io/example/app@sha256:' + 'b'.repeat(64);
  const resources = releaseResources(image, sha);
  assert.equal(resources.length, 4);
  assert.deepEqual(resources[0].data, { HERBIE_DEPLOYMENT_ID: sha });
  assert.deepEqual(resources[1].spec, { template: { spec: { containers: [{ name: 'herbie', image }] } } });
  for (const resource of resources) assert.equal(resource.metadata.namespace, undefined);
  assert.equal(JSON.stringify(resources).includes('secret'), false);
});

test('reject mutable images, injected manifest content and invalid revisions', () => {
  const digest = 'ghcr.io/example/app@sha256:' + 'b'.repeat(64);
  for (const image of ['ghcr.io/example/app:latest', digest + '\nkind: Secret', 'https://example.test']) {
    assert.throws(() => releaseResources(image, 'a'.repeat(40)));
  }
  assert.throws(() => releaseResources(digest, 'main'));
});
