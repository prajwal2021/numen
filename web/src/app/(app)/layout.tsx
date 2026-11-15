"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { ActivityTracker } from "@/components/activity-tracker";
import { AppSidebar } from "@/components/app-sidebar";
import { Button } from "@/components/ui/button";
import { useMe } from "@/lib/auth";

const ADMIN_ONLY = ["/admin", "/settings"];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const { data: me, isLoading } = useMe();

  useEffect(() => {
    const onUnauthorized = () => {
      qc.invalidateQueries({ queryKey: ["me"] });
      router.replace("/login");
    };
    window.addEventListener("numen:unauthorized", onUnauthorized);
    return () => window.removeEventListener("numen:unauthorized", onUnauthorized);
  }, [router, qc]);

  useEffect(() => {
    if (!me) return;
    if (me.needs_setup) router.replace("/setup");
    else if (!me.authenticated) router.replace("/login");
    else if (me.user?.must_change_password && pathname !== "/account") router.replace("/account?required=1");
  }, [me, pathname, router]);

  if (isLoading || !me?.authenticated || !me.user) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  const blocked = me.user.role !== "admin" && ADMIN_ONLY.some((p) => pathname.startsWith(p));
  return (
    <div className="flex min-h-screen">
      <ActivityTracker />
      <AppSidebar />
      <main className="min-w-0 flex-1">
        {blocked ? (
          <div className="flex h-[70vh] flex-col items-center justify-center text-center">
            <ShieldAlert className="mb-3 size-8 text-muted-foreground" strokeWidth={1.5} />
            <h1 className="text-lg font-semibold">Admins only</h1>
            <p className="mt-1 text-sm text-muted-foreground">Ask an admin if you need access to this page.</p>
            <Button asChild variant="outline" className="mt-4">
              <Link href="/">Go home</Link>
            </Button>
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
