"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell, PasswordHint } from "@/components/auth-shell";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useMe } from "@/lib/auth";

export default function SetupPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (me && !me.needs_setup) router.replace(me.authenticated ? "/" : "/login");
  }, [me, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) return setErrors({ confirm: "Passwords don't match." });
    setBusy(true);
    setErrors({});
    try {
      await api.post("/auth/setup", { name: form.name, email: form.email, password: form.password });
      await qc.invalidateQueries({ queryKey: ["me"] });
      router.replace("/");
    } catch (err) {
      setErrors(err instanceof ApiError && err.fields.length ? Object.fromEntries(err.fields.map((f) => [f.field, f.message])) : { form: errorMessage(err) });
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  return (
    <AuthShell title="Create your admin account" description="This is the first account on this workspace. You can invite your team next.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name">Full name</Label>
          <Input id="name" autoFocus autoComplete="name" value={form.name} onChange={set("name")} />
          {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Work email</Label>
          <Input id="email" type="email" autoComplete="email" value={form.email} onChange={set("email")} />
          {errors.email && <p className="text-xs text-destructive">{errors.email}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} />
          {errors.password ? <p className="text-xs text-destructive">{errors.password}</p> : <PasswordHint />}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input id="confirm" type="password" autoComplete="new-password" value={form.confirm} onChange={set("confirm")} />
          {errors.confirm && <p className="text-xs text-destructive">{errors.confirm}</p>}
        </div>
        {errors.form && <p className="text-[13px] text-destructive">{errors.form}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={busy || !form.name || !form.email || !form.password}>
          {busy ? "Creating…" : "Create account"}
        </Button>
      </form>
    </AuthShell>
  );
}
