import { test, expect } from "@playwright/test";

for (const discoveryFails of [false, true]) {
  test(`project model picker supports selection and custom entry (discovery fails: ${discoveryFails})`, async ({
    page,
  }) => {
    const json = (body: unknown) => ({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    await page.route("**/api/health", (route) => route.fulfill(json({ mode: "live" })));
    await page.route("**/api/session", (route) =>
      route.fulfill(json({ mode: "live", user: { id: "fixture", login: "fixture" } })),
    );
    await page.route("**/api/projects", (route) => route.fulfill(json([])));
    await page.route("**/api/repositories", (route) =>
      route.fulfill(json([{ fullName: "demo/example", defaultBranch: "main", installationId: 1 }])),
    );
    await page.route("**/api/reasoning-efforts?*", (route) => {
      const model = new URL(route.request().url()).searchParams.get("model");
      return route.fulfill(
        json(
          model === "gpt-6-luna"
            ? ["low", "high"]
            : model === "gpt-6-astra"
              ? ["low", "medium"]
              : [],
        ),
      );
    });
    let calls = 0;
    await page.route("**/api/models", (route) => {
      calls++;
      return route.fulfill(
        discoveryFails && calls === 1
          ? { status: 502, ...json({ error: "Unavailable" }) }
          : json(["gpt-6-luna", "gpt-6-astra"]),
      );
    });
    await page.goto("/#new");
    const picker = page.getByRole("combobox", { name: "Model", exact: true });
    await expect(page.getByText("gpt-6-luna", { exact: true })).toBeVisible();
    const reasoning = page.getByRole("combobox", { name: /^Reasoning level/ });
    await expect(reasoning).toBeEnabled();
    await reasoning.selectOption("high");
    if (discoveryFails) {
      await expect(
        page.getByRole("status").filter({ hasText: "Could not load models" }),
      ).toContainText("Could not load models");
      await picker.fill("custom-model");
      await page.getByRole("option", { name: "Use custom model “custom-model”" }).click();
      await expect(page.getByText("custom-model", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Retry models", exact: true }).click();
    }
    await picker.fill("astra");
    await page.getByRole("option", { name: "gpt-6-astra", exact: true }).click();
    await expect(page.getByText("gpt-6-astra", { exact: true })).toBeVisible();
    await expect(reasoning.getByRole("option")).toHaveText([
      "Choose a supported level",
      "low",
      "medium",
    ]);
    await reasoning.selectOption("medium");
    await picker.fill("custom-model");
    await page.getByRole("option", { name: "Use custom model “custom-model”" }).click();
    await page.reload();
    await expect(page.getByText("custom-model", { exact: true })).toBeVisible();
    await expect(reasoning).toBeDisabled();
    await expect(reasoning).toHaveValue("medium");
  });
}
