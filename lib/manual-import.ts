import { normalizeDomain } from "@/lib/sources/domain";
import type { FindResult, FoundCompany } from "@/lib/sources/types";

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$/i;
const FREE_MAIL = /^(gmail|googlemail|yahoo|outlook|hotmail|icloud|me|proton|protonmail|aol|live|hey)\./i;

// One prospect per line, fields separated by commas or tabs, in any order:
//   Jane Doe, CTO, jane@acme.dev, linkedin.com/in/janedoe, acme.dev
// Lines with only a URL or domain add a company. Pastes from Apollo/Clay CSV
// exports work as long as each row is on its own line.
export function parseManualImport(text: string): FindResult {
  const byCompany = new Map<string, FoundCompany>();
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 500);

  lines.forEach((line, index) => {
    const fields = line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((f) => f.replace(/^"|"$/g, "").trim()).filter(Boolean);
    let email: string | undefined;
    let linkedinUrl: string | undefined;
    let domain: string | undefined;
    const text: string[] = [];
    for (const field of fields) {
      if (!email && EMAIL.test(field)) email = field.toLowerCase();
      else if (!linkedinUrl && /linkedin\.com\/in\//i.test(field)) {
        linkedinUrl = field.startsWith("http") ? field : `https://${field.replace(/^\/+/, "")}`;
      } else if (!domain && /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(field) && !/\s/.test(field)) {
        domain = normalizeDomain(field);
      } else text.push(field);
    }
    const emailDomain = email?.split("@")[1];
    if (!domain && emailDomain && !FREE_MAIL.test(emailDomain)) domain = normalizeDomain(emailDomain);
    const [name, title, companyName] = text;
    if (!domain && !companyName) {
      warnings.push(`Line ${index + 1}: no company domain or name, skipped.`);
      return;
    }
    const key = domain ?? companyName!.toLowerCase();
    const company =
      byCompany.get(key) ??
      ({
        name: companyName ?? titleCase(domain!.split(".")[0]!),
        ...(domain ? { domain, website: `https://${domain}` } : {}),
        signals: [],
        people: [],
      } satisfies FoundCompany);
    byCompany.set(key, company);
    if (name && (email || linkedinUrl || title)) {
      company.people.push({
        name,
        ...(title ? { title } : {}),
        ...(email ? { email, emailStatus: "found" as const } : {}),
        ...(linkedinUrl ? { linkedinUrl } : {}),
      });
    }
  });
  return { source: "manual", companies: [...byCompany.values()], warnings };
}

function titleCase(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
