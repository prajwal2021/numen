"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { api, ApiError, errorMessage } from "@/lib/api";
import type { Agent } from "@/lib/types";

export type Patch = <S extends keyof Agent>(section: S, value: Partial<Agent[S]> | Agent[S]) => void;

const RESPONSE_ONLY = ["phone_numbers", "knowledge_base_name", "office_open_now"] as const;

function strip(a: Agent) {
  const copy = { ...a } as Record<string, unknown>;
  RESPONSE_ONLY.forEach((k) => delete copy[k]);
  return copy as unknown as Agent;
}

/** Holds an editable copy of the agent; tracks unsaved changes; saves with PUT. */
export function useAgentDraft(id: string) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["agent", id], queryFn: () => api.get<Agent>(`/agents/${id}`) });
  // Only local edits live in state; with none, the draft is the saved agent.
  const [edits, setEdits] = useState<Agent | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const draft = edits ?? query.data ?? null;

  const dirty = useMemo(
    () => !!draft && !!query.data && JSON.stringify(strip(draft)) !== JSON.stringify(strip(query.data)),
    [draft, query.data],
  );

  const patch: Patch = useCallback((section, value) => {
    setEdits((cur) => {
      const d = cur ?? (qc.getQueryData(["agent", id]) as Agent | undefined) ?? null;
      if (!d) return cur;
      const prev = d[section];
      const next = prev && typeof prev === "object" && !Array.isArray(prev) && typeof value === "object" ? { ...prev, ...value } : value;
      return { ...d, [section]: next } as Agent;
    });
  }, [qc, id]);

  const save = useMutation({
    mutationFn: () => api.put<Agent>(`/agents/${id}`, strip(draft!)),
    onSuccess: (a) => {
      qc.setQueryData(["agent", id], a);
      qc.invalidateQueries({ queryKey: ["agents"] });
      setEdits(null);
      setFieldErrors({});
      toast.success("Agent saved");
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields.length) {
        setFieldErrors(Object.fromEntries(e.fields.map((f) => [f.field, f.message])));
        toast.error("Some settings need fixing", { description: e.fields.map((f) => `${f.field}: ${f.message}`).join("\n") });
      } else toast.error(errorMessage(e));
    },
  });

  const discard = () => {
    setEdits(null);
    setFieldErrors({});
  };

  return { query, draft, patch, dirty, save, discard, fieldErrors };
}
