import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  version: string;
};

export function runningVersion(deploymentId?: string, imageRevision?: string) {
  let commitSha = [deploymentId, imageRevision].find((value) => /^[a-f0-9]{40}$/.test(value ?? ""));
  if (!commitSha) {
    try {
      commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fileURLToPath(root),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // Source archives may have neither deployment metadata nor a Git checkout.
    }
  }
  return { version, commitSha: commitSha ?? null };
}
