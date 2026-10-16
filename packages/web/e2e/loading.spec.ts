import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const fixtureSession = { mode: "live", user: { id: "fixture-user", login: "sample-user" } };
const projectId = randomUUID();
const fixtureProject = {
  id: projectId,
  ownerId: "fixture-owner",
  repository: "demo/sample",
  name: "Keep loaded work visible",
  prompt: "Keep loaded work visible",
  runCount: 1,
  state: "running",
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
  mode: "live",
  stopRequested: null,
  pullRequest: null,
  error: null,
};
const health = { mode: "live" };
const json = (route: Parameters<Parameters<Page["route"]>[1]>[0], body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function routeSignedIn(page: Page, projects: unknown[] = [fixtureProject]) {
  await page.route("**/api/health", (route) => json(route, health));
  await page.route("**/api/session", (route) => json(route, fixtureSession));
  await page.route("**/api/projects", (route) =>
    route.request().method() === "GET" ? json(route, projects) : route.continue(),
  );
  await page.route("**/api/repositories", (route) => json(route, []));
  await page.route("**/api/projects/*/events**", (route) => json(route, []));
}

test("the deployed commit stays accessible across views", async ({ page }) => {
  const revision = "a".repeat(40);
  await routeSignedIn(page);
  await page.route("**/api/health", (route) =>
    json(route, { ...health, deploymentId: revision, imageRevision: "b".repeat(40) }),
  );
  await page.goto("/");
  const link = page.getByRole("contentinfo").getByRole("link", { name: revision.slice(0, 7) });
  await expect(link).toHaveAttribute(
    "href",
    `https://github.com/cmraible/herbie/commit/${revision}`,
  );
  await expect(link).toHaveAttribute("title", revision);
  await page.getByRole("button", { name: /Keep loaded work visible/ }).click();
  await expect(link).toBeVisible();
  await page.getByRole("button", { name: "All projects" }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(link).toBeVisible();
});

test("the welcome footer falls back to the image commit", async ({ page }) => {
  const revision = "b".repeat(40);
  await page.route("**/api/health", (route) =>
    json(route, { ...health, deploymentId: "local", imageRevision: revision }),
  );
  await page.route("**/api/session", (route) => json(route, null, 401));
  await page.goto("/");
  await expect(page.getByRole("contentinfo").getByRole("link")).toHaveAttribute(
    "href",
    `https://github.com/cmraible/herbie/commit/${revision}`,
  );
});

test("missing revision metadata does not produce a broken commit link", async ({ page }) => {
  await page.route("**/api/health", (route) => json(route, { ...health, imageRevision: "1" }));
  await page.route("**/api/session", (route) => json(route, null, 401));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toHaveText("Version unavailable");
  await expect(page.getByRole("contentinfo").getByRole("link")).toHaveCount(0);
});

test("the welcome copy renders immediately while health and session are pending", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/health", async (route) => {
    await gate;
    await json(route, health);
  });
  await page.route("**/api/session", async (route) => {
    await gate;
    await json(route, null, 401);
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Herbie/ })).toBeVisible();
  await expect(page.getByText("Checking your workspace…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/loading-welcome-pending.png", fullPage: true });
  release();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
});

test("projects and repository actions stay pending until their responses arrive", async ({
  page,
}) => {
  let releaseProjects!: () => void;
  let releaseRepos!: () => void;
  const projectsGate = new Promise<void>((resolve) => {
    releaseProjects = resolve;
  });
  const reposGate = new Promise<void>((resolve) => {
    releaseRepos = resolve;
  });
  await page.route("**/api/health", (route) => json(route, health));
  await page.route("**/api/session", (route) => json(route, fixtureSession));
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "GET") {
      await projectsGate;
      await json(route, []);
    } else await route.continue();
  });
  await page.route("**/api/repositories", async (route) => {
    await reposGate;
    await json(route, []);
  });
  await page.route("**/api/projects/*/events**", (route) => json(route, []));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Loading projects" })).toBeVisible();
  await expect(page.getByText("No projects yet")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New project", exact: true })).toBeDisabled();
  await page.screenshot({ path: "test-results/loading-dashboard-pending.png", fullPage: true });
  releaseProjects();
  await expect(page.getByText("No projects yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "New project", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Checking repository access" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Start project/ })).toBeDisabled();
  releaseRepos();
  await expect(
    page
      .getByRole("region", { name: "New project", exact: true })
      .getByText("No repositories available."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Start project/ })).toBeDisabled();
});

