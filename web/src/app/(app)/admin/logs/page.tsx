"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Download, Radio, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, Mono, Page, PageHeader, Pill } from "@/components/common";
import { api } from "@/lib/api";
import type { User } from "@/lib/auth";
import { cn } from "@/lib/utils";

type Entry = {
  id: number;
  at: string;
  type: string;
  action: string;
  user_id: string | null;
  user_email: string | null;
  target: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  duration_ms: number | null;
  ip: string | null;
  user_agent: string | null;
  session_id: string | null;
  meta: Record<string, unknown> | null;
};
type Page_ = { items: Entry[]; has_more: boolean; next_before_id: number | null; counts: Record<string, number> };

const TYPES: { id: string; label: string; tone: "gray" | "blue" | "green" | "amber" | "red" }[] = [
  { id: "click", label: "Clicks", tone: "gray" },
  { id: "page_view", label: "Page views", tone: "gray" },
  { id: "api", label: "Changes", tone: "blue" },
  { id: "auth", label: "Sign-ins", tone: "green" },
  { id: "user", label: "Users", tone: "amber" },
  { id: "call", label: "Calls", tone: "blue" },
  { id: "system", label: "System", tone: "gray" },
  { id: "error", label: "Errors", tone: "red" },
];
const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t]));
const RANGES = [
  { v: "1", label: "Last 24 hours" },
  { v: "7", label: "Last 7 days" },
  { v: "30", label: "Last 30 days" },
  { v: "90", label: "Last 90 days" },
];

