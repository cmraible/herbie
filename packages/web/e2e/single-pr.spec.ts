import { test, expect } from "@playwright/test";

test("single PR creation persists the workflow and hides recurring controls", async ({ page }) => {
  test.skip(process.env.HERBIE_UI_FIXTURES !== "1", "Requires preview:ui");
  await page.goto("/#new");
  const workflow = page.getByRole("combobox", { name: /^Workflow/ });
  await workflow.selectOption("single_pr");
  await expect(page.getByRole("spinbutton", { name: "Target WIP" })).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "What should Herbie work on?" })
    .fill("Fix the signup ticket");
  await page.reload();
  await expect(workflow).toHaveValue("single_pr");
  await expect(page.getByRole("textbox", { name: "What should Herbie work on?" })).toHaveValue(
    "Fix the signup ticket",
  );
  const submission = page.waitForRequest(
    (request) => request.url().endsWith("/api/projects") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Create PR", exact: true }).click();
  const input = (await submission).postDataJSON();
  expect(input.workflow).toBe("single_pr");
  expect(input.targetWip).toBe(1);
  await expect(page).toHaveURL(/#[a-f0-9-]{36}$/);
  await expect(page.getByText("Single PR", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Project actions", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("spinbutton", { name: "Target WIP" })).toHaveCount(0);
  await expect(workflow).toHaveCount(0);
});
