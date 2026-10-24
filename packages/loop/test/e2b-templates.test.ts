import assert from "node:assert/strict";
import test from "node:test";
import { Template, type TemplateClass, type BuildOptions } from "e2b";
import { setTimeout as delay } from "node:timers/promises";
import {
  createE2BTemplateApi,
  createE2BTemplateResolver,
  e2bTemplateName,
  type E2BTemplateApi,
} from "../src/e2b-templates.js";

const resources = { cpu: 4, memory: 8, disk: 10 };
const ids = { templateId: "template-id", buildId: "build-id" };
const pause = async () => {};
function unused(): never {
  throw new Error("Unexpected API call");
}

test("template identities track resource sizes and runtime base without embedding credentials", () => {
  const name = e2bTemplateName({}, resources);
  assert.match(name, /^herbie-runtime-[a-f0-9]{24}$/);
  assert.equal(name, e2bTemplateName({}, { disk: 10, memory: 8, cpu: 4 }));
  for (const key of ["cpu", "memory", "disk"] as const)
    assert.notEqual(name, e2bTemplateName({}, { ...resources, [key]: resources[key] + 1 }));
  assert.notEqual(name, e2bTemplateName({ template: "custom-base" }, resources));
  assert.notEqual(name, e2bTemplateName({}, resources, "apt-get install -y python3"));
  assert.notEqual(
    e2bTemplateName({}, resources, "echo first"),
    e2bTemplateName({}, resources, "echo second"),
  );
});

test("template builds use E2B's SDK and GiB conversions for both generated and existing bases", async (t) => {
  let calls = 0;
  const script = "echo setup-ready\n";
  const encoded = Buffer.from(script).toString("base64");
  t.mock.method(
    Template,
    "buildInBackground",
    async (template: TemplateClass, name: string, options?: Omit<BuildOptions, "alias">) => {
      calls++;
      assert.equal(name, "herbie-sized");
      assert.equal(options?.apiKey, "test-key");
      assert.equal(options?.cpuCount, 4);
      assert.equal(options?.memoryMB, 8192);
      assert.equal(options?.minFreeDiskMb, 10240);
      assert.equal(options?.requestTimeoutMs, 30_000);
      assert.ok(options?.signal);
      assert.equal(options?.skipCache, true);
      const recipe = await Template.toJSON(template, false);
      assert.ok(recipe.includes("dist-upgrade"));
      assert.ok(recipe.includes("20260816ubuntu0.24.04.1"));
      assert.ok(recipe.includes("node-v24.22.1"));
      assert.ok(recipe.includes("docker-ce=5:29.9.2"));
      assert.ok(recipe.indexOf("dist-upgrade") < recipe.indexOf("node-v24.22.1"));
      if (calls % 2 === 1) {
        assert.ok(recipe.includes("ubuntu:24.04"));
        assert.ok(recipe.includes("codex"));
      } else {
        assert.ok(recipe.includes("custom-base"));
      }
      if (calls > 2) {
        assert.ok(recipe.includes(encoded));
        assert.ok(recipe.includes("600s bash -euo pipefail"));
        assert.ok(recipe.includes("docker compose version"));
        if (calls === 3) assert.ok(recipe.indexOf("docker-ce=") < recipe.indexOf(encoded));
      }
      return { ...ids, name: "herbie-sized", alias: "herbie-sized", tags: [] };
    },
  );
  const signal = new AbortController().signal;
  await createE2BTemplateApi({ apiKey: "test-key" }).build("herbie-sized", resources, signal);
  await createE2BTemplateApi({ apiKey: "test-key", template: "custom-base" }).build(
    "herbie-sized",
    resources,
    signal,
  );
  for (const template of [undefined, "custom-base"])
    await createE2BTemplateApi({ apiKey: "test-key", template }).build(
      "herbie-sized",
      resources,
      signal,
      script,
    );
  assert.equal(calls, 4);
});

test("E2B template lookup distinguishes absence, API failures, and unfinished builds", async () => {
  let code = 404;
  const paths: string[] = [];
  const http = {
    GET: async (
      path: string,
      options: { params: { path: Record<string, string> }; signal: AbortSignal },
    ) => {
      paths.push(path);
      assert.ok(options.signal);
      if (path.includes("aliases")) {
        assert.equal(options.params.path.alias, "herbie-test");
        return {
          response: new Response(null, { status: code }),
          data: code === 200 ? { templateID: "found" } : undefined,
        };
      }
      assert.equal(options.params.path.templateID, "found");
      return {
        response: new Response(),
        data: {
          builds: [
            { buildID: "old", status: "ready", createdAt: "2026-01-01T00:00:00Z" },
            { buildID: "new", status: "building", createdAt: "2026-02-01T00:00:00Z" },
          ],
        },
      };
    },
  };
  const api = createE2BTemplateApi({ apiKey: "test-key" }, http as never);
  const signal = new AbortController().signal;
  assert.equal(await api.lookup("herbie-test", signal), null);
  assert.equal(paths.length, 1);
  code = 403;
  await assert.rejects(api.lookup("herbie-test", signal), /Could not look up/);
  code = 200;
  assert.deepEqual(await api.lookup("herbie-test", signal), {
    templateId: "found",
    buildId: "new",
    status: "building",
  });
});

test("template preparation times out without leaving an immortal poll loop", async () => {
  const resolve = createE2BTemplateResolver(
    { apiKey: "timeout" },
    {
      lookup: async () => ({ ...ids, status: "building" }),
      build: unused,
      status: unused,
    },
    (signal) => delay(1000, undefined, { signal }),
    10,
  );
  await assert.rejects(resolve(resources), { name: "AbortError" });
});

