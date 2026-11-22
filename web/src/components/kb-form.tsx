"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/common";
import type { KnowledgeBase } from "@/lib/types";

export type KBDraft = Pick<KnowledgeBase, "name" | "description" | "type" | "url" | "api_key" | "timeout_s" | "fallback_message">;

export const EMPTY_KB: KBDraft = {
  name: "",
  type: "documents",
  description: "",
  url: "",
  api_key: "",
  timeout_s: 8,
  fallback_message: "I'm sorry, I don't have an answer for that. You can ask me something else.",
};

export function KBForm({
  value,
  onChange,
  errors = {},
  keyHint,
}: {
  value: KBDraft;
  onChange: (v: KBDraft) => void;
  errors?: Record<string, string>;
  keyHint?: string;
}) {
  const set = (p: Partial<KBDraft>) => onChange({ ...value, ...p });
  return (
    <div className="space-y-4">
      <Field label="Name" error={errors.name} hint={value.type === "documents" ? "Your organization or office. Answers are given on its behalf." : undefined}>
        <Input value={value.name} placeholder="e.g. Admissions office" onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Description">
        <Input value={value.description} placeholder="What it covers" onChange={(e) => set({ description: e.target.value })} />
      </Field>
      {value.type === "rag_service" && (
      <>
      <Field
        label="Service URL"
        error={errors.url}
        hint={<>Calls <code className="font-mono">POST {value.url || "<url>"}/answer</code></>}
      >
        <Input className="font-mono text-[13px]" value={value.url} placeholder="https://kb.example.edu/cla-kb" onChange={(e) => set({ url: e.target.value })} />
      </Field>
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <Field label="API key" hint={keyHint ?? "Bearer token. Optional."}>
            <Input type="password" autoComplete="off" value={value.api_key} placeholder={keyHint ? "Leave blank to keep the current key" : ""} onChange={(e) => set({ api_key: e.target.value })} />
          </Field>
        </div>
        <Field label="Timeout (seconds)" error={errors.timeout_s}>
          <Input type="number" min={1} max={30} value={value.timeout_s} onChange={(e) => set({ timeout_s: Number(e.target.value) })} />
        </Field>
      </div>
      </>
      )}
      <Field label="Fallback message" hint="Spoken when there's no answer or the lookup fails.">
        <Textarea rows={3} value={value.fallback_message} onChange={(e) => set({ fallback_message: e.target.value })} />
      </Field>
    </div>
  );
}
