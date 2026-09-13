import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseConfig } from "../src/lib/database";

afterEach(() => vi.unstubAllEnvs());

describe("indexer database connection budget", () => {
  const postgres = () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/indexer_test");
    vi.stubEnv("INDEXER_DATABASE_POOL_MAX", undefined);
  };

  it("bounds Postgres connections when no override is set", () => {
    postgres();
    expect(databaseConfig()).toEqual({
      kind: "postgres",
      connectionString: "postgresql://localhost/indexer_test",
      poolConfig: { max: 5 },
    });
    vi.stubEnv("INDEXER_DATABASE_POOL_MAX", "");
    expect(databaseConfig().poolConfig?.max).toBe(5);
  });

  it("accepts an explicit pool budget", () => {
    postgres();
    vi.stubEnv("INDEXER_DATABASE_POOL_MAX", "8");
    expect(databaseConfig().poolConfig?.max).toBe(8);
  });

  it.each(["0", "1", "2", "3", "4", "-1", "5.5", "NaN", "Infinity"])("rejects unsafe pool budget %s", value => {
    postgres();
    vi.stubEnv("INDEXER_DATABASE_POOL_MAX", value);
    expect(() => databaseConfig()).toThrow(/INDEXER_DATABASE_POOL_MAX/);
  });

  it("keeps local PGlite independent of Postgres pool settings", () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("INDEXER_DATABASE_POOL_MAX", "0");
    vi.stubEnv("PGLITE_DIRECTORY", undefined);
    expect(databaseConfig()).toEqual({ kind: "pglite", directory: ".ponder/pglite" });
    vi.stubEnv("PGLITE_DIRECTORY", "/tmp/indexer-test");
    expect(databaseConfig()).toEqual({ kind: "pglite", directory: "/tmp/indexer-test" });
  });
});
