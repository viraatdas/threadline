import { mergeResults, parseBirdSearch, profileFromRaw } from "@/lib/sources/x";

// The shape `bird search --json-full` prints: mapped fields plus the raw
// GraphQL tweet in `_raw`, whose author profile carries bio, link and reach.
const tweet = (
  id: string,
  text: string,
  author: { username: string; name: string; id?: string },
  profile: { description?: string; url?: string; location?: string; followers?: number } = {},
) => ({
  id,
  text,
  createdAt: "Thu Oct 30 18:04:11 +0000 2026",
  likeCount: 4,
  author: { username: author.username, name: author.name },
  authorId: author.id ?? "1001",
  _raw: {
    rest_id: id,
    core: {
      user_results: {
        result: {
          rest_id: author.id ?? "1001",
          core: { screen_name: author.username, name: author.name },
          location: { location: profile.location ?? "" },
          legacy: {
            description: profile.description ?? "",
            followers_count: profile.followers ?? 900,
            entities: profile.url ? { url: { urls: [{ url: "https://t.co/x", expanded_url: profile.url }] } } : {},
          },
        },
      },
    },
  },
});

describe("parseBirdSearch", () => {
  const ada = { username: "ada_builds", name: "Ada", id: "42" };

  it("turns an author with a company link into that company, with their posts as signals", () => {
    const result = parseBirdSearch(
      JSON.stringify([
        tweet("1", "Our GitHub Actions macOS runners queue for 20 minutes every PR. ugh", ada, {
          description: "iOS lead @acme",
          url: "https://www.acme.dev/about",
          location: "Berlin",
        }),
        tweet("2", "xcodebuild is fine, it's the runners", ada),
      ]),
      '"macos runner"',
    );
    expect(result.warnings).toEqual([]);
    expect(result.companies).toHaveLength(1);
    const [company] = result.companies;
    expect(company).toMatchObject({ name: "Acme", domain: "acme.dev", website: "https://acme.dev", location: "Berlin" });
    expect(company!.people).toEqual([
      { name: "Ada", title: "iOS lead @acme", twitterUrl: "https://x.com/ada_builds", xUserId: "42", location: "Berlin" },
    ]);
    expect(company!.signals.map((s) => [s.dedupeKey, s.strength])).toEqual([
      ["x:1", 3],
      ["x:2", 2],
    ]);
    expect(company!.signals[0]).toMatchObject({
      kind: "x",
      url: "https://x.com/ada_builds/status/1",
      observedAt: "2026-10-30T18:04:11.000Z",
    });
  });

  it("keeps the person as the account when the link is a profile host, and drops noise", () => {
    const result = parseBirdSearch(
      JSON.stringify({
        tweets: [
          tweet("3", "Buying a mac mini just to run agents is wild", { username: "solo", name: "Sol O" }, { url: "https://linktr.ee/solo" }),
          tweet("4", "RT @someone: macos runners are slow", { username: "rt", name: "Re Tweet" }),
          tweet("5", "Apple Silicon runners are slow", { username: "brand", name: "Big Brand" }, { followers: 2_000_000 }),
          tweet("6", "great coffee today", { username: "coffee", name: "Coffee" }),
          { id: "not-a-number", text: "bad row" },
        ],
        nextCursor: null,
      }),
    );
    expect(result.companies.map((c) => c.name)).toEqual(["Sol O (@solo)"]);
    expect(result.companies[0]!.domain).toBeUndefined();
    expect(result.warnings).toEqual(["1 post skipped (unexpected shape)."]);
  });

  it("reports unparseable output instead of throwing", () => {
    expect(parseBirdSearch("Missing required credentials")).toMatchObject({ companies: [], warnings: ["bird output was not JSON."] });
  });

  it("reads profiles defensively", () => {
    expect(profileFromRaw(undefined)).toEqual({ bio: undefined, url: undefined, location: undefined, followers: undefined });
  });
});

describe("mergeResults", () => {
  it("keeps one company per domain or handle across queries", () => {
    const ada = { username: "ada_builds", name: "Ada", id: "42" };
    const a = parseBirdSearch(JSON.stringify([tweet("1", "macos runners are slow", ada, { url: "https://acme.dev" })]), "q1");
    const b = parseBirdSearch(JSON.stringify([tweet("1", "macos runners are slow", ada, { url: "https://acme.dev" }), tweet("7", "xcode cloud is expensive", ada, { url: "https://acme.dev" })]), "q2");
    const merged = mergeResults([a, b]);
    expect(merged.companies).toHaveLength(1);
    expect(merged.companies[0]!.signals.map((s) => s.dedupeKey).sort()).toEqual(["x:1", "x:7"]);
    expect(merged.companies[0]!.people).toHaveLength(1);
  });
});
