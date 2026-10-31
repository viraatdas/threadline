import type { FetchLike } from "@/lib/sources/types";

export interface Call {
  url: URL;
  init: RequestInit | undefined;
}

/** A fetch stand-in that routes every request through `handler` and records calls. */
export function fakeFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
