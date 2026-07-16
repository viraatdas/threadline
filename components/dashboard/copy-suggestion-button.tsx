"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

interface CopySuggestionButtonProps {
  text: string;
}

export function CopySuggestionButton({ text }: CopySuggestionButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;

    const timeout = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  async function copySuggestion() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  }

  return (
    <button
      type="button"
      onClick={copySuggestion}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-[6px] border border-line bg-white px-2.5 text-[12px] font-medium text-ink-muted transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none"
      aria-label={
        copied ? "Follow-up suggestion copied" : "Copy follow-up suggestion"
      }
    >
      {copied ? (
        <Check
          className="size-3.5 text-accent-strong"
          strokeWidth={2}
          aria-hidden="true"
        />
      ) : (
        <Copy className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
      )}
      <span>{copied ? "Copied" : "Copy note"}</span>
      <span className="sr-only" aria-live="polite">
        {copied ? "Follow-up suggestion copied to clipboard." : ""}
      </span>
    </button>
  );
}
