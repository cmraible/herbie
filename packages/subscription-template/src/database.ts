import { Pool } from "pg";
export function database(url: string) {
  return new Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10000,
  });
}
