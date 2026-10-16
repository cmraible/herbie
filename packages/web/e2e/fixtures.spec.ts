import { test, expect } from "@playwright/test";

test("fixture preview uses production UI and supports local edits", async ({ page }) => {
  test.skip(process.env.HERBIE_UI_FIXTURES !== "1", "Requires preview:ui");
  await page.setViewportSize({ width: 796, height: 824 });
  await page.goto("/#00000000-0000-4000-8000-000000000001");
  await expect(page.getByRole("heading", { name: "Make signup errors helpful" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText(
    "acme/storefront",
  );
  await expect(page.getByRole("button", { name: "Run 3 Ready for review" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("link", { name: "Review on GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/acme/storefront/pull/148",
  );
  await expect(page.getByText(/demo|simulat/i)).toHaveCount(0);
  await page.screenshot({ path: "test-results/fixtures-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Run 2 Failed" }).click();
  await expect(page.getByText("Run failed. No patches were saved.")).toBeVisible();
  await expect(
    page.getByText("The integration suite could not connect to its test database.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "All projects" }).click();
  await page.goto("/#00000000-0000-4000-8000-000000000002");
  await page.getByRole("button", { name: "Project actions" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Project name", { exact: true }).fill("Reduce search latency");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { name: "Reduce search latency" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Reduce search latency" })).toBeVisible();
  await page.getByRole("button", { name: "Project actions" }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".detail-heading .badge")).toHaveText("Paused");
  await page.getByRole("button", { name: "All projects" }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page.getByText(/demo|simulat/i)).toHaveCount(0);
  await page.getByLabel("What should Herbie work on?").fill("Add sorting to the product grid.");
  await page.getByRole("button", { name: "Start project" }).click();
  await expect(
    page.getByRole("heading", { name: "Add sorting to the product grid" }),
  ).toBeVisible();
  await expect(page.locator(".detail-heading .badge")).toHaveText("Queued");
});
