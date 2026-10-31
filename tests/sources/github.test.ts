import { checkOrgForMacCi, findMacCiTeams } from "@/lib/sources/github";

import { fakeFetch, json } from "./fake-fetch";

function item(owner: string, repo: string, path: string, opts: { type?: string; fork?: boolean } = {}) {
  return {
    name: path.split("/").pop(),
    path,
    sha: "abc",
    html_url: `https://github.com/${owner}/${repo}/blob/abc/${path}`,
    repository: {
      name: repo,
      full_name: `${owner}/${repo}`,
      fork: opts.fork ?? false,
      owner: { login: owner, type: opts.type ?? "Organization" },
    },
  };
}

const orgs: Record<string, unknown> = {
  acme: { login: "acme", name: "Acme Inc", blog: "https://www.acme.io", location: "SF", description: "Rockets", public_repos: 12 },
  beta: { login: "beta", name: null, blog: "https://github.com/beta", location: null, description: null, public_repos: 3 },
};

describe("findMacCiTeams", () => {
  it("groups hits by org, keeps orgs only, ranks by file count, and caps signals", async () => {
    const macosHits = [
      ...Array.from({ length: 7 }, (_, i) => item("acme", `app${i}`, `.github/workflows/ios${i}.yml`)),
      item("beta", "mobile", ".github/workflows/ci.yaml"),
      item("solo-dev", "toy", ".github/workflows/ios.yml", { type: "User" }),
      item("forker", "copied", ".github/workflows/ios.yml", { fork: true }),
      item("acme", "old", ".github/workflows/ci.yml.old"),
      { junk: true },
    ];
    const xcodeHits = [item("beta", "mobile", ".github/workflows/ci.yaml"), item("beta", "mobile", ".github/workflows/release.yml")];
    const fetch = fakeFetch((url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
      expect(new Headers(init?.headers).get("x-github-api-version")).toBe("2022-11-28");
      if (url.pathname === "/search/code") {
        const q = url.searchParams.get("q") ?? "";
        const items = q.startsWith('"runs-on: macos" path') ? macosHits : q.startsWith("xcodebuild") ? xcodeHits : [];
        return json({ total_count: items.length, incomplete_results: false, items });
      }
      const login = url.pathname.split("/").pop() ?? "";
      return orgs[login] ? json(orgs[login]) : json({ message: "Not Found" }, 404);
    });

    const result = await findMacCiTeams({ token: "tok", fetch });

    expect(result.companies.map((c) => c.githubLogin)).toEqual(["acme", "beta"]);
    const [acme, beta] = result.companies;
    expect(acme).toMatchObject({ name: "Acme Inc", domain: "acme.io", website: "https://acme.io", location: "SF", description: "Rockets", people: [] });
    expect(acme?.signals).toHaveLength(5);
    expect(acme?.signals[0]).toMatchObject({
      kind: "github_macos_ci",
      strength: 3,
      title: "Runs macOS CI in acme/app0 (.github/workflows/ios0.yml)",
      url: "https://github.com/acme/app0/blob/abc/.github/workflows/ios0.yml",
      dedupeKey: "github:acme/app0:.github/workflows/ios0.yml",
    });
    expect(acme?.signals[0]?.detail).toContain("12 public repos");

    // The macOS match wins over the xcodebuild match for the same file; the xcodebuild-only file is strength 2.
    expect(beta?.name).toBe("beta");
    expect(beta?.domain).toBeUndefined();
    expect(beta?.signals.map((s) => [s.dedupeKey, s.strength])).toEqual([
      ["github:beta/mobile:.github/workflows/ci.yaml", 3],
      ["github:beta/mobile:.github/workflows/release.yml", 2],
    ]);
    expect(result.warnings).toContain("Skipped 1 malformed GitHub search result(s).");
    // Three default queries, one page each, never more.
    expect(fetch.calls.filter((c) => c.url.pathname === "/search/code")).toHaveLength(3);
  });

  it("stops searching on a rate limit and warns without leaking the token", async () => {
    const fetch = fakeFetch((url) => {
      if (url.pathname === "/search/code") {
        return url.searchParams.get("q")?.startsWith("xcodebuild")
          ? json({ message: "API rate limit exceeded" }, 403)
          : json({ total_count: 1, items: [item("acme", "app", ".github/workflows/ios.yml")] });
      }
      return json(orgs.acme);
    });

    const result = await findMacCiTeams({ token: "secret-token", fetch });

    expect(result.companies.map((c) => c.githubLogin)).toEqual(["acme"]);
    expect(fetch.calls.filter((c) => c.url.pathname === "/search/code")).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes("rate limit") && w.includes("403"))).toBe(true);
    expect(result.warnings.join(" ")).not.toContain("secret-token");
  });

  it("respects maxOrgs and the 3-request budget across pages", async () => {
    const page = Array.from({ length: 100 }, (_, i) => item(`org${i}`, "app", ".github/workflows/ios.yml"));
    const fetch = fakeFetch((url) =>
      url.pathname === "/search/code" ? json({ total_count: 5000, items: page }) : json({ login: url.pathname.split("/").pop() }),
    );

    const result = await findMacCiTeams({ token: "tok", maxOrgs: 5, queries: ['"runs-on: macos" path:.github/workflows'], fetch });

    const searches = fetch.calls.filter((c) => c.url.pathname === "/search/code");
    expect(searches.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(result.companies).toHaveLength(5);
    expect(fetch.calls.filter((c) => c.url.pathname.startsWith("/orgs/"))).toHaveLength(5);
  });

  it("keeps an org by login when its profile fails to load", async () => {
    const fetch = fakeFetch((url) =>
      url.pathname === "/search/code" ? json({ total_count: 1, items: [item("ghost", "app", ".github/workflows/ios.yml")] }) : json({}, 500),
    );
    const result = await findMacCiTeams({ token: "tok", queries: ["q runs-on: macos"], fetch });
    expect(result.companies[0]).toMatchObject({ name: "ghost", githubLogin: "ghost" });
    expect(result.warnings.some((w) => w.includes("profile details"))).toBe(true);
  });
});

describe("checkOrgForMacCi", () => {
  it("returns signals scoped to the org", async () => {
    const fetch = fakeFetch((url) => {
      expect(url.searchParams.get("q")).toMatch(/^org:acme /);
      return json({ total_count: 1, items: [item("acme", "app", ".github/workflows/ios.yml")] });
    });
    const signals = await checkOrgForMacCi({ token: "tok", login: "acme", fetch });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ strength: 3, dedupeKey: "github:acme/app:.github/workflows/ios.yml" });
  });

  it("returns [] for unknown orgs (422) and invalid logins", async () => {
    const fetch = fakeFetch(() => json({ message: "Validation Failed" }, 422));
    await expect(checkOrgForMacCi({ token: "tok", login: "nope", fetch })).resolves.toEqual([]);
    await expect(checkOrgForMacCi({ token: "tok", login: "a b OR org:x", fetch })).resolves.toEqual([]);
    expect(fetch.calls).toHaveLength(1);
  });

  it("throws a safe error on rate limits", async () => {
    const fetch = fakeFetch(() => json({ message: "rate limited" }, 429));
    await expect(checkOrgForMacCi({ token: "tok", login: "acme", fetch })).rejects.toThrow("HTTP 429");
  });
});
