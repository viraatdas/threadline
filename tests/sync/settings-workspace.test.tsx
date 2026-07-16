/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsWorkspace } from "@/components/settings/settings-workspace";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsWorkspace sync reporting", () => {
  it("distinguishes partial syncs and lists per-channel attention", async () => {
    mockFetch({
      ok: true,
      summary: {
        status: "partial",
        outcomes: [
          { channel: "gmail", displayName: "Gmail", status: "succeeded" },
          {
            channel: "linkedin",
            displayName: "LinkedIn",
            status: "failed",
            errorMessage: "Credentials rejected by provider",
          },
          { channel: "x", displayName: "X", status: "partial" },
        ],
      },
    });
    const user = userEvent.setup();
    render(<SettingsWorkspace />);

    await user.click(
      await screen.findByRole("button", { name: "Sync all sources" }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Sync partially completed. LinkedIn: Credentials rejected by provider; X: needs attention.",
    );
  });

  it.each([
    { ok: false, summary: { status: "succeeded", outcomes: [] } },
    { ok: true, summary: { status: "failed", outcomes: [] } },
    { ok: true, summary: { status: "unknown", outcomes: [] } },
  ])(
    "does not report a 2xx false-success payload as completed",
    async (payload) => {
      mockFetch(payload);
      const user = userEvent.setup();
      render(<SettingsWorkspace />);

      await user.click(
        await screen.findByRole("button", { name: "Sync all sources" }),
      );

      expect(await screen.findByRole("status")).toHaveTextContent(
        "Sync could not be completed. Review the connection status and try again.",
      );
      expect(
        screen.queryByText("Sync request completed."),
      ).not.toBeInTheDocument();
    },
  );
});

function mockFetch(syncPayload: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url === "/api/sync") {
        return jsonResponse(syncPayload);
      }
      if (url === "/api/integrations/gmail/status") {
        return jsonResponse({
          connected: true,
          accountEmail: "owner@example.com",
        });
      }
      if (url === "/api/integrations/linkedin/status") {
        return jsonResponse({ connected: true, displayName: "Owner" });
      }
      if (url === "/api/integrations/x/health") {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
