import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  loadProjects,
  loadVerdicts,
  PROJECT_MATCH_STORAGE_KEY,
  PROJECT_STORAGE_KEY,
  SEED_PROJECT,
  saveProjects,
  saveVerdicts,
  type Project,
  type ProjectVerdict,
} from "@/components/people/projects";

// jsdom in this setup does not provide localStorage; install a minimal stub.
beforeAll(() => {
  if (typeof window.localStorage === "undefined") {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        clear: () => store.clear(),
        key: (index: number) => [...store.keys()][index] ?? null,
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

describe("projects storage", () => {
  it("seeds the Libra starter project on first load", () => {
    const projects = loadProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe("libra");
    expect(projects[0]?.name).toBe("Libra");
    // The seed is persisted so it survives a reload.
    expect(window.localStorage.getItem(PROJECT_STORAGE_KEY)).toContain("Libra");
  });

  it("does not re-seed once the owner has saved their own set", () => {
    saveProjects([]);
    expect(loadProjects()).toEqual([]);
  });

  it("round-trips saved projects", () => {
    const project: Project = {
      id: "p1",
      name: "Ada",
      description: "Docs tooling",
      createdAt: new Date().toISOString(),
    };
    saveProjects([SEED_PROJECT, project]);
    const loaded = loadProjects();
    expect(loaded.map((p) => p.id)).toEqual(["libra", "p1"]);
  });

  it("drops malformed entries", () => {
    window.localStorage.setItem(
      PROJECT_STORAGE_KEY,
      JSON.stringify([{ id: "ok", name: "Ok", description: "d" }, { id: 5 }]),
    );
    const loaded = loadProjects();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe("ok");
  });

  it("stores verdicts scoped per project", () => {
    const verdictA: Record<string, ProjectVerdict> = {
      c1: { match: true, confidence: 0.9, reason: "fit", at: "2026-01-01" },
    };
    const verdictB: Record<string, ProjectVerdict> = {
      c1: { match: false, confidence: 0.1, reason: "no", at: "2026-01-01" },
    };
    saveVerdicts("libra", verdictA);
    saveVerdicts("other", verdictB);
    expect(loadVerdicts("libra").c1?.match).toBe(true);
    expect(loadVerdicts("other").c1?.match).toBe(false);
    expect(loadVerdicts("missing")).toEqual({});
    // Both projects coexist under one storage key.
    const raw = window.localStorage.getItem(PROJECT_MATCH_STORAGE_KEY);
    expect(raw).toContain("libra");
    expect(raw).toContain("other");
  });
});
