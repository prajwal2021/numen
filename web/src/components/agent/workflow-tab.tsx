"use client";

import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ArrowRightLeft, BookOpen, Bot, Clock, MessageSquare, Phone, PhoneOff, type LucideIcon } from "lucide-react";
import { useMemo } from "react";
import { formatPhone } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Agent } from "@/lib/types";

type Tone = "neutral" | "agent" | "tool" | "transfer" | "condition" | "end";
type StepData = { kind: string; title: string; subtitle?: string; icon: LucideIcon; tone: Tone; tab?: string };

const TONES: Record<Tone, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  agent: "bg-violet-100 text-violet-700",
  tool: "bg-sky-100 text-sky-700",
  transfer: "bg-amber-100 text-amber-800",
  condition: "bg-emerald-100 text-emerald-700",
  end: "bg-neutral-100 text-neutral-500",
};

const SIDES = [
  ["top", Position.Top],
  ["right", Position.Right],
  ["bottom", Position.Bottom],
  ["left", Position.Left],
] as const;

function StepNode({ data, selected }: NodeProps<Node<StepData>>) {
  const Icon = data.icon;
  return (
    <div
      className={cn(
        "w-[250px] cursor-pointer rounded-xl border bg-card px-3.5 py-3 shadow-sm transition-shadow hover:shadow-md",
        selected && "ring-2 ring-foreground",
      )}
    >
      {SIDES.map(([side, pos]) => (
        <Handle key={`t-${side}`} id={`t-${side}`} type="target" position={pos} className="!size-1.5 !border-0 !bg-neutral-300" />
      ))}
      <div className="flex items-start gap-2.5">
        <div className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", TONES[data.tone])}>
          <Icon className="size-3.5" />
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{data.kind}</div>
          <div className="truncate text-[13px] font-semibold leading-snug">{data.title}</div>
          {data.subtitle && <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{data.subtitle}</div>}
        </div>
      </div>
      {SIDES.map(([side, pos]) => (
        <Handle key={`s-${side}`} id={`s-${side}`} type="source" position={pos} className="!size-1.5 !border-0 !bg-neutral-300 !opacity-0" />
      ))}
    </div>
  );
}

const nodeTypes = { step: StepNode };

