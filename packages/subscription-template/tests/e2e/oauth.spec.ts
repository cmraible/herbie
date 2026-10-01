import { test, expect } from "@playwright/test";
import { z } from "zod";
test("configured Google and GitHub authorization uses state and rejects an unsolicited callback", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Continue with Google", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with GitHub", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with ChatGPT", exact: true }),
  ).toHaveCount(0);
  for (const [provider, host] of [
    ["google", "accounts.google.com"],
    ["github", "github.com"],
  ]) {
    const response = await page.request.post("/api/auth/sign-in/social", {
      headers: { origin: "http://localhost:8790" },
      data: { provider, callbackURL: "/", disableRedirect: true },
    });
    expect(response.status()).toBe(200);
    const url = new URL(z.object({ url: z.url() }).parse(await response.json()).url);
    expect(url.hostname).toBe(host);
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8790/api/auth/callback/" + provider,
    );
  }
  await page.goto("/api/auth/callback/google?state=unsolicited&code=fake");
  expect((await page.request.get("/api/account")).status()).toBe(401);
});
