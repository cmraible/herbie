import { afterEach, expect, test, vi } from "vitest";
import { management, reviewDatabase } from "../../scripts/hosting";
const parent = "abcdefghijklmnopqrst";
const name = "herbie-subscription-pr-12";
const branch = {
  project_ref: "previewbranchrefxxxxx",
  parent_project_ref: parent,
  name,
  is_default: false,
};
const details = {
  ref: branch.project_ref,
  status: "ACTIVE_HEALTHY",
  db_host: "db.previewbranchrefxxxxx.supabase.co",
  db_port: 5432,
  db_user: "postgres",
  db_pass: "fixture-only:@/password",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("a lost branch-creation response can be retried without creating a second branch or copying data", async () => {
  let created = false;
  let creates = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(request.headers.get("authorization")).toBe("Bearer fixture-management-token");
    const path = new URL(request.url).pathname;
    if (path === `/v1/projects/${parent}/branches`) {
      if (request.method === "GET") return Response.json(created ? [branch] : []);
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual({
        branch_name: name,
        persistent: false,
        with_data: false,
      });
      creates++;
      created = true;
      return new Response("provider-private-message", { status: 502 });
    }
    expect(path).toBe(`/v1/branches/${branch.project_ref}`);
    return Response.json(details);
  });
  const api = management("fixture-management-token");
  await expect(reviewDatabase(api, parent, name)).rejects.toThrow(
    "Supabase management operation failed (502)",
  );
  const connection = new URL(await reviewDatabase(api, parent, name));
  expect(connection.hostname).toBe(details.db_host);
  expect(decodeURIComponent(connection.password)).toBe(details.db_pass);
  expect(connection.searchParams.get("sslmode")).toBe("verify-full");
  expect(creates).toBe(1);
});

test("provisioning rejects a response for a different review name before reading credentials", async () => {
  const read = vi.fn(async (_path: string, method = "GET") =>
    method === "GET" ? [] : { ...branch, name: "herbie-subscription-pr-99" },
  );
  await expect(reviewDatabase(read, parent, name)).rejects.toThrow(
    "Invalid review branch response",
  );
  expect(read).toHaveBeenCalledTimes(2);
});

test("branch polling waits for credentials and rejects mismatched or failed branches", async () => {
  vi.useFakeTimers();
  let polls = 0;
  const read = async (path: string) => {
    if (path.endsWith("/branches")) return [branch];
    return ++polls === 1 ? { ...details, status: "INIT_IN_PROGRESS", db_pass: undefined } : details;
  };
  const ready = reviewDatabase(read, parent, name);
  await vi.advanceTimersByTimeAsync(10000);
  expect(new URL(await ready).hostname).toBe(details.db_host);
  expect(polls).toBe(2);
  for (const invalid of [
    { ...details, ref: parent },
    { ...details, status: "INIT_FAILED" },
  ]) {
    await expect(
      reviewDatabase(
        async (path) => (path.endsWith("/branches") ? [branch] : invalid),
        parent,
        name,
      ),
    ).rejects.toThrow();
  }
});

test("missing database credentials time out without resetting a password or deleting the branch", async () => {
  vi.useFakeTimers();
  const methods: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    methods.push(request.method);
    return Response.json(
      new URL(request.url).pathname.endsWith("/branches")
        ? [branch]
        : { ...details, db_pass: undefined },
    );
  });
  const pending = expect(reviewDatabase(management("fixture-token"), parent, name)).rejects.toThrow(
    "retry later using the same branch",
  );
  await vi.runAllTimersAsync();
  await pending;
  expect(new Set(methods)).toEqual(new Set(["GET"]));
});
