import { batchRecency, fetchYcCompany, parseYcCliOutput, parseYcCompanyPage, searchYcDirectory } from "@/lib/sources/yc";

import { fakeFetch, html, json } from "./fake-fetch";

function entry(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    slug,
    website: `https://www.${slug}.com`,
    one_liner: "Something",
    long_description: "",
    tags: [],
    industries: [],
    batch: "Winter 2020",
    status: "Active",
    team_size: 10,
    all_locations: "San Francisco, CA, USA",
    isHiring: false,
    url: `https://www.ycombinator.com/companies/${slug}`,
    ...overrides,
  };
}

describe("batchRecency", () => {
  it("orders seasons within a year and years overall", () => {
    expect(batchRecency("Fall 2025")).toBeLessThan(batchRecency("Winter 2026"));
    expect(batchRecency("Winter 2026")).toBeLessThan(batchRecency("Spring 2026"));
    expect(batchRecency("Summer 2026")).toBeLessThan(batchRecency("Fall 2026"));
    expect(batchRecency("Unspecified")).toBe(0);
  });
});

describe("searchYcDirectory", () => {
  const directory = [
    entry("oldmatch", { one_liner: "iOS CI for teams", batch: "Winter 2015" }),
    entry("newmatch", { one_liner: "Fast iOS builds", batch: "Summer 2025", isHiring: true }),
    entry("both", { long_description: "We run iOS apps through CI on macOS runners", batch: "Winter 2012" }),
    entry("dead", { one_liner: "iOS CI", status: "Inactive", batch: "Fall 2026" }),
    entry("acquired", { one_liner: "iOS CI", status: "Acquired" }),
    entry("kiosk", { one_liner: "Kiosk software", tags: ["Bios"] }),
    entry("tagged", { tags: ["iOS"], batch: "Summer 2025", website: null, team_size: null }),
    entry("d_model", { one_liner: "Unrelated" }),
    { name: 42, slug: "bad" },
  ];

  it("filters to Active, ranks by phrases matched, then batch recency, then hiring", async () => {
    const fetch = fakeFetch(() => json(directory));
    const result = await searchYcDirectory({ query: "iOS, ci ,", fetch });

    // oldmatch and both match two phrases; oldmatch's batch is newer. newmatch beats tagged on hiring.
    expect(result.companies.map((c) => c.ycSlug)).toEqual(["oldmatch", "both", "newmatch", "tagged"]);
    expect(result.warnings).toEqual(["Skipped 1 malformed YC directory entry."]);

    const newmatch = result.companies.find((c) => c.ycSlug === "newmatch");
    expect(newmatch).toMatchObject({
      name: "Newmatch",
      domain: "newmatch.com",
      website: "https://newmatch.com",
      ycBatch: "Summer 2025",
      teamSize: 10,
      location: "San Francisco, CA, USA",
      people: [],
    });
    expect(newmatch?.signals).toEqual([
      expect.objectContaining({ kind: "yc", title: "YC Summer 2025: Fast iOS builds", url: "https://www.ycombinator.com/companies/newmatch", strength: 2, dedupeKey: "yc:newmatch" }),
      expect.objectContaining({ kind: "hiring", strength: 1, dedupeKey: "yc-hiring:newmatch" }),
    ]);
    // Matched only in long_description → weak.
    expect(result.companies.find((c) => c.ycSlug === "both")?.signals[0]?.strength).toBe(1);
    const tagged = result.companies.find((c) => c.ycSlug === "tagged");
    expect(tagged?.signals[0]?.strength).toBe(2);
    expect(tagged?.domain).toBeUndefined();
    expect(tagged?.teamSize).toBeUndefined();
  });

  it("breaks ties on hiring and respects limit", async () => {
    const fetch = fakeFetch(() =>
      json([entry("a", { one_liner: "macOS sandbox", isHiring: false }), entry("b", { one_liner: "macOS sandbox", isHiring: true })]),
    );
    const result = await searchYcDirectory({ query: "macos sandbox", limit: 1, fetch });
    expect(result.companies.map((c) => c.ycSlug)).toEqual(["b"]);
  });

  it("warns on HTTP errors and empty queries", async () => {
    const fetch = fakeFetch(() => json({}, 503));
    expect((await searchYcDirectory({ query: "ios", fetch })).warnings).toEqual(["YC directory request failed (HTTP 503)."]);
    expect((await searchYcDirectory({ query: " , ", fetch })).warnings).toEqual(["YC search needs at least one phrase."]);
  });
});

function escapeAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const pageJson = {
  component: "ycdc_new/pages/Companies/ShowPage",
  props: {
    company: {
      id: 5,
      slug: "circuithub",
      name: "CircuitHub",
      batch_name: "Winter 2012",
      one_liner: "On-Demand Electronics Manufacturing",
      website: "https://circuithub.com",
      long_description: "Tesla & NASA's \"go-to\" <factory> — 10x faster",
      team_size: 58,
      location: "London, United Kingdom",
      linkedin_url: "https://www.linkedin.com/company/circuithub",
      twitter_url: "https://twitter.com/circuithub",
      github_url: "https://github.com/circuithub",
      primary_group_partner: { full_name: "Some Partner" },
      founders: [
        { full_name: "Andrew Seddon", title: "Founder/CEO", linkedin_url: "https://www.linkedin.com/in/seddonandrew/", twitter_url: "https://x.com/seddonandrew", is_active: true, has_email: true },
        { full_name: "Former Founder", title: "CTO", is_active: false },
        { full_name: "No Title", title: "", linkedin_url: "javascript:alert(1)", is_active: true },
        { title: "Missing name" },
      ],
    },
    jobPostings: [{ id: 1, title: "Engineer" }],
  },
};
const pageHtml = `<!doctype html><html><body><div id="app" data-page="${escapeAttr(JSON.stringify(pageJson))}"></div></body></html>`;

describe("YC company page", () => {
  it("parses the entity-escaped data-page blob", () => {
    expect(pageHtml).toContain("&quot;");
    const company = parseYcCompanyPage(pageHtml);
    expect(company).toMatchObject({
      name: "CircuitHub",
      ycSlug: "circuithub",
      ycBatch: "Winter 2012",
      domain: "circuithub.com",
      teamSize: 58,
      location: "London, United Kingdom",
      linkedinUrl: "https://www.linkedin.com/company/circuithub",
      githubLogin: "circuithub",
    });
    expect(company?.description).toContain(`Tesla & NASA's "go-to" <factory>`);
    expect(company?.people).toEqual([
      { name: "Andrew Seddon", title: "Founder/CEO", linkedinUrl: "https://www.linkedin.com/in/seddonandrew/", twitterUrl: "https://x.com/seddonandrew" },
      { name: "No Title", title: "Founder" },
    ]);
    expect(company?.signals.map((s) => s.dedupeKey)).toEqual(["yc:circuithub", "yc-hiring:circuithub"]);
  });

  it("decodes numeric entities", () => {
    const numeric = pageHtml.replace(/&quot;/g, "&#34;").replace("CircuitHub&#34;,&#34;batch_name", "Circuit&#x48;ub&#34;,&#34;batch_name");
    expect(parseYcCompanyPage(numeric)?.name).toBe("CircuitHub");
  });

  it("returns null for missing or malformed blobs", () => {
    expect(parseYcCompanyPage("<html></html>")).toBeNull();
    expect(parseYcCompanyPage('<div data-page="{not json"></div>')).toBeNull();
    expect(parseYcCompanyPage(`<div data-page="${escapeAttr(JSON.stringify({ props: { company: { name: "x" } } }))}"></div>`)).toBeNull();
  });

  it("fetches with a browser UA and maps 404 to null", async () => {
    const fetch = fakeFetch((url) => (url.pathname.endsWith("/circuithub") ? html(pageHtml) : html("not found", 404)));
    expect((await fetchYcCompany({ slug: "circuithub", fetch }))?.name).toBe("CircuitHub");
    expect(new Headers(fetch.calls[0]?.init?.headers).get("user-agent")).toMatch(/Mozilla/);
    await expect(fetchYcCompany({ slug: "missing", fetch })).resolves.toBeNull();
    await expect(fetchYcCompany({ slug: "../etc", fetch })).resolves.toBeNull();
    expect(fetch.calls).toHaveLength(2);
  });
});

