import "./style.css";
import { createAuthClient } from "better-auth/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { z } from "zod";
import {
  Account,
  WorkspaceList,
  Workspace,
  Members,
  Confirmation,
  Configuration,
  Billing,
  Redirect,
} from "./contracts";
let mfaPending = false;
const client = createAuthClient({
  plugins: [
    twoFactorClient({
      onTwoFactorRedirect: async () => {
        mfaPending = true;
        node("auth").hidden = true;
        node("challenge").hidden = false;
        node("challenge-title").textContent = "Verify your sign-in";
      },
    }),
    passkeyClient(),
  ],
});
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
const pending = new WeakSet<HTMLElement>();
async function runAction(source: HTMLElement, action: () => Promise<void>) {
  const scope = source.closest("form") ?? source;
  if (pending.has(scope)) return;
  pending.add(scope);
  const buttons =
    scope instanceof HTMLButtonElement ? [scope] : [...scope.querySelectorAll("button")];
  const enabled = buttons.filter((button) => !button.disabled);
  for (const button of enabled) button.disabled = true;
  node("error").textContent = "";
  message("");
  try {
    await action();
  } catch (error) {
    report(error);
  } finally {
    pending.delete(scope);
    for (const button of enabled) button.disabled = false;
  }
}
function handle(id: string, action: () => Promise<void>) {
  const source = node(id);
  source.addEventListener("click", () => {
    void runAction(source, action);
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
    await renderBilling(workspace, current);
  }
  await renderPasskeys();
  node("enable-totp").hidden = account.twoFactorEnabled;
  node("disable-totp").hidden = !account.twoFactorEnabled;
  node("regenerate-codes").hidden = !account.twoFactorEnabled;
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
  void runAction(node("account-form"), async () => {
    check(await client.signIn.email(credentials()));
    if (!mfaPending) await load();
  });
});
handle("logout", async () => {
  check(await client.signOut());
  location.reload();
});
node("workspace-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void runAction(node("workspace-form"), async () => {
    const w = await api("/api/workspaces", Workspace, { name: input("workspace-name").value });
    selected = w.id;
    input("workspace-name").value = "";
    await load();
  });
});
node("workspace").addEventListener("change", (e) => {
  if (e.target instanceof HTMLSelectElement) {
    selected = e.target.value;
    void load().catch(report);
  }
});
async function start() {
  const config = await api("/api/config", Configuration);
  for (const provider of config.providers) {
    const labels = { google: "Google", github: "GitHub", chatgpt: "ChatGPT" };
    const button = element("button", "Continue with " + labels[provider]);
    button.onclick = () => {
      void client.signIn
        .social({ provider, callbackURL: "/" + location.search })
        .then(check)
        .catch(report);
    };
    node("providers").append(button);
  }
  if (new URL(location.href).searchParams.has("token")) {
    node("auth").hidden = true;
    node("reset").hidden = false;
    return;
  }
  const session = await client.getSession();
  if (session.data) await load();
}
void start()
  .then(() => node("interface").removeAttribute("disabled"))
  .catch(report);
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

handle("add-passkey", async () => {
  check(await client.passkey.addPasskey({ name: "Personal passkey" }));
  await renderPasskeys();
  message("Passkey added.");
});
handle("passkey-login", async () => {
  check(await client.signIn.passkey());
  await load();
});
async function renderPasskeys() {
  const result = await client.passkey.listUserPasskeys();
  check(result);
  const container = node("passkeys");
  container.replaceChildren();
  for (const passkey of result.data ?? []) {
    const row = element("p", passkey.name ?? "Passkey");
    const remove = element("button", "Remove passkey");
    remove.onclick = () => {
      void (async () => {
        check(await client.passkey.deletePasskey({ id: passkey.id }));
        await renderPasskeys();
        message("Passkey removed.");
      })().catch(report);
    };
    row.append(remove);
    container.append(row);
  }
}

function recoveryCodes(codes: string[]) {
  const field = node("recovery-codes");
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("Invalid recovery field");
  field.value = codes.join("\n");
  node("totp-setup").hidden = false;
}
handle("enable-totp", async () => {
  const result = await client.twoFactor.enable({ password: input("current-password").value });
  check(result);
  if (!result.data || result.data.method !== "totp") throw new Error("Setup failed");
  input("totp-uri").value = result.data.totpURI;
  recoveryCodes(result.data.backupCodes);
  node("challenge").hidden = false;
  node("challenge-title").textContent = "Confirm two-factor setup";
  input("current-password").value = "";
});
async function verified() {
  mfaPending = false;
  node("challenge").hidden = true;
  node("totp-setup").hidden = true;
  input("totp-uri").value = "";
  input("totp-code").value = "";
  input("recovery-code").value = "";
  recoveryCodes([]);
  node("totp-setup").hidden = true;
  await load();
}
handle("verify-totp", async () => {
  check(await client.twoFactor.verifyTotp({ code: input("totp-code").value }));
  await verified();
});
handle("verify-recovery", async () => {
  check(await client.twoFactor.verifyBackupCode({ code: input("recovery-code").value }));
  await verified();
});
handle("disable-totp", async () => {
  check(await client.twoFactor.disable({ password: input("current-password").value }));
  input("current-password").value = "";
  await verified();
});
handle("regenerate-codes", async () => {
  const result = await client.twoFactor.generateBackupCodes({
    password: input("current-password").value,
  });
  check(result);
  if (result.data) recoveryCodes(result.data.backupCodes);
  input("current-password").value = "";
});

handle("forgot-password", async () => {
  check(await client.requestPasswordReset({ email: input("email").value, redirectTo: "/" }));
  message("If your account exists, check your email for a reset link.");
});
handle("save-password", async () => {
  const token = new URL(location.href).searchParams.get("token");
  if (!token) throw new Error("Reset link is missing its token");
  check(await client.resetPassword({ token, newPassword: input("new-password").value }));
  input("new-password").value = "";
  history.replaceState({}, "", "/");
  node("reset").hidden = true;
  node("auth").hidden = false;
  message("Password updated. Sign in with your new password.");
});

async function renderBilling(workspace: z.infer<typeof Workspace>, current: number) {
  const base = "/api/workspaces/" + workspace.id + "/billing";
  const billing = await api(base, Billing);
  if (current !== generation) return;
  const section = node("billing");
  section.replaceChildren(
    element("h3", "Subscription"),
    element("p", "Subscription status: " + billing.status),
    element("p", "Paid access: " + (billing.entitled ? "yes" : "no")),
  );
  if (!billing.enabled) {
    section.append(element("p", "Billing is not configured yet."));
    return;
  }
  if (workspace.role === "member") return;
  for (const [action, label] of [
    ["checkout", "Subscribe"],
    ["portal", "Manage billing"],
  ]) {
    const button = element("button", label);
    button.onclick = () => {
      button.disabled = true;
      void api(base + "/" + action, Redirect, {})
        .then((result) => location.assign(result.url))
        .catch(report)
        .finally(() => {
          button.disabled = false;
        });
    };
    section.append(button);
  }
  const refresh = element("button", "Refresh billing");
  refresh.onclick = () => {
    void api(base + "/refresh", Billing, {})
      .then(load)
      .catch(report);
  };
  section.append(refresh);
}
