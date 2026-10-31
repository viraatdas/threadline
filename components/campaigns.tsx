"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { saveCampaignAction } from "@/app/(app)/actions";
import { Button, Field, Input, Select, Status, Textarea, cn } from "@/components/ui";
import { CHANNELS, CHANNEL_LABELS, DEFAULT_CAMPAIGN, type CampaignStep } from "@/lib/domain";
import type { CampaignRow } from "@/lib/queries";

type Draft = { id?: string; name: string; angle: string; steps: CampaignStep[]; active: boolean };

export function Campaigns({ rows }: { rows: CampaignRow[] }) {
  const [editing, setEditing] = useState<Draft | null>(null);

  return (
    <div>
      <div className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.035em]">Campaigns</h1>
          <p className="mt-2 max-w-2xl text-[14px] text-ink-muted">
            A campaign is an angle plus a few steps across email and LinkedIn. AI writes each step from the prospect’s
            signals; you approve every one on Today. Replies stop the sequence.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => setEditing({ name: "", angle: DEFAULT_CAMPAIGN.angle, steps: DEFAULT_CAMPAIGN.steps, active: true })}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          New campaign
        </Button>
      </div>

      {editing && !editing.id ? <Editor initial={editing} onDone={() => setEditing(null)} /> : null}

      <ul className="divide-y divide-line">
        {rows.map((campaign) => (
          <li key={campaign.id} className="py-6">
            {editing?.id === campaign.id ? (
              <Editor initial={editing} onDone={() => setEditing(null)} />
            ) : (
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 max-w-3xl">
                  <h2 className="flex items-center gap-3 text-[16px] font-semibold">
                    {campaign.name}
                    <Status tone={campaign.active ? "accent" : "neutral"}>{campaign.active ? "active" : "paused"}</Status>
                  </h2>
                  <p className="mt-1 text-[13px] leading-6 text-ink-muted">{campaign.angle}</p>
                  <ol className="mt-3 flex flex-wrap gap-1.5 text-[12px]">
                    {campaign.steps.map((step, index) => (
                      <li key={index} className="rounded-[6px] border border-line px-2 py-1 text-ink-muted">
                        {index === 0 ? "Day 0" : `+${step.waitDays}d`} · {CHANNEL_LABELS[step.channel]}
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="flex shrink-0 items-start gap-6">
                  <dl className="grid grid-cols-4 gap-4 text-right text-[12px] text-ink-muted">
                    {(
                      [
                        ["Enrolled", campaign.enrolled],
                        ["Active", campaign.inSequence],
                        ["Sent", campaign.sent],
                        ["Replied", campaign.replied],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd className="text-[16px] font-semibold text-ink tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <Button size="sm" onClick={() => setEditing({ id: campaign.id, name: campaign.name, angle: campaign.angle, steps: campaign.steps, active: campaign.active })}>
                    Edit
                  </Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Editor({ initial, onDone }: { initial: Draft; onDone: () => void }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(initial);
  const [pending, startTransition] = useTransition();

  const setStep = (index: number, patch: Partial<CampaignStep>) =>
    setDraft({ ...draft, steps: draft.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)) });
  const move = (index: number, delta: number) => {
    const steps = [...draft.steps];
    const [step] = steps.splice(index, 1);
    steps.splice(index + delta, 0, step!);
    setDraft({ ...draft, steps });
  };

  const save = () =>
    startTransition(async () => {
      const result = await saveCampaignAction(draft);
      if (!result.ok) return void toast.error(result.error);
      toast.success("Campaign saved");
      onDone();
      router.refresh();
    });

  return (
    <form
      className="my-6 space-y-4 rounded-[10px] border border-line p-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Field label="Name">
        <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required />
      </Field>
      <Field label="Angle" hint="Who this is for and why now. Every draft in this campaign is written from it.">
        <Textarea rows={3} value={draft.angle} onChange={(event) => setDraft({ ...draft, angle: event.target.value })} required />
      </Field>
      <div className="space-y-2">
        <p className="text-[12px] font-medium">Steps</p>
        {draft.steps.map((step, index) => (
          <div key={index} className="grid gap-2 rounded-[8px] bg-surface-subtle p-3 sm:grid-cols-[160px_110px_1fr_auto] sm:items-start">
            <Select aria-label={`Step ${index + 1} channel`} value={step.channel} onChange={(event) => setStep(index, { channel: event.target.value as CampaignStep["channel"] })}>
              {CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {CHANNEL_LABELS[channel]}
                </option>
              ))}
            </Select>
            <label className={cn("flex h-9 items-center gap-2 text-[12px] text-ink-muted", index === 0 && "opacity-50")}>
              wait
              <Input
                type="number"
                min={0}
                max={60}
                disabled={index === 0}
                value={index === 0 ? 0 : step.waitDays}
                onChange={(event) => setStep(index, { waitDays: Number(event.target.value) })}
                className="w-16"
                aria-label={`Step ${index + 1} wait days`}
              />
              d
            </label>
            <Input
              value={step.guidance}
              placeholder="Guidance for this step"
              onChange={(event) => setStep(index, { guidance: event.target.value })}
              aria-label={`Step ${index + 1} guidance`}
            />
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                <ArrowUp className="size-3.5" aria-hidden="true" />
              </Button>
              <Button size="sm" variant="ghost" aria-label="Move down" disabled={index === draft.steps.length - 1} onClick={() => move(index, 1)}>
                <ArrowDown className="size-3.5" aria-hidden="true" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Remove step"
                disabled={draft.steps.length === 1}
                onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          disabled={draft.steps.length >= 8}
          onClick={() => setDraft({ ...draft, steps: [...draft.steps, { channel: "email", waitDays: 3, guidance: "" }] })}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          Add step
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} className="accent-[var(--accent)]" />
          Active (paused campaigns draft nothing new)
        </label>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : "Save campaign"}
          </Button>
        </div>
      </div>
    </form>
  );
}
