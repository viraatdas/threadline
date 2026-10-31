import { timingSafeEqual } from "node:crypto";

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; the local `pnpm scout`
// CLI sends `Bearer $IMPORT_TOKEN`. Compared in constant time.
export function hasBearer(request: Request, ...secrets: (string | undefined)[]): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  return secrets.some((secret) => {
    if (!secret) return false;
    const expected = Buffer.from(secret);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  });
}
