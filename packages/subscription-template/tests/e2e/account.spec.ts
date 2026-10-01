import { test, expect } from "@playwright/test";
import { register, signIn, createWorkspace, password } from "./helpers";
test("sign-in waits for JavaScript initialization before accepting interaction", async ({
  page,
}) => {
  const ready = Promise.withResolvers<void>();
  await page.route("**/assets/*.js", async (route) => {
    await ready.promise;
    await route.continue();
  });
  try {
    await page.goto("/", { waitUntil: "commit" });
    const submit = page.locator('#account-form button[type="submit"]');
    await expect(submit).toBeVisible();
    await expect(submit.click({ trial: true, timeout: 500 })).rejects.toThrow(/Timeout/);
  } finally {
    ready.resolve();
  }
  await signIn(page, "missing-" + crypto.randomUUID() + "@example.test");
  await expect(page.getByRole("alert")).not.toBeEmpty();
  expect(new URL(page.url()).search).toBe("");
});
test("verified owner creates a workspace and retains it after signing out and back in", async ({
  page,
}) => {
  const email = await register(page, "Alice");
  const document = await page.request.get("/");
  expect(document.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(document.headers()["x-content-type-options"]).toBe("nosniff");
  expect(
    (
      await page.request.post("/api/auth/organization/create", {
        headers: { origin: "http://localhost:8790" },
        data: { name: "", slug: crypto.randomUUID() },
      })
    ).status(),
  ).toBe(404);
  await createWorkspace(page, "Studio");
  await expect(page.getByText("Your role: owner")).toBeVisible();
  const oldCookie = (await page.context().cookies())
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  expect((await page.request.get("/api/workspaces")).status()).toBe(401);
  expect(
    (await page.request.get("/api/account", { headers: { cookie: oldCookie } })).status(),
  ).toBe(401);
  await signIn(page, email);
  await expect(page.getByRole("heading", { name: "Studio", exact: true })).toBeVisible();
});
test("unverified signup cannot create a workspace and cross-origin writes are rejected", async ({
  page,
}) => {
  await page.goto("/");
  const email = "unverified-" + crypto.randomUUID() + "@example.test";
  const signup = await page.request.post("/api/auth/sign-up/email", {
    headers: { origin: "http://localhost:8790" },
    data: { name: "Unverified", email, password },
  });
  expect(signup.ok()).toBe(true);
  expect(
    (
      await page.request.post("/api/workspaces", {
        headers: { origin: "http://localhost:8790" },
        data: { name: "No access" },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await page.request.post("/api/workspaces", {
        headers: { origin: "https://other.test" },
        data: { name: "No access" },
      })
    ).status(),
  ).toBe(403);
});
