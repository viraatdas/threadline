import {
  isRetryableGmailError,
  normalizeGmailError,
} from "@/src/integrations/gmail/errors";

export interface GmailRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
}

export async function withGmailRetry<T>(
  operation: () => Promise<T>,
  options: GmailRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      const normalized = normalizeGmailError(error);
      if (attempt === attempts - 1 || !isRetryableGmailError(normalized))
        throw normalized;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jittered = Math.round(exponential * (0.75 + random() * 0.5));
      await sleep(normalized.retryAfterMs ?? jittered, options.signal);
    }
  }

  throw new Error("Gmail retry loop exited unexpectedly.");
}

async function abortableSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Operation aborted."),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
