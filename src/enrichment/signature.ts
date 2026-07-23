// Deterministic role/company extraction from email signature blocks. Inbound
// messages usually end with "Name / Title / Company" lines — this reads only
// the tail of the body and never guesses beyond an explicit role keyword.

const ROLE_PATTERN =
  /\b(?:co[- ]?founder|founder|ceo|cto|coo|cfo|cmo|cpo|chief [a-z]+ officer|president|vice president|vp of [a-z &]+|vp|head of [a-z &]+|director|principal|partner|staff [a-z]+|senior [a-z]+|lead [a-z]+|[a-z]+ lead|engineer|developer|designer|scientist|researcher|recruiter|analyst|consultant|advisor|investor|product manager|program manager|account executive|solutions architect|architect|general manager|managing [a-z]+)\b/i;

const NOISE_LINE =
  /(https?:\/\/|www\.|@[\w-]+\.|^\+?[\d\s().-]{7,}$|^sent from|unsubscribe|^cal(endly)?\b|^book (a )?time)/i;

interface SignatureFacts {
  title: string;
  company: string | null;
}

function cleanLines(bodyText: string): string[] {
  return bodyText
    .split(/\r?\n/)
    .map((line) => line.replace(/^[>\s*-]+/, "").trim())
    .filter(Boolean)
    .slice(-15)
    .filter((line) => line.length <= 80 && !NOISE_LINE.test(line));
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) =>
      word.length > 2 || /^(vp|ceo|cto|coo|cfo|cmo|cpo|gm)$/i.test(word)
        ? word
        : word.toLowerCase(),
    )
    .join(" ");
}

// Accepts "Title, Company" / "Title | Company" / "Title at Company" /
// "Title @ Company" / a standalone role line. Returns null when no explicit
// role keyword appears — a name or slogan line must never become a title.
export function extractSignatureFacts(
  bodyText: string | null | undefined,
): SignatureFacts | null {
  if (!bodyText) return null;
  const lines = cleanLines(bodyText);
  for (const line of lines) {
    if (!ROLE_PATTERN.test(line)) continue;
    const separated = line.split(/\s+[|·•]\s+|,\s+|\s+at\s+|\s+@\s*/i);
    const first = separated[0]?.trim() ?? "";
    if (!ROLE_PATTERN.test(first) || first.split(/\s+/).length > 6) continue;
    const company = separated.length > 1 ? (separated[1]?.trim() ?? "") : "";
    return {
      title: titleCase(first),
      company:
        company && company.length <= 60 && !/^\d/.test(company)
          ? company
          : null,
    };
  }
  return null;
}
