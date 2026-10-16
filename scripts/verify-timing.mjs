import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export function recordTiming(timing) {
  const directory = join(process.env.HERBIE_CI_ARTIFACT_DIR, "timings");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, timing.id.replaceAll("/", "_") + ".json");
  writeFileSync(file + ".tmp", JSON.stringify(timing) + "\n");
  renameSync(file + ".tmp", file);
}

// pnpm's structured lifecycle events retain package concurrency and dependency ordering.
export function packageTimings(parent, output = console.log) {
  const running = new Map();
  return {
    event(event) {
      if (event.name !== "pnpm:lifecycle") {
        if (event.level === "error" || event.level === "warn")
          output(event.message ?? JSON.stringify(event));
        return;
      }
      const name = `@herbie/${basename(event.wd)} ${event.stage}`;
      const id = `${parent}.${basename(event.wd)}-${event.stage}`;
      if (event.script) {
        running.set(id, { id, parent, name, started: event.time / 1000 });
        output(`${name}$ ${event.script}`);
      } else if (event.line !== undefined) {
        const count = event.line.match(/ℹ (tests|skipped) (\d+)$/);
        if (count && running.has(id)) running.get(id)[count[1]] = Number(count[2]);
        output(`${name}: ${event.line}`);
      } else if (event.exitCode !== undefined && running.has(id)) {
        recordTiming({
          ...running.get(id),
          seconds: event.time / 1000 - running.get(id).started,
          status: event.exitCode,
        });
        running.delete(id);
        output(`${name}: ${event.exitCode === 0 ? "Done" : "Failed"}`);
      }
    },
    finish(status) {
      for (const timing of running.values())
        recordTiming({ ...timing, seconds: Date.now() / 1000 - timing.started, status });
    },
  };
}

// Used alongside Playwright's list reporter; each spec includes its own setup and retries.
export default class BrowserTimings {
  suites = new Map();
  onTestBegin(test) {
    if (!this.suites.has(test.location.file))
      this.suites.set(test.location.file, { started: Date.now() / 1000, tests: new Map() });
  }
  onTestEnd(test, result) {
    this.onTestBegin(test);
    const suite = this.suites.get(test.location.file);
    suite.ended = Date.now() / 1000;
    suite.tests.set(test.id, { status: result.status, expected: test.expectedStatus });
  }
  onEnd() {
    for (const [file, suite] of this.suites) {
      const parent = "workspace_checks.browser-e2e";
      recordTiming({
        id: `${parent}.${basename(file)}`,
        parent,
        name: basename(file),
        started: suite.started,
        seconds: suite.ended - suite.started,
        tests: suite.tests.size,
        skipped: [...suite.tests.values()].filter((test) => test.status === "skipped").length,
        status: [...suite.tests.values()].every(
          (test) => test.status === "skipped" || test.status === test.expected,
        )
          ? 0
          : 1,
      });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [parent, ...args] = process.argv.slice(2);
  const timings = packageTimings(parent);
  const child = spawn("pnpm", ["--reporter=ndjson", ...args], {
    stdio: ["inherit", "pipe", "inherit"],
  });
  const finished = new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(error.message);
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
  });
  for await (const line of createInterface({ input: child.stdout })) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      console.log(line);
      continue;
    }
    timings.event(event);
  }
  const status = await finished;
  timings.finish(status);
  process.exitCode = status;
}
