import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PeopleBoard } from "@/components/people/people-board";
import { workspaceData } from "@/components/people";
import type { MatchProjectAction } from "@/components/people/projects";
import { PROJECT_STORAGE_KEY } from "@/components/people/projects";
import type { PersonRecord } from "@/components/people/types";

// jsdom here provides no localStorage; install a minimal in-memory stub so the
// board can seed and persist projects/verdicts.
beforeAll(() => {
  if (typeof window.localStorage === "undefined") {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size;
        },
      },
    });
  }
});

beforeEach(() => {
  window.localStorage.clear();
});

// Two people from the sample set, one clearly on-topic for Libra, one not.
function fixturePeople(): PersonRecord[] {
  const [a, b] = workspaceData.people;
  if (!a || !b) throw new Error("sample data has too few people");
  return [
    { ...a, id: "sre-1", displayName: "Priya Nair", hasManualOverride: true },
    { ...b, id: "vendor-1", displayName: "Travel Weekly", hasManualOverride: true },
  ];
}

describe("PeopleBoard projects UI", () => {
  it("renders the project controls with the seeded Libra project", () => {
    render(
      <PeopleBoard
        people={fixturePeople()}
        companies={workspaceData.companies}
        generatedAt={workspaceData.generatedAt}
        ownerDomain="exla.ai"
      />,
    );
    expect(screen.getByText("Project")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New project" }),
    ).toBeInTheDocument();
    // The Libra starter is seeded as a selectable option.
    expect(
      screen.getByRole("option", { name: "Libra" }),
    ).toBeInTheDocument();
  });

  it("shows no AI match button when no owner action is wired (demo/read-only)", async () => {
    render(
      <PeopleBoard
        people={fixturePeople()}
        companies={workspaceData.companies}
        generatedAt={workspaceData.generatedAt}
        ownerDomain="exla.ai"
      />,
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /Project/ }),
      "Libra",
    );
    expect(
      screen.queryByRole("button", { name: /Match with AI/ }),
    ).not.toBeInTheDocument();
  });

  it("classifies people and filters the board to matches with reasons", async () => {
    const matchAction: MatchProjectAction = vi.fn(async (payload: Parameters<MatchProjectAction>[0]) => ({
      ok: true as const,
      data: {
        verdicts: payload.contacts.map((c) => ({
          id: c.id,
          match: c.id === "sre-1",
          confidence: c.id === "sre-1" ? 0.94 : 0.05,
          reason: c.id === "sre-1" ? "Staff SRE — ideal Libra user" : "Unrelated",
        })),
      },
    }));

    render(
      <PeopleBoard
        people={fixturePeople()}
        companies={workspaceData.companies}
        generatedAt={workspaceData.generatedAt}
        ownerDomain="exla.ai"
        matchProjectAction={matchAction}
      />,
    );

    // Before matching, both people are on the board.
    expect(screen.getByText("Priya Nair")).toBeInTheDocument();
    expect(screen.getByText("Travel Weekly")).toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: /Project/ }),
      "Libra",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Match with AI/ }),
    );

    // The action ran with the Libra definition and both contacts.
    await waitFor(() => expect(matchAction).toHaveBeenCalledTimes(1));
    const arg = (matchAction as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0]?.[0] as { name: string; contacts: unknown[] };
    expect(arg.name).toBe("Libra");
    expect(arg.contacts).toHaveLength(2);

    // Only the match remains, and its reason is shown.
    await waitFor(() => {
      expect(screen.getByText("Staff SRE — ideal Libra user")).toBeInTheDocument();
    });
    expect(screen.queryByText("Travel Weekly")).not.toBeInTheDocument();
    expect(screen.getByText("Priya Nair")).toBeInTheDocument();
  });

  it("creates a new project and persists it", async () => {
    render(
      <PeopleBoard
        people={fixturePeople()}
        companies={workspaceData.companies}
        generatedAt={workspaceData.generatedAt}
        ownerDomain="exla.ai"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "New project" }));
    await userEvent.type(screen.getByPlaceholderText("Libra"), "Ada");
    await userEvent.type(
      screen.getByPlaceholderText(/Describe the project/),
      "Docs tooling for technical writers.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save project" }));

    await waitFor(() => {
      expect(window.localStorage.getItem(PROJECT_STORAGE_KEY)).toContain("Ada");
    });
    expect(screen.getByRole("option", { name: "Ada" })).toBeInTheDocument();
  });
});
