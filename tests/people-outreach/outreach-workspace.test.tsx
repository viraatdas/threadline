import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { workspaceData } from "@/components/people";
import { OutreachWorkspace, groupOutreachPlans } from "@/components/outreach";

const filters = {
  query: "",
  channel: "all" as const,
  ownerState: "all" as const,
};

describe("outreach queue", () => {
  it("groups reply and timing states deterministically", () => {
    const grouped = groupOutreachPlans(
      workspaceData.plans,
      workspaceData.generatedAt,
    );
    expect(grouped.planned.map((plan) => plan.contactId)).toContain(
      "20000000-0000-4000-8000-000000000005",
    );
    expect(grouped.due.map((plan) => plan.contactId)).toContain(
      "20000000-0000-4000-8000-000000000003",
    );
    expect(grouped.waiting.map((plan) => plan.contactId)).toContain(
      "20000000-0000-4000-8000-000000000006",
    );
    expect(grouped.replied.map((plan) => plan.contactId)).toContain(
      "20000000-0000-4000-8000-000000000001",
    );
    expect(grouped.stale.map((plan) => plan.contactId)).toContain(
      "20000000-0000-4000-8000-000000000002",
    );
  });

  it("marks complete, undoes, reschedules, retries a draft, and keeps filters in the URL", async () => {
    const user = userEvent.setup();
    render(<OutreachWorkspace data={workspaceData} initialFilters={filters} />);

    const priyaArticle = screen.getByText("Priya Shah").closest("article");
    if (!priyaArticle) throw new Error("Priya outreach card missing");
    await user.click(
      within(priyaArticle).getByRole("button", { name: "Mark complete" }),
    );
    expect(screen.queryByText("Priya Shah")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("Priya Shah")).toBeInTheDocument();

    const jonArticle = screen.getByText("Jon Bell").closest("article");
    if (!jonArticle) throw new Error("Jon outreach card missing");
    await user.click(
      within(jonArticle).getByRole("button", { name: "Reschedule" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Reschedule follow-up review",
    });
    const dateInput = within(dialog).getByLabelText("New review date");
    await user.clear(dateInput);
    await user.type(dateInput, "2026-07-25");
    await user.click(within(dialog).getByRole("button", { name: "Save date" }));
    expect(
      within(
        screen
          .getByRole("heading", { name: /Planned/ })
          .closest("section") as HTMLElement,
      ).getByText("Jon Bell"),
    ).toBeInTheDocument();

    const marcusArticle = screen.getByText("Marcus Liu").closest("article");
    if (!marcusArticle) throw new Error("Marcus outreach card missing");
    await user.click(
      within(marcusArticle).getByRole("button", { name: "Retry" }),
    );
    expect(within(marcusArticle).getByText(/Draft ready/)).toBeInTheDocument();

    await user.type(
      screen.getByRole("searchbox", { name: "Search outreach" }),
      "Northstar",
    );
    expect(window.location.search).toContain("q=Northstar");
    expect(screen.queryByText("Jon Bell")).not.toBeInTheDocument();
  });

  it("offers copy-only draft controls and no external write action", () => {
    render(<OutreachWorkspace data={workspaceData} initialFilters={filters} />);
    expect(
      screen.getAllByRole("button", { name: "Copy draft" }).length,
    ).toBeGreaterThan(0);
    for (const forbidden of ["send", "reply", "post", "connect", "delete"]) {
      expect(
        screen.queryByRole("button", { name: new RegExp(forbidden, "i") }),
      ).not.toBeInTheDocument();
    }
  });
});
