import { buildMime } from "@/lib/gmail";
import { findResultSchema } from "@/lib/ingest";
import { browserCookiesSchema, LinkedinClient, normalizeLinkedinUrl, parseLinkedinTime, peopleFromSearch, repliesFromInbox } from "@/lib/linkedin";
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

  it("keeps only plausible buyers with real profile URLs from a company search", () => {
    const people = peopleFromSearch({
      people: [
        { name: "A", profileUrl: "https://www.linkedin.com/in/a", headline: "Co-founder & CTO at Acme" },
        { name: "B", profileUrl: "https://www.linkedin.com/in/b", headline: "Account Executive" },
        { name: "C", profileUrl: "https://linkedin.com/in/C/", headline: "Senior iOS Engineer", location: "SF" },
        { name: "D", profileUrl: "https://www.linkedin.com/company/acme", headline: "Head of Platform" },
        { bogus: true },
      ],
    });
    expect(people.map((p) => p.name)).toEqual(["A", "C"]);
    expect(people[1]).toMatchObject({ location: "SF", linkedinUrl: "https://www.linkedin.com/in/c" });
    expect(peopleFromSearch(null)).toEqual([]);
  });

  it("reads replies from an inbox-check run", () => {
    expect(
      repliesFromInbox({
        conversations: [
          { name: "Ada Founder", lastMessageFromThem: true, preview: "Sounds good, let's talk", when: "2:14 PM" },
          { name: "Bo", lastMessageFromThem: false, preview: "You: hey" },
          { name: 7 },
        ],
      }),
    ).toEqual([{ name: "Ada Founder", preview: "Sounds good, let's talk", when: "2:14 PM" }]);
  });

  it("parses LinkedIn's conversation-list times", () => {
    const now = new Date(2026, 9, 31, 15, 0); // Sat Oct 31 2026
    const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime();
    expect(parseLinkedinTime("2:14 PM", now)?.getTime()).toBe(day(2026, 9, 31));
    expect(parseLinkedinTime("Yesterday", now)?.getTime()).toBe(day(2026, 9, 30));
    expect(parseLinkedinTime("Mon", now)?.getTime()).toBe(day(2026, 9, 26));
    expect(parseLinkedinTime("Oct 29", now)?.getTime()).toBe(day(2026, 9, 29));
    expect(parseLinkedinTime("Dec 30", new Date(2027, 0, 5))?.getTime()).toBe(day(2026, 11, 30));
    expect(parseLinkedinTime("Oct 29, 2025", now)?.getTime()).toBe(day(2025, 9, 29));
    expect(parseLinkedinTime("someday", now)).toBeNull();
    expect(parseLinkedinTime(undefined, now)).toBeNull();
  });
});

describe("LinkedinClient (browser worker)", () => {
  const client = new LinkedinClient({ url: "https://worker.test", token: "worker-token" });
  const calls: { url: string; init: RequestInit }[] = [];
  const respond = (body: unknown, status = 200) => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    });
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    calls.length = 0;
  });

  it("queues one narrow run with a bearer token, a step cap and an output schema", async () => {
    respond({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", status: "queued" });
    const id = await client.startConnectionRequest("https://www.linkedin.com/in/ada", 'Hi "Ada"\nloved the post');
    expect(id).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const [call] = calls;
    expect(call!.url).toBe("https://worker.test/runs");
    expect(call!.init.method).toBe("POST");
    expect((call!.init.headers as Record<string, string>).authorization).toBe("Bearer worker-token");
    const body = JSON.parse(String(call!.init.body));
    expect(body.maxSteps).toBeGreaterThan(0);
    expect(body.outputSchema.required).toEqual(["outcome", "detail"]);
    // The note travels as a JSON string so quotes and newlines can't break the task.
    expect(body.task).toContain(JSON.stringify('Hi "Ada"\nloved the post'));
  });

  it("maps run outcomes to states the engine understands", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    respond({ id, status: "queued" });
    expect(await client.workflow(id)).toEqual({ status: "pending", workflowId: id });
    expect(calls[0]!.url).toBe(`https://worker.test/runs/${id}`);
    respond({ id, status: "running" });
    expect(await client.workflow(id)).toEqual({ status: "running", workflowId: id });
    respond({ status: "completed", output: { outcome: "sent", detail: "Invitation sent." } });
    expect(await client.workflow(id)).toMatchObject({ status: "completed" });
    respond({ status: "completed", output: JSON.stringify({ outcome: "sent_without_note", detail: "" }) });
    expect(await client.workflow(id)).toMatchObject({ status: "completed", detail: expect.stringContaining("without a note") });
    respond({ status: "completed", output: { outcome: "already_connected", detail: "1st" } });
    expect(await client.workflow(id)).toMatchObject({ status: "failed", code: "alreadyConnected" });
    respond({ status: "completed", output: { outcome: "logged_out", detail: "sign in page" } });
    expect(await client.workflow(id)).toMatchObject({ status: "failed", code: "loggedOut" });
    respond({ status: "failed", error: "Could not produce output matching outputSchema." });
    expect(await client.workflow(id)).toMatchObject({ status: "failed", code: "runFailed" });
    respond({ error: "Not found" }, 404);
    expect(await client.workflow(id)).toMatchObject({ status: "failed", code: "runLost" });
  });

  it("reads the worker's session, forwards cookies, and explains HTTP failures without bodies", async () => {
    respond({
      ok: true,
      busy: false,
      queued: 0,
      model: "anthropic/claude-haiku-5.5",
      linkedin: { signedIn: true, expiresAt: "2027-04-30T00:00:00Z", verifiedAt: "2026-10-31T05:00:00Z", lastCheck: "Signed in." },
    });
    expect((await client.status()).linkedin.signedIn).toBe(true);
    respond({ signedIn: true, detail: "Signed in.", cookies: 1 });
    expect(await client.importSession([{ name: "li_at", value: "v", domain: ".linkedin.com" }])).toMatchObject({ signedIn: true });
    expect(calls[1]).toMatchObject({ url: "https://worker.test/session", init: { method: "PUT" } });
    respond({ error: "No li_at cookie." }, 422);
    await expect(client.importSession([])).rejects.toThrow("No li_at cookie.");
    respond({ detail: "secret task text echoed" }, 401);
    await expect(client.status()).rejects.toThrow("BROWSER_WORKER_TOKEN");
    respond({ detail: "secret task text echoed" }, 500);
    await expect(client.status()).rejects.toThrow("HTTP 500");
  });
});

describe("browserCookiesSchema", () => {
  it("takes a Cookie-Editor export as-is and keeps only linkedin.com cookies", () => {
    const parsed = browserCookiesSchema.parse([
      { domain: ".www.linkedin.com", expirationDate: 1824773233.9, hostOnly: false, httpOnly: true, name: "li_at", path: "/", sameSite: "no_restriction", secure: true, session: false, storeId: null, value: "v" },
      { domain: "www.linkedin.com", hostOnly: true, name: "g_state", path: "/", sameSite: null, secure: false, session: true, storeId: null, value: "{}" },
      { domain: ".evillinkedin.com", name: "li_at", value: "x" },
      { domain: ".google.com", name: "SID", value: "x" },
    ]);
    expect(parsed.map((cookie) => cookie.name)).toEqual(["li_at", "g_state"]);
    expect(parsed[0]).toMatchObject({ expirationDate: 1824773233.9, sameSite: "no_restriction" });
    expect(browserCookiesSchema.safeParse([]).success).toBe(false);
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
