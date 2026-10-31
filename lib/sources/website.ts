// Fetches a company homepage server-side and extracts a small, safe snapshot.
// URLs come from third-party data, so every hop is checked against SSRF.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { FetchLike } from "./types";
import { BROWSER_USER_AGENT, clip, decodeEntities, httpUrl, isUrlOnHost, isValidEmail, readTextCapped } from "./util";

export interface WebsiteSnapshot {
  url: string;
  title?: string;
  description?: string;
  /** Visible text, at most 6000 chars. */
  text: string;
  links: { linkedin?: string; github?: string; twitter?: string; careers?: string };
  /** mailto: and visible addresses, at most 10. */
  emails: string[];
  /** Which ICP keywords appear on the page. */
  mentions: string[];
}

type Lookup = (host: string) => Promise<string[]>;

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const MAX_TEXT = 6_000;

export const WEBSITE_KEYWORDS = [
  "ios",
  "macos",
  "swift",
  "xcode",
  "testflight",
  "app store",
  "github actions",
  "ci/cd",
  "agent",
  "computer use",
  "simulator",
] as const;

const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((r) => r.address);

// ---------------------------------------------------------------------------
// Address classification

function parseV4(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : undefined;
}

function isPublicV4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expands an IPv6 address into eight 16-bit groups. */
function parseV6(ip: string): number[] | undefined {
  let address = ip.toLowerCase();
  const tail: number[] = [];
  const lastColon = address.lastIndexOf(":");
  const last = address.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseV4(last);
    if (!v4) return undefined;
    const [a, b, c, d] = v4 as [number, number, number, number];
    tail.push((a << 8) | b, (c << 8) | d);
    // "::ffff:1.2.3.4" → "::ffff", but "::1.2.3.4" → "::".
    address = address.slice(0, lastColon + 1);
    if (!address.endsWith("::")) address = address.slice(0, -1);
  }
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const toGroups = (part: string) => (part ? part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = toGroups(halves[0] ?? "");
  const rest = toGroups(halves[1] ?? "");
  const missing = 8 - head.length - rest.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...new Array<number>(missing).fill(0), ...rest, ...tail];
  return groups.length === 8 && groups.every(Number.isInteger) ? groups : undefined;
}

/** True only for globally routable unicast addresses. Anything unparseable is not public. */
export function isPublicAddress(ip: string): boolean {
  const address = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const version = isIP(address);
  if (version === 4) {
    const v4 = parseV4(address);
    return v4 ? isPublicV4(v4) : false;
  }
  if (version !== 6) return false;
  const g = parseV6(address);
  if (!g) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embeddedV4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return isPublicV4(embeddedV4); // IPv4-mapped
    return false; // ::, ::1, deprecated IPv4-compatible
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicV4(embeddedV4); // NAT64
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return isPublicV4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]); // 6to4
  return (g0 & 0xe000) === 0x2000; // global unicast is 2000::/3
}

async function isSafeUrl(url: URL, lookup: Lookup): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || /\.(?:localhost|local|internal)$/.test(host)) return false;
  if (isIP(host)) return isPublicAddress(host);
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every(isPublicAddress);
}

// ---------------------------------------------------------------------------
// HTML extraction. Hostile pages can be built to make lazy regexes go
// quadratic, so block stripping is a linear scan and every regex is bounded.

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeEntities(value);
}

function metaDescription(html: string): string | undefined {
  for (const tag of html.match(/<meta\b[^<>]{0,2000}>/gi) ?? []) {
    const key = (attr(tag, "name") ?? attr(tag, "property"))?.toLowerCase();
    if (key === "description" || key === "og:description") {
      const content = clip(attr(tag, "content"), 500);
      if (content) return content;
    }
  }
  return undefined;
}

const SKIPPED_BLOCK_RE = /^<(script|style|noscript|template|svg|head)(?![a-z0-9-])/;

/** Visible text: drops comments, script/style-like blocks, and tags; decodes entities. */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (lower.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) break;
      i = end + 3;
      out.push(" ");
      continue;
    }
    const block = SKIPPED_BLOCK_RE.exec(lower.slice(lt, lt + 12));
    if (block) {
      const close = lower.indexOf(`</${block[1]}`, lt);
      const gt = close === -1 ? -1 : html.indexOf(">", close);
      if (gt === -1) break;
      i = gt + 1;
      out.push(" ");
      continue;
    }
    if (/[a-z/!?]/i.test(html[lt + 1] ?? "")) {
      const gt = html.indexOf(">", lt);
      if (gt === -1) break; // no ">" anywhere after, so no more tags either
      i = gt + 1;
      out.push(" ");
      continue;
    }
    out.push("<");
    i = lt + 1;
  }
  return decodeEntities(out.join("")).replace(/\s+/g, " ").trim();
}

