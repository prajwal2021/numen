"use client";

import Link from "next/link";
import { useState } from "react";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "@/components/auth-shell";
import { api, errorMessage } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/auth/forgot", { email });
      setSent(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <AuthShell title="Check your email" footer={<Link href="/login" className="hover:text-foreground">Back to sign in</Link>}>
        <div className="flex gap-3 text-[13.5px] text-muted-foreground">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-foreground" />
          <p>
            If an account exists for <span className="font-medium text-foreground">{email}</span>, we&apos;ve sent a link to reset the password. It
            expires in 1 hour. No email? Ask your admin for a reset link.
          </p>
        </div>
      </AuthShell>
    );

  return (
    <AuthShell
      title="Reset your password"
      description="Enter your email and we'll send you a link to choose a new password."
      footer={<Link href="/login" className="hover:text-foreground">Back to sign in</Link>}
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <Button type="submit" size="lg" className="w-full" disabled={busy || !email}>
          {busy ? "Sending…" : "Send reset link"}
        </Button>
      </form>
    </AuthShell>
  );
}
