import { randomUUID } from "node:crypto";
import type { EnvironmentResources } from "@herbie/contracts";

type State = "building" | "ready" | "failed";
interface Preparation {
  id: string;
  owner: string;
  repository: string;
  resources: EnvironmentResources | null;
  setupScript: string;
  state: State;
  expires: number;
}
export function sameEnvironment(a: EnvironmentResources | null, b: EnvironmentResources | null) {
  return a === null || b === null
    ? a === b
    : a.cpu === b.cpu && a.memory === b.memory && a.disk === b.disk;
}

// Projects are persisted only after preparation. E2B retains the actual build
// state, so retrying after a service restart can reconnect to an existing build.
export function createEnvironmentPreparations(
  prepare:
    | ((resources: EnvironmentResources | null, setupScript?: string) => Promise<void>)
    | undefined,
  reportFailure: (error: unknown) => void,
) {
  const items = new Map<string, Preparation>();
  const get = (id: string, owner: string) => {
    const item = items.get(id);
    return item?.owner === owner && item.expires > Date.now() ? item : undefined;
  };
  return {
    get,
    start(
      owner: string,
      repository: string,
      resources: EnvironmentResources | null,
      setupScript = "",
    ) {
      for (const [id, item] of items) if (item.expires <= Date.now()) items.delete(id);
      // Repeated requests from the same owner share preparation while it runs.
      const existing = [...items.values()].find(
        (item) =>
          item.owner === owner &&
          item.repository === repository &&
          sameEnvironment(item.resources, resources) &&
          item.setupScript === setupScript &&
          item.state !== "failed",
      );
      if (existing) return existing;
      const item: Preparation = {
        id: randomUUID(),
        owner,
        repository,
        resources,
        setupScript,
        state: prepare ? "building" : "ready",
        expires: Date.now() + 20 * 60_000,
      };
      items.set(item.id, item);
      if (prepare)
        void Promise.resolve()
          .then(() => prepare(resources, setupScript))
          .then(
            () => {
              item.state = "ready";
            },
            (error) => {
              item.state = "failed";
              reportFailure(error);
            },
          );
      return item;
    },
    ready(
      id: string,
      owner: string,
      repository: string,
      resources: EnvironmentResources | null,
      setupScript = "",
    ) {
      const item = get(id, owner);
      return (
        item?.state === "ready" &&
        item.repository === repository &&
        item.setupScript === setupScript &&
        sameEnvironment(item.resources, resources)
      );
    },
  };
}
