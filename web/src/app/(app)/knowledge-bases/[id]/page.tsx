"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, BookOpen, Bot, FileText, Link2, Loader2, Search, Send, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LookupResult } from "@/components/agent/knowledge-tab";
import { Page, PageHeader, Pill, Section } from "@/components/common";
import { KBDocuments } from "@/components/kb-documents";
import { KBForm, type KBDraft } from "@/components/kb-form";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useIsAdmin } from "@/lib/auth";
import type { KBLookup, KnowledgeBase } from "@/lib/types";

const SAMPLES = ["What are your hours?", "How much does it cost?", "What's two plus two?"];

export default function KnowledgeBasePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const { data: kb, isError, error } = useQuery({ queryKey: ["knowledge-base", id], queryFn: () => api.get<KnowledgeBase>(`/knowledge-bases/${id}`) });
  const [edits, setEdits] = useState<KBDraft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<KBLookup[]>([]);

  const toDraft = (k: KnowledgeBase): KBDraft => ({
    name: k.name, description: k.description, type: k.type, url: k.url, api_key: "", timeout_s: k.timeout_s, fallback_message: k.fallback_message,
  });
  const draft: KBDraft | null = edits ?? (kb ? toDraft(kb) : null);

  const save = useMutation({
    mutationFn: () => api.put<KnowledgeBase>(`/knowledge-bases/${id}`, draft),
    onSuccess: (k) => {
      qc.setQueryData(["knowledge-base", id], k);
      qc.invalidateQueries({ queryKey: ["knowledge-bases"] });
      setEdits(null);
      setErrors({});
      toast.success("Knowledge base saved");
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields.length) setErrors(Object.fromEntries(e.fields.map((f) => [f.field, f.message])));
      else toast.error(errorMessage(e));
    },
  });
  const health = useMutation({
    mutationFn: () => api.post<{ ok: boolean; http_status?: number; latency_ms: number; error?: string }>(`/knowledge-bases/${id}/health`),
  });
  const query = useMutation({
    mutationFn: (q: string) => api.post<KBLookup>(`/knowledge-bases/${id}/query`, { question: q }),
    onSuccess: (r) => setHistory((h) => [r, ...h].slice(0, 10)),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/knowledge-bases/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success("Knowledge base deleted");
      router.push("/knowledge-bases");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (isError) return <div className="p-8 text-sm text-destructive">{errorMessage(error)}</div>;
  if (!kb || !draft) return <Page><Skeleton className="h-96 rounded-xl" /></Page>;
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(kb));
  const docs = kb.type === "documents";
  const ask = (q: string) => q.trim() && query.mutate(q.trim());

  return (
    <Page>
      <Link href="/knowledge-bases" className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Knowledge Base
      </Link>
      <PageHeader
        icon={BookOpen}
        tone="sky"
        title={kb.name}
        description={kb.description || (docs ? "Documents" : "RAG service")}
        actions={
          <>
            {!docs && (
            <Button variant="outline" onClick={() => health.mutate()} disabled={health.isPending}>
              {health.isPending ? <Loader2 className="animate-spin" /> : <Activity />} Test connection
            </Button>
            )}
            <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />} Save
            </Button>
          </>
        }
      />
      {health.data && (
        <div className="-mt-2 mb-5">
          <Pill tone={health.data.ok ? "green" : "red"}>
            {health.data.ok ? "Connected" : "Unreachable"} · {health.data.latency_ms} ms
            {health.data.http_status ? ` · HTTP ${health.data.http_status}` : ""}
            {health.data.error ? ` · ${health.data.error}` : ""}
          </Pill>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-5">
        <div className="space-y-5 lg:col-span-3">
          {docs && (
            <Section title="Documents" description="The agent answers only from these." icon={FileText} tone="sky">
              <KBDocuments kbId={id} />
            </Section>
          )}
          <Section title={docs ? "Settings" : "Connection"} icon={Link2} tone="sky">
            <KBForm
              value={draft}
              onChange={setEdits}
              errors={errors}
              keyHint={kb.api_key_status?.set ? `Current key ${kb.api_key_status.hint}. Leave blank to keep it.` : undefined}
            />
          </Section>
          {isAdmin && (
          <Section title="Delete" icon={Trash2} tone="rose">
            <div className="flex items-center justify-between gap-4">
              <p className="text-[13px] text-muted-foreground">
                {kb.used_by?.length
                  ? `Detach it from ${kb.used_by.map((a) => a.name).join(", ")} first.`
                  : "Not used by any agent."}
              </p>
              <Button variant="destructive" disabled={!!kb.used_by?.length || del.isPending} onClick={() => del.mutate()}>
                <Trash2 /> Delete
              </Button>
            </div>
          </Section>
          )}
        </div>
        <div className="space-y-5 lg:col-span-2">
          <Section title="Used by" icon={Users} tone="violet">
            {kb.used_by?.length ? (
              <ul className="space-y-1">
                {kb.used_by.map((a) => (
                  <li key={a.id}>
                    <Link href={`/agents/${a.id}?tab=knowledge`} className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-[13px] hover:bg-muted">
                      <Bot className="size-3.5 text-muted-foreground" /> {a.name}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">No agents yet.</p>
            )}
          </Section>
          <Section title="Test queries" description="Real lookups, saved settings." icon={Search} tone="indigo">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                ask(question);
              }}
            >
              <Input placeholder="Ask a question" value={question} onChange={(e) => setQuestion(e.target.value)} />
              <Button type="submit" variant="outline" size="icon" disabled={!question.trim() || query.isPending}>
                {query.isPending ? <Loader2 className="animate-spin" /> : <Send />}
              </Button>
            </form>
            <div className="flex flex-wrap gap-1.5">
              {SAMPLES.map((s) => (
                <button key={s} onClick={() => ask(s)} className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                  {s}
                </button>
              ))}
            </div>
            <div className="space-y-3">
              {history.map((r, i) => (
                <div key={i} className="space-y-1.5">
                  <div className="text-xs font-medium">“{r.question}”</div>
                  <LookupResult r={r} />
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </Page>
  );
}
