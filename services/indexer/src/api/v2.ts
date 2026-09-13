import { Hono } from "hono";
import { db } from "ponder:api";
import { and, desc, eq, exists, gt, lt, sql } from "ponder";
import { v2Participants, v2Positions } from "ponder:schema";
import { isAddress, type Address } from "viem";
import { loadDeployment } from "../lib/deployment";

export const v2Api = new Hono();
const deployment = loadDeployment();
const configured = (value: string | undefined) => deployment.nativeV2?.engines.find(e => e.engine.toLowerCase() === value?.toLowerCase());

v2Api.get("/deployment", c => c.json({chainId: deployment.chainId, nativeV2: deployment.nativeV2 ?? null}));
v2Api.get("/positions", async c => {
  const engine = configured(c.req.query("engine"));
  if (!engine) return c.json({error: {code: "UNKNOWN_ENGINE", message: "Choose a published V2 engine."}}, 400);
  const account = c.req.query("account");
  const cursor = c.req.query("cursor");
  const state = c.req.query("state");
  const sale = c.req.query("sale");
  const lenderSale = c.req.query("lenderSale");
  const limit = Number(c.req.query("limit") ?? 50);
  if ((account && !isAddress(account)) || (cursor && !/^\d+$/.test(cursor)) || !Number.isInteger(limit) || limit < 1 || limit > 100
    || (sale && sale !== "true") || (lenderSale && lenderSale !== "true") || (state && !["funding", "active", "repaid", "defaulted", "cancelled"].includes(state))) {
    return c.json({error: {code: "BAD_QUERY", message: "Invalid V2 position filter."}}, 400);
  }
  const where = and(eq(v2Positions.engine, engine.engine.toLowerCase() as Address), state ? eq(v2Positions.state, state) : undefined,
    cursor ? lt(v2Positions.loanId, BigInt(cursor)) : undefined,
    sale ? and(eq(v2Positions.state, "active"), gt(v2Positions.askPrice, 0n), gt(v2Positions.askDeadline, BigInt(Math.floor(Date.now() / 1000)))) : undefined,
    lenderSale ? and(eq(v2Positions.state, "active"), gt(v2Positions.lenderAskDeadline, BigInt(Math.floor(Date.now() / 1000)))) : undefined,
    account ? exists(db.select({one: sql`1`}).from(v2Participants).where(and(eq(v2Participants.account, account.toLowerCase() as Address), eq(v2Participants.positionKey, v2Positions.key)))) : undefined);
  const rows = await db.select().from(v2Positions).where(where).orderBy(desc(v2Positions.loanId)).limit(limit + 1);
  return c.json({chainId: deployment.chainId, engine: engine.engine, items: rows.slice(0, limit).map(row => JSON.parse(row.snapshot)),
    nextCursor: rows.length > limit ? rows[limit - 1]!.loanId.toString() : null});
});
v2Api.get("/positions/:engine/:id", async c => {
  const engine = configured(c.req.param("engine"));
  const id = c.req.param("id");
  if (!engine || !/^\d+$/.test(id)) return c.json({error: {code: "NOT_FOUND", message: "Unknown V2 position."}}, 404);
  const key = `${deployment.chainId}:${engine.engine.toLowerCase()}:${BigInt(id)}`;
  const [row] = await db.select().from(v2Positions).where(eq(v2Positions.key, key)).limit(1);
  return row ? c.json(JSON.parse(row.snapshot)) : c.json({error: {code: "NOT_FOUND", message: "Position not indexed yet."}}, 404);
});
