export type ErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "NO_POOL"
  | "NO_ROUTE"
  | "NO_LIQUIDITY"
  | "WRONG_CHAIN"
  | "RANGE_ONE_SIDED"
  | "UNSUPPORTED"
  | "RPC_ERROR"
  | "EXPLORER_ERROR";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  NO_POOL: 503,
  NO_ROUTE: 503,
  NO_LIQUIDITY: 503,
  WRONG_CHAIN: 503,
  RANGE_ONE_SIDED: 400,
  UNSUPPORTED: 400,
  RPC_ERROR: 502,
  EXPLORER_ERROR: 502
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.status = STATUS[code];
  }

  toJSON(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError("BAD_REQUEST", message);
}
