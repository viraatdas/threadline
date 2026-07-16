import { describe, expect, it } from "vitest";

import { runWithRetry, SyncTimeoutError } from "@/src/sync/retry";

describe("sync retry policy", () => {
  it("aborts timed-out work without starting overlapping retries", async () => {
    let attempts = 0;
    await expect(
      runWithRetry({
        maxAttempts: 3,
        timeoutMs: 10,
        operation: (signal) => {
          attempts += 1;
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      }),
    ).rejects.toMatchObject({
      name: "SyncTimeoutError",
      attempts: 1,
    } satisfies Partial<SyncTimeoutError & { attempts: number }>);
    expect(attempts).toBe(1);
  });
});
