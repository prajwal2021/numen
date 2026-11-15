"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, FileText, MessageSquare, Sparkles } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field, Section } from "@/components/common";
import { api } from "@/lib/api";
import type { Agent, Meta } from "@/lib/types";
import type { Patch } from "./use-agent-draft";

export function useMeta() {
  return useQuery({ queryKey: ["meta"], queryFn: () => api.get<Meta>("/meta"), staleTime: 300_000 });
}

function FullPrompt({ agent }: { agent: Agent }) {
  const [open, setOpen] = useState(false);
  const preview = useMutation({ mutationFn: () => api.post<{ prompt: string }>(`/agents/${agent.id}/prompt-preview`, agent) });
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          preview.mutate();
        }}
      >
        <FileText /> View full prompt
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Full system prompt</DialogTitle>
            <DialogDescription>Exactly what the model receives on a call, including unsaved changes.</DialogDescription>
          </DialogHeader>
          <ScrollArea className="h-[60vh] rounded-lg border bg-muted/30">
            <pre className="whitespace-pre-wrap p-4 font-mono text-[12px] leading-relaxed">
              {preview.isPending ? "Building…" : preview.isError ? String(preview.error) : preview.data?.prompt}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AgentTab({ draft, patch, errors }: { draft: Agent; patch: Patch; errors: Record<string, string> }) {
  const { data: meta } = useMeta();
  return (
    <div className="space-y-5">
      <Section title="Details" description="For your team; callers never hear these." icon={Bot} tone="violet">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" error={errors["name"]}>
            <Input value={draft.name} onChange={(e) => patch("name", e.target.value)} />
          </Field>
          <Field label="Description">
            <Input value={draft.description} placeholder="What this agent handles" onChange={(e) => patch("description", e.target.value)} />
          </Field>
        </div>
      </Section>

      <Section title="First message" description="Spoken word for word when the call is answered." icon={MessageSquare} tone="indigo">
        <Textarea
          rows={3}
          value={draft.greeting}
          onChange={(e) => patch("greeting", e.target.value)}
          className="resize-y text-[13px] leading-relaxed"
        />
        <div className="text-right text-xs text-muted-foreground tabular-nums">
          ~{Math.max(1, Math.round(draft.greeting.split(/\s+/).length / 2.6))}s spoken
        </div>
      </Section>

      <Section
        title="System prompt"
        description="Personality and guardrails. Hours, knowledge and transfer rules are added for you."
        icon={FileText}
        tone="violet"
        actions={<FullPrompt agent={draft} />}
      >
        <Textarea
          rows={18}
          value={draft.prompt}
          onChange={(e) => patch("prompt", e.target.value)}
          className="resize-y font-mono text-[12.5px] leading-relaxed"
        />
      </Section>

      <Section title="Language model" description="Decides each turn: look up, transfer, or reply." icon={Sparkles} tone="emerald">
        <Field label="Model">
          <Select value={draft.llm.model} onValueChange={(v) => patch("llm", { model: v })}>
            <SelectTrigger className="w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(meta?.llm_models ?? [{ id: draft.llm.model, name: draft.llm.model, description: "" }]).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <span className="flex items-center gap-2">
                    <Sparkles className="size-3.5 text-muted-foreground" />
                    {m.name}
                    <span className="text-xs text-muted-foreground">{m.description}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </Section>
    </div>
  );
}
