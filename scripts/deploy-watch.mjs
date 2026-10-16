import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const sha = /^[a-f0-9]{40}$/;

async function readVersion(url, timeout) {
  const response = await fetch(url, {
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`Version endpoint returned HTTP ${response.status}`);
  return response.json();
}

async function compare(repo, expected, deployed, timeout) {
  const { stdout } = await execute(
    "gh",
    ["api", `repos/${repo}/compare/${expected}...${deployed}`, "--jq", ".status"],
    { timeout },
  );
  return stdout.trim();
}

export async function watchDeployment(
  {
    repo,
    commit,
    startedAt,
    url = "https://herbie.raible.dev/api/version",
    timeout = 1_800,
    interval = 5,
  },
  {
    read = readVersion,
    compareCommits = compare,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    emit = (value) => console.log(JSON.stringify(value)),
  } = {},
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error("Supply --repo OWNER/REPO");
  if (!sha.test(commit ?? "")) throw new Error("Supply the full merge --commit SHA");
  if (
    startedAt !== undefined &&
    (!Number.isFinite(Date.parse(startedAt)) || Date.parse(startedAt) > now())
  )
    throw new Error("Invalid --started-at timestamp");
  if (!(timeout > 0 && Number.isFinite(timeout)) || !(interval >= 1 && interval <= 60))
    throw new Error("Invalid timeout or interval (interval must be 1–60 seconds)");
  const endpoint = new URL(url);
  if (!["https:", "http:"].includes(endpoint.protocol))
    throw new Error("Version URL must use HTTP or HTTPS");
  const deadline = now() + timeout * 1_000;
  const requestTimeout = () => Math.max(1, Math.min(10_000, Math.floor(deadline - now())));
  const ancestry = new Map();
  let deployed = null;
  let lastError;
  let previous;
  const result = (status) => ({
    status,
    repo,
    expected: commit,
    url: endpoint.href,
    deployed,
    ...(lastError ? { error: lastError } : {}),
  });
  while (now() < deadline) {
    try {
      const request = new URL(endpoint);
      request.searchParams.set("ship", String(now()));
      const version = await read(request.href, requestTimeout());
      if (typeof version?.commitSha !== "string" || !sha.test(version.commitSha))
        throw new Error("Missing or invalid deployed commitSha");
      deployed = version.commitSha;
      lastError = undefined;
      let includes = deployed === commit;
      if (!includes && now() < deadline) {
        if (!ancestry.has(deployed)) {
          const status = await compareCommits(repo, commit, deployed, requestTimeout());
          if (!["ahead", "identical", "behind", "diverged"].includes(status))
            throw new Error("Unknown commit comparison result");
          ancestry.set(deployed, status === "ahead" || status === "identical");
        }
        includes = ancestry.get(deployed);
      }
      if (includes && now() < deadline)
        return {
          ...result("deployed"),
          verifiedAt: new Date(now()).toISOString(),
          durationSeconds: startedAt ? Math.floor((now() - Date.parse(startedAt)) / 1_000) : null,
        };
    } catch (error) {
      lastError = error.message;
    }
    const progress = result("deployment_pending");
    const signature = JSON.stringify(progress);
    if (signature !== previous) {
      emit(progress);
      previous = signature;
    }
    await sleep(Math.min(interval * 1_000, Math.max(0, deadline - now())));
  }
  return result("deployment_timeout");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        repo: { type: "string" },
        commit: { type: "string" },
        url: { type: "string" },
        "started-at": { type: "string" },
        timeout: { type: "string", default: "1800" },
        interval: { type: "string", default: "5" },
      },
    });
    const outcome = await watchDeployment({
      ...values,
      startedAt: values["started-at"],
      timeout: Number(values.timeout),
      interval: Number(values.interval),
    });
    console.log(JSON.stringify(outcome));
    process.exitCode = outcome.status === "deployed" ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ status: "error", message: error.message }));
    process.exitCode = 1;
  }
}
