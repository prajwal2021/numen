"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, FlaskConical, Loader2, MoreHorizontal, Phone, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentAvatar } from "@/components/agent-avatar";
import { AdvancedTab } from "@/components/agent/advanced-tab";
import { AgentTab } from "@/components/agent/agent-tab";
import { KnowledgeTab } from "@/components/agent/knowledge-tab";
import { RoutingTab } from "@/components/agent/routing-tab";
import { TestPanel } from "@/components/agent/test-panel";
import { useAgentDraft } from "@/components/agent/use-agent-draft";
import { VoiceTab } from "@/components/agent/voice-tab";
import { WorkflowTab } from "@/components/agent/workflow-tab";
import { CallsTable } from "@/components/calls-table";
import { CopyButton, EmptyState, Pill } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useIsAdmin } from "@/lib/auth";
import { formatPhone } from "@/lib/format";
import type { Agent, CallRow } from "@/lib/types";
import { MessagesSquare } from "lucide-react";

const TABS = [
  ["agent", "Agent"],
  ["workflow", "Workflow"],
  ["voice", "Voice"],
  ["knowledge", "Knowledge"],
  ["routing", "Call routing"],
  ["advanced", "Advanced"],
  ["conversations", "Conversations"],
] as const;

function AgentCalls({ agentId }: { agentId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["calls", agentId], queryFn: () => api.get<CallRow[]>(`/calls?agent_id=${agentId}`) });
  if (isLoading) return <Skeleton className="h-40 rounded-xl" />;
  if (!data?.length) return <EmptyState icon={MessagesSquare} title="No conversations yet" description="Calls this agent handles will appear here." />;
  return <CallsTable calls={data} showAgent={false} />;
}

export default function AgentPage() {
  return (
    <Suspense>
      <AgentEditor />
    </Suspense>
  );
}

function AgentEditor() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const isAdmin = useIsAdmin();
  const router = useRouter();
  const qc = useQueryClient();
  const { query, draft, patch, dirty, save, discard, fieldErrors } = useAgentDraft(id);
  const [tab, setTab] = useState(() => params.get("tab") ?? "agent");
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Warn before leaving with unsaved changes; save with Cmd/Ctrl+S.
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (dirty && !save.isPending) save.mutate();
      }
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("keydown", key);
    };
  }, [dirty, save]);

  const del = useMutation({
    mutationFn: () => api.del(`/agents/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Agent deleted");
      router.push("/agents");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const duplicate = useMutation({
    mutationFn: () => api.post<Agent>("/agents", { name: `${draft?.name} (copy)`, copy_from: id }),
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      router.push(`/agents/${a.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (query.isError) return <div className="p-8 text-sm text-destructive">{errorMessage(query.error)}</div>;
  if (!draft) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-8 py-8">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-8 w-[520px]" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="pb-24">
      <div className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-8 pt-5">
          <Button variant="ghost" size="icon-sm" asChild>
            <Link href="/agents">
              <ArrowLeft />
            </Link>
          </Button>
          <AgentAvatar name={draft.name} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight">{draft.name}</h1>
              {dirty && <Pill tone="amber">Unsaved</Pill>}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-0.5 font-mono">
                {draft.id}
                <CopyButton value={draft.id} />
              </span>
              {query.data?.phone_numbers?.map((n) => (
                <span key={n.id} className="inline-flex items-center gap-1 tabular-nums">
                  <Phone className="size-3" /> {formatPhone(n.number)}
                </span>
              ))}
              {!query.data?.phone_numbers?.length && (
                <Link href="/phone-numbers" className="underline-offset-2 hover:underline">
                  No phone number assigned
                </Link>
              )}
            </div>
          </div>
          <Button variant="outline" onClick={() => setTesting(true)}>
            <FlaskConical /> Test agent
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => duplicate.mutate()}>
                <Copy /> Duplicate
              </DropdownMenuItem>
              {isAdmin && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                    <Trash2 /> Delete agent
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="mx-auto max-w-6xl px-8">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList variant="line" className="mt-3 h-10 gap-1">
              {TABS.map(([v, label]) => (
                <TabsTrigger key={v} value={v} className="px-2.5 text-[13px] data-active:text-primary after:bg-primary">
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="mx-auto max-w-6xl px-8 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsContent value="agent">
            <AgentTab draft={draft} patch={patch} errors={fieldErrors} />
          </TabsContent>
          <TabsContent value="workflow">
            <WorkflowTab draft={{ ...draft, phone_numbers: query.data?.phone_numbers }} onNavigate={setTab} />
          </TabsContent>
          <TabsContent value="voice">
            <VoiceTab draft={draft} patch={patch} />
          </TabsContent>
          <TabsContent value="knowledge">
            <KnowledgeTab draft={draft} patch={patch} />
          </TabsContent>
          <TabsContent value="routing">
            <RoutingTab draft={draft} patch={patch} errors={fieldErrors} />
          </TabsContent>
          <TabsContent value="advanced">
            <AdvancedTab draft={draft} patch={patch} />
          </TabsContent>
          <TabsContent value="conversations">
            <AgentCalls agentId={id} />
          </TabsContent>
        </Tabs>
      </div>

      {/* Save bar */}
      <div
        className={`fixed inset-x-0 bottom-0 z-30 flex justify-center pb-5 pl-60 transition-all duration-200 ${dirty ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-4 opacity-0"}`}
      >
        <div className="flex items-center gap-4 rounded-xl border bg-slate-900 py-2 pl-4 pr-2 text-white shadow-lg">
          <span className="text-[13px]">You have unsaved changes</span>
          <Button size="sm" variant="ghost" className="text-background hover:bg-white/10 hover:text-background" onClick={discard}>
            Discard
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} Save
            <kbd className="ml-1 rounded border border-white/30 px-1 font-sans text-[10px] text-white/80">⌘S</kbd>
          </Button>
        </div>
      </div>

      <TestPanel agent={query.data ?? draft} open={testing} onOpenChange={setTesting} dirty={dirty} />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {draft.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This can&apos;t be undone. Its phone numbers become unassigned and calls to them get a “not in service” message.
              Past conversations are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => del.mutate()}>
              Delete agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
