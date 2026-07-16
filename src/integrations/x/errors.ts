export const X_INTEGRATION_ERROR_CODES = [
  "X_AUTH_EXPIRED",
  "X_ENDPOINT_ROTATED",
  "X_RATE_LIMITED",
  "X_BIRD_UNAVAILABLE",
  "X_BIRD_DM_UNSUPPORTED",
  "X_INVALID_RESPONSE",
  "X_PAGE_LIMIT_EXCEEDED",
  "X_UPSTREAM_FAILED",
] as const;

export type XIntegrationErrorCode = (typeof X_INTEGRATION_ERROR_CODES)[number];

export class XIntegrationError extends Error {
  readonly code: XIntegrationErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    code: XIntegrationErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean; status?: number },
  ) {
    super(message, { cause: options?.cause });
    this.name = "XIntegrationError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status;
  }
}

export function toXIntegrationError(error: unknown): XIntegrationError {
  if (error instanceof XIntegrationError) return error;
  return new XIntegrationError(
    "X_UPSTREAM_FAILED",
    error instanceof Error ? error.message : "X direct-message sync failed.",
    { cause: error, retryable: true },
  );
}

export function classifyXResponseFailure(
  status: number,
  body: string,
): XIntegrationError {
  const normalized = body.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    normalized.includes("could not authenticate") ||
    normalized.includes("bad authentication") ||
    normalized.includes("login required") ||
    normalized.includes('"code":32') ||
    normalized.includes('"code":89')
  ) {
    return new XIntegrationError(
      "X_AUTH_EXPIRED",
      "X rejected the session cookies. Refresh auth_token and ct0, then reconnect the integration.",
      { status },
    );
  }

  if (status === 429) {
    return new XIntegrationError(
      "X_RATE_LIMITED",
      "X rate-limited the DM read request.",
      {
        status,
        retryable: true,
      },
    );
  }

  if (
    status === 404 ||
    normalized.includes("persistedquerynotfound") ||
    normalized.includes("unknown operation") ||
    normalized.includes("query id")
  ) {
    return new XIntegrationError(
      "X_ENDPOINT_ROTATED",
      "X rotated a private DM endpoint or query ID. The integration was stopped before advancing its cursor.",
      { status },
    );
  }

  return new XIntegrationError(
    "X_UPSTREAM_FAILED",
    `X DM read failed with HTTP ${status}.`,
    { status, retryable: status >= 500 },
  );
}
