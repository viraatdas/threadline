import { learnLifts, rankPerson, stakeholderOf } from "@/lib/rank";

const company = { name: "Acme", score: 80, hook: "Runs iOS builds on macos-14 runners", fitSummary: null, targetTitles: ["Head of Mobile"] };
const base = { title: null, email: null, emailStatus: null, linkedinUrl: null, company, inTouch: false } as const;

describe("stakeholderOf", () => {
  it.each([
    ["Co-Founder & CEO", "decider"],
    ["CTO", "decider"],
    ["VP Engineering", "decider"],
    ["VP Sales", "other"],
    ["Head of Mobile Engineering", "champion"],
    ["iOS Lead", "champion"],
    ["Engineering Manager, Platform", "champion"],
    ["Senior iOS Engineer", "user"],
    ["DevOps Engineer", "user"],
    ["Head of Marketing", "other"],
    ["Recruiter", "other"],
    ["", "unknown"],
    [null, "unknown"],
  ])("%s → %s", (title, expected) => {
    expect(stakeholderOf(title)).toBe(expected);
  });
});

describe("rankPerson", () => {
  it("ranks a reachable decider at a strong fit above a hands-on engineer, and says why", () => {
    const cto = rankPerson({ ...base, title: "CTO", email: "cto@acme.dev", emailStatus: "found" });
    const engineer = rankPerson({ ...base, title: "iOS Engineer", email: "eng@acme.dev", emailStatus: "found" });
    expect(cto.score).toBe(80);
    expect(engineer.score).toBe(52);
    expect(cto.reasons).toEqual(["CTO: can decide on CI spend", "Acme fit 80: Runs iOS builds on macos-14 runners", "email found"]);
  });

  it("counts a title research named as close to a decider", () => {
    expect(rankPerson({ ...base, title: "Head of Mobile", linkedinUrl: "https://www.linkedin.com/in/x" })).toMatchObject({
      score: 57,
      reasons: ["Head of Mobile: a title research says buys here", expect.any(String), "LinkedIn only"],
    });
  });

  it("discounts the unreachable, the unresearched and the guessed", () => {
    expect(rankPerson({ ...base, title: "CTO" }).score).toBe(24);
    expect(rankPerson({ ...base, title: "CTO", email: "x@acme.dev", emailStatus: "guessed" }).score).toBe(64);
    const unresearched = rankPerson({ ...base, title: "CTO", email: "x@acme.dev", emailStatus: "found", company: { ...company, score: null } });
    expect(unresearched).toMatchObject({ score: 35, reasons: [expect.any(String), "Acme isn't researched yet", "email found"] });
  });

  it("applies what replies have taught, and says so", () => {
    const lifts = learnLifts([
      { key: "decider", contacted: 20, replied: 6 },
      { key: "user", contacted: 20, replied: 0 },
    ]);
    expect(lifts.decider).toMatchObject({ lift: 1.7, contacted: 20, replied: 6 });
    expect(lifts.user?.lift).toBe(0.5);
    const cto = rankPerson({ ...base, title: "CTO", email: "x@acme.dev", emailStatus: "found", company: { ...company, score: 50 } }, lifts);
    expect(cto.score).toBe(85);
    expect(cto.reasons).toContain("Decision makers reply 1.7× average so far (6/20)");
  });
});

describe("learnLifts", () => {
  it("stays neutral without replies and pulls small groups toward the average", () => {
    expect(learnLifts([{ key: "decider", contacted: 5, replied: 0 }])).toEqual({});
    const lifts = learnLifts([
      { key: "decider", contacted: 1, replied: 1 },
      { key: "user", contacted: 30, replied: 2 },
    ]);
    // One reply out of one would be a 15× lift raw; smoothing keeps it modest.
    expect(lifts.decider!.lift).toBeLessThan(2.1);
    expect(lifts.user!.lift).toBeGreaterThan(0.5);
  });
});
