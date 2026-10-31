// Last-resort address guessing. Callers must mark results emailStatus "guessed".
import { resolveMx as dnsResolveMx } from "node:dns/promises";

import { normalizeDomain } from "./domain";

type ResolveMx = (domain: string) => Promise<{ exchange: string }[]>;

const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "mx", "prof", "sir"]);
// Letters NFKD does not decompose into ASCII.
const FOLDS: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", đ: "d", ð: "d", ł: "l", þ: "th", ı: "i" };

function asciiFold(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ßæœøđðłþı]/g, (ch) => FOLDS[ch] ?? ch)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

/** `first@domain`, e.g. ("José Núñez", "acme.io") → "jose@acme.io". */
export function guessEmail(name: string, domain: string): string | undefined {
  const host = normalizeDomain(domain);
  if (!host) return undefined;
  const tokens = name
    .trim()
    .split(/\s+/)
    .map((t) => asciiFold(t).replace(/[^a-z]/g, ""))
    .filter((t) => t && !HONORIFICS.has(t));
  const first = tokens[0];
  return first && first.length >= 2 ? `${first}@${host}` : undefined;
}

/** True when the domain publishes at least one usable MX record. */
export async function domainAcceptsMail(domain: string, options: { resolveMx?: ResolveMx } = {}): Promise<boolean> {
  const host = normalizeDomain(domain);
  if (!host) return false;
  const resolveMx = options.resolveMx ?? dnsResolveMx;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), 5_000);
    });
    const records = await Promise.race([resolveMx(host), timeout]);
    // A null MX ("." per RFC 7505) means the domain explicitly accepts no mail.
    return records.some((r) => typeof r.exchange === "string" && r.exchange !== "" && r.exchange !== ".");
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
