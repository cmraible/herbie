import { test, expect } from "@playwright/test";
import { WorkspaceList, Members } from "../../src/contracts";
import { register, createWorkspace, emailLink } from "./helpers";
test("demotion fences concurrent invitations and concurrent acceptance admits the recipient once", async ({
  page,
  browser,
}) => {
  await register(page, "Race owner");
  await createWorkspace(page, "Race team");
  const workspace = WorkspaceList.parse(
    await (await page.request.get("/api/workspaces")).json(),
  )[0];
  if (!workspace) throw new Error("Missing workspace");
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const admin = pages[0],
      recipient = pages[1];
    if (!admin || !recipient) throw new Error("Missing browser context");
    const [adminEmail, recipientEmail] = await Promise.all([
      register(admin, "Race admin"),
      register(recipient, "Race recipient"),
    ]);
    const headers = { origin: "http://localhost:8790" };
    const base = `/api/workspaces/${workspace.id}`;
    expect(
      (
        await page.request.post(base + "/invitations", {
          headers,
          data: { email: adminEmail, role: "admin" },
        })
      ).status(),
    ).toBe(201);
    const adminInvite = new URL(
      await emailLink(admin, adminEmail, "Workspace invitation"),
    ).searchParams.get("invitation");
    expect(
      (
        await admin.request.post(`/api/invitations/${adminInvite}/accept`, { headers, data: {} })
      ).status(),
    ).toBe(200);
    const members = Members.parse(await (await page.request.get(base + "/members")).json());
    const membership = members.find((member) => member.email === adminEmail);
    if (!membership) throw new Error("Missing administrator");
    const [invited, demoted] = await Promise.all([
      admin.request.post(base + "/invitations", {
        headers,
        data: { email: recipientEmail, role: "member" },
      }),
      page.request.patch(base + "/members/" + membership.id, { headers, data: { role: "member" } }),
    ]);
    expect(demoted.status()).toBe(200);
    expect([201, 403]).toContain(invited.status());
    if (invited.status() === 201) {
      const id = new URL(
        await emailLink(recipient, recipientEmail, "Workspace invitation"),
      ).searchParams.get("invitation");
      expect(
        (
          await recipient.request.post(`/api/invitations/${id}/accept`, { headers, data: {} })
        ).status(),
      ).toBe(403);
    }
    expect((await recipient.request.get(base)).status()).toBe(403);
    expect(
      (
        await page.request.post(base + "/invitations", {
          headers,
          data: { email: recipientEmail, role: "member" },
        })
      ).status(),
    ).toBe(201);
    const id = new URL(
      await emailLink(recipient, recipientEmail, "Workspace invitation"),
    ).searchParams.get("invitation");
    const accepts = await Promise.all(
      [0, 1].map(() =>
        recipient.request.post(`/api/invitations/${id}/accept`, { headers, data: {} }),
      ),
    );
    expect(accepts.map((result) => result.status()).sort()).toEqual([200, 409]);
    const final = Members.parse(await (await page.request.get(base + "/members")).json());
    expect(final.filter((member) => member.email === recipientEmail)).toHaveLength(1);
    expect(final.filter((member) => member.role === "owner")).toHaveLength(1);
    expect(final.find((member) => member.email === adminEmail)?.role).toBe("member");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
test("an invited verified teammate joins once, cannot manage membership or other workspaces, and loses access when removed", async ({
  browser,
  page,
}) => {
  await register(page, "Owner");
  await createWorkspace(page, "Design team");
  const ownerWorkspaces = WorkspaceList.parse(
    await (await page.request.get("/api/workspaces")).json(),
  );
  const workspace = ownerWorkspaces[0];
  if (!workspace) throw new Error("Workspace absent");
  const context = await browser.newContext();
  const colleague = await context.newPage();
  try {
    const email = await register(colleague, "Colleague");
    await createWorkspace(colleague, "Private team");
    expect((await colleague.request.get("/api/workspaces/" + workspace.id)).status()).toBe(403);
    await page.getByLabel("Invite email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Send invitation", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Invitation sent");
    const link = await emailLink(colleague, email, "Workspace invitation");
    const wrongRecipient = new URL(link).searchParams.get("invitation");
    expect(
      (
        await page.request.post("/api/invitations/" + wrongRecipient + "/accept", {
          headers: { origin: "http://localhost:8790" },
          data: {},
        })
      ).status(),
    ).toBe(403);
    await colleague.goto(link);
    await colleague.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect(
      colleague.getByRole("heading", { name: "Design team", exact: true }),
    ).toBeVisible();
    await expect(colleague.getByText("Your role: member")).toBeVisible();
    expect(
      (
        await colleague.request.post("/api/workspaces/" + workspace.id + "/invitations", {
          headers: { origin: "http://localhost:8790" },
          data: { email: "other@example.test", role: "owner" },
        })
      ).status(),
    ).toBe(403);
    const invitation = new URL(link).searchParams.get("invitation");
    expect(
      (
        await colleague.request.post("/api/invitations/" + invitation + "/accept", {
          headers: { origin: "http://localhost:8790" },
          data: {},
        })
      ).status(),
    ).toBe(409);
    await page.reload();
    await page
      .getByRole("row")
      .filter({ hasText: email })
      .getByRole("button", { name: "Make admin" })
      .click();
    await expect(page.getByRole("row").filter({ hasText: email })).toContainText("admin");
    await colleague.reload();
    await colleague.getByLabel("Workspace", { exact: true }).selectOption(workspace.id);
    await expect(colleague.getByText("Your role: admin")).toBeVisible();
    expect(
      (
        await colleague.request.post("/api/workspaces/" + workspace.id + "/invitations", {
          headers: { origin: "http://localhost:8790" },
          data: { email: "unauthorized@example.test", role: "admin" },
        })
      ).status(),
    ).toBe(403);
    await page
      .getByRole("row")
      .filter({ hasText: email })
      .getByRole("button", { name: "Make member" })
      .click();
    await expect(page.getByRole("row").filter({ hasText: email })).toContainText("member");
    await page
      .getByRole("row")
      .filter({ hasText: email })
      .getByRole("button", { name: "Remove" })
      .click();
    await expect
      .poll(async () => (await colleague.request.get("/api/workspaces/" + workspace.id)).status())
      .toBe(403);
    await colleague.reload();
    await expect(
      colleague.getByRole("heading", { name: "Private team", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("ownership cannot be demoted, removed, or granted through invitations", async ({ page }) => {
  await register(page, "Protected owner");
  await createWorkspace(page, "Protected workspace");
  const workspaces = WorkspaceList.parse(await (await page.request.get("/api/workspaces")).json());
  const workspace = workspaces[0];
  if (!workspace) throw new Error("Missing workspace");
  const members = Members.parse(
    await (await page.request.get("/api/workspaces/" + workspace.id + "/members")).json(),
  );
  const owner = members[0];
  if (!owner) throw new Error("Missing owner");
  const path = "/api/workspaces/" + workspace.id + "/members/" + owner.id;
  const changes = await Promise.all([
    page.request.patch(path, {
      headers: { origin: "http://localhost:8790" },
      data: { role: "member" },
    }),
    page.request.delete(path, { headers: { origin: "http://localhost:8790" }, data: {} }),
  ]);
  expect(changes.map((response) => response.status())).toEqual([409, 409]);
  expect(
    (
      await page.request.post("/api/workspaces/" + workspace.id + "/invitations", {
        headers: { origin: "http://localhost:8790" },
        data: { email: "invite@example.test", role: "owner" },
      })
    ).status(),
  ).toBe(400);
  await page.reload();
  await expect(page.getByText("Your role: owner")).toBeVisible();
});

test("new invitees retain the invitation through signup and old invitations cannot restore revoked access", async ({
  page,
  browser,
}) => {
  await register(page, "Inviter");
  await createWorkspace(page, "New team");
  const workspace = WorkspaceList.parse(
    await (await page.request.get("/api/workspaces")).json(),
  )[0];
  if (!workspace) throw new Error("Missing workspace");
  const email = "new-" + crypto.randomUUID() + "@example.test";
  const invite = () =>
    page.request.post(`/api/workspaces/${workspace.id}/invitations`, {
      headers: { origin: "http://localhost:8790" },
      data: { email, role: "member" },
    });
  const responses = await Promise.all([invite(), invite()]);
  expect(responses.map((r) => r.status())).toEqual([201, 201]);
  const link = await emailLink(page, email, "Workspace invitation");
  const context = await browser.newContext();
  const recipient = await context.newPage();
  try {
    await recipient.goto(link);
    await recipient.getByLabel("Name", { exact: true }).fill("New teammate");
    await recipient.getByLabel("Email", { exact: true }).fill(email);
    await recipient.getByLabel("Password", { exact: true }).fill("correct-horse-battery-staple");
    await recipient.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(recipient.getByRole("status")).toContainText("Check your email");
    await recipient.goto(await emailLink(recipient, email, "Verify your email"));
    await recipient.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect(recipient.getByRole("heading", { name: "New team", exact: true })).toBeVisible();
    // A newly sent invitation is also revoked when membership is removed.
    expect((await invite()).status()).toBe(201);
    const pending = new URL(await emailLink(page, email, "Workspace invitation")).searchParams.get(
      "invitation",
    );
    await page.reload();
    await page
      .getByRole("row")
      .filter({ hasText: email })
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(page.getByRole("row").filter({ hasText: email })).toHaveCount(0);
    expect(
      (
        await recipient.request.post(`/api/invitations/${pending}/accept`, {
          headers: { origin: "http://localhost:8790" },
          data: {},
        })
      ).status(),
    ).toBe(409);
    expect((await recipient.request.get(`/api/workspaces/${workspace.id}`)).status()).toBe(403);
  } finally {
    await context.close();
  }
});
