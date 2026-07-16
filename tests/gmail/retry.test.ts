import { describe, expect, it } from "vitest";

import { withGmailRetry } from "@/src/integrations/gmail/retry";

describe("Gmail retry policy", () => {
  it("uses bounded exponential backoff for rate limits and server errors", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const result = await withGmailRetry(
      async () => {
        attempts += 1;
        if (attempts < 3)
          throw {
            response: { status: attempts === 1 ? 429 : 503 },
            message: "retry",
          };
        return "ok";
      },
      {
        baseDelayMs: 100,
        random: () => 0.5,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("does not retry non-transient client failures", async () => {
    let attempts = 0;
    await expect(
      withGmailRetry(async () => {
        attempts += 1;
        throw { response: { status: 400 }, message: "bad request" };
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(attempts).toBe(1);
  });
});
