"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, ArrowRightLeft, BookOpen, Bot, FileText, PhoneIncoming, Wrench } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EndReason } from "@/components/calls-table";
import { CopyButton, Mono, Page, Pill } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { formatDuration, formatPhone, formatWhen } from "@/lib/format";
import type { CallRecord, TimelineEvent } from "@/lib/types";

const SOURCE: Record<string, string> = {
  greeting: "First message",
  kb_answer: "Knowledge base answer",
  kb_fallback: "Fallback",
  lookup_filler: "Filler",
  transfer_message: "Transfer message",
  transfer_failed: "Transfer failed",
  goodbye: "Goodbye",
  safety_emergency: "Safety · emergency",
  safety_crisis: "Safety · crisis support",
  max_duration: "Time limit",
  llm: "LLM",
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Fixed lines come from bot_said (labelled by source); LLM-written lines only exist as
 *  assistant_turn, so show those whose text isn't already covered by a fixed line. */
function transcript(timeline: TimelineEvent[]): TimelineEvent[] {
  const fixed = norm(timeline.filter((e) => e.type === "bot_said").map((e) => String(e.text)).join(" "));
  return timeline.filter((e) => {
    if (["caller_said", "bot_said", "tool_call", "kb_lookup", "transfer", "error", "call_connected"].includes(e.type)) return true;
    if (e.type === "assistant_turn") return !fixed.includes(norm(String(e.text)));
    return false;
  });
}

function Stamp({ t }: { t: number }) {
  return <span className="w-10 shrink-0 pt-0.5 text-right font-mono text-[10.5px] tabular-nums text-muted-foreground">{formatDuration(t)}</span>;
}

function TranscriptView({ rec }: { rec: CallRecord }) {
  const items = transcript(rec.timeline);
  return (
    <div className="space-y-3 rounded-xl border bg-card p-5">
      {items.map((e, i) => {
        if (e.type === "caller_said")
          return (
            <div key={i} className="flex justify-end gap-3">
              <div className="max-w-[70%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[13px] text-primary-foreground">{String(e.text)}</div>
              <Stamp t={e.t} />
            </div>
          );
        if (e.type === "bot_said" || e.type === "assistant_turn") {
          const source = e.type === "assistant_turn" ? "llm" : String(e.source);
          return (
            <div key={i} className="flex gap-3">
              <Stamp t={e.t} />
              <div className="max-w-[70%]">
                <div className={`rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-[13px] leading-relaxed ${source === "lookup_filler" ? "italic text-muted-foreground" : ""}`}>
                  {String(e.text)}
                </div>
                <div className="mt-1 pl-1 text-[10.5px] text-muted-foreground">
                  {SOURCE[source] ?? source}
                  {e.interrupted ? " · interrupted" : ""}
                </div>
              </div>
            </div>
          );
        }
        const chip = (icon: React.ReactNode, body: React.ReactNode, tone = "") => (
          <div key={i} className="flex gap-3">
            <Stamp t={e.t} />
            <div className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] text-muted-foreground ${tone}`}>
              {icon}
              {body}
            </div>
          </div>
        );
        if (e.type === "call_connected")
          return chip(<PhoneIncoming className="size-3.5" />, <>Call connected · office {e.office_open ? "open" : "closed"} · route: {String(e.route).replaceAll("_", " ")}</>);
        if (e.type === "tool_call")
          return chip(<Wrench className="size-3.5" />, <>{String(e.name)}{(e.arguments as { question?: string })?.question ? ` (“${(e.arguments as { question: string }).question}”)` : ""}</>);
        if (e.type === "kb_lookup")
          return chip(
            <BookOpen className="size-3.5" />,
            <>
              <Pill tone={e.found ? "green" : e.result === "no_answer" ? "amber" : "red"} className="py-0">{e.found ? "found" : String(e.result).replace("_", " ")}</Pill>
              <span className="tabular-nums">{String(e.latency_ms)} ms</span>
              {e.http_status != null && <span>HTTP {String(e.http_status)}</span>}
            </>,
          );
        if (e.type === "transfer")
          return chip(
            <ArrowRightLeft className="size-3.5" />,
            <>Transfer to {formatPhone(e.number as string)} · {e.success ? "connected" : `failed${e.error ? `: ${e.error}` : ""}`}</>,
            e.success ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-800",
          );
        if (e.type === "error") return chip(<AlertTriangle className="size-3.5" />, String(e.message), "border-red-200 bg-red-50 text-red-800");
        return null;
      })}
    </div>
  );
}

function KbView({ rec }: { rec: CallRecord }) {
  if (!rec.kb_lookups.length) return <p className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">No knowledge-base lookups on this call.</p>;
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="pl-4">#</TableHead>
            <TableHead>Question</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Latency</TableHead>
            <TableHead className="pr-4">Answer</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rec.kb_lookups.map((l) => (
            <TableRow key={l.n} className="align-top">
              <TableCell className="pl-4 text-xs text-muted-foreground">{l.n}</TableCell>
              <TableCell className="max-w-56 whitespace-normal text-[13px]">{l.question}</TableCell>
              <TableCell>
                <Pill tone={l.found ? "green" : l.result === "no_answer" ? "amber" : "red"}>{l.result.replace("_", " ")}</Pill>
                {l.http_status != null && <div className="mt-1 text-[11px] text-muted-foreground">HTTP {l.http_status}</div>}
                {l.error && <div className="mt-1 text-[11px] text-destructive">{l.error}</div>}
              </TableCell>
              <TableCell className="text-[13px] tabular-nums">{l.latency_ms ?? "—"} ms</TableCell>
              <TableCell className="max-w-md whitespace-normal pr-4 text-[13px] leading-relaxed">
                {l.answer ?? <span className="text-muted-foreground">{l.spoken_to_caller ?? "Fallback"}</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ConfigView({ rec }: { rec: CallRecord }) {
  const cfg = rec.config as Record<string, unknown>;
  const prompt = (cfg.prompt as { text?: string } | undefined)?.text;
  const rest = { ...cfg, prompt: { ...(cfg.prompt as object), text: prompt ? `(${prompt.length} chars, shown below)` : undefined } };
  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-card">
        <div className="border-b px-5 py-3 text-sm font-semibold">Settings used on this call</div>
        <pre className="max-h-[420px] overflow-auto p-5 font-mono text-[11.5px] leading-relaxed">{JSON.stringify(rest, null, 2)}</pre>
      </div>
      {prompt && (
        <div className="rounded-xl border bg-card">
          <div className="border-b px-5 py-3 text-sm font-semibold">System prompt used</div>
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap p-5 font-mono text-[11.5px] leading-relaxed">{prompt}</pre>
        </div>
      )}
    </div>
  );
}

function EventsView({ rec }: { rec: CallRecord }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="pl-4">Time</TableHead>
            <TableHead>Event</TableHead>
            <TableHead className="pr-4">Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rec.timeline.map((e, i) => {
            const { t, at, type, ...rest } = e;
            void at;
            return (
              <TableRow key={i} className="align-top">
                <TableCell className="pl-4 font-mono text-[11px] tabular-nums text-muted-foreground">{t.toFixed(2)}s</TableCell>
                <TableCell className="font-mono text-[11.5px]">{type}</TableCell>
                <TableCell className="max-w-2xl whitespace-pre-wrap break-words pr-4 font-mono text-[11px] text-muted-foreground">
                  {JSON.stringify(rest)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function ConversationPage() {
  const { sid } = useParams<{ sid: string }>();
  const { data: rec, isLoading, isError, error } = useQuery({
    queryKey: ["call", sid],
    queryFn: () => api.get<CallRecord>(`/calls/${sid}`),
    refetchInterval: (q) => (q.state.data && !q.state.data.call.ended_at ? 3000 : false),
  });

  if (isError) return <div className="p-8 text-sm text-destructive">{errorMessage(error)}</div>;
  if (isLoading || !rec) return <Page><Skeleton className="h-96 rounded-xl" /></Page>;
  const c = rec.call;
  const s = rec.summary;

  return (
    <Page>
      <Link href="/conversations" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Conversations
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight tabular-nums">{formatPhone(c.from)}</h1>
            <EndReason reason={c.end_reason} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
            <span>{formatWhen(c.started_at)}</span>
            <span>·</span>
            <span>{formatDuration(c.duration_s)}</span>
            <span>·</span>
            <span>to {formatPhone(c.to)}</span>
            {rec.agent?.id && (
              <>
                <span>·</span>
                <Link href={`/agents/${rec.agent.id}`} className="inline-flex items-center gap-1 hover:text-foreground">
                  <Bot className="size-3.5" /> {rec.agent.name}
                </Link>
              </>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Mono>{c.call_sid}</Mono>
            <CopyButton value={c.call_sid} />
          </div>
        </div>
        <div className="grid grid-cols-4 gap-px overflow-hidden rounded-xl border bg-border">
          {[
            ["Caller turns", s.caller_turns ?? 0],
            ["KB lookups", s.kb_lookups ?? 0],
            ["KB answered", `${s.kb_hits ?? 0}/${s.kb_lookups ?? 0}`],
            ["Avg KB latency", s.kb_avg_latency_ms ? `${s.kb_avg_latency_ms} ms` : "—"],
          ].map(([label, value]) => (
            <div key={label as string} className="bg-card px-4 py-2.5">
              <div className="text-[11px] text-muted-foreground">{label}</div>
              <div className="text-base font-semibold tabular-nums">{value}</div>
            </div>
          ))}
        </div>
      </div>

      <Tabs defaultValue="transcript">
        <TabsList variant="line" className="mb-4 h-9 gap-1 border-b">
          <TabsTrigger value="transcript" className="px-2.5 text-[13px] data-active:text-primary after:bg-primary">Transcript</TabsTrigger>
          <TabsTrigger value="kb" className="px-2.5 text-[13px] data-active:text-primary after:bg-primary">Knowledge base ({rec.kb_lookups.length})</TabsTrigger>
          <TabsTrigger value="config" className="px-2.5 text-[13px] data-active:text-primary after:bg-primary">Configuration</TabsTrigger>
          <TabsTrigger value="events" className="px-2.5 text-[13px] data-active:text-primary after:bg-primary">Events ({rec.timeline.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="transcript"><TranscriptView rec={rec} /></TabsContent>
        <TabsContent value="kb"><KbView rec={rec} /></TabsContent>
        <TabsContent value="config"><ConfigView rec={rec} /></TabsContent>
        <TabsContent value="events"><EventsView rec={rec} /></TabsContent>
      </Tabs>
      <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
        <FileText className="size-3.5" /> Full debug log: <Mono>{c.debug_log}</Mono>
      </p>
    </Page>
  );
}
