import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PeopleWorkspace, workspaceData } from "@/components/people";
import { isOutreach } from "@/components/people/people-board";

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

  it("moves a relationship across the board and persists through the stage action", async () => {
    const user = userEvent.setup();
    const ana = workspaceData.people.find(
      (person) => person.displayName === "Ana Torres",
    );
    expect(ana?.relationshipStage).toBe("planned");
    const moveStageAction = vi.fn(async () => ({
      ok: true as const,
      data: {
        contactId: ana?.id ?? "",
        actorEmail: "owner@threadline.local",
        occurredAt: new Date().toISOString(),
      },
    }));

    render(
      <PeopleWorkspace
        data={workspaceData}
        initialFilters={filters}
        moveStageAction={moveStageAction}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Board" }));
    expect(window.location.search).toContain("view=board");
    expect(
      screen.getByRole("heading", { name: /relationships by stage/ }),
    ).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Move Ana Torres to a stage" }),
      "active",
    );

    await waitFor(() =>
      expect(moveStageAction).toHaveBeenCalledWith(ana?.id, "active"),
    );
    expect(
      screen.getByRole("combobox", { name: "Move Ana Torres to a stage" }),
    ).toHaveValue("active");
  });

  it("defaults the board to outreach the owner started, with wider lenses", async () => {
    const user = userEvent.setup();
    const outreachCount = workspaceData.people.filter((person) =>
      isOutreach(person, null),
    ).length;

    render(
      <PeopleWorkspace
        data={workspaceData}
        initialFilters={{ ...filters, view: "board" }}
      />,
    );

    const lens = screen.getByRole("combobox", { name: /show/i });
    expect(lens).toHaveValue("outreach");
    expect(
      screen.getByRole("heading", {
        name: `${outreachCount} relationships by stage`,
      }),
    ).toBeInTheDocument();

    await user.selectOptions(lens, "all");
    expect(
      screen.getByRole("heading", {
        name: `${workspaceData.people.length} relationships by stage`,
      }),
    ).toBeInTheDocument();
  });

  it("deletes a relationship from the board and restores it through undo", async () => {
    const user = userEvent.setup();
    const ana = workspaceData.people.find(
      (person) => person.displayName === "Ana Torres",
    );
    const receipt = {
      ok: true as const,
      data: {
        contactId: ana?.id ?? "",
        actorEmail: "owner@threadline.local",
        occurredAt: new Date().toISOString(),
      },
    };
    const archiveContactAction = vi.fn(async () => receipt);
    const restoreContactAction = vi.fn(async () => receipt);

    render(
      <PeopleWorkspace
        data={workspaceData}
        initialFilters={{ ...filters, view: "board" }}
        archiveContactAction={archiveContactAction}
        restoreContactAction={restoreContactAction}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete Ana Torres" }),
    );
    expect(screen.queryByText("Ana Torres")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(archiveContactAction).toHaveBeenCalledWith(ana?.id),
    );

    await user.click(await screen.findByRole("button", { name: "Undo" }));
    expect(screen.getAllByText("Ana Torres").length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(restoreContactAction).toHaveBeenCalledWith(ana?.id),
    );
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
