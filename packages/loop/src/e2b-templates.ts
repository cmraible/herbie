import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  ApiClient,
  ConnectionConfig,
  Template,
  type BuildInfo,
  type TemplateBuildStatus,
} from "e2b";
import { installEnvironmentRuntime } from "./environment-runtime.js";

type Resources = { cpu: number; memory: number; disk: number };
type Build = Pick<BuildInfo, "templateId" | "buildId"> & { status: TemplateBuildStatus };
type Config = { apiKey: string; template?: string };
export interface E2BTemplateApi {
  lookup(name: string, signal: AbortSignal): Promise<Build | null>;
  build(
    name: string,
    resources: Resources,
    signal: AbortSignal,
  ): Promise<Pick<Build, "templateId" | "buildId">>;
  status(
    build: Pick<Build, "templateId" | "buildId">,
    signal: AbortSignal,
  ): Promise<TemplateBuildStatus>;
}

export function e2bTemplateName(config: Pick<Config, "template">, resources: Resources) {
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        1,
        config.template ?? "ubuntu:22.04",
        installEnvironmentRuntime,
        resources.cpu,
        resources.memory,
        resources.disk,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `herbie-runtime-${version}`;
}

export function createE2BTemplateApi(
  config: Config,
  http?: Pick<ApiClient["api"], "GET">,
): E2BTemplateApi {
  const options = { apiKey: config.apiKey, requestTimeoutMs: 30_000 };
  const connection = new ConnectionConfig(options);
  const client = http ?? new ApiClient(connection).api;
  return {
    async lookup(name, signal) {
      const alias = await client.GET("/templates/aliases/{alias}", {
        params: { path: { alias: name } },
        signal: connection.getSignal(undefined, signal),
      });
      if (alias.response.status === 404) return null;
      if (!alias.data) throw new Error("Could not look up the E2B runtime template.");
      const templateId = alias.data.templateID;
      const result = await client.GET("/templates/{templateID}", {
        params: { path: { templateID: templateId }, query: { limit: 100 } },
        signal: connection.getSignal(undefined, signal),
      });
      if (!result.data) throw new Error("Could not read E2B runtime template builds.");
      const latest = result.data.builds.sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      )[0];
      return latest ? { templateId, buildId: latest.buildID, status: latest.status } : null;
    },
    build: (name, resources, signal) =>
      Template.buildInBackground(
        config.template
          ? Template().fromTemplate(config.template).setUser("root")
          : Template().fromImage("ubuntu:22.04").setUser("root").runCmd(installEnvironmentRuntime),
        name,
        {
          ...options,
          signal,
          cpuCount: resources.cpu,
          memoryMB: resources.memory * 1024,
          minFreeDiskMb: resources.disk * 1024,
        },
      ),
    status: async (build, signal) =>
      (await Template.getBuildStatus(build, { ...options, signal })).status,
  };
}

// Providers are instantiated per attempt. Coalesce builds across those instances,
// while keeping each account's templates and credentials separate.
const pending = new Map<string, Promise<string>>();
function observe<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createE2BTemplateResolver(
  config: Config,
  api: E2BTemplateApi = createE2BTemplateApi(config),
  pause: (signal: AbortSignal) => Promise<void> = (signal) => delay(2000, undefined, { signal }),
  waitTimeoutMs = 15 * 60_000,
) {
  return async (resources: Resources, signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    for (const value of Object.values(resources))
      if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(value * 1024))
        throw new Error("E2B resources must be positive whole numbers in cores and GiB.");
    const name = e2bTemplateName(config, resources);
    const key = createHash("sha256").update(config.apiKey).update(name).digest("hex");
    let work = pending.get(key);
    if (!work) {
      work = (async () => {
        // This bounds template preparation separately from the sandbox lifetime.
        const buildSignal = AbortSignal.timeout(waitTimeoutMs);
        let build = await api.lookup(name, buildSignal);
        if (!build || build.status === "error") {
          try {
            build = { ...(await api.build(name, resources, buildSignal)), status: "building" };
          } catch (error) {
            // Another coordinator may have registered the same template name.
            build = await api.lookup(name, buildSignal);
            if (!build || build.status === "error") throw error;
          }
        }
        while (build.status !== "ready") {
          buildSignal.throwIfAborted();
          if (build.status === "error") throw new Error("E2B runtime template build failed.");
          await pause(buildSignal);
          build.status = await api.status(build, buildSignal);
        }
        return name;
      })();
      pending.set(key, work);
      void work
        .finally(() => {
          if (pending.get(key) === work) pending.delete(key);
        })
        .catch(() => {});
    }
    // Cancelling one attempt must not cancel a template needed by other projects.
    return observe(work, signal);
  };
}