describe("parseYcCliOutput", () => {
  it("attaches nested founders to their company", () => {
    const raw = {
      results: [
        {
          company: {
            name: "Acme",
            slug: "acme",
            batch: "W24",
            website: "https://www.acme.dev",
            one_liner: "Mac CI",
            founders: [
              { full_name: "Ada Lovelace", title: "CEO", email: "ADA@acme.dev", linkedin_url: "https://linkedin.com/in/ada" },
              { first_name: "Bob", last_name: "Builder", email: "not-an-email" },
            ],
            group_partner: { full_name: "Partner Person" },
          },
        },
        { name: "Beta", url: "https://www.ycombinator.com/companies/beta", team: [{ name: "Cy", title: "CTO" }] },
      ],
    };
    const result = parseYcCliOutput(JSON.stringify(raw));
    expect(result.source).toBe("yc-cli");
    expect(result.companies).toHaveLength(2);
    const [acme, beta] = result.companies;
    expect(acme).toMatchObject({ name: "Acme", ycSlug: "acme", ycBatch: "W24", domain: "acme.dev", description: "Mac CI" });
    expect(acme?.people).toEqual([
      { name: "Ada Lovelace", title: "CEO", email: "ada@acme.dev", emailStatus: "found", linkedinUrl: "https://linkedin.com/in/ada" },
      { name: "Bob Builder" },
    ]);
    expect(acme?.signals).toEqual([expect.objectContaining({ kind: "yc", strength: 2, dedupeKey: "yc:acme", title: "YC W24: Mac CI" })]);
    expect(beta?.domain).toBeUndefined();
    expect(beta?.people).toEqual([{ name: "Cy", title: "CTO" }]);
    expect(beta?.signals[0]?.dedupeKey).toBe("yc:beta");
  });

  it("groups a flat people list by company_name", () => {
    const raw = [
      { full_name: "Dee Dev", title: "Head of Mobile", company_name: "Gamma Labs", email: "dee@gamma.io" },
      { full_name: "Eve Ops", company_name: "gamma labs", linkedin: "https://www.linkedin.com/in/eve" },
      { full_name: "Dee Dev", company_name: "Gamma Labs" },
      { full_name: "Fay", company: { name: "Delta", slug: "delta", website: "delta.so" } },
      { full_name: "Nobody" },
      { name: "Gus Founder", title: "CEO", url: "https://www.ycombinator.com/people/gus", company: "Gamma Labs" },
    ];
    const result = parseYcCliOutput(raw);
    expect(result.companies.map((c) => c.name)).toEqual(["Gamma Labs", "Delta"]);
    const [gamma, delta] = result.companies;
    expect(gamma?.people.map((p) => p.name)).toEqual(["Dee Dev", "Eve Ops", "Gus Founder"]);
    expect(gamma?.people[0]).toMatchObject({ email: "dee@gamma.io", emailStatus: "found" });
    expect(gamma?.signals[0]?.dedupeKey).toBe("yc:gamma-labs");
    expect(delta).toMatchObject({ ycSlug: "delta", domain: "delta.so", people: [{ name: "Fay" }] });
    expect(result.warnings).toContain("Skipped 1 person record(s) with no company.");
  });

  it("warns on bad JSON and bounds the walk", () => {
    expect(parseYcCliOutput("{oops").warnings).toEqual(["Could not parse the pasted YC CLI output as JSON."]);
    let deep: unknown = { name: "Deep Co", slug: "deep" };
    for (let i = 0; i < 20; i++) deep = { child: deep };
    expect(parseYcCliOutput(deep).companies).toHaveLength(0);
    const wide = Array.from({ length: 5000 }, (_, i) => ({ name: `Co ${i}`, slug: `co-${i}` }));
    const result = parseYcCliOutput(wide);
    expect(result.companies.length).toBeLessThan(2000);
    expect(result.warnings.some((w) => w.includes("2,000"))).toBe(true);
  });
});
