import { describe, expect, it } from "vitest";
import { formatPosition } from "../src/lib/format";

const position: Parameters<typeof formatPosition>[0] = {
  tokenId: 2137331n,
  poolId: `0x${"ab".repeat(32)}`,
  owner: "0x00000000000000000000000000000000000000c1",
  tickLower: -600,
  tickUpper: 600,
  liquidity: 0n,
  weight: 0n,
  inRange: false,
  lastCheckpoint: 1788820000n,
  isSeed: false,
  createdAt: 1n,
  updatedAt: 2n,
};

describe("formatPosition (D64)", () => {
  const earned = { emissionsEarned: 100n, creatorFeeEarned: 10n, streamerEarned: 5n };
  it("carries the streamer's uncollected balance beside the LPRewards figures, as wei strings", () => {
    expect(formatPosition(position, earned, undefined, false)).toMatchObject({
      tokenId: "2137331", emissionsEarned: "100", creatorFeeEarned: "10", streamerEarned: "5", valueGAGE: "0", lastCheckpoint: 1788820000,
    });
  });
  it('renders "0" for a deployment without a streamer', () => {
    expect(formatPosition(position, { ...earned, streamerEarned: 0n }, undefined, false).streamerEarned).toBe("0");
  });
});
