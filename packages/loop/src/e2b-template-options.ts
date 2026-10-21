export function e2bTemplateOptions(args: string[]) {
  const [name, ...sizes] = args;
  if (!name?.trim() || (sizes.length !== 0 && sizes.length !== 3))
    throw new Error(
      "Usage: pnpm --filter @herbie/loop build:e2b-template <template-name> [<cpu> <memory-GiB> <minimum-free-disk-GiB>]",
    );
  const [cpu, memory, disk] = sizes.map(Number);
  if (
    sizes
      .map(Number)
      .some(
        (size) => !Number.isSafeInteger(size) || size <= 0 || size > Number.MAX_SAFE_INTEGER / 1024,
      )
  )
    throw new Error("Template resources must be positive whole numbers in cores and GiB.");
  return {
    name,
    options: {
      cpuCount: cpu ?? 2,
      memoryMB: (memory ?? 4) * 1024,
      ...(disk !== undefined ? { minFreeDiskMb: disk * 1024 } : {}),
    },
  };
}
