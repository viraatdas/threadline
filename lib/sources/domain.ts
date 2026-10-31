// Turns URLs and hosts into a company domain, or undefined when the host is a
// platform (GitHub, LinkedIn, a hosting provider…) rather than a company.

// Matched as the host itself or any subdomain of it.
const GENERIC_HOSTS = [
  "github.com",
  "github.io",
  "githubusercontent.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "medium.com",
  "substack.com",
  "apple.com",
  "google.com",
  "notion.site",
  "notion.so",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "ycombinator.com",
  "producthunt.com",
  "reddit.com",
  "facebook.com",
  "instagram.com",
  "gitlab.com",
  "bitbucket.org",
  "npmjs.com",
  "pypi.org",
  "discord.gg",
  "discord.com",
  "t.co",
  "bit.ly",
  "linktr.ee",
  "wikipedia.org",
  // Profile-link hosts that show up in X bios.
  "bsky.app",
  "threads.net",
  "calendly.com",
  "bento.me",
  "beacons.ai",
  "about.me",
  "read.cv",
  "buymeacoffee.com",
  "ko-fi.com",
  "patreon.com",
  "tiktok.com",
  "twitch.tv",
  "mastodon.social",
  "dev.to",
  "hashnode.dev",
  "lu.ma",
  // Multi-tenant hosting: "acme.pages.dev" is not the company "pages.dev".
  "pages.dev",
  "workers.dev",
  "fly.dev",
  "web.app",
  "firebaseapp.com",
  "webflow.io",
  "framer.website",
  "framer.app",
  "carrd.co",
  "wixsite.com",
  "squarespace.com",
  "myshopify.com",
  "gitbook.io",
  "readthedocs.io",
  "blogspot.com",
  "wordpress.com",
  "replit.app",
  "glitch.me",
  "onrender.com",
  "railway.app",
  "streamlit.app",
  "huggingface.co",
];

// Second-level labels under a ccTLD that are public suffixes ("acme.co.uk").
const CC_SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "ne", "or", "go", "gob", "mil", "ltd", "plc", "nom"]);

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD_RE = /^(?:[a-z]{2,24}|xn--[a-z0-9-]{1,59})$/;

/**
 * Lower-case registrable domain without "www.", e.g. "https://blog.Offstage.cloud/x"
 * → "offstage.cloud". Undefined for invalid input, IP addresses, and generic hosts.
 */
export function normalizeDomain(input: string | null | undefined): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed)) return undefined;

  let host: string;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    if (!hasScheme && /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[^:/]+:\d/.test(trimmed)) return undefined; // mailto:, javascript:
    const url = new URL(hasScheme ? trimmed : `https://${trimmed.replace(/^\/+/, "")}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    host = url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }

  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return undefined;
  const tld = labels[labels.length - 1] as string;
  if (!TLD_RE.test(tld)) return undefined; // also rejects IPv4 literals

  const sld = labels[labels.length - 2] as string;
  const keep = tld.length === 2 && CC_SECOND_LEVEL.has(sld) ? 3 : 2;
  if (labels.length < keep) return undefined;

  if (GENERIC_HOSTS.some((g) => host === g || host.endsWith(`.${g}`))) return undefined;
  return labels.slice(-keep).join(".");
}

export function websiteFromDomain(domain: string): string {
  return `https://${domain}`;
}
