import { writeFile } from "node:fs/promises";
import { testEnv } from "./test-env";
await writeFile(
  ".dev.vars",
  Object.entries(testEnv())
    .map(([key, value]) => key + "=" + JSON.stringify(value))
    .join("\n") + "\n",
  { mode: 0o600 },
);
