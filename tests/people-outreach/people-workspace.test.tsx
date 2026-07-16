import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { PeopleWorkspace, workspaceData } from "@/components/people";

const filters = {
  query: "",
  view: "people" as const,
  reply: "all" as const,
  channel: "all" as const,
  confidence: "all" as const,
};

describe("people and company workspace", () => {
  it("filters typed records through URL-backed controls and exposes responsive representations", async () => {
    const user = userEvent.setup();
    render(<PeopleWorkspace data={workspaceData} initialFilters={filters} />);

    expect(
      screen.getByText(
        "People with company, touch, reply, channel, confidence, and follow-up details",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("People cards")).toBeInTheDocument();

    await user.type(
      screen.getByRole("searchbox", { name: "Search people" }),
      "Arcminute",
    );
    expect(screen.getAllByText("Priya Shah").length).toBeGreaterThan(0);
    expect(screen.queryByText("Jon Bell")).not.toBeInTheDocument();
    expect(window.location.search).toContain("q=Arcminute");

    await user.click(screen.getByRole("button", { name: /Companies/ }));
    expect(
      screen.getByRole("searchbox", { name: "Search companies" }),
    ).toBeInTheDocument();
    expect(window.location.search).toContain("view=companies");
    expect(screen.getAllByText("Arcminute").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Companies with relationship, reply, channel, and follow-up metrics",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Company cards")).toBeInTheDocument();
  });

  it("adds and merges manual relationships with a reversible local mutation", async () => {
    const user = userEvent.setup();
    render(<PeopleWorkspace data={workspaceData} initialFilters={filters} />);

    await user.click(screen.getByRole("button", { name: "Add person" }));
    const addDialog = screen.getByRole("dialog", {
      name: "Add a relationship",
    });
    await user.type(within(addDialog).getByLabelText("Name"), "Nora Fields");
    await user.type(
      within(addDialog).getByLabelText("Company"),
      "Granite Works",
    );
    await user.type(within(addDialog).getByLabelText("Role"), "COO");
    await user.click(
      within(addDialog).getByRole("button", { name: "Add relationship" }),
    );
    expect(screen.getAllByText("Nora Fields").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Merge Jon Bell" }));
    const mergeDialog = screen.getByRole("dialog", {
      name: "Merge duplicate relationship",
    });
    await user.selectOptions(
      within(mergeDialog).getByLabelText("Merge target"),
      workspaceData.people[0]?.id ?? "",
    );
    await user.click(
      within(mergeDialog).getByRole("button", { name: "Merge records" }),
    );
    expect(screen.queryByText("Jon Bell")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getAllByText("Jon Bell").length).toBeGreaterThan(0);
  });
});
