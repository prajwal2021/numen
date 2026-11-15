"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, Bot, CheckCircle2, Globe, Loader2, Phone, Radar, Settings as SettingsIcon, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyButton, Field, Mono, Page, PageHeader, Pill, Section } from "@/components/common";
import { api, errorMessage } from "@/lib/api";
import type { SecretStatus, Settings } from "@/lib/types";

type Check = { ok: boolean; detail: string };

function SecretInput({ status, value, onChange, placeholder }: { status?: SecretStatus; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="space-y-1.5">
      <Input type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder={status?.set ? `Saved (${status.hint}). Type to replace.` : placeholder} />
      {status?.set && status.source === "env" && <p className="text-xs text-muted-foreground">From the server&apos;s .env file. Saving here overrides it.</p>}
    </div>
  );
}

function CheckButton({ provider }: { provider: "twilio" | "elevenlabs" | "openai" }) {
  const check = useMutation({ mutationFn: () => api.post<Check>(`/settings/check/${provider}`) });
  return (
    <div className="flex items-center gap-2">
      {check.data && (
        <span className={`inline-flex items-center gap-1 text-xs ${check.data.ok ? "text-emerald-700" : "text-destructive"}`}>
          {check.data.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
          {check.data.detail}
        </span>
      )}
      <Button variant="outline" size="sm" onClick={() => check.mutate()} disabled={check.isPending}>
        {check.isPending && <Loader2 className="animate-spin" />} Test
      </Button>
    </div>
  );
}

function TestEmail({ disabled }: { disabled: boolean }) {
  const [to, setTo] = useState("");
  const send = useMutation({ mutationFn: () => api.post<Check>("/settings/test-email", { to }) });
  return (
    <div className="flex items-center gap-2">
      <Input className="w-72" type="email" placeholder="Send a test email to…" value={to} onChange={(e) => setTo(e.target.value)} />
      <Button variant="outline" onClick={() => send.mutate()} disabled={disabled || !to || send.isPending}>
        {send.isPending && <Loader2 className="animate-spin" />} Send test
      </Button>
      {send.data && (
        <span className={`inline-flex items-center gap-1 text-xs ${send.data.ok ? "text-emerald-700" : "text-destructive"}`}>
          {send.data.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
          {send.data.detail}
        </span>
      )}
      {disabled && !send.data && <span className="text-xs text-muted-foreground">Save first</span>}
    </div>
  );
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<Settings>("/settings") });
  const [edits, setEdits] = useState<Settings | null>(null);
  const form = edits ?? data ?? null;

  const save = useMutation({
    mutationFn: () => api.put<Settings>("/settings", form),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s);
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["phone-numbers"] });
      qc.invalidateQueries({ queryKey: ["meta"] });
      setEdits(null);
      toast.success("Settings saved");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const detect = useMutation({
    mutationFn: () => api.get<{ url: string | null }>("/settings/detect-public-url"),
    onSuccess: (r) => {
      if (r.url) {
        setEdits((f) => {
          const base = f ?? (qc.getQueryData(["settings"]) as Settings | undefined);
          return base ? { ...base, public_base_url: r.url! } : f;
        });
        toast.success(`Found ${r.url}`);
      } else toast.error("No ngrok tunnel found on this machine.");
    },
  });

  if (!form) return <Page><Skeleton className="h-96 rounded-xl" /></Page>;
  const set = (p: Partial<Settings>) => setEdits({ ...form, ...p });
  const dirty = JSON.stringify(form) !== JSON.stringify(data);

  return (
    <Page className="max-w-3xl">
      <PageHeader
        icon={SettingsIcon}
        tone="slate"
        title="Settings"
        description="Workspace, server address and provider keys."
        actions={
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />} Save changes
          </Button>
        }
      />
      <div className="space-y-5">
        <Section title="General" icon={Globe} tone="indigo">
          <Field label="Workspace name">
            <Input value={form.workspace_name} onChange={(e) => set({ workspace_name: e.target.value })} />
          </Field>
          <Field
            label="Public URL"
            hint="Where Twilio reaches this server, e.g. your ngrok URL."
            aside={
              <Button variant="ghost" size="xs" onClick={() => detect.mutate()} disabled={detect.isPending}>
                <Radar /> Detect ngrok
              </Button>
            }
          >
            <Input className="font-mono text-[13px]" placeholder="https://your-tunnel.ngrok-free.dev" value={form.public_base_url} onChange={(e) => set({ public_base_url: e.target.value })} />
          </Field>
          {data?.webhook_url && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              Voice webhook: <Mono>{data.webhook_url}</Mono>
              <CopyButton value={data.webhook_url} />
            </div>
          )}
        </Section>

        <Section title="Twilio" description="Numbers and transfers" icon={Phone} tone="rose" actions={<CheckButton provider="twilio" />}>
          <Field label="Account SID">
            <Input className="font-mono text-[13px]" value={form.twilio_account_sid} onChange={(e) => set({ twilio_account_sid: e.target.value })} placeholder="AC…" />
          </Field>
          <Field label="Auth token">
            <SecretInput status={data?.twilio_auth_token_status} value={form.twilio_auth_token} onChange={(v) => set({ twilio_auth_token: v })} />
          </Field>
        </Section>

        <Section title="ElevenLabs" description="Speech-to-text and voices" icon={AudioLines} tone="violet" actions={<CheckButton provider="elevenlabs" />}>
          <Field label="API key">
            <SecretInput status={data?.elevenlabs_api_key_status} value={form.elevenlabs_api_key} onChange={(v) => set({ elevenlabs_api_key: v })} />
          </Field>
        </Section>

        <Section title="OpenAI" description="Runs each conversation" icon={Bot} tone="emerald" actions={<CheckButton provider="openai" />}>
          <Field label="API key">
            <SecretInput status={data?.openai_api_key_status} value={form.openai_api_key} onChange={(v) => set({ openai_api_key: v })} placeholder="sk-…" />
          </Field>
        </Section>

        <Section
          title="Email"
          description="Sends password resets and invites. Without it, admins share links from Users."
          actions={data?.email_configured ? <Pill tone="green">Set up</Pill> : <Pill tone="gray">Not set up</Pill>}
        >
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <Field label="SMTP server">
                <Input placeholder="smtp.office365.com" value={form.smtp_host} onChange={(e) => set({ smtp_host: e.target.value })} />
              </Field>
            </div>
            <Field label="Port">
              <Input type="number" value={form.smtp_port} onChange={(e) => set({ smtp_port: Number(e.target.value) })} />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <Field label="Security">
              <Select value={form.smtp_security} onValueChange={(v) => set({ smtp_security: v as Settings["smtp_security"] })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starttls">STARTTLS (587)</SelectItem>
                  <SelectItem value="ssl">SSL/TLS (465)</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Username">
              <Input autoComplete="off" value={form.smtp_username} onChange={(e) => set({ smtp_username: e.target.value })} />
            </Field>
            <Field label="Password">
              <SecretInput status={data?.smtp_password_status} value={form.smtp_password} onChange={(v) => set({ smtp_password: v })} />
            </Field>
          </div>
          <Field label="From address" hint="e.g. Numen <no-reply@yourdomain.edu>">
            <Input value={form.smtp_from} onChange={(e) => set({ smtp_from: e.target.value })} />
          </Field>
          <Field label="Web app address" hint="Used in reset and invite links.">
            <Input className="font-mono text-[13px]" value={form.app_base_url} onChange={(e) => set({ app_base_url: e.target.value })} />
          </Field>
          <TestEmail disabled={dirty || !data?.email_configured} />
        </Section>

        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Pill tone="gray">Note</Pill> Keys and passwords are stored in PostgreSQL and never shown again.
        </p>
      </div>
    </Page>
  );
}
