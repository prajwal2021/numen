"use client";

import { ArrowRightLeft, CalendarOff, Clock, Moon, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dot, Field, Pill, Section } from "@/components/common";
import { cn } from "@/lib/utils";
import { WEEKDAYS, WEEKDAY_NAMES, type Agent } from "@/lib/types";
import { useMeta } from "./agent-tab";
import type { Patch } from "./use-agent-draft";

function PhoneField({ value, onChange, error, placeholder }: { value: string | null; onChange: (v: string | null) => void; error?: string; placeholder?: string }) {
  return (
    <Input
      className={cn("w-64 font-mono text-[13px]", error && "border-destructive")}
      placeholder={placeholder ?? "+18065550100"}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}

export function RoutingTab({ draft, patch, errors }: { draft: Agent; patch: Patch; errors: Record<string, string> }) {
  const { data: meta } = useMeta();
  const r = draft.routing;
  const setDay = (d: (typeof WEEKDAYS)[number], v: Partial<Agent["routing"]["week"]["mon"]>) =>
    patch("routing", { week: { ...r.week, [d]: { ...r.week[d], ...v } } });

  return (
    <div className="space-y-5">
      <Section
        title="Office hours"
        description="When the office is open"
        icon={Clock}
        tone="emerald"
        actions={
          <div className="flex items-center gap-3">
            {r.office_hours_enabled && (
              <Pill tone={draft.office_open_now ? "green" : "gray"}>
                <Dot tone={draft.office_open_now ? "green" : "gray"} /> {draft.office_open_now ? "Open now" : "Closed now"}
              </Pill>
            )}
            <Switch checked={r.office_hours_enabled} onCheckedChange={(v) => patch("routing", { office_hours_enabled: v })} />
          </div>
        }
      >
        {!r.office_hours_enabled ? (
          <p className="text-[13px] text-muted-foreground">Off: always treated as open.</p>
        ) : (
          <>
            <Field label="Time zone">
              <Select value={r.timezone} onValueChange={(v) => patch("routing", { timezone: v })}>
                <SelectTrigger className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {(meta?.timezones ?? [r.timezone]).map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="divide-y rounded-lg border">
              {WEEKDAYS.map((d) => {
                const day = r.week[d];
                return (
                  <div key={d} className="flex h-12 items-center gap-4 px-4">
                    <Switch checked={day.open} onCheckedChange={(v) => setDay(d, { open: v })} />
                    <div className="w-28 text-[13px] font-medium">{WEEKDAY_NAMES[d]}</div>
                    {day.open ? (
                      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                        <Input type="time" className="h-8 w-32" value={day.start} onChange={(e) => setDay(d, { start: e.target.value })} />
                        to
                        <Input type="time" className="h-8 w-32" value={day.end} onChange={(e) => setDay(d, { end: e.target.value })} />
                      </div>
                    ) : (
                      <span className="text-[13px] text-muted-foreground">Closed</span>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Section>

      {r.office_hours_enabled && (
        <Section
          title="Holidays"
          description="Closed all day"
          icon={CalendarOff}
          tone="amber"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => patch("routing", { holidays: [...r.holidays, { date: new Date().toISOString().slice(0, 10), name: "" }] })}
            >
              <Plus /> Add holiday
            </Button>
          }
        >
          {!r.holidays.length ? (
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <CalendarOff className="size-4" /> No holidays.
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {[...r.holidays]
                .map((h, i) => ({ h, i }))
                .sort((a, b) => a.h.date.localeCompare(b.h.date))
                .map(({ h, i }) => (
                  <div key={i} className="flex items-center gap-3 px-3 py-2">
                    <Input
                      type="date"
                      className="h-8 w-40"
                      value={h.date}
                      onChange={(e) => patch("routing", { holidays: r.holidays.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)) })}
                    />
                    <Input
                      className="h-8 flex-1"
                      placeholder="Name, e.g. Thanksgiving"
                      value={h.name}
                      onChange={(e) => patch("routing", { holidays: r.holidays.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => patch("routing", { holidays: r.holidays.filter((_, j) => j !== i) })}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
            </div>
          )}
        </Section>
      )}

      <Section
        title="Transfer to a live agent"
        description="When the caller asks for a person"
        icon={ArrowRightLeft}
        tone="rose"
        actions={<Switch checked={r.transfer_enabled} onCheckedChange={(v) => patch("routing", { transfer_enabled: v })} />}
      >
        {!r.transfer_enabled ? (
          <p className="text-[13px] text-muted-foreground">Off: callers are told no one is available.</p>
        ) : (
          <>
            <Field label="Transfer number" error={errors["routing.transfer_number"]} hint="During office hours. E.164, e.g. +18065154465.">
              <PhoneField value={r.transfer_number} onChange={(v) => patch("routing", { transfer_number: v })} error={errors["routing.transfer_number"]} />
            </Field>
            <Field label="Said before transferring">
              <Input value={r.transfer_message} onChange={(e) => patch("routing", { transfer_message: e.target.value })} />
            </Field>
            {r.office_hours_enabled && (
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="After hours" hint="To the after-hours number.">
                  <Textarea rows={2} value={r.transfer_message_after_hours} onChange={(e) => patch("routing", { transfer_message_after_hours: e.target.value })} />
                </Field>
                <Field label="To voicemail" hint="No after-hours number set.">
                  <Textarea rows={2} value={r.transfer_message_voicemail} onChange={(e) => patch("routing", { transfer_message_voicemail: e.target.value })} />
                </Field>
              </div>
            )}
            <Field label="If the transfer fails">
              <Textarea rows={2} value={r.transfer_failed_message} onChange={(e) => patch("routing", { transfer_failed_message: e.target.value })} />
            </Field>
          </>
        )}
      </Section>

      {r.office_hours_enabled && (
        <Section title="Calls outside office hours" icon={Moon} tone="indigo">
          <div className="flex gap-3">
            {(
              [
                ["answer", "Agent answers", "Helps as usual; transfers go to the after-hours line or voicemail."],
                ["transfer", "Transfer immediately", "A short message, then straight to the after-hours number."],
              ] as const
            ).map(([value, title, desc]) => (
              <button
                key={value}
                type="button"
                onClick={() => patch("routing", { after_hours_action: value })}
                className={cn(
                  "flex-1 rounded-xl border p-4 text-left transition-all",
                  r.after_hours_action === value ? "border-primary bg-primary/[0.04] ring-1 ring-primary" : "hover:border-foreground/30",
                )}
              >
                <div className="text-[13px] font-semibold">{title}</div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>
              </button>
            ))}
          </div>
          <Field
            label="After-hours number"
            error={errors["routing.after_hours_number"]}
            hint={r.after_hours_action === "transfer" && !r.after_hours_number ? "Required, otherwise the agent answers." : "Optional."}
          >
            <PhoneField value={r.after_hours_number} onChange={(v) => patch("routing", { after_hours_number: v })} error={errors["routing.after_hours_number"]} />
          </Field>
          {r.after_hours_action === "transfer" && (
            <Field label="Said before the after-hours transfer">
              <Textarea rows={2} value={r.after_hours_message} onChange={(e) => patch("routing", { after_hours_message: e.target.value })} />
            </Field>
          )}
        </Section>
      )}
    </div>
  );
}
