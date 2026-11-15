"use client";

import { Check, Copy, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Tone } from "@/lib/tones";
import { cn } from "@/lib/utils";

export function IconChip({ icon: Icon, size = "md" }: { icon: LucideIcon; tone?: Tone; size?: "sm" | "md" | "lg" }) {
  const box = { sm: "size-6 rounded-md", md: "size-8 rounded-lg", lg: "size-9 rounded-lg" }[size];
  const ico = { sm: "size-3.5", md: "size-4", lg: "size-[18px]" }[size];
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center border bg-background text-foreground/70", box)}>
      <Icon className={ico} strokeWidth={1.75} />
    </span>
  );

}

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  icon?: LucideIcon;
  tone?: Tone;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4 pb-8", className)}>
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-7 tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-[13.5px] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );

}

export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-8 py-8", className)}>{children}</div>;
}

export function Section({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  actions?: React.ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
}) {
  return (
    <section className="border-b border-border/70 py-7 first:pt-1 last:border-0 last:pb-1">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-6">{title}</h2>
          {description && <p className="text-[13px] leading-5 text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );

}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  aside,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string;
  htmlFor?: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={htmlFor} className="text-[13px] font-medium">
          {label}
        </Label>
        {aside}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        hint && <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export function ToggleRow({
  title,
  description,
  control,
}: {
  title: string;
  description?: React.ReactNode;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <div className="text-[13px] font-medium leading-5">{title}</div>
        {description && <div className="text-xs leading-5 text-muted-foreground">{description}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center">
      <div className="mb-3">
        <IconChip icon={Icon} size="lg" />
      </div>
      <div className="text-sm font-medium">{title}</div>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function CopyButton({ value, className }: { value: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn("inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground", className)}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            navigator.clipboard.writeText(value);
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          }}
        >
          {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>{done ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  );
}

export function Dot({ tone }: { tone: "green" | "amber" | "red" | "gray" | "blue" }) {
  const colors = {
    green: "bg-emerald-500",
    amber: "bg-amber-500",
    red: "bg-red-500",
    gray: "bg-neutral-400",
    blue: "bg-sky-500",
  };
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", colors[tone])} />;
}

export function Pill({
  tone = "gray",
  children,
  className,
}: {
  tone?: "green" | "amber" | "red" | "gray" | "blue";
  children: React.ReactNode;
  className?: string;
}) {
  const tones = {
    green: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
    amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
    red: "bg-red-50 text-red-700 ring-red-600/15",
    gray: "bg-neutral-100 text-neutral-700 ring-neutral-500/15",
    blue: "bg-sky-50 text-sky-700 ring-sky-600/15",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[12px]", className)}>{children}</span>;
}