function Detail({ e, onClose }: { e: Entry | null; onClose: () => void }) {
  return (
    <Sheet open={!!e} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-[480px] gap-0 p-0 sm:max-w-[480px]">
        {e && (
          <>
            <SheetHeader className="border-b px-5 py-4">
              <SheetTitle className="text-base">{e.action}</SheetTitle>
              <SheetDescription className="text-xs">{format(new Date(e.at), "EEEE, MMM d yyyy · h:mm:ss a")}</SheetDescription>
            </SheetHeader>
            <div className="space-y-5 overflow-y-auto px-5 py-4">
              <dl className="space-y-2.5 text-[13px]">
                {(
                  [
                    ["Type", <Pill key="t" tone={TYPE[e.type]?.tone ?? "gray"}>{TYPE[e.type]?.label ?? e.type}</Pill>],
                    ["User", e.user_email ?? "—"],
                    ["Target", e.target ?? "—"],
                    ["Page / path", e.path ? <Mono key="p">{e.path}</Mono> : "—"],
                    ["Request", e.method ? <Mono key="m">{`${e.method} · ${e.status ?? ""} · ${e.duration_ms ?? "?"} ms`}</Mono> : "—"],
                    ["IP address", e.ip ?? "—"],
                    ["Session", e.session_id ? <Mono key="s">{e.session_id}</Mono> : "—"],
                    ["Device", <span key="d" className="break-words text-xs text-muted-foreground">{e.user_agent ?? "—"}</span>],
                  ] as [string, React.ReactNode][]
                ).map(([k, v]) => (
                  <div key={k} className="flex gap-3">
                    <dt className="w-28 shrink-0 text-muted-foreground">{k}</dt>
                    <dd className="min-w-0 flex-1 break-words">{v}</dd>
                  </div>
                ))}
              </dl>
              {e.meta && (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">Details</div>
                  <pre className="max-h-[50vh] overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11.5px] leading-relaxed">{JSON.stringify(e.meta, null, 2)}</pre>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function AuditLogsPage() {
  const [days, setDays] = useState("7");
  const [types, setTypes] = useState<string[]>([]);
  const [userId, setUserId] = useState("all");
  const [q, setQ] = useState("");
  const dq = useDeferredValue(q);
  const [live, setLive] = useState(true);
  const [open, setOpen] = useState<Entry | null>(null);
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/users") });

  const params = useMemo(() => {
    const p = new URLSearchParams({ days });
    if (types.length) p.set("type", types.join(","));
    if (userId !== "all") p.set("user_id", userId);
    if (dq) p.set("q", dq);
    return p;
  }, [days, types, userId, dq]);

  const logs = useInfiniteQuery({
    queryKey: ["audit", params.toString()],
    queryFn: ({ pageParam }) => api.get<Page_>(`/audit?${params}&limit=100${pageParam ? `&before_id=${pageParam}` : ""}`),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.has_more ? last.next_before_id : undefined),
    refetchInterval: live ? 5000 : false,
  });
  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = logs.data?.pages[0]?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const toggle = (t: string) => setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  return (
    <Page className="max-w-7xl">
      <PageHeader
        title="Audit logs"
        description="Every click, page view, change, sign-in and call, by user. Kept for 90 days."
        actions={
          <>
            <label className="mr-1 flex items-center gap-2 text-[13px] text-muted-foreground">
              <Radio className={cn("size-3.5", live && "text-emerald-600")} />
              Live
              <Switch checked={live} onCheckedChange={setLive} />
            </label>
            <Button variant="outline" asChild>
              <a href={`/api/audit/export?${params}`} download>
                <Download /> Export CSV
              </a>
            </Button>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search actions, pages, emails, IPs" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={userId} onValueChange={setUserId}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All users</SelectItem>
            {users.data?.map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.name} <span className="text-muted-foreground">{u.email}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((r) => (
              <SelectItem key={r.v} value={r.v}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setTypes([])}
          className={cn("h-7 rounded-full border px-3 text-xs", !types.length ? "border-foreground bg-foreground text-background" : "hover:bg-muted")}
        >
          All <span className="tabular-nums opacity-70">{total}</span>
        </button>
        {TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => toggle(t.id)}
            className={cn("h-7 rounded-full border px-3 text-xs", types.includes(t.id) ? "border-foreground bg-foreground text-background" : "hover:bg-muted")}
          >
            {t.label} <span className="tabular-nums opacity-70">{counts[t.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {logs.isLoading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : !items.length ? (
        <EmptyState icon={Search} title="No activity matches these filters" />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[150px] pl-4">Time</TableHead>
                  <TableHead className="w-[200px]">User</TableHead>
                  <TableHead className="w-[100px]">Type</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead className="w-[150px]">Page</TableHead>
                  <TableHead className="w-[110px] pr-4">IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((e) => (
                  <TableRow key={e.id} className="cursor-pointer" onClick={() => setOpen(e)}>
                    <TableCell className="pl-4 text-[12.5px] tabular-nums text-muted-foreground">{format(new Date(e.at), "MMM d, h:mm:ss a")}</TableCell>
                    <TableCell className="truncate text-[13px]">{e.user_email ?? <span className="text-muted-foreground">System</span>}</TableCell>
                    <TableCell>
                      <Pill tone={TYPE[e.type]?.tone ?? "gray"}>{TYPE[e.type]?.label.replace(/s$/, "") ?? e.type}</Pill>
                    </TableCell>
                    <TableCell className="truncate text-[13px]" title={e.action}>
                      {e.action}
                      {e.target && e.type !== "click" && <span className="text-muted-foreground"> · {e.target}</span>}
                    </TableCell>
                    <TableCell className="truncate font-mono text-[11.5px] text-muted-foreground">{e.path ?? "—"}</TableCell>
                    <TableCell className="pr-4 text-[12.5px] tabular-nums text-muted-foreground">{e.ip ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {items.length} of {types.length ? types.reduce((a, t) => a + (counts[t] ?? 0), 0) : total}
            </span>
            {logs.hasNextPage && (
              <Button variant="outline" size="sm" onClick={() => logs.fetchNextPage()} disabled={logs.isFetchingNextPage}>
                Load more
              </Button>
            )}
          </div>
        </>
      )}
      <Detail e={open} onClose={() => setOpen(null)} />
    </Page>
  );
}
