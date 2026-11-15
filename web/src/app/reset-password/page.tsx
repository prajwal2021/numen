"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell, PasswordHint } from "@/components/auth-shell";
import { api, ApiError, errorMessage } from "@/lib/api";

type TokenInfo = { valid: boolean; purpose?: "reset" | "invite"; email?: string; name?: string };

function ResetForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const router = useRouter();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["token", token], queryFn: () => api.get<TokenInfo>(`/auth/token/${encodeURIComponent(token)}`), enabled: !!token, retry: false });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    setError("");
    try {
      await api.post("/auth/reset", { token, password });
      await qc.invalidateQueries({ queryKey: ["me"] });
      router.replace("/");
    } catch (err) {
      setError(err instanceof ApiError && err.fields.length ? err.fields[0].message : errorMessage(err));
      setBusy(false);
    }
  }

  if (!token || info.data?.valid === false || info.isError)
    return (
      <AuthShell title="Link expired" description="This link is invalid, already used, or expired." footer={<Link href="/login" className="hover:text-foreground">Back to sign in</Link>}>
        <Button asChild className="w-full" size="lg">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </AuthShell>
    );
  if (!info.data) return <AuthShell title="Checking link…">{null}</AuthShell>;

  const invite = info.data.purpose === "invite";
  return (
    <AuthShell
      title={invite ? `Welcome, ${info.data.name?.split(" ")[0]}` : "Choose a new password"}
      description={invite ? `Set a password to finish creating your account (${info.data.email}).` : `For ${info.data.email}. You'll be signed out on other devices.`}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="password">New password</Label>
          <Input id="password" type="password" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <PasswordHint />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={busy || !password || !confirm}>
          {busy ? "Saving…" : invite ? "Create account" : "Reset password"}
        </Button>
      </form>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
