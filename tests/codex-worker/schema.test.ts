import { describe, expect, it } from "vitest";

import injectedOutput from "./fixtures/model-injected-output.json";
import validOutput from "./fixtures/valid-output.json";
import { parseClassificationOutput } from "../../worker/codex/schema";

describe("classification output schema", () => {
  it("accepts complete normalized outreach output", () => {
    const parsed = parseClassificationOutput(validOutput);
    expect(parsed.reply.state).toBe("replied");
    expect(parsed.company.domain).toBe("example.com");
    expect(parsed.confidence).toBe(0.94);
  });

  it("rejects model-injected tool fields", () => {
    expect(() => parseClassificationOutput(injectedOutput)).toThrow();
  });

  it("rejects inconsistent reply and follow-up semantics", () => {
    expect(() =>
      parseClassificationOutput({
        ...validOutput,
        reply: { detected: false, state: "replied", latestReplyAt: null },
        nextAction: { recommendation: "follow_up", followUpAt: null, summary: "Follow up." },
      }),
    ).toThrow();
  });
});
