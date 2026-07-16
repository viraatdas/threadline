export async function consumeCheckpointedPages<TPage, TPageResult>(input: {
  pages: AsyncIterable<TPage>;
  apply(page: TPage): Promise<TPageResult>;
  cursor(page: TPage): string | undefined;
  failed(result: TPageResult): number;
  checkpoint(cursor: string): Promise<void>;
  accumulate(total: TPageResult, page: TPageResult): TPageResult;
  initial: TPageResult;
}): Promise<{ total: TPageResult; cursor?: string }> {
  let total = input.initial;
  let cursor: string | undefined;

  for await (const page of input.pages) {
    const result = await input.apply(page);
    total = input.accumulate(total, result);
    if (input.failed(result) > 0) break;
    const nextCursor = input.cursor(page);
    if (!nextCursor) continue;
    await input.checkpoint(nextCursor);
    cursor = nextCursor;
  }

  return { total, ...(cursor ? { cursor } : {}) };
}
