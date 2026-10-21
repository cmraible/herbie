import { expect, test } from "@playwright/test";

for (const operation of ["create", "edit"] as const)
  test(`${operation} waits for its environment before saving and retains the form after a build failure`, async ({
    page,
  }) => {
    test.skip(process.env.HERBIE_UI_FIXTURES !== "1", "Requires preview:ui");
    const projectId = "00000000-0000-4000-8000-000000000001";
    const preparationId = "d2bbc348-a9f4-414e-a477-388ec2f8a7fe";
    let fail = true;
    let finish!: () => void;
    let gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let saves = 0;
    const keys: (string | undefined)[] = [];
    await page.route("**/api/project-environments", (route) =>
      route.fulfill({
        status: 202,
        json: { id: preparationId, state: "building" },
      }),
    );
    await page.route(`**/api/project-environments/${preparationId}`, async (route) => {
      await gate;
      await route.fulfill({ json: { id: preparationId, state: fail ? "failed" : "ready" } });
    });
    await page.route(
      operation === "create" ? "**/api/projects" : `**/api/projects/${projectId}`,
      async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        keys.push(route.request().headers()["idempotency-key"]);
        if (!route.request().headers()["x-herbie-environment-preparation"])
          return route.fulfill({
            status: 409,
            json: { error: "Prepare the environment", code: "environment_preparation_required" },
          });
        expect(fail).toBe(false);
        saves++;
        await route.continue();
      },
    );
    await page.goto(operation === "create" ? "/#new" : `/#${projectId}/edit`);
    const prompt = page.getByRole("textbox", { name: "What should Herbie work on?" });
    const brief = `Prepare the environment before ${operation}`;
    await prompt.fill(brief);
    if (operation === "edit") {
      await page.getByRole("combobox", { name: "Sizing", exact: true }).selectOption("custom");
      await page.getByRole("spinbutton", { name: /^Memory/ }).fill("12");
    }
    const save = page.getByRole("button", {
      name: operation === "create" ? "Start project" : "Save changes",
      exact: true,
    });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Preparing your environment" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Preparing environment…" })).toBeDisabled();
    await expect(prompt).toBeDisabled();
    expect(saves).toBe(0);
    finish();
    await expect(
      page.getByRole("alert").filter({ hasText: "environment could not be built" }),
    ).toBeVisible();
    await expect(prompt).toHaveValue(brief);
    await expect(save).toBeEnabled();
    expect(saves).toBe(0);
    fail = false;
    gate = Promise.resolve();
    await save.click();
    await expect(page).toHaveURL(/#[a-f0-9-]{36}$/);
    expect(saves).toBe(1);
    if (operation === "create") expect(new Set(keys).size).toBe(1);
  });