test("missing templates build once across provider instances and are reused from E2B", async () => {
  let builds = 0;
  let ready = false;
  let polls = 0;
  const api: E2BTemplateApi = {
    lookup: async () => (ready ? { ...ids, status: "ready" } : null),
    build: async (_, requested) => {
      builds++;
      assert.deepEqual(requested, resources);
      return ids;
    },
    status: async () => {
      polls++;
      ready = true;
      return "ready";
    },
  };
  const config = { apiKey: "coalesced" };
  const first = createE2BTemplateResolver(config, api, pause);
  const second = createE2BTemplateResolver(config, api, pause);
  const names = await Promise.all([first(resources), second(resources)]);
  assert.equal(names[0], names[1]);
  assert.equal(builds, 1);
  assert.equal(polls, 1);
  // A fresh resolver consults persisted E2B state rather than an in-memory success cache.
  assert.equal(await createE2BTemplateResolver(config, api, pause)(resources), names[0]);
  assert.equal(builds, 1);
});

test("a build already running in E2B is resumed without provisioning another template", async () => {
  let polls = 0;
  const resolve = createE2BTemplateResolver(
    { apiKey: "resume" },
    {
      lookup: async () => ({ ...ids, status: "building" }),
      build: unused,
      status: async (build) => {
        assert.equal(build.buildId, ids.buildId);
        return ++polls === 1 ? "waiting" : "ready";
      },
    },
    pause,
  );
  await resolve(resources);
  assert.equal(polls, 2);
});

test("failed builds propagate and can be retried without poisoning the cache", async () => {
  let failed = false;
  let builds = 0;
  const resolve = createE2BTemplateResolver(
    { apiKey: "failed" },
    {
      lookup: async () => (failed ? { ...ids, status: "error" } : null),
      build: async () => {
        builds++;
        return ids;
      },
      status: async () => {
        if (!failed) {
          failed = true;
          return "error";
        }
        return "ready";
      },
    },
    pause,
  );
  await assert.rejects(resolve(resources), /template build failed/);
  await resolve(resources);
  assert.equal(builds, 2);
});

test("lookup failures never trigger a speculative paid build", async () => {
  const resolve = createE2BTemplateResolver(
    { apiKey: "offline" },
    {
      lookup: async () => {
        throw new Error("lookup offline");
      },
      build: unused,
      status: unused,
    },
    pause,
  );
  await assert.rejects(resolve(resources), /lookup offline/);
});

test("a concurrent coordinator registering a template is recovered by looking up its build", async () => {
  let lookups = 0;
  const resolve = createE2BTemplateResolver(
    { apiKey: "racing" },
    {
      lookup: async () => (++lookups === 1 ? null : { ...ids, status: "building" }),
      build: async () => {
        throw new Error("alias registered concurrently");
      },
      status: async () => "ready",
    },
    pause,
  );
  await resolve(resources);
  assert.equal(lookups, 2);
});

test("cancelling one waiter leaves another waiter able to finish the shared template", async () => {
  const controller = new AbortController();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const resolve = createE2BTemplateResolver(
    { apiKey: "cancelled" },
    {
      lookup: async () => null,
      build: async () => ids,
      status: async () => {
        await gate;
        return "ready";
      },
    },
    pause,
  );
  const cancelled = resolve(resources, controller.signal);
  const continuing = resolve(resources);
  controller.abort(new Error("Attempt stopped"));
  await assert.rejects(cancelled, /Attempt stopped/);
  finish();
  await continuing;
});

test("accounts do not share builds and invalid or cancelled requests make no API calls", async () => {
  let builds = 0;
  const api: E2BTemplateApi = {
    lookup: async () => null,
    build: async () => {
      builds++;
      return ids;
    },
    status: async () => "ready",
  };
  await Promise.all(
    ["account-a", "account-b"].map((apiKey) =>
      createE2BTemplateResolver({ apiKey }, api, pause)(resources),
    ),
  );
  assert.equal(builds, 2);
  const resolve = createE2BTemplateResolver(
    { apiKey: "invalid" },
    { lookup: unused, build: unused, status: unused },
    pause,
  );
  await assert.rejects(resolve({ ...resources, cpu: 0 }), /positive whole/);
  await assert.rejects(resolve({ ...resources, memory: 1.5 }), /positive whole/);
  await assert.rejects(resolve(resources, AbortSignal.abort(new Error("Stopped"))), /Stopped/);
});

test("different setup scripts build separately while identical scripts share and reuse a template", async () => {
  const ready = new Set<string>();
  const scripts: string[] = [];
  const resolve = createE2BTemplateResolver(
    { apiKey: "script-cache" },
    {
      lookup: async (name) => (ready.has(name) ? { ...ids, status: "ready" } : null),
      build: async (name, _resources, _signal, script) => {
        scripts.push(script!);
        ready.add(name);
        return ids;
      },
      status: async () => "ready",
    },
    pause,
  );
  const first = "apt-get install -y python3";
  const second = "apt-get install -y ruby";
  const names = await Promise.all([
    resolve(resources, undefined, first),
    resolve(resources, undefined, first),
    resolve(resources, undefined, second),
  ]);
  assert.equal(names[0], names[1]);
  assert.notEqual(names[0], names[2]);
  assert.deepEqual(scripts.sort(), [first, second].sort());
  assert.equal(await resolve(resources, undefined, first), names[0]);
  assert.equal(scripts.length, 2);
});
