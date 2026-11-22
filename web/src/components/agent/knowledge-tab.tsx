"use client";

import Link from "next/link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { BookOpen, ExternalLink, Loader2, MessageSquare, Quote, Search, Send, Wand2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Field, Pill, Section, ToggleRow } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Agent, KBLookup, KnowledgeBase } from "@/lib/types";
import type { Patch } from "./use-agent-draft";

export function LookupResult({ r }: { r: KBLookup }) {
  const tone = r.found ? "green" : r.result === "no_answer" ? "amber" : "red";
  const label = { answer: "Answered", no_answer: "No answer", rate_limited: "Rate limited", unauthorized: "Key rejected", timeout: "Timed out" }[r.result] ?? r.result;
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Pill tone={tone}>{label}</Pill>
        {r.latency_ms != null && <span className="tabular-nums text-muted-foreground">{r.latency_ms} ms</span>}
        {r.http_status != null && <span className="text-muted-foreground">HTTP {r.http_status}</span>}
        {r.error && <span className="text-destructive">{r.error}</span>}
      </div>
      <p className="text-[13px] leading-relaxed">{r.found ? r.answer : <span className="text-muted-foreground">{r.spoken ?? "Fallback message spoken"}</span>}</p>
    </div>
  );
}

function ModeCard({
  selected,
  onClick,
  icon: Icon,
  title,
  description,
  badge,
}: {
  selected: boolean;
  onClick: () => void;
  icon: typeof Quote;
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-xl border p-4 text-left transition-all",
        selected ? "border-primary bg-primary/[0.04] ring-1 ring-primary" : "hover:border-foreground/30",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4" />
        <span className="text-[13px] font-semibold">{title}</span>
        {badge && <Pill tone="green">{badge}</Pill>}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
    </button>
  );
}

export function KnowledgeTab({ draft, patch }: { draft: Agent; patch: Patch }) {
  const kbs = useQuery({ queryKey: ["knowledge-bases"], queryFn: () => api.get<KnowledgeBase[]>("/knowledge-bases") });
  const k = draft.knowledge;
  const kb = kbs.data?.find((x) => x.id === k.knowledge_base_id);
  const [question, setQuestion] = useState("");
  const test = useMutation({
    mutationFn: () => api.post<KBLookup>(`/knowledge-bases/${k.knowledge_base_id}/query`, { question }),
  });

  return (
    <div className="space-y-5">
      <Section
        title="Knowledge base"
        description="Where answers come from"
        icon={BookOpen}
        tone="sky"
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link href="/knowledge-bases">
              Manage <ExternalLink />
            </Link>
          </Button>
        }
      >
        <Select
          value={k.knowledge_base_id ?? "none"}
          onValueChange={(v) => patch("knowledge", { knowledge_base_id: v === "none" ? null : v })}
        >
          <SelectTrigger className="w-96">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No knowledge base</SelectItem>
            {(kbs.data ?? []).map((x) => (
              <SelectItem key={x.id} value={x.id}>
                <BookOpen className="size-3.5" /> {x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {kb && <p className="font-mono text-xs text-muted-foreground">{kb.url}/answer</p>}
        {!k.knowledge_base_id && (
          <p className="text-[13px] text-muted-foreground">Without one, the agent only uses its system prompt.</p>
        )}
      </Section>

      {k.knowledge_base_id && (
        <>
          <Section title="Answer mode" icon={Quote} tone="emerald">
            <div className="flex gap-3">
              <ModeCard
                selected={k.answer_mode === "verbatim"}
                onClick={() => patch("knowledge", { answer_mode: "verbatim" })}
                icon={Quote}
                title="Word for word"
                badge="No hallucination"
                description="Answers are spoken exactly as returned. The LLM can't change them."
              />
              <ModeCard
                selected={k.answer_mode === "rephrase"}
                onClick={() => patch("knowledge", { answer_mode: "rephrase" })}
                icon={Wand2}
                title="Natural rephrase"
                description="The LLM rewords answers. More natural, small risk of drift."
              />
            </div>
            <ToggleRow
              title="Send every question to the knowledge base"
              description="Off-topic questions too, so the agent never answers from its own knowledge."
              control={<Switch checked={k.route_all_questions} onCheckedChange={(v) => patch("knowledge", { route_all_questions: v })} />}
            />
          </Section>

          <Section title="Spoken lines" icon={MessageSquare} tone="indigo">
            <Field label="While looking up" hint="Leave empty for none.">
              <Input value={k.lookup_filler} onChange={(e) => patch("knowledge", { lookup_filler: e.target.value })} />
            </Field>
            <Field label="After an answer" hint="Leave empty for none.">
              <Input value={k.follow_up} onChange={(e) => patch("knowledge", { follow_up: e.target.value })} />
            </Field>
            <ToggleRow
              title="Typing sound while looking up"
              description="A faint keyboard sound plays while the agent searches, so the pause feels natural."
              control={<Switch checked={k.typing_sound} onCheckedChange={(v) => patch("knowledge", { typing_sound: v })} />}
            />
            {kb && (
              <Field label="When there's no answer" hint="Set on the knowledge base.">
                <p className="rounded-lg border bg-muted/30 px-3 py-2 text-[13px]">{kb.fallback_message}</p>
              </Field>
            )}
          </Section>

          <Section title="Try a question" description="Runs a real lookup" icon={Search} tone="sky">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (question.trim()) test.mutate();
              }}
            >
              <Input placeholder="e.g. Is there a free course?" value={question} onChange={(e) => setQuestion(e.target.value)} />
              <Button type="submit" variant="outline" disabled={!question.trim() || test.isPending}>
                {test.isPending ? <Loader2 className="animate-spin" /> : <Send />} Ask
              </Button>
            </form>
            {test.isError && <p className="text-xs text-destructive">{errorMessage(test.error)}</p>}
            {test.data && <LookupResult r={test.data} />}
          </Section>
        </>
      )}
    </div>
  );
}
