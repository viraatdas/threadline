import { describe, expect, it } from "vitest";

import { isAuthorizedCronRequest } from "@/src/sync/auth";
import { consumeCheckpointedPages } from "@/src/sync/checkpoint";

describe("scheduled sync authentication", () => {
  it("accepts only the configured bearer or cron header secret", () => {
    expect(
      isAuthorizedCronRequest(
        new Request("https://threadline.test/api/cron/sync", {
          headers: { authorization: "Bearer correct" },
        }),
        "correct",
      ),
    ).toBe(true);
    expect(
      isAuthorizedCronRequest(
        new Request("https://threadline.test/api/cron/sync", {
          headers: { "x-threadline-cron-secret": "correct" },
        }),
        "correct",
      ),
    ).toBe(true);
    expect(
      isAuthorizedCronRequest(
        new Request("https://threadline.test/api/cron/sync", {
          headers: { authorization: "Bearer wrong" },
        }),
        "correct",
      ),
    ).toBe(false);
  });
});

describe("cursor checkpointing", () => {
  it("checkpoints every successful page and stops before a failed page cursor", async () => {
    const checkpoints: string[] = [];
    const result = await consumeCheckpointedPages({
      pages: pages(),
      apply: async (page) => ({
        inserted: page.failed ? 0 : 1,
        failed: page.failed ? 1 : 0,
      }),
      cursor: (page) => page.cursor,
      failed: (pageResult) => pageResult.failed,
      checkpoint: async (cursor) => {
        checkpoints.push(cursor);
      },
      initial: { inserted: 0, failed: 0 },
      accumulate: (left, right) => ({
        inserted: left.inserted + right.inserted,
        failed: left.failed + right.failed,
      }),
    });

    expect(checkpoints).toEqual(["cursor-1"]);
    expect(result).toEqual({
      total: { inserted: 1, failed: 1 },
      cursor: "cursor-1",
    });
  });
});

async function* pages() {
  yield { cursor: "cursor-1", failed: false };
  yield { cursor: "cursor-2", failed: true };
  yield { cursor: "cursor-3", failed: false };
}
