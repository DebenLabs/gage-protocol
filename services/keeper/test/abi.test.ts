/**
 * The keeper embeds its ABIs as human-readable signatures. When a forge build is present, every function and
 * error selector here must exist in the compiled interface, so a contract change cannot silently desync us.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, toBytes, type Abi } from "viem";
import { formatAbiItem } from "viem/utils";
import { describe, expect, it } from "vitest";
import {
  buybackAbi,
  collateralRegistryAbi,
  creatorFeeSplitterAbi,
  dealRewardsAbi,
  dealVaultAbi,
  dripAbi,
  emissionsAbi,
  feeSinkAbi,
  lpRewardsAbi,
  lpStreamerAbi,
} from "../src/abi.js";

import { earnAbi, earnCoreAbi, earnCoreRewardsAbi } from "../src/earn-abi.js";

const OUT = resolve(import.meta.dirname, "../../../contracts/out");

const cases: [string, Abi][] = [
  ["HybridVault", earnAbi],
  ["GageV2Rewards", earnCoreRewardsAbi],
  ["GageV2Vault", earnCoreAbi],
  ["IDealVault", dealVaultAbi],
  ["FeeSink", feeSinkAbi],
  // The keeper also reads `owner()` and `EMISSIONS()`, which the concrete contract carries, not the interface.
  ["DealRewards", dealRewardsAbi],
  ["IEmissions", emissionsAbi],
  ["ILPRewards", lpRewardsAbi],
  ["ILPStreamer", lpStreamerAbi],
  ["IDrip", dripAbi],
  ["ICollateralRegistry", collateralRegistryAbi],
  ["IBuyback", buybackAbi],
  ["ICreatorFeeSplitter", creatorFeeSplitterAbi],
];

/** Signature hashes for functions, errors and events (4 bytes is enough to compare). */
function selectors(abi: Abi): Set<string> {
  const out = new Set<string>();
  for (const item of abi) {
    if (item.type === "function" || item.type === "error" || item.type === "event") {
      out.add(`${item.type} ${keccak256(toBytes(formatAbiItem(item))).slice(0, 10)}`);
    }
  }
  return out;
}

describe.skipIf(!existsSync(OUT))("embedded ABIs match contracts/out", () => {
  for (const [name, abi] of cases) {
    it(name, () => {
      const path = resolve(OUT, `${name}.sol/${name}.json`);
      const compiled = (JSON.parse(readFileSync(path, "utf8")) as { abi: Abi }).abi;
      const have = selectors(compiled);
      const missing = [...selectors(abi)].filter((s) => !have.has(s));
      expect(missing, `selectors missing from compiled ${name}`).toEqual([]);
    });
  }
});
