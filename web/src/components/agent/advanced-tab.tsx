"use client";

import { AudioWaveform, PhoneIncoming } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Section, ToggleRow } from "@/components/common";
import type { Agent } from "@/lib/types";
import type { Patch } from "./use-agent-draft";

export function AdvancedTab({ draft, patch }: { draft: Agent; patch: Patch }) {
  const c = draft.conversation;
  return (
    <div className="space-y-5">
      <Section title="Answering" icon={PhoneIncoming} tone="emerald">
        <div className="space-y-2.5">
          <div className="flex items-baseline justify-between">
            <div className="text-[13px] font-medium">Ring before answering</div>
            <div className="font-mono text-xs tabular-nums text-muted-foreground">{c.ring_seconds}s</div>
          </div>
          <Slider value={[c.ring_seconds]} min={0} max={10} step={1} onValueChange={([v]) => patch("conversation", { ring_seconds: v })} />
          <p className="text-xs text-muted-foreground">Ringing before pickup (max 10s).</p>
        </div>
      </Section>

      <Section title="Turn-taking" description="Stops line echo from interrupting the agent" icon={AudioWaveform} tone="violet">
        <ToggleRow
          title="Protect the first message"
          description="The caller can't interrupt it. Recommended."
          control={<Switch checked={c.mute_during_greeting} onCheckedChange={(v) => patch("conversation", { mute_during_greeting: v })} />}
        />
        <div className="space-y-2.5">
          <div className="flex items-baseline justify-between">
            <div className="text-[13px] font-medium">Words needed to interrupt the agent</div>
            <div className="font-mono text-xs tabular-nums text-muted-foreground">{c.min_words_to_interrupt}</div>
          </div>
          <Slider value={[c.min_words_to_interrupt]} min={1} max={6} step={1} onValueChange={([v]) => patch("conversation", { min_words_to_interrupt: v })} />
          <p className="text-xs text-muted-foreground">While the agent talks. Default 3.</p>
        </div>
      </Section>
    </div>
  );
}
