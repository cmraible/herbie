import { expect, test } from "@playwright/test";

const baseUrl = process.env.HERBIE_E2E_URL ?? "http://127.0.0.1:8787";

test("repository setup runs during onboarding, refreshes access, and survives Back navigation", async ({
  page,
}) => {
  let connected = false;
  let signedIn = false;
  let repositoryRequests = 0;
  let reportInstallStart!: () => void;
  const installStarted = new Promise<void>((resolve) => {
    reportInstallStart = resolve;
  });
  let releaseInstallStart!: () => void;
  const installStartGate = new Promise<void>((resolve) => {
    releaseInstallStart = resolve;
  });
  await page.route("**/api/health", (route) => route.fulfill({ json: { mode: "live" } }));
  await page.route("**/api/session", (route) =>
    signedIn
      ? route.fulfill({ json: { user: { id: "7", login: "fixture-owner" }, mode: "live" } })
      : route.fulfill({ status: 401, json: { error: "Sign in required" } }),
  );
  await page.route("**/api/goals", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/repositories", (route) => {
    repositoryRequests++;
    return route.fulfill({
      json: connected
        ? [{ fullName: "public-sample/project", defaultBranch: "main", installationId: 11 }]
        : [],
    });
  });
  await page.route("**/api/auth/start", (route) =>
    route.fulfill({ json: { url: `${baseUrl}/fake/github-oauth` } }),
  );
  await page.route("**/fake/github-oauth", (route) => {
    signedIn = true;
    return route.fulfill({
      contentType: "text/html",
      body: `<script>location.replace(${JSON.stringify(baseUrl)})</script>`,
    });
  });
  await page.route("**/api/auth/install/start", async (route) => {
    reportInstallStart();
    await installStartGate;
    return route.fulfill({
      json: { url: `${baseUrl}/fake/github-installation?state=synthetic-state` },
    });
  });
  await page.route("**/fake/github-installation**", async (route) => {
    connected = true;
    await route.fulfill({
      contentType: "text/html",
      body: `<script>location.replace(${JSON.stringify(`${baseUrl}/?installation=connected`)})</script>`,
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await installStarted;
  await expect(page.getByRole("heading", { name: "Goals", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect repositories" })).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
  );
  await expect(page.getByRole("button", { name: "Sign out" }).first()).toBeEnabled();
  await expect(page.getByRole("button", { name: "New goal", exact: true })).toBeEnabled();
  releaseInstallStart();
  await expect(
    page.getByText("GitHub connected. Repositories are refreshing.", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(`${baseUrl}/`);
  expect(repositoryRequests).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "New goal", exact: true }).click();
  await expect(page.locator(".repository-select__single-value")).toHaveText(
    "public-sample / project",
  );
  await expect(page.getByRole("button", { name: "Add repositories" })).toBeVisible();
  await page.getByRole("button", { name: "Back to goals" }).click();

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Goals", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Goals", exact: true })).toBeVisible();
  await expect.poll(() => repositoryRequests).toBeGreaterThanOrEqual(3);
  await expect(page.getByRole("button", { name: "Connect repositories" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" }).first()).toBeEnabled();
  await page.getByRole("button", { name: "New goal", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to goals" })).toBeEnabled();
  await expect(page.locator(".repository-select__single-value")).toHaveText(
    "public-sample / project",
  );
});
