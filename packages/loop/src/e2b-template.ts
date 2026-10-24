import { Template } from "e2b";
import { environmentBaseImage, installEnvironmentRuntime } from "./environment-runtime.js";
import { e2bTemplateOptions } from "./e2b-template-options.js";
import { refreshE2BOs } from "./e2b-os.js";

const { name, options } = e2bTemplateOptions(process.argv.slice(2));
// Optional operator command; the provider also builds templates automatically.
await Template.build(
  Template()
    .fromImage(environmentBaseImage)
    .setUser("root")
    .runCmd(refreshE2BOs)
    .runCmd(installEnvironmentRuntime),
  name,
  { ...options, skipCache: true },
);
