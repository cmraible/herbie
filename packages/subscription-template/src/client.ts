import "./style.css";
import { createAuthClient } from "better-auth/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { z } from "zod";
import { Account, WorkspaceList, Workspace, Members, Confirmation } from "./contracts";
const client = createAuthClient({ plugins: [twoFactorClient(), passkeyClient()] });
function node(id: string) {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing UI element " + id);
  return value;
}
function input(id: string) {
  const value = node(id);
  if (!(value instanceof HTMLInputElement)) throw new Error("Invalid field");
  return value;
}
function message(text: string) {
  node("status").textContent = text;
}
function report(error: unknown) {
  node("error").textContent = error instanceof Error ? error.message : "Something went wrong";
}
async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  method: "POST" | "PATCH" | "DELETE" = "POST",
): Promise<T> {
  const result = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data: unknown = await result.json();
  if (!result.ok) {
    const e = z.object({ error: z.string() }).safeParse(data);
    throw new Error(e.success ? e.data.error : "Request failed");
  }
  return schema.parse(data);
}
function handle(id: string, action: () => Promise<void>) {
  node(id).addEventListener("click", () => {
    node("error").textContent = "";
    void action().catch(report);
  });
}
function credentials() {
  return { email: input("email").value, password: input("password").value };
}
function check(result: { error: { message?: string } | null }) {
  if (result.error) throw new Error(result.error.message ?? "Request failed");
}
let selected: string | undefined;
let generation = 0;
async function load() {
  const current = ++generation;
  const account = await api("/api/account", Account);
  node("auth").hidden = true;
  node("invitation").hidden = !new URL(location.href).searchParams.has("invitation");
  node("app").hidden = false;
  node("greeting").textContent = "Welcome, " + account.name;
  const workspaces = await api("/api/workspaces", WorkspaceList);
  if (current !== generation) return;
  const select = node("workspace");
  if (!(select instanceof HTMLSelectElement)) throw new Error("Invalid selector");
  select.replaceChildren(
    ...workspaces.map((w) => {
      const option = document.createElement("option");
      option.value = w.id;
      option.textContent = w.name;
      return option;
    }),
  );
  selected = workspaces.find((w) => w.id === selected)?.id ?? workspaces[0]?.id;
  if (selected) select.value = selected;
  const workspace = workspaces.find((w) => w.id === selected);
  node("workspace-detail").hidden = !workspace;
  if (workspace) {
    node("workspace-title").textContent = workspace.name;
    node("role").textContent = "Your role: " + workspace.role;
    await renderTeam(workspace, current);
  }
  node("security-status").textContent = account.twoFactorEnabled
    ? "Two-factor authentication enabled"
    : "Two-factor authentication not enabled";
}
handle("signup", async () => {
  check(
    await client.signUp.email({
      ...credentials(),
      name: input("name").value,
      callbackURL: "/" + location.search,
    }),
  );
  message("Check your email to verify your account.");
});
node("account-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    check(await client.signIn.email(credentials()));
    await load();
  })().catch(report);
});
handle("logout", async () => {
  check(await client.signOut());
  location.reload();
});
node("workspace-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    const w = await api("/api/workspaces", Workspace, { name: input("workspace-name").value });
    selected = w.id;
    input("workspace-name").value = "";
    await load();
  })().catch(report);
});
node("workspace").addEventListener("change", (e) => {
  if (e.target instanceof HTMLSelectElement) {
    selected = e.target.value;
    void load().catch(report);
  }
});
async function start() {
  const session = await client.getSession();
  if (session.data) await load();
}
void start().catch(report);
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  return item;
}
async function renderTeam(workspace: z.infer<typeof Workspace>, current: number) {
  const base = "/api/workspaces/" + encodeURIComponent(workspace.id);
  const members = await api(base + "/members", Members);
  if (current !== generation) return;
  const section = node("team");
  section.replaceChildren(element("h3", "Team members"));
  const table = element("table");
  const header = element("tr");
  for (const text of ["Member", "Role", "Actions"]) header.append(element("th", text));
  table.append(header);
  for (const member of members) {
    const row = element("tr");
    row.append(element("td", member.email), element("td", member.role));
    const actions = element("td");
    if (workspace.role !== "member" && member.role !== "owner") {
      const remove = element("button", "Remove");
      remove.onclick = () => {
        void api(base + "/members/" + member.id, Confirmation, {}, "DELETE")
          .then(load)
          .catch(report);
      };
      actions.append(remove);
      if (workspace.role === "owner") {
        const role = element("button", member.role === "admin" ? "Make member" : "Make admin");
        role.onclick = () => {
          void api(
            base + "/members/" + member.id,
            Confirmation,
            { role: member.role === "admin" ? "member" : "admin" },
            "PATCH",
          )
            .then(load)
            .catch(report);
        };
        actions.append(role);
      }
    }
    row.append(actions);
    table.append(row);
  }
  section.append(table);
  if (workspace.role === "member") return;
  const form = element("form"),
    label = element("label", "Invite email"),
    email = element("input");
  email.type = "email";
  email.required = true;
  label.append(email);
  form.append(label);
  const roleLabel = element("label", "Invitation role"),
    role = element("select");
  for (const value of workspace.role === "owner" ? ["member", "admin"] : ["member"]) {
    const option = element("option", value);
    option.value = value;
    role.append(option);
  }
  roleLabel.append(role);
  form.append(roleLabel);
  const send = element("button", "Send invitation");
  form.append(send);
  form.onsubmit = (e) => {
    e.preventDefault();
    send.disabled = true;
    void api(base + "/invitations", Confirmation, { email: email.value, role: role.value })
      .then(() => {
        message("Invitation sent.");
        email.value = "";
      })
      .catch(report)
      .finally(() => {
        send.disabled = false;
      });
  };
  section.append(form);
}
handle("accept-invitation", async () => {
  const invitation = new URL(location.href).searchParams.get("invitation");
  if (!invitation) throw new Error("Invitation missing");
  const result = await api(
    "/api/invitations/" + encodeURIComponent(invitation) + "/accept",
    z.object({ workspace: z.string() }),
    {},
  );
  selected = result.workspace;
  history.replaceState({}, "", "/");
  await load();
  message("Invitation accepted.");
});
