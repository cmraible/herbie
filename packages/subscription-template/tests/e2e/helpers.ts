import { expect, type Page } from "@playwright/test";
import { z } from "zod";
export const password = "correct-horse-battery-staple";
const Emails = z.array(
  z.object({ to: z.array(z.string()), subject: z.string(), text: z.string() }),
);
export async function emailLink(page: Page, email: string, subject: string) {
  let link = "";
  await expect
    .poll(async () => {
      const response = await page.request.get(
        "http://127.0.0.1:8791/emails?to=" + encodeURIComponent(email),
      );
      const messages = Emails.parse(await response.json());
      link = messages.filter((m) => m.subject === subject).at(-1)?.text ?? "";
      return link;
    })
    .not.toBe("");
  return link;
}
export async function register(page: Page, prefix: string) {
  const email = prefix.toLowerCase() + "-" + crypto.randomUUID() + "@example.test";
  await page.goto("/");
  await page.getByLabel("Name", { exact: true }).fill(prefix);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  await page.goto(await emailLink(page, email, "Verify your email"));
  await expect(page.getByRole("heading", { name: "Welcome, " + prefix })).toBeVisible();
  return email;
}
export async function signIn(page: Page, email: string) {
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
export async function createWorkspace(page: Page, name: string) {
  await page.getByLabel("Workspace name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}
