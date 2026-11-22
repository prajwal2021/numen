"use client";

import { useRouter } from "next/navigation";
import { ArrowRightLeft, BookOpen } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pill } from "@/components/common";
import { endReasonLabel, formatDuration, formatPhone, formatWhen } from "@/lib/format";
import type { CallRow } from "@/lib/types";

export function EndReason({ reason }: { reason: string | null }) {
  const label = endReasonLabel(reason);
  const tone = !reason ? "blue" : reason.startsWith("transferred") ? "amber" : reason === "caller hung up" || reason === "agent ended the call" ? "green" : "red";
  return <Pill tone={tone}>{label}</Pill>;
}

export function CallsTable({ calls, showAgent = true }: { calls: CallRow[]; showAgent?: boolean }) {
  const router = useRouter();
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead className="pl-4">Date</TableHead>
            {showAgent && <TableHead>Agent</TableHead>}
            <TableHead>Caller</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Knowledge base</TableHead>
            <TableHead className="pr-4">Outcome</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {calls.map((c) => {
            const s = c.summary ?? {};
            return (
              <TableRow
                key={c.call_sid}
                className="cursor-pointer"
                onClick={() => router.push(`/conversations/${c.call_sid}`)}
              >
                <TableCell className="pl-4 text-[13px]">{formatWhen(c.started_at)}</TableCell>
                {showAgent && <TableCell className="text-[13px] font-medium">{c.agent_name ?? "—"}</TableCell>}
                <TableCell className="text-[13px] tabular-nums text-muted-foreground">{formatPhone(c.from_number)}</TableCell>
                <TableCell className="text-[13px] tabular-nums">{formatDuration(c.duration_s)}</TableCell>
                <TableCell className="text-[13px]">
                  {s.kb_lookups ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <BookOpen className="size-3.5 text-sky-500" />
                      <span className="tabular-nums">
                        <span className="font-medium text-foreground">
                          {s.kb_hits ?? 0}/{s.kb_lookups}
                        </span>{" "}
                        answered
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="pr-4">
                  <div className="flex items-center gap-1.5">
                    <EndReason reason={c.end_reason} />
                    {!!s.transfers && !c.end_reason?.startsWith("transferred") && (
                      <ArrowRightLeft className="size-3.5 text-muted-foreground" />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
