"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, KeyRound, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, IconChip, Page, PageHeader, Pill } from "@/components/common";
import { EMPTY_KB, KBForm, type KBDraft } from "@/components/kb-form";
import { api, ApiError, errorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { KnowledgeBase } from "@/lib/types";

export default function KnowledgeBasesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<KBDraft>(EMPTY_KB);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { data, isLoading } = useQuery({ queryKey: ["knowledge-bases"], queryFn: () => api.get<KnowledgeBase[]>("/knowledge-bases") });

  const create = useMutation({
    mutationFn: () => api.post<KnowledgeBase>("/knowledge-bases", draft),
    onSuccess: (kb) => {
      qc.invalidateQueries({ queryKey: ["knowledge-bases"] });
      toast.success(`Added ${kb.name}`);
      setOpen(false);
      setDraft(EMPTY_KB);
      router.push(`/knowledge-bases/${kb.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields.length) setErrors(Object.fromEntries(e.fields.map((f) => [f.field, f.message])));
      else toast.error(errorMessage(e));
    },
  });

  return (
    <Page>
      <PageHeader
        icon={BookOpen}
        tone="sky"
        title="Knowledge Base"
        description="RAG services your agents answer from."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus /> Add knowledge base
          </Button>
        }
      />
      {isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : !data?.length ? (
        <EmptyState
          icon={BookOpen}
          tone="sky"
          title="No knowledge bases"
          description="Connect a RAG service so agents can answer from your documents."
          action={
            <Button onClick={() => setOpen(true)}>
              <Plus /> Add knowledge base
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.map((kb) => (
            <Link key={kb.id} href={`/knowledge-bases/${kb.id}`} className="group rounded-xl border bg-card p-5 transition-shadow hover:shadow-md">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <IconChip icon={BookOpen} tone="sky" />
                  <div>
                    <div className="text-sm font-semibold">{kb.name}</div>
                    <div className="text-xs text-muted-foreground">{kb.description || "RAG service"}</div>
                  </div>
                </div>
                {kb.api_key_status?.set && (
                  <Pill tone="gray">
                    <KeyRound className="size-3" /> Key {kb.api_key_status.hint}
                  </Pill>
                )}
              </div>
              <div className="mt-4 truncate rounded-md bg-muted/50 px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground">{kb.url}</div>
              <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {kb.used_by?.length ? `Used by ${kb.used_by.map((a) => a.name).join(", ")}` : "Not in use"}
                </span>
                <span>Edited {timeAgo(kb.updated_at)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add a knowledge base</DialogTitle>
            <DialogDescription>Connect a RAG service. You can test it right after.</DialogDescription>
          </DialogHeader>
          <KBForm value={draft} onChange={setDraft} errors={errors} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => create.mutate()} disabled={!draft.name.trim() || !draft.url.trim() || create.isPending}>
              {create.isPending ? "Adding…" : "Add knowledge base"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
