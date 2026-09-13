import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadDeployment } from "../src/deployment.js";
import { loadNativeZapDeployments } from "../src/native-v2.js";

// The hosted service boots from launch/live/<chainId>.json; a row that fails validation takes production down.
const live = resolve(import.meta.dirname, "../../../launch/live/4663.json");

describe("published mainnet deployment file", () => {
  it.skipIf(!existsSync(live))("parses with the same loaders the service boots with", () => {
    const d = loadDeployment(live);
    expect(d.chainId).toBe(4663);
    for (const [token, note] of Object.entries(d.collateralNotes ?? {})) {
      expect(note.note.length, `collateral note for ${token}`).toBeLessThanOrEqual(1000);
    }
    const native = loadNativeZapDeployments(live);
    expect(native.length).toBeGreaterThan(0);
  });
});
