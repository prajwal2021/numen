// One color per area of the app, used for icons, chips and accents so pages are easy to tell apart.

export type Tone = "indigo" | "violet" | "sky" | "emerald" | "amber" | "rose" | "slate";

export const TONE: Record<Tone, { chip: string; text: string; soft: string; ring: string; bar: string }> = {
  indigo: { chip: "bg-indigo-50 text-indigo-600 ring-indigo-100", text: "text-indigo-600", soft: "bg-indigo-50", ring: "ring-indigo-200", bar: "bg-indigo-500" },
  violet: { chip: "bg-violet-50 text-violet-600 ring-violet-100", text: "text-violet-600", soft: "bg-violet-50", ring: "ring-violet-200", bar: "bg-violet-500" },
  sky: { chip: "bg-sky-50 text-sky-600 ring-sky-100", text: "text-sky-600", soft: "bg-sky-50", ring: "ring-sky-200", bar: "bg-sky-500" },
  emerald: { chip: "bg-emerald-50 text-emerald-600 ring-emerald-100", text: "text-emerald-600", soft: "bg-emerald-50", ring: "ring-emerald-200", bar: "bg-emerald-500" },
  amber: { chip: "bg-amber-50 text-amber-600 ring-amber-100", text: "text-amber-600", soft: "bg-amber-50", ring: "ring-amber-200", bar: "bg-amber-500" },
  rose: { chip: "bg-rose-50 text-rose-600 ring-rose-100", text: "text-rose-600", soft: "bg-rose-50", ring: "ring-rose-200", bar: "bg-rose-500" },
  slate: { chip: "bg-slate-100 text-slate-600 ring-slate-200", text: "text-slate-600", soft: "bg-slate-100", ring: "ring-slate-200", bar: "bg-slate-500" },
};

export const AREA = {
  home: "indigo",
  agents: "violet",
  knowledge: "sky",
  phone: "emerald",
  conversations: "amber",
  settings: "slate",
} as const satisfies Record<string, Tone>;
