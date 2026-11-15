"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Monochrome: primary series near-black, secondary mid-gray (told apart by dash + legend, not color alone).
export const SERIES = ["#171717", "#a3a3a3", "#525252", "#d4d4d4", "#737373"] as const;
const AXIS = { fontSize: 11, fill: "#8a8a8a" };

type TipItem = { dataKey?: string | number; name?: string | number; value?: number | string; color?: string };

function ChartTooltip({
  active,
  payload,
  label,
  format,
  labelFormat,
}: {
  active?: boolean;
  payload?: TipItem[];
  label?: string | number;
  format?: (v: number, name: string) => string;
  labelFormat?: (v: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-foreground">{labelFormat ? labelFormat(String(label)) : label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2 text-muted-foreground">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">
            {format ? format(p.value as number, p.name as string) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BarSeries({
  data,
  x,
  y,
  name,
  color = SERIES[0],
  height = 220,
  tickFormatter,
  format,
}: {
  data: Record<string, unknown>[];
  x: string;
  y: string;
  name: string;
  color?: string;
  height?: number;
  tickFormatter?: (v: string) => string;
  format?: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 4, left: -18, bottom: 0 }} barCategoryGap="38%">
        <CartesianGrid vertical={false} stroke="#f0f0f0" />
        <XAxis dataKey={x} tick={AXIS} tickLine={false} axisLine={false} tickFormatter={tickFormatter} interval="preserveStartEnd" minTickGap={16} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
        <Tooltip cursor={{ fill: "rgba(0,0,0,0.035)" }} content={<ChartTooltip format={format ? (v) => format(v) : undefined} labelFormat={tickFormatter} />} />
        <Bar dataKey={y} name={name} fill={color} fillOpacity={0.88} radius={[4, 4, 0, 0]} maxBarSize={20} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function LineSeries({
  data,
  x,
  lines,
  height = 220,
  tickFormatter,
  format,
  axisFormat,
}: {
  data: Record<string, unknown>[];
  x: string;
  axisFormat?: (v: number) => string;
  lines: { key: string; name: string; color: string; dashed?: boolean }[];
  height?: number;
  tickFormatter?: (v: string) => string;
  format?: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#f0f0f0" />
        <XAxis dataKey={x} tick={AXIS} tickLine={false} axisLine={false} tickFormatter={tickFormatter} interval="preserveStartEnd" minTickGap={16} />
        <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} tickFormatter={axisFormat} />
        <Tooltip cursor={{ stroke: "#c7c7d1", strokeWidth: 1 }} content={<ChartTooltip format={format ? (v) => format(v) : undefined} labelFormat={tickFormatter} />} />
        {lines.map((l) => (
          <Line
            key={l.key}
            type="monotone"
            dataKey={l.key}
            name={l.name}
            stroke={l.color}
            strokeWidth={2}
            strokeDasharray={l.dashed ? "5 4" : undefined}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff" }}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function Legend({ items }: { items: { name: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((i) => (
        <span key={i.name} className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-3.5 rounded-full" style={{ background: i.dashed ? `repeating-linear-gradient(90deg, ${i.color} 0 4px, transparent 4px 7px)` : i.color }} />
          {i.name}
        </span>
      ))}
    </div>
  );
}

/** Horizontal bars with the value and share written out (identity never by color alone). */
export function BreakdownBars({ rows }: { rows: { label: string; value: number; color?: string }[] }) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!total) return <div className="flex h-40 items-center justify-center text-[13px] text-muted-foreground">No data yet</div>;
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.label} className="group">
          <div className="mb-1 flex items-baseline justify-between text-[13px]">
            <span>{r.label}</span>
            <span className="tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{r.value}</span> · {Math.round((r.value / total) * 100)}%
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full rounded-full bg-neutral-800 transition-all" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
