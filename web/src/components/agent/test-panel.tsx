"use client";

import { ArrowRightLeft, ArrowUp, BookOpen, Loader2, PhoneOff, RotateCcw, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Pill } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { formatPhone } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Agent, TestEvent } from "@/lib/types";

const SOURCE_LABEL: Record<string, string> = {
  greeting: "First message",
  kb_answer: "Knowledge base · word for word",
  kb_fallback: "Fallback",
  lookup_filler: "Filler",
  transfer_message: "Transfer",
  goodbye: "Goodbye",
  safety_emergency: "Safety · emergency",
  safety_crisis: "Safety · crisis support",
  llm: "LLM",
};

function EventView({ e }: { e: TestEvent }) {
  if (e.type === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[13px] text-primary-foreground">{e.text}</div>
      </div>
    );
  if (e.type === "bot")
    return (
      <div className="max-w-[85%]">
        <div className={cn("rounded-2xl rounded-bl-md bg-muted px-3.5 py-2 text-[13px] leading-relaxed", e.source === "lookup_filler" && "italic text-muted-foreground")}>
          {e.text}
        </div>
        <div className="mt-1 pl-1 text-[10.5px] text-muted-foreground">
          {SOURCE_LABEL[e.source] ?? e.source}
          {e.latency_ms ? ` · ${e.latency_ms} ms` : ""}
        </div>
      </div>
    );
  if (e.type === "tool_call")
    return (
      <div className="flex items-center gap-1.5 pl-1 text-[11px] text-muted-foreground">
        <Wrench className="size-3" /> {e.name}
        {"question" in e.arguments ? <span className="truncate">(“{String(e.arguments.question)}”)</span> : null}
      </div>
    );
  if (e.type === "kb_lookup")
    return (
      <div className="flex items-center gap-1.5 pl-1 text-[11px] text-muted-foreground">
        <BookOpen className="size-3" />
        <Pill tone={e.found ? "green" : e.result === "no_answer" ? "amber" : "red"} className="py-0 text-[10.5px]">
          {e.found ? "found" : e.result.replace("_", " ")}
        </Pill>
        {e.latency_ms != null && <span className="tabular-nums">{e.latency_ms} ms</span>}
      </div>
    );
  if (e.type === "transfer")
    return (
      <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
        <ArrowRightLeft className="size-3.5" />
        Would transfer to {formatPhone(e.number)} ({e.office_open ? "office open" : "office closed"}). Simulated: nothing is dialed.
      </div>
    );
  if (e.type === "end_call")
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
        <PhoneOff className="size-3.5" />
        The agent hangs up here. Start a new test to keep going.
      </div>
    );
  return null;
}

export function TestPanel({ agent, open, onOpenChange, dirty }: { agent: Agent; open: boolean; onOpenChange: (v: boolean) => void; dirty: boolean }) {
  const [session, setSession] = useState<string | null>(null);
  const [events, setEvents] = useState<TestEvent[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  async function start() {
    try {
      const r = await api.post<{ session_id: string; events: TestEvent[] }>(`/agents/${agent.id}/test/start`);
      setError("");
      setSession(r.session_id);
      setEvents(r.events);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  useEffect(() => {
    // start() only sets state after its request resolves, so this doesn't cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [events, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !session || busy) return;
    const msg = text.trim();
    setText("");
    setEvents((ev) => [...ev, { type: "user", text: msg }]);
    setBusy(true);
    setError("");
    try {
      const r = await api.post<{ events: TestEvent[] }>(`/agents/${agent.id}/test/message`, { session_id: session, text: msg });
      setEvents((ev) => [...ev, ...r.events]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setTimeout(() => input.current?.focus(), 0);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex w-[440px] flex-col gap-0 p-0 sm:max-w-[440px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          input.current?.focus();
        }}
      >
        <SheetHeader className="border-b px-5 py-4">
          <div className="flex items-center justify-between pr-8">
            <SheetTitle className="text-base">Test {agent.name}</SheetTitle>
            <Button variant="ghost" size="icon-sm" onClick={start} title="Restart">
              <RotateCcw />
            </Button>
          </div>
          <SheetDescription className="text-xs">Type as the caller. Real knowledge base; transfers simulated.</SheetDescription>
          {dirty && (
            <div className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
              You have unsaved changes. The test uses the saved version.
            </div>
          )}
        </SheetHeader>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {events.map((e, i) => (
            <EventView key={i} e={e} />
          ))}
          {busy && (
            <div className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Thinking…
            </div>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div ref={bottom} />
        </div>
        <form onSubmit={send} className="flex gap-2 border-t p-3">
          <Input ref={input} placeholder="Say something…" value={text} onChange={(e) => setText(e.target.value)} />
          <Button type="submit" size="icon" disabled={!text.trim() || busy || !session}>
            <ArrowUp />
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
