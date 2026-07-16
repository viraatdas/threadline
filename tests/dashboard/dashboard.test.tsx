import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  createDashboardDemoData,
  DashboardEmpty,
  DashboardError,
  DashboardLoading,
  DashboardOverview,
} from "@/components/dashboard";

const demoData = createDashboardDemoData(new Date("2026-07-15T17:00:00.000Z"));

describe("relationship intelligence overview", () => {
  it("prioritizes next actions before compact outreach evidence", () => {
    render(<DashboardOverview data={demoData} mode="demo" />);

    const nextActions = screen.getByRole("heading", { name: "Next actions" });
    const outreachSummary = screen.getByRole("heading", {
      name: "Outreach summary",
    });

    expect(
      nextActions.compareDocumentPosition(outreachSummary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Today’s relationship view" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Maya Chen")).toBeInTheDocument();
    expect(screen.getAllByText(/Model rationale/).length).toBeGreaterThan(0);
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: "Outbound outreach by channel" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", {
        name: "Recent customer outreach conversations",
      }),
    ).toBeInTheDocument();
  });

  it("exposes only safe open and copy actions", () => {
    render(<DashboardOverview data={demoData} />);

    expect(
      screen.queryByRole("button", { name: /send/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /reply/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "Open" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Copy follow-up suggestion" })
        .length,
    ).toBeGreaterThan(0);
  });

  it("copies a suggested follow-up with keyboard activation", async () => {
    const user = userEvent.setup();
    render(<DashboardOverview data={demoData} />);

    const copyButton = screen.getAllByRole("button", {
      name: "Copy follow-up suggestion",
    })[0];
    if (!copyButton) throw new Error("Expected a copy suggestion button.");

    copyButton.focus();
    await user.keyboard("{Enter}");

    expect(copyButton).toHaveAccessibleName("Follow-up suggestion copied");
    expect(copyButton).toHaveFocus();
  });

  it("labels source and analysis health without relying on color", () => {
    render(<DashboardOverview data={demoData} />);

    const systemHealth = screen
      .getByRole("heading", { name: "System health" })
      .closest("section");
    if (!systemHealth) throw new Error("Expected the system health section.");

    expect(within(systemHealth).getAllByText("Current")).toHaveLength(2);
    expect(
      within(systemHealth).getAllByText("Needs attention").length,
    ).toBeGreaterThan(0);
    expect(
      within(systemHealth).getByText("Analysis queue"),
    ).toBeInTheDocument();
    expect(within(systemHealth).getByText("Working")).toBeInTheDocument();
  });
});

describe("dashboard fallback states", () => {
  it("offers a useful empty-state path and isolated demo preview", () => {
    render(<DashboardEmpty />);

    expect(
      screen.getByRole("heading", { name: "No relationship threads yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Connect a source" }),
    ).toHaveAttribute("href", "/settings");
    expect(
      screen.getByRole("link", { name: /Preview with demo data/ }),
    ).toHaveAttribute("href", "/?demo=1");
  });

  it("announces read errors and confirms source safety", () => {
    render(<DashboardError message="Database unavailable." />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Database unavailable.",
    );
    expect(screen.getByText(/No source data was changed/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("announces the loading state without requiring animation", () => {
    render(<DashboardLoading />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading relationship overview.");
  });
});
