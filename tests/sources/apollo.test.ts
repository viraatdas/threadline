import { apolloFindPeople, apolloRevealEmail } from "@/lib/sources/apollo";

import { fakeFetch, json } from "./fake-fetch";

describe("apollo", () => {
  it("searches people by domain and maps them", async () => {
    const fetch = fakeFetch((url, init) => {
      expect(url.toString()).toBe("https://api.apollo.io/api/v1/mixed_people/api_search");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("key-123");
      expect(JSON.parse(String(init?.body))).toMatchObject({ q_organization_domains_list: ["acme.io"], per_page: 2 });
      return json({
        people: [
          { name: "Ada Lovelace", title: "CTO", linkedin_url: "http://www.linkedin.com/in/ada" },
          // What api_search really returns: first name, hidden last name, an id.
          { id: "5f1b2c3d4e5f60718293a4b5", first_name: "Bob", last_name_obfuscated: "Bu***r", title: "Head of Mobile", has_email: true },
          { title: "nameless" },
        ],
      });
    });
    const people = await apolloFindPeople({ apiKey: "key-123", domain: "https://www.acme.io", limit: 2, fetch });
    expect(people).toEqual([
      { name: "Ada Lovelace", title: "CTO", linkedinUrl: "http://www.linkedin.com/in/ada" },
      { name: "Bob", title: "Head of Mobile", apolloId: "5f1b2c3d4e5f60718293a4b5", apolloHasEmail: true },
    ]);
  });

  it("throws a safe error with the status only", async () => {
    const fetch = fakeFetch(() => json({ error: "invalid key key-123" }, 401));
    const error = await apolloFindPeople({ apiKey: "key-123", domain: "acme.io", fetch }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Apollo people search failed (HTTP 401)");
  });

  it("reveals only real, available emails", async () => {
    const respond = (person: unknown) => fakeFetch(() => json({ person }));
    await expect(apolloRevealEmail({ apiKey: "k", name: "Ada", domain: "acme.io", fetch: respond({ email: "ada@acme.io", email_status: "verified" }) })).resolves.toEqual({ email: "ada@acme.io" });
    await expect(apolloRevealEmail({ apiKey: "k", name: "Ada", fetch: respond({ email: "ada@acme.io", email_status: "unavailable" }) })).resolves.toEqual({});
    await expect(apolloRevealEmail({ apiKey: "k", name: "Ada", fetch: respond({ email: "email_not_unlocked@domain.com" }) })).resolves.toEqual({});
    await expect(apolloRevealEmail({ apiKey: "k", name: "Ada", fetch: respond(null) })).resolves.toBeUndefined();
  });

  it("looks up by Apollo id when it has one, and returns the full name", async () => {
    const fetch = fakeFetch((_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ id: "5f1b2c3d4e5f60718293a4b5", reveal_personal_emails: false });
      return json({
        person: { first_name: "Bob", last_name: "Builder", email: "bob@acme.io", email_status: "verified", linkedin_url: "https://www.linkedin.com/in/bob" },
      });
    });
    await expect(apolloRevealEmail({ apiKey: "k", name: "Bob", apolloId: "5f1b2c3d4e5f60718293a4b5", domain: "acme.io", fetch })).resolves.toEqual({
      email: "bob@acme.io",
      name: "Bob Builder",
      linkedinUrl: "https://www.linkedin.com/in/bob",
    });
  });
});
