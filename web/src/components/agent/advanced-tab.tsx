"use client";

import { useState } from "react";
import { AudioWaveform, Ear, LifeBuoy, PhoneIncoming, PhoneOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Field, Section, ToggleRow } from "@/components/common";
import type { Agent } from "@/lib/types";
import type { Patch } from "./use-agent-draft";

const FILTERS: { value: Agent["conversation"]["background_voice_filter"]; label: string; hint: string }[] = [
  { value: "standard", label: "Standard", hint: "Ignores quieter voices in the background (TV, people nearby). Recommended." },
  { value: "strong", label: "Strong", hint: "For noisy places. Callers need to speak clearly into the phone." },
  { value: "off", label: "Off", hint: "Reacts to any speech the line picks up, however quiet." },
];

const LANGUAGES: { value: Agent["conversation"]["caller_language"]; label: string; hint: string }[] = [
  { value: "en", label: "English", hint: "Most accurate for English callers. Recommended." },
  { value: "es", label: "Spanish", hint: "Pair with a multilingual voice model (Voice tab)." },
  { value: "auto", label: "Detect automatically", hint: "Any language, but English on a phone line is sometimes misheard as another language. Pair with a multilingual voice model." },
];

export function AdvancedTab({ draft, patch }: { draft: Agent; patch: Patch }) {
  const c = draft.conversation;
  const sf = draft.safety;
  const filter = FILTERS.find((f) => f.value === c.background_voice_filter) ?? FILTERS[0];
  const language = LANGUAGES.find((l) => l.value === c.caller_language) ?? LANGUAGES[0];
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

      <Section title="Listening" description="How the agent hears callers" icon={Ear} tone="sky">
        <Field label="Caller language" hint={language.hint}>
          <Select value={c.caller_language} onValueChange={(v) => patch("conversation", { caller_language: v as Agent["conversation"]["caller_language"] })}>
            <SelectTrigger className="w-full sm:w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Key terms" hint="Names and terms to listen for, separated by commas, e.g. Career Learning Academy, MicroCertificate.">
          <KeytermsInput value={c.keyterms} onChange={(keyterms) => patch("conversation", { keyterms })} />
        </Field>
      </Section>

      <Section title="Turn-taking" description="Keeps echo and background noise from interrupting the agent" icon={AudioWaveform} tone="violet">
        <ToggleRow
          title="Protect the first message"
          description="The caller can't interrupt it. Recommended."
          control={<Switch checked={c.mute_during_greeting} onCheckedChange={(v) => patch("conversation", { mute_during_greeting: v })} />}
        />
        <Field label="Background voice filter" hint={filter.hint}>
          <Select
            value={c.background_voice_filter}
            onValueChange={(v) => patch("conversation", { background_voice_filter: v as Agent["conversation"]["background_voice_filter"] })}
          >
            <SelectTrigger className="w-full sm:w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTERS.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="space-y-2.5">
          <div className="flex items-baseline justify-between">
            <div className="text-[13px] font-medium">Words needed to interrupt the agent</div>
            <div className="font-mono text-xs tabular-nums text-muted-foreground">{c.min_words_to_interrupt}</div>
          </div>
          <Slider value={[c.min_words_to_interrupt]} min={1} max={6} step={1} onValueChange={([v]) => patch("conversation", { min_words_to_interrupt: v })} />
          <p className="text-xs text-muted-foreground">While the agent talks. Default 3.</p>
        </div>
      </Section>

      <Section title="Ending the call" icon={PhoneOff} tone="rose">
        <ToggleRow
          title="Hang up when the caller is done"
          description={"When the caller says \"thank you\", \"that's all\" or goodbye, the agent says goodbye and ends the call."}
          control={<Switch checked={c.end_call_enabled} onCheckedChange={(v) => patch("conversation", { end_call_enabled: v })} />}
        />
        {c.end_call_enabled && (
          <Field label="Goodbye" hint="Said word for word before hanging up. Leave empty to hang up without it.">
            <Input value={c.goodbye_message} onChange={(e) => patch("conversation", { goodbye_message: e.target.value })} />
          </Field>
        )}
      </Section>

      <Section title="Safety" description="Callers in danger or crisis" icon={LifeBuoy} tone="amber">
        <ToggleRow
          title="Point callers to emergency help"
          description="If a caller describes an emergency, or talks about suicide or hurting themselves, the agent says one of these messages right away. Recommended."
          control={<Switch checked={sf.enabled} onCheckedChange={(v) => patch("safety", { enabled: v })} />}
        />
        {sf.enabled && (
          <>
            <Field label="Emergency (someone hurt or in danger now)" hint="Said word for word. Spell numbers digit by digit, e.g. 9 1 1.">
              <Textarea rows={3} value={sf.emergency_message} onChange={(e) => patch("safety", { emergency_message: e.target.value })} />
            </Field>
            <Field label="Crisis (suicide, self-harm, severe distress)" hint="Said word for word. Add your campus counseling line here if you have one.">
              <Textarea rows={4} value={sf.crisis_message} onChange={(e) => patch("safety", { crisis_message: e.target.value })} />
            </Field>
          </>
        )}
      </Section>
    </div>
  );
}

/** Comma-separated terms, kept as typed while editing and parsed into a list. */
function KeytermsInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <Input
      value={text}
      placeholder="Career Learning Academy, MicroCertificate"
      onChange={(e) => {
        setText(e.target.value);
        onChange(e.target.value.split(",").map((t) => t.trim()).filter(Boolean));
      }}
    />
  );
}
