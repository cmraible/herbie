import { test, expect } from "@playwright/test";
import { register } from "./helpers";

test("a registered passkey signs in after logout and cannot be used after removal", async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await register(page, "Passkey user");
  await page.getByRole("button", { name: "Add passkey", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Passkey added");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Welcome, Passkey user" })).toBeVisible();
  await page.getByRole("button", { name: "Remove passkey", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Passkey removed");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click();
  await expect(page.getByRole("alert")).not.toBeEmpty();
  expect((await page.request.get("/api/account")).status()).toBe(401);
});

test("TOTP requires confirmation and a second factor; recovery codes work once", async ({
  page,
}) => {
  const { generate } = await import("otplib");
  const { password, signIn } = await import("./helpers");
  const email = await register(page, "TOTP user");
  await expect(page.getByRole("button", { name: "Set up two-factor", exact: true })).toBeVisible();
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Set up two-factor", exact: true }).click();
  const setup = page.getByLabel("Authenticator setup URI", { exact: true });
  await expect(setup).toHaveValue(/^otpauth:\/\//);
  expect((await (await page.request.get("/api/account")).json()).twoFactorEnabled).toBe(false);
  const secret = new URL(await setup.inputValue()).searchParams.get("secret");
  if (!secret) throw new Error("Missing TOTP secret");
  const recovery = (await page.getByLabel("Recovery codes", { exact: true }).inputValue()).split(
    "\n",
  )[0];
  if (!recovery) throw new Error("Missing recovery code");
  await page.getByLabel("Authentication code", { exact: true }).fill(await generate({ secret }));
  await page.getByRole("button", { name: "Verify authentication code", exact: true }).click();
  await expect(page.getByText("Two-factor authentication enabled", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(page, email);
  await expect(
    page.getByRole("heading", { name: "Verify your sign-in", exact: true }),
  ).toBeVisible();
  expect((await page.request.get("/api/account")).status()).toBe(401);
  await page.getByLabel("Authentication code", { exact: true }).fill("bad-code");
  await page.getByRole("button", { name: "Verify authentication code", exact: true }).click();
  await expect(page.getByRole("alert")).not.toBeEmpty();
  expect((await page.request.get("/api/account")).status()).toBe(401);
  await page.getByLabel("Recovery code", { exact: true }).fill(recovery);
  await page.getByRole("button", { name: "Use recovery code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome, TOTP user", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(page, email);
  await page.getByLabel("Recovery code", { exact: true }).fill(recovery);
  await page.getByRole("button", { name: "Use recovery code", exact: true }).click();
  await expect(page.getByRole("alert")).not.toBeEmpty();
  expect((await page.request.get("/api/account")).status()).toBe(401);
  await page.getByLabel("Authentication code", { exact: true }).fill(await generate({ secret }));
  await page.getByRole("button", { name: "Verify authentication code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome, TOTP user", exact: true }),
  ).toBeVisible();
});

test("password reset replaces the password, revokes other sessions, and consumes its token", async ({
  page,
  browser,
}) => {
  const { emailLink, password, signIn } = await import("./helpers");
  const email = await register(page, "Reset user");
  const context = await browser.newContext();
  const other = await context.newPage();
  try {
    await other.goto("/");
    await signIn(other, email);
    await expect(other.getByRole("heading", { name: "Welcome, Reset user" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Email", { exact: true }).fill(email);
    await expect(page.getByRole("button", { name: "Forgot password", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Forgot password", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("If your account exists");
    await page.goto(await emailLink(page, email, "Reset your password"));
    const resetUrl = page.url();
    await page.getByLabel("New password", { exact: true }).fill(password + "-new");
    await page.getByRole("button", { name: "Save new password", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Password updated");
    expect((await other.request.get("/api/account")).status()).toBe(401);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password + "-new");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Welcome, Reset user" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.goto(resetUrl);
    await page.getByLabel("New password", { exact: true }).fill(password + "-again");
    await page.getByRole("button", { name: "Save new password", exact: true }).click();
    await expect(page.getByRole("alert")).not.toBeEmpty();
  } finally {
    await context.close();
  }
});
