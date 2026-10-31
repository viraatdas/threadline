import { buildMime } from "@/lib/gmail";
import { findResultSchema } from "@/lib/ingest";
import { normalizeLinkedinUrl, peopleFromSearch } from "@/lib/linkedin";
import { parseManualImport } from "@/lib/manual-import";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

describe("buildMime", () => {
  it("builds a threaded plain-text message", () => {
    const mime = decode(
      buildMime({
        from: "viraat@exla.ai",
        fromName: "Viraat",
        to: "ada@acme.dev",
        toName: "Ada Lovelace",
        subject: "Re: mac ci",
        body: "Hi Ada,\nquick one.",
        inReplyTo: "<abc@mail.gmail.com>",
      }),
    );
    const [headers, body] = mime.split("\r\n\r\n");
    expect(headers).toContain('From: "Viraat" <viraat@exla.ai>');
    expect(headers).toContain('To: "Ada Lovelace" <ada@acme.dev>');
    expect(headers).toContain("In-Reply-To: <abc@mail.gmail.com>");
    expect(headers).toContain("References: <abc@mail.gmail.com>");
    expect(Buffer.from(body!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Hi Ada,\r\nquick one.");
  });

  it("cannot be header-injected through names or subjects", () => {
    const mime = decode(
      buildMime({
        from: "viraat@exla.ai",
        fromName: "Viraat",
        to: "ada@acme.dev",
        toName: 'Ada"\r\nBcc: evil@x.com',
        subject: "hello\r\nBcc: evil@x.com",
        body: "x",
      }),
    );
    const headerLines = mime.split("\r\n\r\n")[0]!.split("\r\n");
    expect(headerLines.some((line) => line.startsWith("Bcc:"))).toBe(false);
  });

  it("encodes non-ASCII subjects", () => {
    const mime = decode(buildMime({ from: "a@b.co", fromName: "Zoë", to: "c@d.co", subject: "Café ☕", body: "x" }));
    expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from("Café ☕").toString("base64")}?=`);
    expect(mime).toContain("From: =?UTF-8?B?");
  });
});

describe("parseManualImport", () => {
  it("reads fields in any order and groups people by company", () => {
    const result = parseManualImport(
      [
        "Jane Doe, CTO, jane@acme.dev, linkedin.com/in/janedoe",
        "John Roe\tiOS Lead\tacme.dev",
        "beta.io",
        "Free Mailer, Founder, someone@gmail.com",
      ].join("\n"),
    );
    expect(result.companies.map((c) => c.domain)).toEqual(["acme.dev", "beta.io"]);
    expect(result.companies[0]!.people).toEqual([
      { name: "Jane Doe", title: "CTO", email: "jane@acme.dev", emailStatus: "found", linkedinUrl: "https://linkedin.com/in/janedoe" },
      { name: "John Roe", title: "iOS Lead" },
    ]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe("linkedin helpers", () => {
  it("normalizes profile URLs so replies match enrolled people", () => {
    expect(normalizeLinkedinUrl("https://linkedin.com/in/JaneDoe/?trk=x")).toBe("https://www.linkedin.com/in/janedoe");
    expect(normalizeLinkedinUrl("not a url")).toBe("not a url");
  });

  it("keeps only plausible buyers from a company search", () => {
    const people = peopleFromSearch([
      { name: "A", publicUrl: "https://www.linkedin.com/in/a", headline: "Co-founder & CTO at Acme" },
      { name: "B", publicUrl: "https://www.linkedin.com/in/b", headline: "Account Executive" },
      { name: "C", publicUrl: "https://www.linkedin.com/in/c", headline: "Senior iOS Engineer", location: "SF" },
      { bogus: true },
    ]);
    expect(people.map((p) => p.name)).toEqual(["A", "C"]);
    expect(people[1]).toMatchObject({ location: "SF", linkedinUrl: "https://www.linkedin.com/in/c" });
  });
});

describe("findResultSchema", () => {
  it("accepts CLI payloads and rejects junk", () => {
    const ok = findResultSchema.safeParse({
      source: "yc-cli",
      companies: [{ name: "Acme", domain: "ACME.dev", people: [{ name: "Ada", email: "ADA@acme.dev" }] }],
    });
    expect(ok.success).toBe(true);
    expect(ok.data?.companies[0]).toMatchObject({ domain: "acme.dev", signals: [], people: [{ email: "ada@acme.dev" }] });
    expect(findResultSchema.safeParse({ source: "x", companies: [{ name: "" }] }).success).toBe(false);
    expect(
      findResultSchema.safeParse({ source: "x", companies: [{ name: "A", signals: [{ kind: "nope", title: "t", strength: 1, dedupeKey: "k" }] }] })
        .success,
    ).toBe(false);
  });
});
