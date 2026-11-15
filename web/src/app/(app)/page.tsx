"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowRightLeft,
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  Circle,
  Clock,
  Gauge,
  HelpCircle,

  MessagesSquare,
  PhoneCall,
  Plus,
  ShieldCheck,
  Timer,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AgentAvatar } from "@/components/agent-avatar";
import { CallsTable } from "@/components/calls-table";
import { BarSeries, BreakdownBars, Legend, LineSeries, SERIES } from "@/components/charts";
import { EmptyState, Page, PageHeader } from "@/components/common";
import { api } from "@/lib/api";
import { useIsAdmin } from "@/lib/auth";
import { formatDuration, timeAgo } from "@/lib/format";
import type { Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";
import type { Agent, CallRow, PhoneNumberRow, Settings } from "@/lib/types";

type Kpis = {
  calls: number;
  unique_callers: number;
  avg_duration_s: number;
  talk_time_s: number;
  kb_lookups: number;
  kb_hits: number;
  kb_misses: number;
  kb_failures: number;
  transferred_calls: number;
  completed_calls: number;
  errors: number;
  kb_latency_p50_ms: number | null;
  kb_latency_p95_ms: number | null;
};
type Question = { key: string; question: string; asked: number; answered: number; unanswered?: number; last_asked: string };
type Analytics = {
  range: { days: number };
  kpis: Kpis;
  previous: Kpis;
  daily: { day: string; calls: number; avg_duration_s: number; kb_lookups: number; kb_hits: number; transfers: number }[];
  latency_daily: { day: string; p50: number; p95: number }[];
  hourly: { hour: number; calls: number }[];
  outcomes: { outcome: string; calls: number }[];
  kb_results: { result: string; lookups: number }[];
  top_questions: Question[];
  unanswered_questions: Question[];
  agents: { agent_id: string | null; agent_name: string | null; calls: number; avg_duration_s: number; kb_lookups: number; kb_hits: number; transfers: number; last_call: string }[];
  recent_calls: CallRow[];
};

const RANGES = [
  { days: 1, label: "24h" },
  { days: 7, label: "7d" },
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
];
const TZ = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "America/Chicago";

const rate = (n: number, d: number) => (d ? n / d : null);
const pctText = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const hhmm = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : formatDuration(s));

function Delta({ now, before, better = "up", asRate = false }: { now: number | null; before: number | null; better?: "up" | "down"; asRate?: boolean }) {
  if (now == null || before == null || (!before && !asRate)) return <span className="text-xs text-muted-foreground">No prior data</span>;
  const diff = asRate ? (now - before) * 100 : before ? ((now - before) / before) * 100 : 0;
  if (Math.abs(diff) < 0.5) return <span className="text-xs text-muted-foreground">No change</span>;
  const good = better === "up" ? diff > 0 : diff < 0;
  const Icon = diff > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", good ? "text-emerald-600" : "text-rose-600")}>
      <Icon className="size-3.5" />
      {Math.abs(Math.round(diff))}
      {asRate ? " pts" : "%"}
    </span>
  );
}

