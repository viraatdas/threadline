import { domainAcceptsMail, guessEmail } from "@/lib/sources/email-guess";

describe("guessEmail", () => {
  it("uses the ASCII-folded first name", () => {
    expect(guessEmail("José Núñez", "acme.io")).toBe("jose@acme.io");
    expect(guessEmail("Zoë Ångström", "https://www.acme.io")).toBe("zoe@acme.io");
    expect(guessEmail("Łukasz Żak", "acme.io")).toBe("lukasz@acme.io");
    expect(guessEmail("Dr. Søren Kierkegaard", "acme.io")).toBe("soren@acme.io");
    expect(guessEmail("Jean-Luc Picard", "acme.io")).toBe("jeanluc@acme.io");
  });

  it("returns undefined without a usable first name or domain", () => {
    expect(guessEmail("王伟", "acme.io")).toBeUndefined();
    expect(guessEmail("J. Smith", "acme.io")).toBeUndefined();
    expect(guessEmail("   ", "acme.io")).toBeUndefined();
    expect(guessEmail("Jane Doe", "github.com")).toBeUndefined();
  });
});

describe("domainAcceptsMail", () => {
  it("is true with an MX record", async () => {
    await expect(domainAcceptsMail("acme.io", { resolveMx: async () => [{ exchange: "mx.acme.io" }] })).resolves.toBe(true);
  });

  it("is false for no records, null MX, or lookup errors", async () => {
    await expect(domainAcceptsMail("acme.io", { resolveMx: async () => [] })).resolves.toBe(false);
    await expect(domainAcceptsMail("acme.io", { resolveMx: async () => [{ exchange: "." }] })).resolves.toBe(false);
    const enotfound = Object.assign(new Error("queryMx ENOTFOUND"), { code: "ENOTFOUND" });
    await expect(domainAcceptsMail("acme.io", { resolveMx: async () => Promise.reject(enotfound) })).resolves.toBe(false);
  });
});
