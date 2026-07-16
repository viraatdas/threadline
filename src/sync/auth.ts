import { timingSafeEqual } from "node:crypto";

export function isAuthorizedCronRequest(
  request: Request,
  expectedSecret = process.env.CRON_SECRET,
): boolean {
  if (!expectedSecret) return false;
  const authorization = request.headers.get("authorization");
  const headerSecret = request.headers.get("x-threadline-cron-secret");
  const candidate = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : headerSecret;
  if (!candidate) return false;

  const expected = Buffer.from(expectedSecret);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function boundedInvocationId(
  value: string | null,
  fallback: string,
): string {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 255) : fallback;
}
