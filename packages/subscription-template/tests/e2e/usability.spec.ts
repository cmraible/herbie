import { test, expect } from "@playwright/test";
import { register } from "./helpers";
import { WorkspaceList } from "../../src/contracts";

test("keyboard retries and repeated submits create one workspace and clear resolved errors", async ({
  page,
}) => {
  await register(page, "Keyboard user");
  const name = page.getByLabel("Workspace name", { exact: true });
  await name.fill("   ");
  await name.press("Enter");
  await expect(page.getByRole("alert")).not.toBeEmpty();
  const release = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  await page.route("**/api/workspaces", async (route) => {
    if (route.request().method() === "POST") {
      arrived.resolve();
      await release.promise;
    }
    await route.continue();
  });
  try {
    await name.fill("One workspace");
    await name.press("Enter");
    await arrived.promise;
    await expect(
      page.getByRole("button", { name: "Create workspace", exact: true }),
    ).toBeDisabled();
    await name.press("Enter");
  } finally {
    release.resolve();
  }
  await expect(page.getByRole("heading", { name: "One workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toBeEmpty();
  expect(
    WorkspaceList.parse(await (await page.request.get("/api/workspaces")).json()),
  ).toHaveLength(1);
});

test("mobile workspace controls remain inside the viewport", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, "Mobile keyboard user");
  await page.getByLabel("Workspace name", { exact: true }).fill("Mobile workspace");
  await page.getByLabel("Workspace name", { exact: true }).press("Enter");
  await expect(page.getByRole("heading", { name: "Mobile workspace", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
