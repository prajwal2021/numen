"use client";

import { AudioLines } from "lucide-react";

/** Centered card used by sign-in, setup, forgot and reset password pages. */
export function AuthShell({ title, description, children, footer }: { title: string; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-4 py-12">
      <div className="mb-8 flex items-center gap-2">
        <div className="flex size-7 items-center justify-center rounded-md bg-foreground text-background">
          <AudioLines className="size-4" />
        </div>
        <span className="text-lg font-semibold tracking-tight">Numen</span>
      </div>
      <div className="w-full max-w-[400px] rounded-xl border bg-background p-8 shadow-[0_1px_3px_rgba(0,0,0,0.05)]">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1.5 text-[13.5px] text-muted-foreground">{description}</p>}
        <div className="mt-6">{children}</div>
      </div>
      {footer && <div className="mt-6 text-[13px] text-muted-foreground">{footer}</div>}
    </div>
  );
}

export function PasswordHint() {
  return <p className="text-xs text-muted-foreground">At least 10 characters, mixing letters with numbers or symbols.</p>;
}
