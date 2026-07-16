import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  getCompany,
  getPerson,
  getPlanForPerson,
  PersonDetail,
  WORKSPACE_NOW,
} from "@/components/people";

const person = getPerson("20000000-0000-4000-8000-000000000001");

describe("person detail workspace", () => {
  it("orders the unified timeline, shows reply evidence, and applies reversible corrections", async () => {
    if (!person) throw new Error("Fixture person missing");
    const user = userEvent.setup();
    render(
      <PersonDetail
        initialPerson={person}
        company={person.companyId ? getCompany(person.companyId) : null}
        initialPlan={getPlanForPerson(person.id)}
        now={WORKSPACE_NOW}
      />,
    );

    expect(screen.getAllByText("Replied").length).toBeGreaterThan(0);
    const timeline = screen.getByLabelText(
      "Cross-channel relationship timeline",
    );
    const entries = within(timeline).getAllByRole("listitem");
    expect(entries[0]).toHaveTextContent("Planned follow-up");
    expect(entries[1]).toHaveTextContent("Maya replied on LinkedIn");
    expect(entries.at(-1)).toHaveTextContent("Relationship note");

    await user.click(
      screen.getAllByRole("button", { name: "Correct" })[0] as HTMLElement,
    );
    const dialog = screen.getByRole("dialog", { name: "Correct title" });
    const value = within(dialog).getByLabelText("Resolved value");
    await user.clear(value);
    await user.type(value, "VP, Product Partnerships");
    await user.type(
      within(dialog).getByLabelText("Reason, optional"),
      "Confirmed in a recent note.",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Save correction" }),
    );
    expect(screen.getByText("VP, Product Partnerships")).toBeInTheDocument();
    expect(screen.getAllByText("User override").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(
      screen.getAllByText("Director, Product Partnerships").length,
    ).toBeGreaterThan(0);
  });

  it("copies an internal suggestion and exposes no external message action", async () => {
    if (!person) throw new Error("Fixture person missing");
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(
      <PersonDetail
        initialPerson={person}
        company={person.companyId ? getCompany(person.companyId) : null}
        initialPlan={getPlanForPerson(person.id)}
        now={WORKSPACE_NOW}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy draft" }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Copied to clipboard" }),
    ).toBeInTheDocument();

    for (const forbidden of ["send", "reply", "post", "connect", "delete"]) {
      expect(
        screen.queryByRole("button", { name: new RegExp(forbidden, "i") }),
      ).not.toBeInTheDocument();
    }
  });
});
