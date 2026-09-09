import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// The board is the landing page. Forward any query string (for example the
// `demo=1` fixture flag used by the release suite) so it survives the redirect.
export default async function HomePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) params.append(key, item);
    }
  }
  if (!params.has("view")) params.set("view", "board");
  redirect(`/people?${params.toString()}`);
}
