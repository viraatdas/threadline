import { clsx } from "clsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { twMerge } from "tailwind-merge";

export const cn = (...values: Parameters<typeof clsx>) => twMerge(clsx(values));

const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const buttonVariants = {
  primary: "bg-accent text-white hover:bg-accent-strong disabled:bg-line-strong",
  secondary: "border border-line bg-white text-ink hover:border-line-strong hover:bg-surface-subtle disabled:text-ink-faint",
  ghost: "text-ink-muted hover:bg-surface-subtle hover:text-ink disabled:text-ink-faint",
  danger: "border border-line bg-white text-danger hover:border-danger/40 disabled:text-ink-faint",
} as const;

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof buttonVariants;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[7px] font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "h-8 px-2.5 text-[12px]" : "h-9 px-3.5 text-[13px]",
        buttonVariants[variant],
        focus,
        className,
      )}
    />
  );
}

export const inputClass = cn(
  "w-full rounded-[7px] border border-line bg-white px-3 text-[13px] text-ink placeholder:text-ink-faint hover:border-line-strong focus:border-accent focus:outline-none",
);

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputClass, "h-9", props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(inputClass, "py-2 leading-6", props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(inputClass, "h-9 pr-8", props.className)} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-[12px] font-medium text-ink">{label}</span>
      {children}
      {hint ? <span className="block text-[12px] leading-5 text-ink-muted">{hint}</span> : null}
    </label>
  );
}

const tones = {
  neutral: "bg-ink-faint",
  accent: "bg-accent",
  blue: "bg-secondary",
  warning: "bg-warning",
  danger: "bg-danger",
} as const;

// Status is a dot plus words, never color alone.
export function Status({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
      <span className={cn("size-1.5 shrink-0 rounded-full", tones[tone])} aria-hidden="true" />
      {children}
    </span>
  );
}

export function Score({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[12px] text-ink-faint">—</span>;
  const tone = value >= 70 ? "text-accent-strong" : value >= 40 ? "text-ink" : "text-ink-faint";
  return <span className={cn("text-[13px] font-semibold tabular-nums", tone)}>{value}</span>;
}

export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-b border-line py-7 last:border-b-0", className)}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
          {description ? <p className="mt-1 max-w-2xl text-[13px] leading-5 text-ink-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-[8px] border border-dashed border-line px-4 py-6 text-[13px] leading-6 text-ink-muted">{children}</p>;
}

export function relativeTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === "minute") return format.format(Math.round(diff / ms), unit);
  }
  return "now";
}
