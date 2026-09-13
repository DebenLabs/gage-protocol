/** Public diagnostic codes are a closed vocabulary: never log provider messages, URLs or response bodies. */
export const SAFE_ERROR_CODES = [
  "indexer_http_400", "indexer_http_401", "indexer_http_403", "indexer_http_404", "indexer_http_429",
  "indexer_http_500", "indexer_http_502", "indexer_http_503", "indexer_http_504", "indexer_http_error",
  "indexer_timeout", "indexer_network_error", "indexer_invalid_json", "indexer_invalid_response",
  "indexer_identity_mismatch", "indexer_snapshot_mismatch", "indexer_snapshot_changed", "indexer_snapshot_stale",
  "indexer_pagination_invalid", "indexer_pagination_cursor_repeated", "indexer_unavailable",
  "rpc_timeout", "rpc_transport_error", "rpc_rate_limited", "rpc_error", "rpc_unavailable", "contract_reverted",
  "transaction_confirmation_timeout", "transaction_receipt_unavailable", "insufficient_gas", "chain_mismatch",
  "journal_identity_mismatch", "journal_nonce_consumed", "journal_signature_mismatch", "journal_pending",
  "signer_required", "configuration_invalid", "strategy_unknown", "storage_missing", "storage_permission_denied",
  "storage_full", "unknown_error",
] as const;
export type SafeErrorCode = typeof SAFE_ERROR_CODES[number];
const allowedCodes = new Set<string>(SAFE_ERROR_CODES);

export class KeeperDiagnosticError extends Error {
  constructor(readonly code: SafeErrorCode) {
    super(code);
    this.name = "KeeperDiagnosticError";
  }
}

const messages = new Map<string, SafeErrorCode>([
  ["Earn indexer unavailable", "indexer_unavailable"],
  ["Invalid Earn indexer response", "indexer_invalid_response"],
  ["Earn indexer identity mismatch", "indexer_identity_mismatch"],
  ["Earn strategy identity mismatch", "indexer_identity_mismatch"],
  ["Earn snapshot identity mismatch", "indexer_identity_mismatch"],
  ["Earn indexer snapshot mismatch", "indexer_snapshot_mismatch"],
  ["Earn snapshot changed repeatedly", "indexer_snapshot_changed"],
  ["Earn indexer snapshot stale", "indexer_snapshot_stale"],
  ["Invalid Earn pagination", "indexer_pagination_invalid"],
  ["Earn pagination cursor repeated", "indexer_pagination_cursor_repeated"],
  ["Earn RPC unavailable", "rpc_unavailable"],
  ["Earn deployment chain mismatch", "chain_mismatch"],
  ["Unknown Earn strategy", "strategy_unknown"],
  ["journal-identity-mismatch", "journal_identity_mismatch"],
  ["journal-nonce-consumed", "journal_nonce_consumed"],
  ["journal-signature-mismatch", "journal_signature_mismatch"],
  ["unresolved-journal-transaction", "journal_pending"],
  ["local-signer-required", "signer_required"],
  ["Invalid Earn worker bounds", "configuration_invalid"],
  ["KEEPER_KEY must be a 0x-prefixed 32-byte hex private key", "configuration_invalid"],
]);
const names = new Map<string, SafeErrorCode>([
  ["TimeoutError", "rpc_timeout"],
  ["HttpRequestError", "rpc_transport_error"],
  ["WebSocketRequestError", "rpc_transport_error"],
  ["SocketClosedError", "rpc_transport_error"],
  ["RpcRequestError", "rpc_error"],
  ["InternalRpcError", "rpc_error"],
  ["LimitExceededRpcError", "rpc_rate_limited"],
  ["ContractFunctionRevertedError", "contract_reverted"],
  ["ExecutionRevertedError", "contract_reverted"],
  ["WaitForTransactionReceiptTimeoutError", "transaction_confirmation_timeout"],
  ["TransactionReceiptNotFoundError", "transaction_receipt_unavailable"],
  ["InsufficientFundsError", "insufficient_gas"],
  ["ChainMismatchError", "chain_mismatch"],
]);
const storageCodes = new Map<string, SafeErrorCode>([
  ["ENOENT", "storage_missing"], ["EACCES", "storage_permission_denied"],
  ["EPERM", "storage_permission_denied"], ["ENOSPC", "storage_full"],
]);

/** Inspect a bounded cause chain, including viem wrappers. Unknown text always stays private. */
export function safeErrorCode(error: unknown): SafeErrorCode {
  let current: unknown = error;
  let fallback: SafeErrorCode = "unknown_error";
  const seen = new Set<object>();
  try {
    for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
      if (seen.has(current)) break;
      seen.add(current);
      if (current instanceof KeeperDiagnosticError && allowedCodes.has(current.code)) return current.code;
      const candidate = current as { message?: unknown; name?: unknown; cause?: unknown; code?: unknown; status?: unknown };
      const messageCode = typeof candidate.message === "string" ? messages.get(candidate.message) : undefined;
      if (messageCode) return messageCode;
      const storageCode = typeof candidate.code === "string" ? storageCodes.get(candidate.code) : undefined;
      if (storageCode) return storageCode;
      const nameCode = typeof candidate.name === "string" ? names.get(candidate.name) : undefined;
      if (candidate.name === "HttpRequestError" && candidate.status === 429) return "rpc_rate_limited";
      // viem's outer request/execution errors often wrap a more useful transport or timeout cause.
      if (nameCode === "rpc_transport_error" || nameCode === "rpc_error") fallback = nameCode;
      else if (nameCode) return nameCode;
      current = candidate.cause;
    }
  } catch { /* Diagnostic inspection must not make error handling fail. */ }
  return fallback;
}
