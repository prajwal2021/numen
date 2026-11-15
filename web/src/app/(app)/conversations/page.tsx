"use client";

import { useQuery } from "@tanstack/react-query";
import { MessagesSquare, RefreshCw, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CallsTable } from "@/components/calls-table";
import { EmptyState, Page, PageHeader } from "@/components/common";
import { api } from "@/lib/api";
import type { Agent, CallRow } from "@/lib/types";

export default function ConversationsPage() {
  const [agentId, setAgentId] = useState("all");
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q);
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/agents") });
  const params = new URLSearchParams();
  if (agentId !== "all") params.set("agent_id", agentId);
  if (dq) params.set("q", dq);
  const calls = useQuery({
    queryKey: ["calls", agentId, dq],
    queryFn: () => api.get<CallRow[]>(`/calls?${params}`),
    refetchInterval: 15_000,
  });

  return (
    <Page>
      <PageHeader
        icon={MessagesSquare}
        tone="amber"
        title="Conversations"
        description="Every call with its transcript and lookups."
        actions={
          <Button variant="outline" size="icon" onClick={() => calls.refetch()}>
            <RefreshCw className={calls.isFetching ? "animate-spin" : ""} />
          </Button>
        }
      />
      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search by phone number or call ID" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={agentId} onValueChange={setAgentId}>
          <SelectTrigger className="w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All agents</SelectItem>
            {agents.data?.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {calls.isLoading ? (
        <Skeleton className="h-60 rounded-xl" />
      ) : !calls.data?.length ? (
        <EmptyState icon={MessagesSquare} tone="amber" title={q || agentId !== "all" ? "No matching conversations" : "No conversations yet"} />
      ) : (
        <CallsTable calls={calls.data} />
      )}
    </Page>
  );
}
