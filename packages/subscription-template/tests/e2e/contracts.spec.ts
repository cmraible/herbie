import { test, expect } from "@playwright/test";
import { register, createWorkspace } from "./helpers";
import { WorkspaceList } from "../../src/contracts";
test("public endpoints and team resources reject undocumented methods and path aliases", async ({
  page,
}) => {
  const headers = { origin: "http://localhost:8790" };
  for (const path of ["/health", "/ready", "/api/config"]) {
    expect((await page.request.get(path)).status()).toBe(200);
    expect((await page.request.post(path, { headers, data: {} })).status()).toBe(405);
  }
  await register(page, "Contract owner");
  await createWorkspace(page, "Contract team");
  const workspace = WorkspaceList.parse(
    await (await page.request.get("/api/workspaces")).json(),
  )[0];
  if (!workspace) throw new Error("Missing workspace");
  expect(
    (await page.request.get(`/api/workspaces/${workspace.id}/members/not-a-list`)).status(),
  ).toBe(405);
  expect(
    (
      await page.request.post(`/api/workspaces/${workspace.id}/invitations/not-a-create`, {
        headers,
        data: { email: "unused@example.test", role: "member" },
      })
    ).status(),
  ).toBe(405);
});

test("API input and authority failures use the published JSON contracts without mutating workspaces", async ({
  page,
  request,
}) => {
  const { ErrorBody, Members } = await import("../../src/contracts");
  const headers = { origin: "http://localhost:8790", "Content-Type": "application/json" };
  const anonymous = await request.get("/api/workspaces");
  expect(anonymous.status()).toBe(401);
  expect(ErrorBody.parse(await anonymous.json()).error).toBe("Sign in required");
  const blocked = await request.post("/api/auth/sign-in/email", {
    headers: { origin: "https://other.test" },
    data: {},
  });
  expect(blocked.status()).toBe(403);
  expect(ErrorBody.parse(await blocked.json()).error).toBe("Origin rejected");
  await register(page, "Boundary owner");
  for (const data of [
    "{",
    JSON.stringify({ name: "Valid name", role: "owner" }),
    JSON.stringify({ name: " ".repeat(10) }),
  ]) {
    const result = await page.request.post("/api/workspaces", { headers, data });
    expect(result.status()).toBe(400);
    expect(ErrorBody.parse(await result.json()).error).toMatch(/^Invalid (JSON|request)$/);
    expect(result.headers()["cache-control"]).toBe("no-store");
  }
  expect(WorkspaceList.parse(await (await page.request.get("/api/workspaces")).json())).toEqual([]);
  await createWorkspace(page, "Boundary team");
  const workspace = WorkspaceList.parse(
    await (await page.request.get("/api/workspaces")).json(),
  )[0];
  if (!workspace) throw new Error("Missing workspace");
  const base = `/api/workspaces/${workspace.id}`;
  for (const method of ["PATCH", "DELETE"]) {
    const missing = await page.request.fetch(base + "/members/missing", {
      method,
      headers,
      data: method === "PATCH" ? { role: "member" } : undefined,
    });
    expect(missing.status()).toBe(404);
    expect(ErrorBody.parse(await missing.json()).error).toBe("Member not found");
  }
  expect(Members.parse(await (await page.request.get(base + "/members")).json())).toHaveLength(1);
  for (const action of ["checkout", "portal", "refresh"]) {
    const injected = await page.request.post(base + "/billing/" + action, {
      headers,
      data: { price: "price_unapproved" },
    });
    expect(injected.status()).toBe(400);
    ErrorBody.parse(await injected.json());
  }
  const unknown = await page.request.get("/api/no-such-resource");
  expect(unknown.status()).toBe(404);
  expect(ErrorBody.parse(await unknown.json()).error).toBe("Not found");
});