test("failed startup checks never masquerade as a signed-out session and can be retried", async ({
  page,
}) => {
  let sessionRequest = 0;
  await page.route("**/api/health", (route) => json(route, health));
  await page.route("**/api/session", (route) => {
    sessionRequest++;
    return sessionRequest === 1
      ? json(route, { error: "session unavailable" }, 503)
      : json(route, null, 401);
  });
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("session unavailable");
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
});

test("an initial project failure has a retry state instead of looking like an empty workspace", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/health", (route) => json(route, health));
  await page.route("**/api/session", (route) => json(route, fixtureSession));
  await page.route("**/api/projects", (route) => {
    requests++;
    return requests === 1 ? json(route, { error: "projects unavailable" }, 503) : json(route, []);
  });
  await page.route("**/api/repositories", (route) => json(route, []));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("projects unavailable");
  await expect(page.getByText("No projects yet")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("No projects yet")).toBeVisible();
});

test("an owner-protected projects rejection never exposes an empty workspace or project actions", async ({
  page,
}) => {
  await page.route("**/api/health", (route) => json(route, health));
  await page.route("**/api/session", (route) => json(route, fixtureSession));
  await page.route("**/api/projects", (route) =>
    json(route, { error: "Not authorized to access these projects" }, 403),
  );
  await page.route("**/api/repositories", (route) => json(route, []));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Not authorized to access these projects");
  await expect(page.getByText("No projects yet")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New project", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create a project" })).toHaveCount(0);
});

test("repository discovery errors do not suggest connecting repositories", async ({ page }) => {
  await page.route("**/api/health", (route) => json(route, { mode: "live" }));
  await page.route("**/api/session", (route) =>
    json(route, { mode: "live", user: { id: "fixture-user", login: "sample-user" } }),
  );
  await page.route("**/api/projects", (route) => json(route, []));
  await page.route("**/api/repositories", (route) =>
    json(route, { error: "Repository discovery is unavailable" }, 503),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const screen = page.getByRole("region", { name: "New project", exact: true });
  await expect(screen.getByRole("alert")).toContainText("Repository discovery is unavailable");
  await expect(screen.getByText("No repositories available.")).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "Connect" })).toHaveCount(0);
});

test("signed-out and sign-in states only appear after their responses", async ({ page }) => {
  let releaseLogin!: () => void;
  let signedIn = false;
  const loginGate = new Promise<void>((resolve) => {
    releaseLogin = resolve;
  });
  await page.route("**/api/health", (route) => json(route, health));
  await page.route("**/api/session", (route) =>
    signedIn ? json(route, fixtureSession) : json(route, null, 401),
  );
  await page.route("**/api/auth/start", async (route) => {
    await loginGate;
    const callback = new URL("/fake/github-oauth", page.url()).href;
    await json(route, { url: callback });
  });
  await page.route("**/fake/github-oauth", async (route) => {
    signedIn = true;
    const home = new URL("/", page.url()).href;
    await route.fulfill({
      contentType: "text/html",
      body: `<script>location.replace(${JSON.stringify(home)})</script>`,
    });
  });
  await page.route("**/api/projects", (route) => json(route, []));
  await page.route("**/api/repositories", (route) => json(route, []));
  await page.goto("/");
  const login = page.getByRole("button", { name: "Continue with GitHub" });
  await login.click();
  await expect(login).toBeDisabled();
  await expect(page.getByRole("heading", { name: /Herbie/ })).toBeVisible();
  releaseLogin();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
});

