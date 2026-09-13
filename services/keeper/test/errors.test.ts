import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, ExecutionRevertedError, HttpRequestError, TimeoutError, type BaseError } from "viem";
import { KeeperDiagnosticError, SAFE_ERROR_CODES, safeErrorCode } from "../src/errors.js";

const secret = "https://user:private-password@provider.invalid/private-api-key?token=private-token";
const wrapped = (cause: BaseError) => new ContractFunctionExecutionError(cause, { abi: [], functionName: "read" });

describe("safe keeper error diagnosis", () => {
  it("finds a viem timeout inside contract and HTTP wrappers without mistaking a failed read for a revert", () => {
    const timeout = new TimeoutError({ url: secret, body: { privateKey: "private-key" } });
    const error = wrapped(new HttpRequestError({ url: secret, cause: timeout }));
    expect(safeErrorCode(error)).toBe("rpc_timeout");
    expect(safeErrorCode(wrapped(new HttpRequestError({ url: secret, status: 503 })))).toBe("rpc_transport_error");
    expect(safeErrorCode(wrapped(new HttpRequestError({ url: secret, status: 429 })))).toBe("rpc_rate_limited");
    expect(safeErrorCode(wrapped(new ExecutionRevertedError({ message: secret })))).toBe("contract_reverted");
  });

  it("only accepts exact known messages and fixed typed codes", () => {
    expect(safeErrorCode(new Error("Earn indexer snapshot stale"))).toBe("indexer_snapshot_stale");
    expect(safeErrorCode(new Error("journal-nonce-consumed"))).toBe("journal_nonce_consumed");
    expect(safeErrorCode(new KeeperDiagnosticError("indexer_http_503"))).toBe("indexer_http_503");
    for (const error of [new Error(secret), new Error(`Earn indexer snapshot stale ${secret}`), secret, { code: secret, name: secret, message: secret }]) {
      expect(safeErrorCode(error)).toBe("unknown_error");
    }
    const forged = Object.assign(new KeeperDiagnosticError("indexer_http_503"), { code: secret });
    expect(safeErrorCode(forged)).toBe("unknown_error");
  });

  it("never leaks arbitrary text or throws on a cyclic or hostile cause chain", () => {
    const cyclic = new Error(secret); cyclic.cause = cyclic;
    const hostile = Object.defineProperty({}, "message", { get: () => { throw new Error(secret); } });
    for (const error of [cyclic, hostile, null, undefined, 503, new SyntaxError(secret)]) {
      expect(() => safeErrorCode(error)).not.toThrow();
      expect(SAFE_ERROR_CODES).toContain(safeErrorCode(error));
      expect(safeErrorCode(error)).not.toContain("private");
    }
    let deep = new Error("Earn indexer snapshot stale");
    for (let n = 0; n < 8; n++) deep = new Error(secret, { cause: deep });
    expect(safeErrorCode(deep)).toBe("unknown_error");
  });

  it("classifies disk failures without exposing the journal path", () => {
    expect(safeErrorCode(Object.assign(new Error(secret), { code: "ENOSPC", path: secret }))).toBe("storage_full");
    expect(safeErrorCode(Object.assign(new Error(secret), { code: "EACCES", path: secret }))).toBe("storage_permission_denied");
  });
});
