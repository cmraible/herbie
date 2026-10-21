import { Template } from "e2b";
import { installEnvironmentRuntime } from "./environment-runtime.js";
import { e2bTemplateOptions } from "./e2b-template-options.js";

const { name, options } = e2bTemplateOptions(process.argv.slice(2));
// Optional operator command; the provider also builds templates automatically.
await Template.build(
  Template().fromImage("ubuntu:22.04").setUser("root").runCmd(installEnvironmentRuntime),
  name,
  options,
);