test("stream failures keep the last project and details on screen", async ({ page }) => {
  await routeSignedIn(page);
  await page.routeWebSocket("**/api/stream**", (socket) => socket.close({ code: 1012 }));
  await page.goto("/");
  await page.getByRole("button", { name: /Keep loaded work visible/ }).click();
  await expect(page.getByRole("heading", { name: "Keep loaded work visible" })).toBeVisible();
  await expect(
    page.getByText("Reconnecting to live updates. Displayed progress may be out of date."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keep loaded work visible" })).toBeVisible();
  await expect(page.getByText("No projects yet")).toHaveCount(0);
});

test("the project list hides finished work until requested and opens details separately", async ({
  page,
}) => {
  const completed = {
    ...fixtureProject,
    id: randomUUID(),
    name: "Finished work",
    prompt: "Finished work",
    state: "completed",
  };
  const cancelled = {
    ...fixtureProject,
    id: randomUUID(),
    name: "Stopped work",
    prompt: "Stopped work",
    state: "cancelled",
  };
  await routeSignedIn(page, [fixtureProject, completed, cancelled]);
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Selected project" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Keep loaded work visible/ })).toBeVisible();
  await expect(page.getByText("Finished work")).toHaveCount(0);
  await expect(page.getByText("Stopped work")).toHaveCount(0);
  await page.getByRole("button", { name: "Show completed and cancelled (2)" }).click();
  await page.getByRole("button", { name: /Finished work/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Selected project" })
      .getByRole("heading", { name: "Finished work" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Projects" })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Stopped work/ })).toBeVisible();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page).toHaveURL(/#new$/);
  await expect(page.getByRole("heading", { name: "New project", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Projects", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("What should Herbie work on?").fill("Keep my draft");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByLabel("What should Herbie work on?")).toHaveValue("Keep my draft");
  await page.reload();
  await expect(page.getByRole("heading", { name: "New project", exact: true })).toBeVisible();
  await expect(page.getByLabel("What should Herbie work on?")).toHaveValue("Keep my draft");
  await page.getByRole("button", { name: "Back to projects" }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await expect(page.getByLabel("What should Herbie work on?")).toHaveValue("Keep my draft");
});

test("mobile loading and repeated refresh clicks remain within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let requests = 0;
  await routeSignedIn(page, []);
  await page.unroute("**/api/repositories");
  await page.route("**/api/repositories", (route) => {
    requests++;
    return json(route, []);
  });
  await page.goto("/");
  await expect(page.getByText("No projects yet")).toBeVisible();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const refresh = page.getByRole("button", { name: "Refresh" });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.getByRole("region", { name: "New project", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/new-project-mobile.png", fullPage: true });
  expect(requests).toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("repository refresh keeps alphabetical order and the current selection", async ({ page }) => {
  const policyErrors: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) policyErrors.push(message.text());
  });
  await routeSignedIn(page, []);
  const names = [
    "zebra/App",
    "alpha/zebra",
    "Beta/repo",
    "alpha/Repo",
    "Alpha/repo",
    "alpha/apple",
  ];
  let requests = 0;
  await page.unroute("**/api/repositories");
  await page.route("**/api/repositories", (route) => {
    const list = requests++ === 0 ? names : [...names].reverse();
    return json(
      route,
      list.map((fullName) => ({ fullName, defaultBranch: "main", installationId: 1 })),
    );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const select = page.getByRole("combobox", { name: /^Repository/ });
  await expect(page.locator(".repository-select__control")).toHaveCSS("display", "flex");
  const promptY = (await page.getByLabel("What should Herbie work on?").boundingBox())!.y;
  const expected = [
    "alpha/apple",
    "Alpha/repo",
    "alpha/Repo",
    "alpha/zebra",
    "Beta/repo",
    "zebra/App",
  ];
  await select.click();
  await expect(page.getByRole("option")).toHaveText(
    expected.map((name) => name.replace("/", " / ")),
  );
  await expect(page.locator(".repository-select__menu")).toHaveCSS("position", "absolute");
  expect((await page.getByLabel("What should Herbie work on?").boundingBox())!.y).toBe(promptY);
  await expect(page.getByRole("log")).toHaveCSS("position", "absolute");
  expect(policyErrors).toEqual([]);
  await page.screenshot({ path: "test-results/repository-picker-open.png" });
  await select.fill("btrp");
  await expect(page.getByRole("option")).toHaveCount(1);
  await select.press("ArrowDown");
  await select.press("Enter");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await expect(select).toBeEnabled();
  await expect(page.locator(".repository-select__single-value")).toHaveText("Beta / repo");
  await select.click();
  await expect(page.getByRole("option")).toHaveText(
    expected.map((name) => name.replace("/", " / ")),
  );
  await select.fill("nonexistent-repository");
  await expect(page.getByText("No matching repositories", { exact: true })).toBeVisible();
  await select.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.locator(".repository-select__single-value")).toHaveText("Beta / repo");
});

test("a pending creation respects browser Back navigation", async ({ page }) => {
  await routeSignedIn(page, []);
  await page.unroute("**/api/repositories");
  await page.route("**/api/repositories", (route) =>
    json(route, [{ fullName: "demo/sample", defaultBranch: "main", installationId: 1 }]),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let created = false;
  await page.unroute("**/api/projects");
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() === "POST") {
      await gate;
      created = true;
      await json(route, fixtureProject);
    } else await json(route, created ? [fixtureProject] : []);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("What should Herbie work on?").fill(fixtureProject.prompt);
  const request = page.waitForRequest(
    (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/projects",
  );
  await page.getByRole("button", { name: "Start project", exact: true }).click();
  await request;
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  release();
  await expect(page.getByRole("button", { name: "New project", exact: true })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible({
    timeout: 1000,
  });
  await expect(page.getByRole("button", { name: /Keep loaded work visible/ })).toBeVisible();
});

test("direct creation waits for the initial projects request to succeed", async ({ page }) => {
  await routeSignedIn(page, []);
  await page.unroute("**/api/repositories");
  await page.route("**/api/repositories", (route) =>
    json(route, [{ fullName: "demo/sample", defaultBranch: "main", installationId: 1 }]),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  await page.unroute("**/api/projects");
  await page.route("**/api/projects", async (route) => {
    await gate;
    await (fail ? json(route, { error: "projects unavailable" }, 503) : json(route, []));
  });
  await page.goto("/#new");
  await expect(page.getByLabel("Repository")).toBeEnabled();
  const start = page.getByRole("button", { name: "Start project", exact: true });
  await expect(start).toBeDisabled({ timeout: 1000 });
  release();
  await expect(page.getByRole("alert")).toContainText("projects unavailable");
  await expect(start).toBeDisabled();
  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(start).toBeEnabled();
});

test("successful creation replaces the draft screen in browser history", async ({ page }) => {
  await routeSignedIn(page, []);
  await page.unroute("**/api/repositories");
  await page.route("**/api/repositories", (route) =>
    json(route, [{ fullName: "demo/sample", defaultBranch: "main", installationId: 1 }]),
  );
  await page.unroute("**/api/projects");
  await page.route("**/api/projects", (route) =>
    json(route, route.request().method() === "POST" ? fixtureProject : []),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("What should Herbie work on?").fill(fixtureProject.prompt);
  await page.getByRole("button", { name: "Start project", exact: true }).click();
  await expect(page.getByRole("heading", { name: fixtureProject.name, exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible({
    timeout: 1000,
  });
});
