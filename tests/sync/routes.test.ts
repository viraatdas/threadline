import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  isOwnerSession: vi.fn(),
  isAuthorizedCronRequest: vi.fn(),
  runUnifiedSync: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
  isOwnerSession: mocks.isOwnerSession,
}));

vi.mock("@/src/sync/auth", () => ({
  boundedInvocationId: (_candidate: unknown, fallback: string) => fallback,
  isAuthorizedCronRequest: mocks.isAuthorizedCronRequest,
}));

vi.mock("@/src/sync/runtime", () => ({
  runUnifiedSync: mocks.runUnifiedSync,
}));

import { GET as scheduledSync } from "@/app/api/cron/sync/route";
import { POST as manualSync } from "@/app/api/sync/route";

describe("unified sync route status reporting", () => {
  beforeEach(() => {
    mocks.auth
      .mockReset()
      .mockResolvedValue({ user: { email: "owner@example.com" } });
    mocks.isOwnerSession.mockReset().mockReturnValue(true);
    mocks.isAuthorizedCronRequest.mockReset().mockReturnValue(true);
    mocks.runUnifiedSync.mockReset();
  });

  it.each([
    ["manual", () => manualSync(syncRequest("/api/sync", "POST"))],
    ["scheduled", () => scheduledSync(syncRequest("/api/cron/sync", "GET"))],
  ])("returns 502 when the %s summary failed", async (_name, invoke) => {
    mocks.runUnifiedSync.mockResolvedValue(summary("failed"));

    const response = await invoke();

      expect(response.status).toBe(502);
      expect(mocks.runUnifiedSync).toHaveBeenCalledWith(
        expect.objectContaining({
          maxConcurrency: 3,
          maxAttempts: 2,
          timeoutMs: 120_000,
        }),
      );
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      summary: { status: "failed" },
    });
  });

  it.each([
    ["manual", () => manualSync(syncRequest("/api/sync", "POST"))],
    ["scheduled", () => scheduledSync(syncRequest("/api/cron/sync", "GET"))],
  ])(
    "keeps a %s partial summary as a truthful success",
    async (_name, invoke) => {
      mocks.runUnifiedSync.mockResolvedValue(summary("partial"));

      const response = await invoke();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        summary: { status: "partial" },
      });
    },
  );

  it("preserves owner authorization on manual sync", async () => {
    mocks.isOwnerSession.mockReturnValue(false);

    const response = await manualSync(syncRequest("/api/sync", "POST"));

    expect(response.status).toBe(401);
    expect(mocks.runUnifiedSync).not.toHaveBeenCalled();
  });

  it("preserves cron authorization on scheduled sync", async () => {
    mocks.isAuthorizedCronRequest.mockReturnValue(false);

    const response = await scheduledSync(syncRequest("/api/cron/sync", "GET"));

    expect(response.status).toBe(401);
    expect(mocks.runUnifiedSync).not.toHaveBeenCalled();
  });
});

function syncRequest(path: string, method: "GET" | "POST") {
  return new Request(`http://localhost${path}`, {
    method,
    ...(method === "POST"
      ? { headers: { "content-type": "application/json" }, body: "{}" }
      : {}),
  });
}

function summary(status: "partial" | "failed") {
  return {
    invocationId: "test-invocation",
    trigger: "manual" as const,
    status,
    startedAt: "2026-07-16T00:00:00.000Z",
    completedAt: "2026-07-16T00:00:01.000Z",
    outcomes: [],
  };
}
