"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Laptop, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Page, PageHeader, Pill, Section } from "@/components/common";
import { PasswordHint } from "@/components/auth-shell";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useMe, type User } from "@/lib/auth";
import { timeAgo } from "@/lib/format";

type SessionRow = { id: string; created_at: string; last_seen_at: string; ip: string | null; user_agent: string | null; current: boolean };

function device(ua: string | null) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : /curl/.test(ua) ? "curl" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export default function AccountPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data: me } = useMe();
  const user = me?.user;
  const required = !!user?.must_change_password;
  const [name, setName] = useState<string | null>(null);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwErrors, setPwErrors] = useState<Record<string, string>>({});
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<SessionRow[]>("/account/sessions") });

  const saveName = useMutation({
    mutationFn: () => api.put<{ user: User }>("/account", { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      setName(null);
      toast.success("Profile updated");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const changePw = useMutation({
    mutationFn: () => {
      if (pw.next !== pw.confirm) throw new ApiError(422, "", [{ field: "confirm", message: "Passwords don't match." }]);
      return api.post<{ other_sessions_signed_out: number }>("/account/password", { current_password: pw.current, new_password: pw.next });
    },
    onSuccess: async (r) => {
      setPw({ current: "", next: "", confirm: "" });
      setPwErrors({});
      await qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["sessions"] });
      toast.success("Password changed", { description: r.other_sessions_signed_out ? `Signed out ${r.other_sessions_signed_out} other session(s).` : undefined });
      if (required) router.replace("/");
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields.length) setPwErrors(Object.fromEntries(e.fields.map((f) => [f.field === "new_password" ? "next" : f.field === "current_password" ? "current" : f.field, f.message])));
      else toast.error(errorMessage(e));
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/account/sessions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sessions"] }),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.post<{ signed_out: number }>("/account/sessions/revoke-others"),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      toast.success(`Signed out ${r.signed_out} other session(s)`);
    },
  });

  if (!user) return null;
  return (
    <Page className="max-w-3xl">
      <PageHeader title="Account" description="Your profile, password and signed-in devices." />
      {required && (
        <div className="mb-6 flex items-start gap-3 rounded-lg bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
          <KeyRound className="mt-0.5 size-4 shrink-0" />
          <span>Your admin set a temporary password. Choose a new one to continue.</span>
        </div>
      )}

      {!required && (
        <Section title="Profile">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <Input value={name ?? user.name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email" hint="Ask an admin to change it.">
              <Input value={user.email} disabled />
            </Field>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-muted-foreground">
              Role: <span className="font-medium capitalize text-foreground">{user.role}</span>
            </span>
            <Button onClick={() => saveName.mutate()} disabled={name === null || !name.trim() || name === user.name || saveName.isPending}>
              Save
            </Button>
          </div>
        </Section>
      )}

      <Section title="Password" description={required ? undefined : "You'll stay signed in here; other devices are signed out."}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            changePw.mutate();
          }}
        >
          <Field label={required ? "Temporary password" : "Current password"} error={pwErrors.current}>
            <Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="New password" error={pwErrors.next}>
              <Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </Field>
            <Field label="Confirm new password" error={pwErrors.confirm}>
              <Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </Field>
          </div>
          <div className="flex items-center justify-between">
            <PasswordHint />
            <Button type="submit" disabled={!pw.current || !pw.next || !pw.confirm || changePw.isPending}>
              {changePw.isPending && <Loader2 className="animate-spin" />} Change password
            </Button>
          </div>
        </form>
      </Section>

      {!required && (
        <Section
          title="Sessions"
          description="Devices signed in to your account."
          actions={
            (sessions.data?.length ?? 0) > 1 && (
              <Button variant="outline" size="sm" onClick={() => revokeOthers.mutate()}>
                Sign out other devices
              </Button>
            )
          }
        >
          <div className="divide-y rounded-lg border">
            {sessions.data?.map((s) => (
              <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                <Laptop className="size-4 text-muted-foreground" strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    {device(s.user_agent)}
                    {s.current && <Pill tone="green">This device</Pill>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {s.ip ?? "Unknown IP"} · active {timeAgo(s.last_seen_at)} · signed in {timeAgo(s.created_at)}
                  </div>
                </div>
                {!s.current && (
                  <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)}>
                    Sign out
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}
    </Page>
  );
}