function Kpi({ label, value, delta, sub }: { icon?: LucideIcon; tone?: Tone; label: string; value: React.ReactNode; delta?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="px-5 py-4">
      <div className="text-[13px] text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-baseline gap-2.5">
        <span className="text-[24px] font-semibold leading-none tracking-tight tabular-nums">{value}</span>
        {delta}
      </div>
      {sub && <div className="mt-2 truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Card({ title, right, children, className, subtitle }: { title: string; icon?: LucideIcon; tone?: Tone; right?: React.ReactNode; children: React.ReactNode; className?: string; subtitle?: string }) {
  return (
    <section className={cn("min-w-0", className)}>
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold leading-6">{title}</h2>
          {subtitle && <p className="text-[13px] text-muted-foreground">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function Setup() {
  const isAdmin = useIsAdmin();
  return isAdmin ? <SetupChecklist /> : null;
}

function SetupChecklist() {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/settings") });
  const { data: numbers } = useQuery({ queryKey: ["phone-numbers"], queryFn: () => api.get<{ numbers: PhoneNumberRow[] }>("/phone-numbers") });
  const { data: agents } = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/agents") });
  if (!settings || !numbers || !agents) return null;
  const steps = [
    { done: !!(settings.openai_api_key_status?.set && settings.elevenlabs_api_key_status?.set && settings.twilio_auth_token_status?.set), title: "Connect providers", href: "/settings" },
    { done: !!settings.public_base_url, title: "Set public URL", href: "/settings" },
    { done: agents.length > 0, title: "Create an agent", href: "/agents" },
    { done: agents.some((a) => a.knowledge.knowledge_base_id), title: "Attach a knowledge base", href: "/knowledge-bases" },
    { done: numbers.numbers.some((n) => n.status === "connected" && n.agent_id), title: "Connect a number", href: "/phone-numbers" },
  ];
  const left = steps.filter((s) => !s.done);
  if (!left.length) return null;
  return (
    <div className="mb-8 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg bg-neutral-100/80 px-4 py-2.5">
      <span className="text-[13px] font-medium">Finish setup</span>
      {steps.map((s) => (
        <Link key={s.title} href={s.href} className={cn("inline-flex items-center gap-1.5 text-[13px]", s.done ? "text-muted-foreground line-through" : "text-foreground/80 underline-offset-2 hover:underline")}>
          {s.done ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
          {s.title}
        </Link>
      ))}
    </div>
  );
}

function QuestionsTable({ rows, empty, unanswered }: { rows: Question[]; empty: string; unanswered?: boolean }) {
  if (!rows.length) return <div className="flex h-32 items-center justify-center text-[13px] text-muted-foreground">{empty}</div>;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-8 pl-0 text-xs">Question</TableHead>
          <TableHead className="h-8 w-24 text-right text-xs">{unanswered ? "Unanswered" : "Asked"}</TableHead>
          <TableHead className="h-8 w-24 pr-0 text-right text-xs">{unanswered ? "Last asked" : "Answered"}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((q) => (
          <TableRow key={q.key}>
            <TableCell className="max-w-0 truncate py-2 pl-0 text-[13px]" title={q.question}>
              {q.question}
            </TableCell>
            <TableCell className="py-2 text-right text-[13px] font-medium tabular-nums">
              {unanswered ? (
                <>
                  {q.unanswered}
                  <span className="font-normal text-muted-foreground"> / {q.asked}</span>
                </>
              ) : (
                q.asked
              )}
            </TableCell>
            <TableCell className="py-2 pr-0 text-right text-xs tabular-nums text-muted-foreground">
              {unanswered ? timeAgo(q.last_asked) : pctText(rate(q.answered, q.asked))}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  completed: "Resolved by agent",
  transferred: "Transferred to a person",
  after_hours_transfer: "After-hours transfer",
  no_agent: "No agent on number",
  in_progress: "In progress",
  other: "Other",
};
const RESULT_LABEL: Record<string, string> = {
  answer: "Answered",
  no_answer: "No answer",
  timeout: "Timed out",
  rate_limited: "Rate limited",
  unauthorized: "Key rejected",
  http_error: "Service error",
  error: "Error",
  no_kb: "No knowledge base",
};

export default function HomePage() {
  const [days, setDays] = useState(30);
  const [agentId, setAgentId] = useState("all");
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/agents") });
  const { data, isLoading } = useQuery({
    queryKey: ["analytics", days, agentId],
    queryFn: () => api.get<Analytics>(`/analytics?days=${days}&tz=${encodeURIComponent(TZ)}${agentId !== "all" ? `&agent_id=${agentId}` : ""}`),
    refetchInterval: 30_000,
    placeholderData: (prev) => prev,
  });

  const daily = useMemo(() => {
    if (!data) return [];
    const byDay = new Map(data.daily.map((d) => [d.day, d]));
    const lat = new Map(data.latency_daily.map((d) => [d.day, d]));
    const n = Math.max(days, 1);
    return Array.from({ length: n }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (n - 1 - i));
      const key = d.toLocaleDateString("en-CA");
      const row = byDay.get(key);
      const l = lat.get(key);
      return {
        day: key,
        calls: row?.calls ?? 0,
        answer_rate: row?.kb_lookups ? Math.round((row.kb_hits / row.kb_lookups) * 100) : null,
        p50: l?.p50 != null ? Math.round(l.p50) : null,
        p95: l?.p95 != null ? Math.round(l.p95) : null,
      };
    });
  }, [data, days]);

  const hourly = useMemo(() => {
    const m = new Map((data?.hourly ?? []).map((h) => [h.hour, h.calls]));
    return Array.from({ length: 24 }, (_, h) => ({ hour: `${h % 12 || 12}${h < 12 ? "a" : "p"}`, calls: m.get(h) ?? 0 }));
  }, [data]);

  const k = data?.kpis;
  const p = data?.previous;
  const rangeLabel = days === 1 ? "previous 24h" : `previous ${days} days`;

  return (
    <Page className="max-w-7xl">
      <PageHeader
        title="Home"
        description="How your voice agents are performing."
        actions={
          <>
            <div className="flex h-8 items-center gap-0.5 rounded-lg border bg-background p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.days}
                  onClick={() => setDays(r.days)}
                  className={cn(
                    "h-full rounded-md px-3 text-[13px] font-medium transition-colors",
                    days === r.days ? "bg-neutral-100 text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="h-8 w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agents.data?.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button asChild>
              <Link href="/agents?new=1">
                <Plus /> New agent
              </Link>
            </Button>
          </>
        }
      />
      <Setup />

      {isLoading || !k || !p || !data ? (
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[118px] rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-12">
          <div className="grid grid-cols-2 overflow-hidden rounded-xl border xl:grid-cols-4 [&>*]:border-border [&>*:nth-child(n+5)]:border-t xl:[&>*:not(:nth-child(4n+1))]:border-l max-xl:[&>*:nth-child(even)]:border-l max-xl:[&>*:nth-child(n+3)]:border-t">
            <Kpi icon={PhoneCall} tone="indigo" label="Calls" value={k.calls} delta={<Delta now={k.calls} before={p.calls} />} sub={`vs ${p.calls} in ${rangeLabel}`} />
            <Kpi icon={Users} tone="violet" label="Unique callers" value={k.unique_callers} delta={<Delta now={k.unique_callers} before={p.unique_callers} />} sub={k.calls ? `${(k.calls / Math.max(k.unique_callers, 1)).toFixed(1)} calls per caller` : "—"} />
            <Kpi icon={Timer} tone="sky" label="Avg. call length" value={k.calls ? formatDuration(k.avg_duration_s) : "—"} delta={<Delta now={k.avg_duration_s} before={p.avg_duration_s} better="down" />} sub={`${hhmm(k.talk_time_s)} total talk time`} />
            <Kpi
              icon={ShieldCheck}
              tone="emerald"
              label="Resolved by agent"
              value={pctText(rate(k.completed_calls, k.calls))}
              delta={<Delta now={rate(k.completed_calls, k.calls)} before={rate(p.completed_calls, p.calls)} asRate />}
              sub={`${k.completed_calls} of ${k.calls} calls, no transfer`}
            />
            <Kpi
              icon={BookOpen}
              tone="sky"
              label="KB answer rate"
              value={pctText(rate(k.kb_hits, k.kb_lookups))}
              delta={<Delta now={rate(k.kb_hits, k.kb_lookups)} before={rate(p.kb_hits, p.kb_lookups)} asRate />}
              sub={`${k.kb_hits} of ${k.kb_lookups} questions answered`}
            />
            <Kpi icon={HelpCircle} tone="amber" label="Unanswered questions" value={k.kb_misses} delta={<Delta now={k.kb_misses} before={p.kb_misses} better="down" />} sub={k.kb_failures ? `+ ${k.kb_failures} lookup errors` : "No lookup errors"} />
            <Kpi
              icon={ArrowRightLeft}
              tone="rose"
              label="Transferred"
              value={k.transferred_calls}
              delta={<Delta now={k.transferred_calls} before={p.transferred_calls} better="down" />}
              sub={`${pctText(rate(k.transferred_calls, k.calls))} of calls`}
            />
            <Kpi
              icon={Gauge}
              tone="slate"
              label="KB latency (median)"
              value={k.kb_latency_p50_ms != null ? `${Math.round(k.kb_latency_p50_ms)} ms` : "—"}
              delta={<Delta now={k.kb_latency_p50_ms} before={p.kb_latency_p50_ms} better="down" />}
              sub={k.kb_latency_p95_ms != null ? `p95 ${Math.round(k.kb_latency_p95_ms)} ms` : "No lookups yet"}
            />
          </div>

          <div className="grid gap-x-12 gap-y-12 xl:grid-cols-3">
            <Card title="Calls per day" icon={PhoneCall} tone="indigo" className="xl:col-span-2" right={<span className="text-xs text-muted-foreground">{k.calls} total</span>}>
              <BarSeries data={daily} x="day" y="calls" name="Calls" tickFormatter={shortDay} height={240} />
            </Card>
            <Card title="Call outcomes" icon={CheckCircle2} tone="emerald">
              <BreakdownBars
                rows={data.outcomes.map((o) => ({ label: OUTCOME_LABEL[o.outcome] ?? o.outcome, value: o.calls }))}
              />
            </Card>
          </div>

          <div className="grid gap-x-12 gap-y-12 xl:grid-cols-3">
            <Card title="Knowledge base results" icon={BookOpen} tone="sky">
              <BreakdownBars
                rows={data.kb_results.map((r) => ({ label: RESULT_LABEL[r.result] ?? r.result, value: r.lookups }))}
              />
            </Card>
            <Card title="Knowledge base latency" icon={Gauge} tone="slate" className="xl:col-span-2" right={<Legend items={[{ name: "Median", color: SERIES[0] }, { name: "p95", color: SERIES[1], dashed: true }]} />}>
              <LineSeries
                data={daily}
                x="day"
                tickFormatter={shortDay}
                format={(v) => `${v} ms`}
                axisFormat={(v) => `${(v / 1000).toFixed(1)}s`}
                lines={[
                  { key: "p50", name: "Median", color: SERIES[0] },
                  { key: "p95", name: "p95", color: SERIES[1], dashed: true },
                ]}
              />
            </Card>
          </div>

          <div className="grid gap-x-12 gap-y-12 xl:grid-cols-3">
            <Card title="Calls by hour" icon={Clock} tone="violet" right={<span className="text-xs text-muted-foreground">{TZ.split("/").pop()?.replaceAll("_", " ")} time</span>}>
              <BarSeries data={hourly} x="hour" y="calls" name="Calls" height={220} />
            </Card>
            <Card title="Agents" icon={Users} tone="violet" className="xl:col-span-2">
              {data.agents.length ? (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-8 pl-0 text-xs">Agent</TableHead>
                      <TableHead className="h-8 text-right text-xs">Calls</TableHead>
                      <TableHead className="h-8 text-right text-xs">Avg. length</TableHead>
                      <TableHead className="h-8 text-right text-xs">KB answer rate</TableHead>
                      <TableHead className="h-8 text-right text-xs">Transfers</TableHead>
                      <TableHead className="h-8 pr-0 text-right text-xs">Last call</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.agents.map((a) => (
                      <TableRow key={a.agent_id ?? "none"}>
                        <TableCell className="py-2 pl-0">
                          <Link href={a.agent_id ? `/agents/${a.agent_id}` : "/phone-numbers"} className="flex items-center gap-2 text-[13px] font-medium hover:underline">
                            <AgentAvatar name={a.agent_name ?? "?"} size={22} />
                            {a.agent_name ?? "No agent"}
                          </Link>
                        </TableCell>
                        <TableCell className="py-2 text-right text-[13px] tabular-nums">{a.calls}</TableCell>
                        <TableCell className="py-2 text-right text-[13px] tabular-nums">{formatDuration(a.avg_duration_s)}</TableCell>
                        <TableCell className="py-2 text-right text-[13px] tabular-nums">{pctText(rate(a.kb_hits, a.kb_lookups))}</TableCell>
                        <TableCell className="py-2 text-right text-[13px] tabular-nums">{a.transfers}</TableCell>
                        <TableCell className="py-2 pr-0 text-right text-xs text-muted-foreground">{timeAgo(a.last_call)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">No calls in this period</div>
              )}
            </Card>
          </div>

          <div className="grid gap-x-12 gap-y-12 xl:grid-cols-2">
            <Card title="Top unanswered questions" subtitle="Candidates to add to your knowledge base">
              <QuestionsTable rows={data.unanswered_questions} unanswered empty="Every question was answered" />
            </Card>
            <Card title="Most asked questions" icon={MessagesSquare} tone="sky">
              <QuestionsTable rows={data.top_questions} empty="No questions yet" />
            </Card>
          </div>

          <div>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Recent conversations</h2>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/conversations">
                  View all <ArrowRight />
                </Link>
              </Button>
            </div>
            {data.recent_calls.length ? (
              <CallsTable calls={data.recent_calls} />
            ) : (
              <EmptyState icon={MessagesSquare} title="No conversations yet" description="Calls to your numbers appear here with transcripts and lookups." />
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

