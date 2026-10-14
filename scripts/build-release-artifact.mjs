import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only public release metadata belongs in this artifact. The consumer must
// supply its private configuration as Flux Kustomization patches.
export function releaseResources(image, revision) {
  if (!/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Expected an immutable GHCR image');
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected a full source SHA');
  return [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'herbie-config' }, data: { HERBIE_DEPLOYMENT_ID: revision } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'herbie' }, spec: { template: { spec: { containers: [{ name: 'herbie', image }] } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'herbie' } },
    { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'herbie' } },
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [image, revision, output] = process.argv.slice(2);
  const resources = releaseResources(image, revision);
  // Require a new directory so unrelated local files cannot be uploaded.
  mkdirSync(output);
  writeFileSync(join(output, 'release.yaml'), resources.map(x => JSON.stringify(x, null, 2)).join('\n---\n') + '\n');
  writeFileSync(join(output, 'kustomization.yaml'), 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - release.yaml\n');
}
