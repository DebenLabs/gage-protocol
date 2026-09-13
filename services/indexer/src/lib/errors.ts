/** An error the API returns as `{ error: { code, message } }` with the given status (docs/api.md conventions). */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 404 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string): ApiError => new ApiError(400, code, message);
export const notFound = (code: string, message: string): ApiError => new ApiError(404, code, message);
