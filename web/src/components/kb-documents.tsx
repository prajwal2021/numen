"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ClipboardPaste, Eye, FileText, Loader2, RotateCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, Pill } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { KBDocument } from "@/lib/types";
import { cn } from "@/lib/utils";

const ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.csv,.html,.htm";
const KIND: Record<KBDocument["kind"], string> = { pdf: "PDF", docx: "Word", txt: "Text", md: "Markdown", html: "Web page", text: "Pasted text" };

function size(n: number | null) {
  if (!n) return "";
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function KBDocuments({ kbId }: { kbId: string }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [paste, setPaste] = useState(false);
  const [pasteName, setPasteName] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);

  const key = ["kb-documents", kbId];
  const { data: docs, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get<KBDocument[]>(`/knowledge-bases/${kbId}/documents`),
    // Poll while anything is still being indexed.
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === "processing") ? 2000 : false),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["knowledge-base", kbId] });
    qc.invalidateQueries({ queryKey: ["knowledge-bases"] });
  };

  const upload = useMutation({
    mutationFn: (files: File[]) => {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      return api.upload<{ added: KBDocument[]; failed: { name: string; error: string }[] }>(`/knowledge-bases/${kbId}/documents`, form);
    },
    onSuccess: (r) => {
      refresh();
      if (r.added.length) toast.success(`Added ${r.added.length} file${r.added.length > 1 ? "s" : ""}. Indexing…`);
      r.failed.forEach((f) => toast.error(`${f.name}: ${f.error}`));
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const addText = useMutation({
    mutationFn: () => api.post<KBDocument>(`/knowledge-bases/${kbId}/documents/text`, { name: pasteName, text: pasteText }),
    onSuccess: () => {
      refresh();
      toast.success("Text added. Indexing…");
      setPaste(false);
      setPasteName("");
      setPasteText("");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/knowledge-bases/${kbId}/documents/${id}`),
    onSuccess: () => {
      refresh();
      toast.success("Document removed");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/knowledge-bases/${kbId}/documents/${id}/retry`),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const view = useQuery({
    queryKey: ["kb-document", kbId, viewing],
    queryFn: () => api.get<KBDocument>(`/knowledge-bases/${kbId}/documents/${viewing}`),
    enabled: !!viewing,
  });

  const pick = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length) upload.mutate(files);
    if (input.current) input.current.value = "";
  };

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          pick(e.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors",
          drag ? "border-foreground/40 bg-muted" : "bg-muted/30",
        )}
      >
        {upload.isPending ? <Loader2 className="size-5 animate-spin text-muted-foreground" /> : <Upload className="size-5 text-muted-foreground" />}
        <div className="text-[13px]">
          Drop files here, or{" "}
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => input.current?.click()}>
            choose files
          </button>
        </div>
        <div className="text-xs text-muted-foreground">PDF, Word (.docx), text, Markdown or HTML · up to 10 MB each</div>
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => pick(e.target.files)} />
      </div>
      <Button variant="outline" size="sm" onClick={() => setPaste(true)}>
        <ClipboardPaste /> Paste text
      </Button>

      {isLoading ? null : !docs?.length ? (
        <p className="text-[13px] text-muted-foreground">No documents yet. Agents using this knowledge base will say the fallback message until you add some.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{d.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {[KIND[d.kind], size(d.size_bytes), `${d.chars.toLocaleString()} characters`, d.status === "ready" ? `${d.chunks} passage${d.chunks === 1 ? "" : "s"}` : null, `added ${timeAgo(d.created_at)}`]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {d.status === "failed" && d.error && <div className="mt-0.5 text-xs text-destructive">{d.error}</div>}
              </div>
              {d.status === "processing" && (
                <Pill tone="blue">
                  <Loader2 className="size-3 animate-spin" /> Indexing
                </Pill>
              )}
              {d.status === "ready" && (
                <Pill tone="green">
                  <CheckCircle2 className="size-3" /> Ready
                </Pill>
              )}
              {d.status === "failed" && (
                <>
                  <Pill tone="red">
                    <AlertCircle className="size-3" /> Failed
                  </Pill>
                  <Button variant="ghost" size="icon" title="Try again" onClick={() => retry.mutate(d.id)}>
                    <RotateCw />
                  </Button>
                </>
              )}
              <Button variant="ghost" size="icon" title="View text" onClick={() => setViewing(d.id)}>
                <Eye />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Remove"
                disabled={remove.isPending}
                onClick={() => confirm(`Remove "${d.name}" from this knowledge base?`) && remove.mutate(d.id)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={paste} onOpenChange={setPaste}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Paste text</DialogTitle>
            <DialogDescription>FAQs, policies, a web page&apos;s text: anything the agent should answer from.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Title">
              <Input value={pasteName} placeholder="e.g. Fees and refunds" onChange={(e) => setPasteName(e.target.value)} />
            </Field>
            <Field label="Text" hint="Separate topics with blank lines.">
              <Textarea rows={12} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPaste(false)}>
              Cancel
            </Button>
            <Button onClick={() => addText.mutate()} disabled={!pasteName.trim() || !pasteText.trim() || addText.isPending}>
              {addText.isPending && <Loader2 className="animate-spin" />} Add text
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{view.data?.name ?? "Document"}</DialogTitle>
            <DialogDescription>The text the agent searches, as read from the file.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-[13px] leading-relaxed">
            {view.isLoading ? <Loader2 className="size-4 animate-spin" /> : view.data?.text}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
