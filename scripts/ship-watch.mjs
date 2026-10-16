import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const fields = "url,state,isDraft,headRefOid,baseRefName,mergeable,mergedAt,mergeCommit";

async function github(args) {
  try {
    const { stdout } = await execute("gh", args, { timeout: 30_000 });
    return stdout;
  } catch (error) {
    // `gh pr checks` returns 1 for failing checks and 8 for pending checks.
    if (args[1] === "checks" && [1, 8].includes(error.code)) {
      if (
        /^no (?:required )?checks reported on (?:the '.+' )?branch\b/.test(
          error.stderr?.trim() ?? "",
        )
      )
        return "[]";
      try {
        if (Array.isArray(JSON.parse(error.stdout))) return error.stdout;
      } catch {
        /* Preserve the CLI's authentication/network error below. */
      }
    }
    throw new Error(error.stderr?.trim() || error.message);
  }
}

// Dependencies are injectable so merge behavior can be exercised without GitHub writes.
export async function watchPullRequest(
  { repo, pr, head, startedAt, timeout = 1_800, interval = 15 },
  {
    gh = github,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    emit = (value) => console.log(JSON.stringify(value)),
  } = {},
) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !/^[1-9]\d*$/.test(String(pr))) {
    throw new Error("Supply --repo OWNER/REPO and --pr NUMBER");
  }
  if (!/^[a-f0-9]{40}$/.test(head ?? ""))
    throw new Error("Supply the full checked/reviewed --head SHA");
  if (startedAt !== undefined && !Number.isFinite(Date.parse(startedAt)))
    throw new Error("Invalid --started-at timestamp");
  if (!(timeout > 0 && Number.isFinite(timeout)) || !(interval >= 1 && interval <= 60))
    throw new Error("Invalid timeout or interval (interval must be 1–60 seconds)");

  let deadline = now() + timeout * 1_000;
  let mergeRequested = false;
  let previous;
  const result = (status, details = {}) => ({ status, repo, pr: Number(pr), head, ...details });
  while (true) {
    const pull = JSON.parse(await gh(["pr", "view", String(pr), "--repo", repo, "--json", fields]));
    if (pull.headRefOid !== head)
      return result("head_changed", { url: pull.url, actualHead: pull.headRefOid });
    if (pull.state === "MERGED") {
      if (!pull.mergedAt || !pull.mergeCommit?.oid)
        throw new Error("GitHub has not supplied merge confirmation");
      const durationSeconds = startedAt
        ? Math.floor((Date.parse(pull.mergedAt) - Date.parse(startedAt)) / 1_000)
        : null;
      if (durationSeconds !== null && durationSeconds < 0)
        throw new Error("Merge predates --started-at");
      return result("merged", {
        url: pull.url,
        base: pull.baseRefName,
        mergedAt: pull.mergedAt,
        mergeCommit: pull.mergeCommit.oid,
        durationSeconds,
      });
    }
    if (pull.state !== "OPEN") return result("closed", { url: pull.url });
    if (pull.isDraft) return result("draft", { url: pull.url });
    if (pull.mergeable === "CONFLICTING") return result("conflict", { url: pull.url });

    const checks = JSON.parse(
      await gh([
        "pr",
        "checks",
        String(pr),
        "--repo",
        repo,
        "--required",
        "--json",
        "name,bucket,state,link",
      ]),
    );
    const failed = checks.filter((check) => ["fail", "cancel"].includes(check.bucket));
    if (failed.length) return result("checks_failed", { url: pull.url, checks: failed });
    if (now() >= deadline) return result("timeout", { url: pull.url, mergeRequested, checks });
    // Herbie's aggregate covers every blocking job, including permitted docs-only skips.
    const ready =
      checks.some((check) => check.name === "All tests passed" && check.bucket === "pass") &&
      checks.every((check) => check.bucket === "pass");
    if (ready && pull.mergeable === "MERGEABLE" && !mergeRequested) {
      // GitHub enforces approvals, rulesets and queues; the SHA guard closes the read/merge race.
      await gh([
        "pr",
        "merge",
        String(pr),
        "--repo",
        repo,
        "--squash",
        "--match-head-commit",
        head,
      ]);
      mergeRequested = true;
    }
    const progress = result(mergeRequested ? "merge_pending" : "checks_pending", {
      url: pull.url,
      checks,
    });
    const signature = JSON.stringify(progress);
    if (signature !== previous) {
      emit(progress);
      previous = signature;
      deadline = now() + timeout * 1_000;
    }
    await sleep(Math.min(interval * 1_000, Math.max(0, deadline - now())));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        repo: { type: "string" },
        pr: { type: "string" },
        head: { type: "string" },
        "started-at": { type: "string" },
        timeout: { type: "string", default: "1800" },
        interval: { type: "string", default: "15" },
      },
    });
    const outcome = await watchPullRequest({
      ...values,
      startedAt: values["started-at"],
      timeout: Number(values.timeout),
      interval: Number(values.interval),
    });
    console.log(JSON.stringify(outcome));
    process.exitCode = outcome.status === "merged" ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ status: "error", message: error.message }));
    process.exitCode = 1;
  }
}
