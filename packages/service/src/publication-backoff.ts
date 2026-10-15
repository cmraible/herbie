// Equal jitter: 30–60 seconds initially, doubling to a 7.5–15 minute ceiling.
// Persist the failure count and chosen deadline; restarts must not reset either.
export function publicationBackoffMs(
  failureCount: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(900_000, 60_000 * 2 ** Math.min(4, Math.max(0, failureCount - 1)));
  return Math.floor(ceiling * (0.5 + Math.max(0, Math.min(1, random())) / 2));
}
