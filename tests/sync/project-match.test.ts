import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  classifyProjectMatches,
  isProjectMatchConfigured,
  ProjectMatchConfigError,
  type ProjectMatchContact,
} from "@/lib/ai/project-match";

function contact(id: string, name: string): ProjectMatchContact {
  return { id, name };
}

function mockResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

function completion(content: string) {
  return { choices: [{ message: { content } }] };
}

const originalKey = process.env.OPENROUTER_API_KEY;
const originalModel = process.env.PROJECT_MATCH_MODEL;

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  delete process.env.PROJECT_MATCH_MODEL;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.PROJECT_MATCH_MODEL;
  else process.env.PROJECT_MATCH_MODEL = originalModel;
});

describe("classifyProjectMatches", () => {
  it("throws a config error when the API key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(isProjectMatchConfigured()).toBe(false);
    await expect(
      classifyProjectMatches({
        name: "Libra",
        description: "SRE agent",
        contacts: [contact("a", "A")],
      }),
    ).rejects.toBeInstanceOf(ProjectMatchConfigError);
  });

  it("returns nothing for an empty roster without calling the model", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await classifyProjectMatches({
      name: "Libra",
      description: "SRE agent",
      contacts: [],
    });
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses verdicts and preserves the caller's contact order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse(
        completion(
          JSON.stringify({
            results: [
              { id: "b", match: false, confidence: 0.1, reason: "no" },
              { id: "a", match: true, confidence: 0.9, reason: "yes" },
            ],
          }),
        ),
      ),
    );
    const result = await classifyProjectMatches({
      name: "Libra",
      description: "SRE agent",
      contacts: [contact("a", "A"), contact("b", "B")],
    });
    expect(result.map((v) => v.id)).toEqual(["a", "b"]);
    expect(result[0]).toMatchObject({ id: "a", match: true, confidence: 0.9 });
  });

  it("recovers JSON wrapped in prose or code fences", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse(
        completion(
          'Here you go:\n```json\n{"results":[{"id":"a","match":true,"confidence":2,"reason":"clamp me"}]}\n```',
        ),
      ),
    );
    const result = await classifyProjectMatches({
      name: "Libra",
      description: "SRE agent",
      contacts: [contact("a", "A")],
    });
    // Confidence above 1 is clamped.
    expect(result).toEqual([
      { id: "a", match: true, confidence: 1, reason: "clamp me" },
    ]);
  });

  it("ignores verdicts for ids that were not requested", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse(
        completion(
          JSON.stringify({
            results: [
              { id: "ghost", match: true, confidence: 1, reason: "nope" },
              { id: "a", match: true, confidence: 0.5, reason: "ok" },
            ],
          }),
        ),
      ),
    );
    const result = await classifyProjectMatches({
      name: "Libra",
      description: "SRE agent",
      contacts: [contact("a", "A")],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a");
  });

  it("batches large rosters and isolates a failed batch", async () => {
    // 13 contacts => 3 batches of 6/6/1. Fail the middle batch.
    const contacts = Array.from({ length: 13 }, (_, i) =>
      contact(`c${i}`, `C${i}`),
    );
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      call += 1;
      const body = JSON.parse((init as RequestInit).body as string) as {
        messages: { content: string }[];
      };
      const roster = body.messages[1]?.content ?? "";
      const ids = [...roster.matchAll(/\[id:(c\d+)\]/g)].map((m) => m[1]);
      if (call === 2) return { ok: false, status: 500 } as Response;
      return mockResponse(
        completion(
          JSON.stringify({
            results: ids.map((id) => ({
              id,
              match: true,
              confidence: 0.7,
              reason: "batch",
            })),
          }),
        ),
      );
    });
    const result = await classifyProjectMatches({
      name: "Libra",
      description: "SRE agent",
      contacts,
    });
    // The failed batch's 6 contacts drop out; the other 7 survive.
    expect(result.length).toBe(7);
    expect(result.every((v) => contacts.some((c) => c.id === v.id))).toBe(true);
  });

  it("uses the configured model override", async () => {
    process.env.PROJECT_MATCH_MODEL = "z-ai/glm-5.3-flash";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(mockResponse(completion(JSON.stringify({ results: [] }))));
    await classifyProjectMatches({
      name: "Libra",
      description: "SRE agent",
      contacts: [contact("a", "A")],
    });
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("z-ai/glm-5.3-flash");
  });
});
