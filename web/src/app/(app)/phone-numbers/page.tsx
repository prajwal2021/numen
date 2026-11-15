"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, Link2, Loader2, MoreHorizontal, Phone, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton, Dot, EmptyState, Field, Mono, Page, PageHeader, Pill } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { useIsAdmin } from "@/lib/auth";
import { formatPhone } from "@/lib/format";
import type { Agent, NumberStatus, PhoneNumberRow, TwilioNumber } from "@/lib/types";

const STATUS: Record<NumberStatus, { tone: "green" | "amber" | "red" | "gray"; label: string; help: string }> = {
  connected: { tone: "green", label: "Connected", help: "Twilio sends this number's calls to this server." },
  elsewhere: { tone: "amber", label: "Points elsewhere", help: "Twilio sends this number's calls somewhere else. Click Connect." },
  not_in_account: { tone: "red", label: "Not in Twilio account", help: "This number isn't in the connected Twilio account." },
  unknown: { tone: "gray", label: "Unknown", help: "Couldn't reach Twilio. Check Settings." },
};

function AgentSelect({ value, agents, onChange, className }: { value: string | null; agents: Agent[]; onChange: (v: string | null) => void; className?: string }) {
  return (
    <Select value={value ?? "none"} onValueChange={(v) => onChange(v === "none" ? null : v)}>
      <SelectTrigger className={className ?? "h-8 w-60"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">
          <span className="text-muted-foreground">No agent</span>
        </SelectItem>
        {agents.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ImportDialog({ open, onOpenChange, agents }: { open: boolean; onOpenChange: (v: boolean) => void; agents: Agent[] }) {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState<string | null>(null);
  const twilio = useQuery({ queryKey: ["twilio-numbers"], queryFn: () => api.get<TwilioNumber[]>("/twilio/numbers"), enabled: open });
  const add = useMutation({
    mutationFn: (n: TwilioNumber) => api.post("/phone-numbers", { number: n.number, label: n.friendly_name, agent_id: agentId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["phone-numbers"] });
      qc.invalidateQueries({ queryKey: ["twilio-numbers"] });
      toast.success("Number added");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from Twilio</DialogTitle>
          <DialogDescription>Nothing changes in Twilio until you click Connect.</DialogDescription>
        </DialogHeader>
        <Field label="Assign imported numbers to">
          <AgentSelect value={agentId} agents={agents} onChange={setAgentId} className="w-72" />
        </Field>
        <div className="max-h-96 overflow-y-auto rounded-lg border">
          {twilio.isLoading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : twilio.isError ? (
            <p className="p-4 text-sm text-destructive">{errorMessage(twilio.error)}</p>
          ) : (
            <Table>
              <TableBody>
                {twilio.data?.map((n) => (
                  <TableRow key={n.sid}>
                    <TableCell className="pl-4">
                      <div className="text-[13px] font-medium tabular-nums">{formatPhone(n.number)}</div>
                      <div className="text-xs text-muted-foreground">{n.friendly_name}</div>
                    </TableCell>
                    <TableCell className="max-w-56 truncate font-mono text-[11px] text-muted-foreground">{n.voice_url || "No voice webhook"}</TableCell>
                    <TableCell className="pr-4 text-right">
                      {n.imported ? (
                        <Pill tone="gray">Added</Pill>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => add.mutate(n)} disabled={add.isPending}>
                          <Plus /> Add
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddDialog({ open, onOpenChange, agents }: { open: boolean; onOpenChange: (v: boolean) => void; agents: Agent[] }) {
  const qc = useQueryClient();
  const [number, setNumber] = useState("");
  const [label, setLabel] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api.post("/phone-numbers", { number, label, agent_id: agentId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["phone-numbers"] });
      toast.success("Number added");
      onOpenChange(false);
      setNumber("");
      setLabel("");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a phone number</DialogTitle>
          <DialogDescription>It must already be in your Twilio account.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Phone number" hint="E.164 format, e.g. +18887208616">
            <Input className="font-mono" autoFocus value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+1…" />
          </Field>
          <Field label="Label">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Admissions line" />
          </Field>
          <Field label="Agent">
            <AgentSelect value={agentId} agents={agents} onChange={setAgentId} className="w-full" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => add.mutate()} disabled={!number.trim() || add.isPending}>
            Add number
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PhoneNumbersPage() {
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const numbers = useQuery({
    queryKey: ["phone-numbers"],
    queryFn: () => api.get<{ numbers: PhoneNumberRow[]; webhook_url: string | null; twilio_error: string | null }>("/phone-numbers"),
  });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/agents") });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; agent_id?: string | null; label?: string }) => api.put(`/phone-numbers/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["phone-numbers"] });
      qc.invalidateQueries({ queryKey: ["agents"] });
      toast.success("Saved");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const connect = useMutation({
    mutationFn: (id: string) => api.post(`/phone-numbers/${id}/connect`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["phone-numbers"] });
      toast.success("Connected: Twilio now sends this number's calls here");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/phone-numbers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["phone-numbers"] });
      toast.success("Removed. The number is still in Twilio.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const d = numbers.data;
  return (
    <Page>
      <PageHeader
        icon={Phone}
        tone="emerald"
        title="Phone Numbers"
        description="Twilio numbers and the agent that answers each."
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => numbers.refetch()} title="Refresh status">
              <RefreshCw className={numbers.isFetching ? "animate-spin" : ""} />
            </Button>
            {isAdmin && (
              <>
                <Button variant="outline" onClick={() => setAdding(true)}>
                  <Plus /> Add number
                </Button>
                <Button onClick={() => setImporting(true)}>
                  <Download /> Import from Twilio
                </Button>
              </>
            )}
          </>
        }
      />
      {d && !d.webhook_url && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            Set the public URL before connecting numbers.{" "}
            <Link href="/settings" className="font-medium underline underline-offset-2">
              Open Settings
            </Link>
          </span>
        </div>
      )}
      {d?.twilio_error && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-900">
          <AlertTriangle className="size-4 shrink-0" /> Twilio: {d.twilio_error}
        </div>
      )}
      {d?.webhook_url && (
        <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Link2 className="size-3.5" /> Calls are sent to <Mono>{d.webhook_url}</Mono>
          <CopyButton value={d.webhook_url} />
        </div>
      )}

      {numbers.isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : !d?.numbers.length ? (
        <EmptyState
          icon={Phone}
          tone="emerald"
          title="No phone numbers"
          description={isAdmin ? "Import a number from Twilio and assign it an agent." : "Ask an admin to add a phone number."}
          action={
            isAdmin && (
              <Button onClick={() => setImporting(true)}>
                <Download /> Import from Twilio
              </Button>
            )
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="pl-4">Number</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-4 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {d.numbers.map((n) => {
                const st = STATUS[n.status];
                return (
                  <TableRow key={n.id}>
                    <TableCell className="py-3 pl-4">
                      <div className="flex items-center gap-1 text-sm font-medium tabular-nums">
                        {formatPhone(n.number)}
                        <CopyButton value={n.number} />
                      </div>
                      <div className="text-xs text-muted-foreground">{n.label || "Twilio"}</div>
                    </TableCell>
                    <TableCell>
                      <AgentSelect value={n.agent_id} agents={agents.data ?? []} onChange={(v) => update.mutate({ id: n.id, agent_id: v })} />
                    </TableCell>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Pill tone={st.tone}>
                              <Dot tone={st.tone} /> {st.label}
                            </Pill>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs">
                          {st.help}
                          {n.voice_url && n.status === "elsewhere" && <div className="mt-1 break-all font-mono text-[10px] opacity-80">{n.voice_url}</div>}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {isAdmin && (
                      <div className="flex items-center justify-end gap-1">
                        {n.status === "elsewhere" && (
                          <Button size="sm" variant="outline" onClick={() => connect.mutate(n.id)} disabled={connect.isPending || !d.webhook_url}>
                            {connect.isPending ? <Loader2 className="animate-spin" /> : <Link2 />} Connect
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm">
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => connect.mutate(n.id)} disabled={!d.webhook_url}>
                              <Link2 /> Reconnect webhook
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => remove.mutate(n.id)}>
                              <Trash2 /> Remove from Numen
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <ImportDialog open={importing} onOpenChange={setImporting} agents={agents.data ?? []} />
      <AddDialog open={adding} onOpenChange={setAdding} agents={agents.data ?? []} />
    </Page>
  );
}
