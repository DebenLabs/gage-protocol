// GET /streamer (docs/api.md, D64): the LP streamer's pots, deposits and collections from the indexed events, with
// its live figures read from the chain at one pinned block, the way /positions/:wallet reads LPRewards.earned.
import { db } from "ponder:api";
import { lpStreamerCollected, lpStreamerDeposits, lpStreamerEpochs } from "ponder:schema";
import { asc, desc } from "ponder";

import { notFound } from "../lib/errors";
import type { Reader } from "../lib/live-lp-earnings";
import { liveStreamerState, streamerUnavailable } from "../lib/live-streamer";
import { deployment } from "./views";

export type StreamerJson = {
  address: string;
  currentEpoch: number;
  assignedThrough: number;
  pending: string;
  epochs: { epoch: number; pot: string; rate: string }[];
  deposits: { from: string; amount: string; forEpoch: number; at: number; tx: string }[];
  collectedTotal: string;
};

/** Deposits served, newest first; the per-epoch pots carry the totals whatever the count. */
export const DEPOSIT_LIMIT = 200;

/** `reader` is called only once the deployment is known to have a streamer, so a missing RPC is a 503, not a 404. */
export async function streamerSummary(reader: () => Reader): Promise<StreamerJson> {
  const streamer = deployment.token.LPStreamer;
  if (streamer === undefined) throw notFound("STREAMER_ABSENT", "This deployment has no LP streamer.");
  // The streamer takes its epoch from the Emissions it was built on; a json with one key and not the other is broken.
  const emissions = deployment.token.Emissions;
  if (emissions === undefined) throw streamerUnavailable();
  let client: Reader;
  try {
    client = reader();
  } catch {
    throw streamerUnavailable();
  }
  const [live, epochRows, depositRows, collectedRows] = await Promise.all([
    liveStreamerState(client, streamer, emissions),
    db.select().from(lpStreamerEpochs).orderBy(asc(lpStreamerEpochs.epoch)),
    db.select().from(lpStreamerDeposits).orderBy(desc(lpStreamerDeposits.at), desc(lpStreamerDeposits.id)).limit(DEPOSIT_LIMIT),
    db.select().from(lpStreamerCollected),
  ]);
  let collectedTotal = 0n;
  for (const row of collectedRows) collectedTotal += row.collectedTotal;
  return {
    address: streamer,
    currentEpoch: Number(live.currentEpoch),
    assignedThrough: Number(live.assignedThrough),
    pending: live.pending.toString(),
    epochs: epochRows.map((e) => ({ epoch: Number(e.epoch), pot: e.pot.toString(), rate: e.rate.toString() })),
    deposits: depositRows.map((d) => ({ from: d.from, amount: d.amount.toString(), forEpoch: Number(d.forEpoch), at: Number(d.at), tx: d.tx })),
    collectedTotal: collectedTotal.toString(),
  };
}
