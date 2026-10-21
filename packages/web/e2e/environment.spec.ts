import { test, expect } from "@playwright/test";

test("E2B accepts numeric resource settings without selecting a prebuilt size", async ({
  page,
}) => {
  test.skip(process.env.HERBIE_UI_FIXTURES !== "1", "Requires preview:ui");
  await page.route("**/api/environment-limits", (route) =>
    route.fulfill({
      json: { cpu: null, memory: null, disk: null },
    }),
  );
  const edit = "/#00000000-0000-4000-8000-000000000001/edit";
  await page.goto(edit);
  await page.getByRole("combobox", { name: "Sizing", exact: true }).selectOption("custom");
  const cpu = page.getByRole("spinbutton", { name: "CPU cores" });
  const memory = page.getByRole("spinbutton", { name: /^Memory/ });
  const disk = page.getByRole("spinbutton", { name: /^Disk/ });
  await expect(memory).not.toHaveAttribute("max");
  await cpu.fill("3");
  await memory.fill("7");
  await disk.fill("15");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/#00000000-0000-4000-8000-000000000001$/);
  await page.goto(edit);
  await page.reload();
  await expect(cpu).toHaveValue("3");
  await expect(memory).toHaveValue("7");
  await expect(disk).toHaveValue("15");
  await page.getByRole("combobox", { name: "Sizing", exact: true }).selectOption("default");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/#00000000-0000-4000-8000-000000000001$/);
});

test("project resources survive reload, enforce fetched limits, and reset to inherited sizing", async ({
  page,
}) => {
  test.skip(process.env.HERBIE_UI_FIXTURES !== "1", "Requires preview:ui");
  const edit = "/#00000000-0000-4000-8000-000000000001/edit";
  await page.goto(edit);
  await page.getByRole("combobox", { name: "Sizing", exact: true }).selectOption("custom");
  const memory = page.getByRole("spinbutton", { name: /^Memory/ });
  await expect(memory).toHaveAttribute("max", "16");
  await memory.fill("17");
  expect(await memory.evaluate((input: HTMLInputElement) => input.validity.rangeOverflow)).toBe(
    true,
  );
  await memory.fill("12");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/#00000000-0000-4000-8000-000000000001$/);
  await page.goto(edit);
  await expect(memory).toHaveValue("12");
  await page.reload();
  await expect(memory).toHaveValue("12");
  await page.getByRole("combobox", { name: "Sizing", exact: true }).selectOption("default");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page).toHaveURL(/#00000000-0000-4000-8000-000000000001$/);
  await page.goto(edit);
  await expect(page.getByRole("combobox", { name: "Sizing", exact: true })).toHaveValue("default");
  await expect(memory).toHaveCount(0);
});
