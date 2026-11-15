"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Bot, Phone, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dot, EmptyState, Field, Page, PageHeader } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { formatPhone, timeAgo } from "@/lib/format";
import type { Agent } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";

function NewAgentDialog({ open, onOpenChange, agents }: { open: boolean; onOpenChange: (v: boolean) => void; agents: Agent[] }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [copyFrom, setCopyFrom] = useState("blank");
  const create = useMutation({
    mutationFn: () =>
      api.post<Agent>("/agents", { name, description, copy_from: copyFrom === "blank" ? null : copyFrom }),
    onSuccess: (a) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast.success(`Created ${a.name}`);
      onOpenChange(false);
      router.push(`/agents/${a.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create an agent</DialogTitle>
          <DialogDescription>Name it now; set voice, knowledge and routing next.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Field label="Name" htmlFor="agent-name">
            <Input id="agent-name" autoFocus placeholder="e.g. Ava - Admissions" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <Input placeholder="What this agent handles" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Start from">
            <Select value={copyFrom} onValueChange={setCopyFrom}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="blank">Blank agent</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    Copy of {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending ? "Creating…" : "Create agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentsPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(() => params.get("new") === "1");
  const [q, setQ] = useState("");
  const { data: agents, isLoading } = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/agents") });

  useEffect(() => {
    if (params.get("new")) router.replace("/agents");
  }, [params, router]);

  const filtered = (agents ?? []).filter((a) => a.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <Page>
      <PageHeader
        icon={Bot}
        tone="violet"
        title="Agents"
        description="Each agent answers the numbers assigned to it."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus /> New agent
          </Button>
        }
      />
      {isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : !agents?.length ? (
        <EmptyState
          icon={Bot}
          tone="violet"
          title="No agents yet"
          description="Create an agent, then assign it a phone number."
          action={
            <Button onClick={() => setOpen(true)}>
              <Plus /> New agent
            </Button>
          }
        />
      ) : (
        <>
          <div className="relative mb-3 w-72">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search agents" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="pl-4">Name</TableHead>
                  <TableHead>Phone numbers</TableHead>
                  <TableHead>Knowledge base</TableHead>
                  <TableHead>Voice</TableHead>
                  <TableHead className="pr-4 text-right">Last edited</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((a) => (
                  <TableRow key={a.id} className="cursor-pointer" onClick={() => router.push(`/agents/${a.id}`)}>
                    <TableCell className="py-3 pl-4">
                      <Link href={`/agents/${a.id}`} className="flex items-center gap-3">
                        <AgentAvatar name={a.name} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{a.name}</div>
                          {a.description && <div className="truncate text-xs text-muted-foreground">{a.description}</div>}
                        </div>
                      </Link>
                    </TableCell>
                    <TableCell>
                      {a.phone_numbers?.length ? (
                        <div className="flex flex-col gap-0.5">
                          {a.phone_numbers.map((n) => (
                            <span key={n.id} className="inline-flex items-center gap-1.5 text-[13px] tabular-nums">
                              <Phone className="size-3 text-muted-foreground" /> {formatPhone(n.number)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-[13px] text-muted-foreground">Not assigned</span>
                      )}
                    </TableCell>
                    <TableCell className="text-[13px]">
                      {a.knowledge_base_name ? (
                        <span className="inline-flex items-center gap-1.5">
                          <BookOpen className="size-3.5 text-muted-foreground" />
                          {a.knowledge_base_name}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </TableCell>
                    <TableCell className="text-[13px]">
                      <span className="inline-flex items-center gap-1.5">
                        <Dot tone={a.office_open_now ? "green" : "gray"} />
                        {a.voice.voice_name}
                      </span>
                    </TableCell>
                    <TableCell className="pr-4 text-right text-[13px] text-muted-foreground">{timeAgo(a.updated_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      <NewAgentDialog open={open} onOpenChange={setOpen} agents={agents ?? []} />
    </Page>
  );
}

export default function AgentsPage() {
  return (
    <Suspense>
      <AgentsPageInner />
    </Suspense>
  );
}
