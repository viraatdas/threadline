import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppShell, PageHeader } from "@/components/shell";

describe("owner application shell", () => {
  it("renders the workspace landmarks and owner identity", () => {
    render(
      <AppShell ownerEmail="owner@example.com" ownerName="Viraat">
        <PageHeader title="Attention" description="Relationships needing review." />
      </AppShell>,
    );

    expect(screen.getByLabelText("Primary navigation")).toBeInTheDocument();
    expect(screen.getByLabelText("Mobile navigation")).toBeInTheDocument();
    expect(screen.getAllByText("Threadline").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Attention" })).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign out" })).toHaveAttribute(
      "href",
      "/api/auth/signout",
    );
  });
});
