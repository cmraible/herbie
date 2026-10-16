import { test, expect } from "@playwright/test";

test("an existing installation prompts for required permissions and recovers after approval", async ({
  page,
}) => {
  let approved = false;
  const json = (body: unknown) => ({ contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/health", (r) => r.fulfill(json({ mode: "live" })));
  await page.route("**/api/session", (r) =>
    r.fulfill(json({ mode: "live", user: { id: "fixture", login: "fixture" } })),
  );
  await page.route("**/api/goals", (r) => r.fulfill(json([])));
  await page.route("**/api/repositories", (r) =>
    r.fulfill(
      approved
        ? json([{ fullName: "fixture/project", defaultBranch: "main", installationId: 11 }])
        : {
            ...json({ repositories: [], permissionsRequired: true }),
          },
    ),
  );
  await page.route("**/api/auth/install/start", (r) =>
    r.fulfill(json({ url: "https://github.com/apps/fixture/installations/new?state=fixture" })),
  );
  await page.route("https://github.com/apps/fixture/installations/new?state=fixture", (r) =>
    r.fulfill({ contentType: "text/html", body: "Approve permissions fixture" }),
  );
  await page.goto("/");
  const prompt = page.getByRole("alert").filter({ hasText: "installation permissions" });
  await expect(prompt).toContainText("Workflows write");
  await prompt.getByRole("button", { name: "Update GitHub permissions" }).click();
  await expect(page).toHaveURL(/github.com\/apps\/fixture\/installations\/new/);
  await page.goto("/");
  await expect(prompt).toBeVisible();
  approved = true;
  await prompt.getByRole("button", { name: "Check again" }).click();
  await expect(prompt).toHaveCount(0);
  approved = false;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(prompt).toBeVisible();
});
