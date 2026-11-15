"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { AudioLines, BookOpen, Bot, ChevronsUpDown, House, LogOut, MessagesSquare, Phone, ScrollText, Settings, UserRound, Users } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { initials, useMe } from "@/lib/auth";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Home", icon: House },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/knowledge-bases", label: "Knowledge Base", icon: BookOpen },
  { href: "/phone-numbers", label: "Phone Numbers", icon: Phone },
  { href: "/conversations", label: "Conversations", icon: MessagesSquare },
];
const ADMIN_NAV = [
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/logs", label: "Audit logs", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: typeof House; active: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors",
        active ? "bg-black/[0.055] font-medium text-foreground" : "text-foreground/65 hover:bg-black/[0.035] hover:text-foreground",
      )}
    >
      <Icon className="size-4" strokeWidth={active ? 2 : 1.75} />
      {label}
    </Link>
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const user = me?.user;
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  const workspace = me?.workspace ?? "Numen";

  async function signOut() {
    await api.post("/auth/logout").catch(() => {});
    qc.clear();
    router.replace("/login");
  }

  return (
    <aside className="sticky top-0 flex h-screen w-[232px] shrink-0 flex-col border-r bg-sidebar">
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex size-6 items-center justify-center rounded-md bg-foreground text-background">
          <AudioLines className="size-3.5" />
        </div>
        <span className="text-[15px] font-semibold tracking-tight">Numen</span>
      </div>

      <div className="px-3 pb-3">
        <div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
          <div className="flex size-5 items-center justify-center rounded bg-neutral-200 text-[10px] font-semibold text-neutral-700">
            {workspace.slice(0, 1).toUpperCase()}
          </div>
          <span className="truncate text-[13px] font-medium">{workspace}</span>
        </div>
      </div>

      <nav className="flex-1 space-y-px overflow-y-auto px-3">
        {NAV.map((n) => (
          <NavLink key={n.href} {...n} active={active(n.href)} />
        ))}
        {user?.role === "admin" && (
          <>
            <div className="px-2.5 pb-1.5 pt-5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">Admin</div>
            {ADMIN_NAV.map((n) => (
              <NavLink key={n.href} {...n} active={active(n.href)} />
            ))}
          </>
        )}
      </nav>

      <div className="border-t p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-black/[0.04]" data-audit="Account menu">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-[11px] font-medium text-white">
                {initials(user?.name)}
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[13px] font-medium">{user?.name}</div>
                <div className="truncate text-[11.5px] text-muted-foreground">{user?.email}</div>
              </div>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-[216px]">
            <DropdownMenuLabel className="font-normal">
              <div className="text-[13px] font-medium">{user?.name}</div>
              <div className="text-xs capitalize text-muted-foreground">{user?.role}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/account">
                <UserRound /> Account
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={signOut}>
              <LogOut /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
