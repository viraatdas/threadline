export interface ParsedAddress {
  address: string;
  displayName?: string;
}

export function parseAddressList(
  value: string | null | undefined,
): ParsedAddress[] {
  if (!value) return [];
  const addresses = splitAddressList(value)
    .map(parseAddress)
    .filter((address): address is ParsedAddress => address !== null);

  return [
    ...new Map(addresses.map((address) => [address.address, address])).values(),
  ];
}

export function normalizeEmailAddress(value: string): string {
  return value
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();
}

export function decodeRfc2047(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_match, charset, encoding, data) => {
      try {
        const bytes =
          encoding.toLowerCase() === "b"
            ? Buffer.from(data, "base64")
            : decodeQuotedPrintable(data);
        return new TextDecoder(normalizeCharset(charset)).decode(bytes);
      } catch {
        return data;
      }
    },
  );
}

function splitAddressList(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angleDepth = 0;
  let commentDepth = 0;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === '"' && commentDepth === 0) quoted = !quoted;
    if (!quoted) {
      if (character === "<") angleDepth += 1;
      if (character === ">") angleDepth = Math.max(0, angleDepth - 1);
      if (character === "(") commentDepth += 1;
      if (character === ")") commentDepth = Math.max(0, commentDepth - 1);
    }
    if (
      character === "," &&
      !quoted &&
      angleDepth === 0 &&
      commentDepth === 0
    ) {
      if (current.trim()) entries.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (current.trim()) entries.push(current.trim());
  return entries;
}

function parseAddress(value: string): ParsedAddress | null {
  const withoutGroup =
    value.includes(":") && value.endsWith(";")
      ? value.slice(value.indexOf(":") + 1, -1)
      : value;
  const angleMatch = withoutGroup.match(/^(.*)<([^<>]+)>\s*$/);
  const addressSource = angleMatch?.[2] ?? withoutGroup;
  const addressMatch = addressSource.match(
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  );
  if (!addressMatch) return null;

  const address = normalizeEmailAddress(addressMatch[0]);
  const rawName = angleMatch?.[1]
    ?.replace(/\([^)]*\)/g, " ")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\\(["\\])/g, "$1");
  const displayName = rawName
    ? decodeRfc2047(rawName).replace(/\s+/g, " ").trim()
    : undefined;
  return displayName ? { address, displayName } : { address };
}

function decodeQuotedPrintable(value: string): Buffer {
  const normalized = value
    .replace(/_/g, " ")
    .replace(/=([A-F0-9]{2})/gi, (_match, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  return Buffer.from(normalized, "binary");
}

function normalizeCharset(value: string): string {
  const charset = value.trim().toLowerCase();
  if (charset === "iso-8859-1" || charset === "latin1") return "windows-1252";
  return charset;
}
