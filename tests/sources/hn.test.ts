import { nameFromDomain, searchHackerNews, showHnName } from "@/lib/sources/hn";

import { fakeFetch, json } from "./fake-fetch";

describe("HN title parsing", () => {
  it.each([
    ["Show HN: Foo – fast macOS runners", "Foo"],
    ["Show HN: Foo: bar baz", "Foo"],
    ["Show HN: Foo Bar - CI for iOS", "Foo Bar"],
    ["Show HN: Auto-identity-remove – Automated opt-outs", "Auto-identity-remove"],
    ["Show HN: CiderStack", "CiderStack"],
    ["Show HN: Lume 0.2 – macOS VMs from the CLI", "Lume"],
    ["Show HN: Foo v2: now faster", "Foo"],
    ["Show HN: Area 51 – a game", "Area 51"],
  ])("%s → %s", (title, name) => {
    expect(showHnName(title)).toBe(name);
  });

  it("ignores titles that do not name a product", () => {
    expect(showHnName("Show HN: I built a thing that runs macOS in the browser for fun")).toBeUndefined();
    expect(showHnName("Ask HN: Who runs macOS CI?")).toBeUndefined();
  });

  it("derives a name from the domain", () => {
    expect(nameFromDomain("offstage.cloud")).toBe("Offstage");
  });
});

describe("searchHackerNews", () => {
  const hit = (id: string, title: string, url: string | null, extra: Record<string, unknown> = {}) => ({
    objectID: id,
    title,
    url,
    author: "pg",
    points: 10,
    num_comments: 3,
    created_at: "2026-05-01T12:00:00Z",
    created_at_i: 1777636800,
    _tags: ["story"],
    ...extra,
  });

  it("merges hits by domain, drops generic hosts, and names companies", async () => {
    const byQuery: Record<string, unknown[]> = {
      "macos runner": [
        hit("1", "Show HN: Tart – macOS VMs for CI", "https://tart.run/"),
        hit("2", "Why we left GitHub-hosted runners", "https://blog.acme.io/runners", { points: 200 }),
        hit("3", "Show HN: Something on GitHub", "https://github.com/foo/bar"),
        hit("4", "Ask HN: no url", null),
      ],
      "xcode cloud": [
        hit("2", "Why we left GitHub-hosted runners", "https://blog.acme.io/runners", { points: 200 }),
        hit("5", "Acme raises a seed round", "https://www.acme.io/news", { points: 50 }),
        { objectID: "bad" },
      ],
    };
    const fetch = fakeFetch((url) => {
      expect(url.searchParams.get("tags")).toBe("(story,show_hn)");
      expect(url.searchParams.get("numericFilters")).toMatch(/^created_at_i>\d+$/);
      return json({ hits: byQuery[url.searchParams.get("query") ?? ""] ?? [] });
    });

    const result = await searchHackerNews({ queries: ["macos runner", "xcode cloud"], fetch });

    expect(result.companies.map((c) => c.domain)).toEqual(["acme.io", "tart.run"]);
    const [acme, tart] = result.companies;
    expect(acme?.name).toBe("Acme");
    expect(acme?.signals.map((s) => [s.dedupeKey, s.strength])).toEqual([
      ["hn:2", 3],
      ["hn:5", 2],
    ]);
    expect(acme?.signals[0]).toMatchObject({
      kind: "hn",
      url: "https://news.ycombinator.com/item?id=2",
      detail: "200 points · 3 comments · by pg",
      observedAt: "2026-05-01T12:00:00.000Z",
    });
    expect(tart).toMatchObject({ name: "Tart", website: "https://tart.run", people: [] });
    expect(result.warnings).toEqual(["Skipped 1 malformed HN result(s)."]);
  });

  it("warns per failing query and keeps the others", async () => {
    const fetch = fakeFetch((url) =>
      url.searchParams.get("query") === "bad" ? json({}, 500) : json({ hits: [hit("9", "Mac mini CI farm", "https://minis.dev")] }),
    );
    const result = await searchHackerNews({ queries: ["bad", "good"], fetch });
    expect(result.companies).toHaveLength(1);
    expect(result.warnings).toEqual(['HN search for "bad" failed (HTTP 500).']);
  });
});