const CAREERS_RE = /(?:^|[^a-z])(?:careers?|jobs|join[-\s]?us|we['’]?re[-\s]hiring|open[-\s]roles)(?:[^a-z]|$)/i;
const ATS_HOSTS = ["greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "ycombinator.com", "wellfound.com", "bamboohr.com"];

function extractLinks(html: string, base: URL): { links: WebsiteSnapshot["links"]; mailtos: string[] } {
  const links: WebsiteSnapshot["links"] = {};
  const mailtos: string[] = [];
  const site = base.hostname.replace(/^www\./, "");
  for (const match of html.matchAll(/<a\b([^<>]{0,2000})>([\s\S]{0,300}?)<\/a>/gi)) {
    const href = attr(match[1] ?? "", "href")?.trim();
    if (!href) continue;
    if (/^mailto:/i.test(href)) {
      try {
        mailtos.push(decodeURIComponent(href.slice(7).split("?")[0] ?? "").trim().toLowerCase());
      } catch {
        // malformed percent-encoding
      }
      continue;
    }
    let resolved: string | undefined;
    try {
      resolved = httpUrl(new URL(href, base).toString());
    } catch {
      continue;
    }
    if (!resolved) continue;
    const path = new URL(resolved).pathname;
    if (!links.linkedin && isUrlOnHost(resolved, "linkedin.com") && /^\/(?:company|in|school)\//.test(path)) links.linkedin = resolved;
    else if (!links.github && isUrlOnHost(resolved, "github.com") && /^\/[a-z0-9-]+\/?$/i.test(path)) links.github = resolved;
    else if (!links.twitter && isUrlOnHost(resolved, "twitter.com", "x.com") && /^\/[a-z0-9_]{1,15}\/?$/i.test(path) && !/^\/(?:intent|share|home)\b/i.test(path)) links.twitter = resolved;
    else if (!links.careers) {
      const sameSite = isUrlOnHost(resolved, site);
      const text = htmlToText(match[2] ?? "");
      if ((sameSite || ATS_HOSTS.some((h) => isUrlOnHost(resolved, h))) && (CAREERS_RE.test(path) || CAREERS_RE.test(text))) links.careers = resolved;
    }
  }
  return { links, mailtos };
}

function keywordMentions(haystack: string): string[] {
  return WEBSITE_KEYWORDS.filter((keyword) => {
    const pattern = keyword.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&").replace(/ /g, "\\s*");
    return new RegExp(`(?<![a-z0-9])${pattern}s?(?![a-z0-9])`, "i").test(haystack);
  });
}

/** Parses already-fetched HTML. Exported for tests. */
export function parseHtml(html: string, url: string): WebsiteSnapshot {
  const base = new URL(url);
  const titleMatch = /<title\b[^<>]{0,200}>([\s\S]{0,2000}?)<\/title>/i.exec(html);
  const title = clip(decodeEntities(titleMatch?.[1] ?? ""), 300);
  const description = metaDescription(html);
  const fullText = htmlToText(html);
  const { links, mailtos } = extractLinks(html, base);
  const visibleEmails = fullText.slice(0, 200_000).match(/[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}/gi) ?? [];
  const emails = [...new Set([...mailtos, ...visibleEmails.map((e) => e.toLowerCase())])].filter(isValidEmail).slice(0, 10);
  return {
    url,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    text: fullText.slice(0, MAX_TEXT),
    links,
    emails,
    mentions: keywordMentions(`${title ?? ""} ${description ?? ""} ${fullText.slice(0, 200_000)}`),
  };
}

/** Fetches and snapshots a public web page. Never throws; null on any failure or blocked target. */
export async function fetchWebsite(url: string, options: { fetch?: FetchLike; lookup?: Lookup } = {}): Promise<WebsiteSnapshot | null> {
  const fetchImpl = options.fetch ?? fetch;
  const lookup = options.lookup ?? defaultLookup;
  const start = httpUrl(url, 2000);
  if (!start) return null;
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    let current = new URL(start);
    for (let hop = 0; ; hop++) {
      if (!(await isSafeUrl(current, lookup))) return null;
      const res = await fetchImpl(current, {
        redirect: "manual",
        signal,
        headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        if (!location || hop >= MAX_REDIRECTS) return null;
        current = new URL(location, current);
        continue;
      }
      if (!res.ok || !(res.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const html = await readTextCapped(res, MAX_BYTES);
      return parseHtml(html, current.toString());
    }
  } catch {
    return null;
  }
}
