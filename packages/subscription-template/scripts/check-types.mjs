import { readdir, readFile } from "node:fs/promises";
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = dir + "/" + entry.name;
    if (entry.isDirectory()) await check(path);
    else if (/\.[cm]?tsx?$/.test(path)) {
      const source = await readFile(path, "utf8");
      if (/@ts-(ignore|nocheck|expect-error)/.test(source))
        throw new Error(path + ": TypeScript suppression forbidden");
    }
  }
}
for (const dir of ["src", "scripts", "tests"]) await check(dir);
