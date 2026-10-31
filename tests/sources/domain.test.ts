import { normalizeDomain, websiteFromDomain } from "@/lib/sources/domain";

describe("normalizeDomain", () => {
  it.each([
    ["https://www.Offstage.cloud/pricing?x=1", "offstage.cloud"],
    ["offstage.cloud", "offstage.cloud"],
    ["WWW.ACME.IO/", "acme.io"],
    ["http://acme.io:8080/x", "acme.io"],
    ["https://blog.acme.com/post", "acme.com"],
    ["https://shop.acme.co.uk", "acme.co.uk"],
    ["acme.com.au", "acme.com.au"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    "https://github.com/acme",
    "acme.github.io",
    "https://www.linkedin.com/company/acme",
    "https://x.com/acme",
    "twitter.com/acme",
    "https://youtu.be/abc",
    "https://apps.apple.com/app/id1",
    "https://play.google.com/store/apps",
    "https://docs.google.com/doc",
    "https://news.ycombinator.com/item?id=1",
    "https://acme.notion.site",
    "https://acme.vercel.app",
    "https://acme.substack.com/p/x",
    "https://medium.com/@acme",
    "https://en.wikipedia.org/wiki/Acme",
    "https://t.co/xyz",
    "https://linktr.ee/acme",
    "https://acme.pages.dev",
  ])("rejects generic host %s", (input) => {
    expect(normalizeDomain(input)).toBeUndefined();
  });

  it.each([null, undefined, "", "  ", "not a domain", "localhost", "http://192.168.1.1", "mailto:a@acme.io", "javascript:alert(1)", "ftp://acme.io", "acme"])(
    "rejects invalid %s",
    (input) => {
      expect(normalizeDomain(input)).toBeUndefined();
    },
  );

  it("builds a website URL", () => {
    expect(websiteFromDomain("acme.io")).toBe("https://acme.io");
  });
});
