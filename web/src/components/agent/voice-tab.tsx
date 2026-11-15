"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { AudioLines, Check, Loader2, Pause, Play, Search, SlidersHorizontal, Volume2, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Field, Pill, Section } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Agent, Voice } from "@/lib/types";
import { useMeta } from "./agent-tab";
import type { Patch } from "./use-agent-draft";

function useAudio() {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => () => ref.current?.pause(), []);
  const play = (key: string, src: string) => {
    ref.current?.pause();
    if (playing === key) {
      setPlaying(null);
      return;
    }
    const a = new Audio(src);
    ref.current = a;
    a.onended = () => setPlaying(null);
    a.play();
    setPlaying(key);
  };
  return { play, playing };
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  left,
  right,
  onChange,
  format = (v: number) => v.toFixed(2),
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  left: string;
  right: string;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="font-mono text-xs tabular-nums text-muted-foreground">{format(value)}</div>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

export function VoiceTab({ draft, patch }: { draft: Agent; patch: Patch }) {
  const { data: meta } = useMeta();
  const voices = useQuery({ queryKey: ["voices"], queryFn: () => api.get<Voice[]>("/voices"), staleTime: 600_000 });
  const [q, setQ] = useState("");
  const { play, playing } = useAudio();
  const v = draft.voice;

  const preview = useMutation({
    mutationFn: () =>
      api.post<Blob>("/voices/preview", {
        voice_id: v.voice_id,
        text: draft.greeting.slice(0, 300),
        model: v.model,
        speed: v.speed,
        stability: v.stability,
        similarity_boost: v.similarity_boost,
      }),
    onSuccess: (blob) => play("settings", URL.createObjectURL(blob)),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const list = (voices.data ?? []).filter((x) =>
    `${x.name} ${x.accent ?? ""} ${x.gender ?? ""} ${x.use_case ?? ""}`.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      <div className="lg:col-span-3">
        <Section title="Voice" description="Your ElevenLabs library" icon={AudioLines} tone="violet" actions={<Pill tone="blue">{v.voice_name}</Pill>}>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search voices" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {voices.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : voices.isError ? (
            <p className="text-sm text-destructive">{errorMessage(voices.error)}</p>
          ) : (
            <ScrollArea className="h-[440px] pr-3">
              <div className="space-y-1">
                {list.map((x) => {
                  const selected = x.voice_id === v.voice_id;
                  return (
                    <div
                      key={x.voice_id}
                      role="button"
                      onClick={() => patch("voice", { voice_id: x.voice_id, voice_name: x.name.split(" - ")[0] })}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                        selected ? "border-primary/40 bg-primary/[0.06]" : "border-transparent hover:bg-muted/60",
                      )}
                    >
                      <button
                        type="button"
                        disabled={!x.preview_url}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (x.preview_url) play(x.voice_id, x.preview_url);
                        }}
                        className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-background hover:bg-muted disabled:opacity-40"
                      >
                        {playing === x.voice_id ? <Pause className="size-3.5" /> : <Play className="ml-0.5 size-3.5" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium">{x.name}</div>
                        <div className="truncate text-xs capitalize text-muted-foreground">
                          {[x.gender, x.accent, x.age, x.use_case?.replaceAll("_", " ")].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      {x.category === "professional" && <Pill tone="blue">Professional</Pill>}
                      {selected && <Check className="size-4 text-primary" />}
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </Section>
      </div>

      <div className="space-y-5 lg:col-span-2">
        <Section title="Model" description="Flash is fastest for calls" icon={Zap} tone="amber">
          <Select value={v.model} onValueChange={(m) => patch("voice", { model: m })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(meta?.tts_models ?? []).map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name} <span className="text-xs text-muted-foreground">{m.description}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>
        <Section title="Voice settings" icon={SlidersHorizontal} tone="indigo">
          <SliderField
            label="Speed"
            value={v.speed}
            min={0.7}
            max={1.2}
            step={0.01}
            left="Slower"
            right="Faster"
            format={(x) => `${x.toFixed(2)}×`}
            onChange={(x) => patch("voice", { speed: x })}
          />
          <SliderField
            label="Stability"
            value={v.stability}
            min={0}
            max={1}
            step={0.01}
            left="More expressive"
            right="More consistent"
            onChange={(x) => patch("voice", { stability: x })}
          />
          <SliderField
            label="Similarity"
            value={v.similarity_boost}
            min={0}
            max={1}
            step={0.01}
            left="Low"
            right="High"
            onChange={(x) => patch("voice", { similarity_boost: x })}
          />
          <Field label="Hear it" hint="Plays the first message with these settings.">
            <Button variant="outline" className="w-full" onClick={() => (playing === "settings" ? play("settings", "") : preview.mutate())} disabled={preview.isPending}>
              {preview.isPending ? <Loader2 className="animate-spin" /> : playing === "settings" ? <Pause /> : <Volume2 />}
              {preview.isPending ? "Generating…" : playing === "settings" ? "Stop" : "Preview first message"}
            </Button>
          </Field>
        </Section>
      </div>
    </div>
  );
}
