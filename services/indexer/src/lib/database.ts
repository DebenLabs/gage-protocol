import { envInt, envString } from "./env";

export function databaseConfig() {
  const connectionString = envString("DATABASE_URL", "");
  if (connectionString === "") {
    return { kind: "pglite" as const, directory: envString("PGLITE_DIRECTORY", ".ponder/pglite") };
  }

  // Ponder reserves two admin connections and splits the remainder among its user,
  // readonly and sync pools. Below five, zero-sized pools fall back to pg's default of ten.
  // Five indexers share Postgres, and Railway keeps old deployments alive during rebuilds.
  const max = envInt("INDEXER_DATABASE_POOL_MAX", 5);
  if (max < 5) throw new Error("INDEXER_DATABASE_POOL_MAX must be at least 5");
  return { kind: "postgres" as const, connectionString, poolConfig: { max } };
}