function trim(s: string, n = 70) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function build(agent: Agent): { nodes: Node<StepData>[]; edges: Edge[] } {
  const r = agent.routing;
  const k = agent.knowledge;
  const nodes: Node<StepData>[] = [];
  const edges: Edge[] = [];
  const node = (id: string, x: number, y: number, data: StepData) => nodes.push({ id, type: "step", position: { x, y }, data });
  const edge = (source: string, target: string, label?: string, opts: Partial<Edge> = {}) =>
    edges.push({
      id: `${source}-${target}-${label ?? ""}`,
      source,
      target,
      sourceHandle: "s-bottom",
      targetHandle: "t-top",
      label,
      type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#a3a3a3" },
      style: { stroke: "#a3a3a3", strokeWidth: 1.25 },
      labelStyle: { fontSize: 11, fill: "#525252", fontWeight: 500 },
      labelBgStyle: { fill: "#fff" },
      labelBgPadding: [6, 3],
      labelBgBorderRadius: 6,
      ...opts,
    });

  const numbers = agent.phone_numbers?.map((n) => formatPhone(n.number)).join(", ");
  node("start", 300, 0, {
    kind: "Start",
    title: "Incoming call",
    subtitle: `${numbers || "No number assigned"} · rings ${agent.conversation.ring_seconds}s`,
    icon: Phone,
    tone: "neutral",
    tab: "advanced",
  });

  const openDays = Object.entries(r.week).filter(([, d]) => d.open).length;
  const afterHoursTransfer = r.office_hours_enabled && r.after_hours_action === "transfer" && !!r.after_hours_number;
  let entry = "start";
  if (r.office_hours_enabled) {
    node("hours", 300, 120, {
      kind: "Condition",
      title: "Office open?",
      subtitle: `${openDays} days a week · ${r.holidays.length} holiday${r.holidays.length === 1 ? "" : "s"} · ${r.timezone.split("/").pop()?.replaceAll("_", " ")}`,
      icon: Clock,
      tone: "condition",
      tab: "routing",
    });
    edge("start", "hours");
    entry = "hours";
    if (afterHoursTransfer) {
      node("ah_say", 800, 120, { kind: "Say", title: "Closed message", subtitle: trim(r.after_hours_message), icon: MessageSquare, tone: "neutral", tab: "routing" });
      node("ah_transfer", 800, 250, {
        kind: "Transfer to number",
        title: "After-hours line",
        subtitle: formatPhone(r.after_hours_number),
        icon: ArrowRightLeft,
        tone: "transfer",
        tab: "routing",
      });
      edge("hours", "ah_say", "Closed", { sourceHandle: "s-right", targetHandle: "t-left" });
      edge("ah_say", "ah_transfer");
    }
  }

  node("greet", 300, 250, { kind: "Say", title: "First message", subtitle: trim(agent.greeting), icon: MessageSquare, tone: "neutral", tab: "agent" });
  edge(entry, "greet", r.office_hours_enabled ? (afterHoursTransfer ? "Open" : "Open or closed") : undefined);

  node("agent", 300, 390, {
    kind: "Agent",
    title: agent.name,
    subtitle: `${agent.llm.model} · ${agent.voice.voice_name} voice`,
    icon: Bot,
    tone: "agent",
    tab: "agent",
  });
  edge("greet", "agent");

  if (k.knowledge_base_id) {
    node("kb", -200, 390, {
      kind: "Tool · knowledge base",
      title: agent.knowledge_base_name ?? "Knowledge base",
      subtitle: `${k.route_all_questions ? "Every question" : "Questions about the organization"} · ${k.answer_mode === "verbatim" ? "answer spoken word for word" : "answer rephrased"}`,
      icon: BookOpen,
      tone: "tool",
      tab: "knowledge",
    });
    edge("agent", "kb", "Each question", { sourceHandle: "s-left", targetHandle: "t-right", animated: true });
    node("kb_miss", -200, 540, {
      kind: "Say",
      title: "No answer: offer transfer",
      subtitle: "Knowledge base fallback message",
      icon: MessageSquare,
      tone: "neutral",
      tab: "knowledge",
    });
    edge("kb", "kb_miss", "Not found");
  }

  if (r.transfer_enabled) {
    node("transfer", 800, 390, {
      kind: "Transfer to number",
      title: "Live agent",
      subtitle:
        `Open: ${formatPhone(r.transfer_number)}` +
        (r.office_hours_enabled ? ` · Closed: ${r.after_hours_number ? formatPhone(r.after_hours_number) : "voicemail"}` : ""),
      icon: ArrowRightLeft,
      tone: "transfer",
      tab: "routing",
    });
    edge("agent", "transfer", k.knowledge_base_id ? "Asks for a person / accepts offer" : "Asks for a person", {
      sourceHandle: "s-right",
      targetHandle: "t-left",
    });
  }

  node("end", 300, 540, { kind: "End", title: "Caller hangs up", icon: PhoneOff, tone: "end" });
  edge("agent", "end");
  return { nodes, edges };
}

export function WorkflowTab({ draft, onNavigate }: { draft: Agent; onNavigate: (tab: string) => void }) {
  const { nodes, edges } = useMemo(() => build(draft), [draft]);
  return (
    <div className="space-y-3">
      <div className="h-[640px] overflow-hidden rounded-xl border bg-[#fafafa]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          nodesConnectable={false}
          nodesDraggable
          elementsSelectable
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, n) => n.data.tab && onNavigate(n.data.tab as string)}
          minZoom={0.4}
          maxZoom={1.5}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d4d4d4" />
          <Controls showInteractive={false} className="!rounded-lg !border !shadow-sm" />
        </ReactFlow>
      </div>
      <p className="text-xs text-muted-foreground">Built from this agent&apos;s settings. Click a step to edit it.</p>
    </div>
  );
}
