import type { Repository } from "@herbie/contracts";

export function sortRepositories(repositories: readonly Repository[]): Repository[] {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...repositories].sort(
    (a, b) =>
      compare(a.fullName.toLowerCase(), b.fullName.toLowerCase()) ||
      compare(a.fullName, b.fullName),
  );
}
