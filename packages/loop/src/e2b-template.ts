import { Template } from "e2b";
import { installEnvironmentRuntime } from "./environment-runtime.js";

const name = process.argv[2];
if (!name) throw new Error("Usage: pnpm --filter @herbie/loop build:e2b-template <template-name>");
// Building is an explicit operator action; normal execution only uses existing templates.
await Template.build(
  Template().fromImage("ubuntu:22.04").setUser("root").runCmd(installEnvironmentRuntime),
  name,
  { cpuCount: 2, memoryMB: 4096 },
);
