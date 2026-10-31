import { fetchWebsite, htmlToText, isPublicAddress, parseHtml } from "@/lib/sources/website";

import { fakeFetch, html } from "./fake-fetch";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1%eth0",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:c0a8:0101::1",
    "not-an-ip",
    "",
  ])("rejects %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "[2606:4700::1]"])(
    "accepts %s",
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );
});

const PAGE = `<!doctype html><html><head><title>Acme &amp; Co — macOS CI</title>
<meta content="Run iOS builds on real Macs" name="description"><style>.x{color:red}</style>
<script>var secret = "ios token";</script></head>
<body><!-- hidden comment --><h1>Fast Xcode builds with GitHub Actions</h1>
<p>Our agents use the Simulator. Email <a href="mailto:Hello@acme.io?subject=hi">us</a> or sales@acme.io.</p>
<img src="logo@2x.png"><noscript>enable js</noscript>
<a href="https://www.linkedin.com/company/acme/">LinkedIn</a>
<a href="https://github.com/acme">GitHub</a>
<a href="https://twitter.com/intent/tweet">share</a>
<a href="https://x.com/acmehq">X</a>
<a href="https://evilacme.io/careers">Careers elsewhere</a>
<a href="mailto:%E0%A4%A">broken</a>
<a href="/careers">We're hiring</a>
</body></html>`;

describe("parseHtml", () => {
  it("extracts title, description, text, links, emails, and mentions", () => {
    const snap = parseHtml(PAGE, "https://acme.io/");
    expect(snap.title).toBe("Acme & Co — macOS CI");
    expect(snap.description).toBe("Run iOS builds on real Macs");
    expect(snap.text).toContain("Fast Xcode builds with GitHub Actions");
    expect(snap.text).not.toMatch(/secret|color:red|hidden comment|enable js/);
    expect(snap.links).toEqual({
      linkedin: "https://www.linkedin.com/company/acme/",
      github: "https://github.com/acme",
      twitter: "https://x.com/acmehq",
      careers: "https://acme.io/careers",
    });
    expect(snap.emails).toEqual(["hello@acme.io", "sales@acme.io"]);
    expect(snap.mentions).toEqual(["ios", "macos", "xcode", "github actions", "agent", "simulator"]);
  });

  it("stays fast on pathological markup", () => {
    const evil = "<script".repeat(50_000) + "<!--".repeat(50_000) + "<a".repeat(50_000) + "a".repeat(300_000);
    const started = Date.now();
    htmlToText(evil);
    parseHtml(evil, "https://acme.io/");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("fetchWebsite", () => {
  const publicLookup = async () => ["93.184.216.34"];

  it("fetches a public page", async () => {
    const fetch = fakeFetch(() => html(PAGE));
    const snap = await fetchWebsite("acme.io", { fetch, lookup: publicLookup });
    expect(snap?.url).toBe("https://acme.io/");
    expect(snap?.title).toBe("Acme & Co — macOS CI");
    expect(fetch.calls[0]?.init?.redirect).toBe("manual");
  });

  it("follows a public redirect and reports the final URL", async () => {
    const fetch = fakeFetch((url) =>
      url.hostname === "acme.io" ? new Response(null, { status: 301, headers: { location: "https://www.acme.io/home" } }) : html(PAGE),
    );
    const snap = await fetchWebsite("https://acme.io", { fetch, lookup: publicLookup });
    expect(snap?.url).toBe("https://www.acme.io/home");
  });

  it("rejects a redirect to a private address", async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 302, headers: { location: "http://internal.acme.io/admin" } }));
    const lookup = async (host: string) => (host === "internal.acme.io" ? ["10.0.0.5"] : ["93.184.216.34"]);
    await expect(fetchWebsite("https://acme.io", { fetch, lookup })).resolves.toBeNull();
    expect(fetch.calls).toHaveLength(1);
  });

  it("rejects redirects to IP literals and metadata endpoints", async () => {
    const fetch = fakeFetch(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    await expect(fetchWebsite("https://acme.io", { fetch, lookup: publicLookup })).resolves.toBeNull();
    expect(fetch.calls).toHaveLength(1);
  });

  it("gives up after three redirects", async () => {
    let n = 0;
    const fetch = fakeFetch(() => new Response(null, { status: 302, headers: { location: `https://acme.io/${++n}` } }));
    await expect(fetchWebsite("https://acme.io", { fetch, lookup: publicLookup })).resolves.toBeNull();
    expect(fetch.calls).toHaveLength(4);
  });

  it.each([
    "http://localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://2130706433/",
    "https://acme.io:8443/",
    "ftp://acme.io/",
    "https://user:pass@acme.io/",
  ])("blocks %s without fetching", async (target) => {
    const fetch = fakeFetch(() => html(PAGE));
    await expect(fetchWebsite(target, { fetch, lookup: publicLookup })).resolves.toBeNull();
    expect(fetch.calls).toHaveLength(0);
  });

  it("blocks hosts that resolve to any private address", async () => {
    const fetch = fakeFetch(() => html(PAGE));
    await expect(fetchWebsite("https://acme.io", { fetch, lookup: async () => ["93.184.216.34", "192.168.0.10"] })).resolves.toBeNull();
    await expect(fetchWebsite("https://acme.io", { fetch, lookup: async () => Promise.reject(new Error("ENOTFOUND")) })).resolves.toBeNull();
    expect(fetch.calls).toHaveLength(0);
  });

  it("ignores non-HTML and failed responses, and caps the body", async () => {
    const pdf = fakeFetch(() => new Response("%PDF", { headers: { "content-type": "application/pdf" } }));
    await expect(fetchWebsite("https://acme.io", { fetch: pdf, lookup: publicLookup })).resolves.toBeNull();
    const err = fakeFetch(() => html("nope", 500));
    await expect(fetchWebsite("https://acme.io", { fetch: err, lookup: publicLookup })).resolves.toBeNull();
    const huge = fakeFetch(() => html(`<title>Big</title>${"x".repeat(3_000_000)}<p>tail-marker</p>`));
    const snap = await fetchWebsite("https://acme.io", { fetch: huge, lookup: publicLookup });
    expect(snap?.title).toBe("Big");
    expect(snap?.text.length).toBeLessThanOrEqual(6_000);
    expect(JSON.stringify(snap)).not.toContain("tail-marker");
  });

  it("returns null when fetch throws", async () => {
    const fetch = fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
    await expect(fetchWebsite("https://acme.io", { fetch, lookup: publicLookup })).resolves.toBeNull();
  });
});
