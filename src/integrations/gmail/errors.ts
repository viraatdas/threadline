interface ErrorShape {
  code?: unknown;
  message?: unknown;
  response?: {
    status?: unknown;
    data?: unknown;
    headers?: unknown;
  };
}

export class GmailIntegrationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "GmailIntegrationError";
  }
}

export class GmailHistoryExpiredError extends GmailIntegrationError {
  constructor() {
    super(
      "The Gmail history cursor expired and requires a full synchronization.",
      "history_expired",
      404,
    );
    this.name = "GmailHistoryExpiredError";
  }
}

export class GmailAuthorizationError extends GmailIntegrationError {
  constructor(message = "Gmail authorization is no longer valid.") {
    super(message, "authorization_required", 401);
    this.name = "GmailAuthorizationError";
  }
}

export function normalizeGmailError(error: unknown): GmailIntegrationError {
  if (error instanceof GmailIntegrationError) return error;

  const candidate = isErrorShape(error) ? error : undefined;
  const status =
    numberValue(candidate?.response?.status) ?? numberValue(candidate?.code);
  const message = safeMessage(candidate?.message);
  const responseText = JSON.stringify(
    candidate?.response?.data ?? "",
  ).toLowerCase();
  const lowerMessage = message.toLowerCase();

  if (
    status === 401 ||
    responseText.includes("invalid_grant") ||
    lowerMessage.includes("invalid_grant")
  ) {
    return new GmailAuthorizationError();
  }

  const retryAfterMs = parseRetryAfter(candidate?.response?.headers);
  return new GmailIntegrationError(
    message,
    gmailErrorCode(status),
    status,
    retryAfterMs,
  );
}

export function isRetryableGmailError(error: unknown): boolean {
  const normalized = normalizeGmailError(error);
  return (
    normalized.status === 429 ||
    (normalized.status !== undefined && normalized.status >= 500)
  );
}

export function isNotFoundGmailError(error: unknown): boolean {
  return normalizeGmailError(error).status === 404;
}

function isErrorShape(value: unknown): value is ErrorShape {
  return typeof value === "object" && value !== null;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function safeMessage(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0)
    return "Gmail request failed.";
  return value.replace(/ya29\.[\w-]+/gi, "[redacted]").slice(0, 500);
}

function gmailErrorCode(status: number | undefined): string {
  if (status === 403) return "gmail_forbidden";
  if (status === 404) return "gmail_not_found";
  if (status === 429) return "gmail_rate_limited";
  if (status !== undefined && status >= 500) return "gmail_unavailable";
  return "gmail_request_failed";
}

function parseRetryAfter(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const raw = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "retry-after",
  )?.[1];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}
