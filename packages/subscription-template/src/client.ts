import "./style.css";
import { createAuthClient } from "better-auth/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { z } from "zod";
import { Account, WorkspaceList, Workspace } from "./contracts";
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
async function api<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const result = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
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
async function load() {
  const account = await api("/api/account", Account);
  node("auth").hidden = true;
  node("app").hidden = false;
  node("greeting").textContent = "Welcome, " + account.name;
  const workspaces = await api("/api/workspaces", WorkspaceList);
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
  }
  node("security-status").textContent = account.twoFactorEnabled
    ? "Two-factor authentication enabled"
    : "Two-factor authentication not enabled";
}
handle("signup", async () => {
  check(
    await client.signUp.email({ ...credentials(), name: input("name").value, callbackURL: "/" }),
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
