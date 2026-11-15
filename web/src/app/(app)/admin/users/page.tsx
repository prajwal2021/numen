"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CircleCheck, KeyRound, Link2, Lock, LogOut, MoreHorizontal, Search, Trash2, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PasswordHint } from "@/components/auth-shell";
import { CopyButton, EmptyState, Field, Page, PageHeader, Pill } from "@/components/common";
import { api, ApiError, errorMessage } from "@/lib/api";
import { initials, useMe, type Role, type User } from "@/lib/auth";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

type LinkResult = { link: string; purpose: "reset" | "invite"; emailed: boolean; email_error: string | null; expires_in_hours?: number };

function StatusPill({ u }: { u: User }) {
  if (u.locked) return <Pill tone="red">Locked</Pill>;
  if (u.status === "disabled") return <Pill tone="gray">Disabled</Pill>;
  if (u.status === "invited") return <Pill tone="blue">Invited</Pill>;
  if (u.must_change_password) return <Pill tone="amber">Must change password</Pill>;
  return <Pill tone="green">Active</Pill>;
}

function LinkDialog({ result, email, onClose }: { result: LinkResult | null; email: string; onClose: () => void }) {
  return (
    <Dialog open={!!result} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="min-w-0 sm:max-w-lg [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>{result?.purpose === "invite" ? "Invite link" : "Password reset link"}</DialogTitle>
          <DialogDescription>
            {result?.emailed
              ? `Emailed to ${email}. You can also share this link directly.`
              : `${result?.email_error ?? "Email not sent."} Share this link with ${email} yourself.`}{" "}
            It works once and expires in {result?.expires_in_hours ?? (result?.purpose === "invite" ? 72 : 1)} hour(s).
          </DialogDescription>
        </DialogHeader>
        <div className="flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border bg-muted/40 px-3 py-2" data-audit-ignore>
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{result?.link}</code>
          {result && <CopyButton value={result.link} />}
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteDialog({ open, onOpenChange, onLink }: { open: boolean; onOpenChange: (v: boolean) => void; onLink: (r: LinkResult, email: string) => void }) {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const empty = { name: "", email: "", role: "user" as Role, mode: (me?.email_configured ? "invite" : "invite") as "invite" | "password", password: "" };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: () => api.post<{ user: User; invite_link: string | null; emailed: boolean; email_error: string | null }>("/users", { ...form, password: form.mode === "password" ? form.password : null }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["users"] });
      onOpenChange(false);
      setForm(empty);
      setErrors({});
      if (r.invite_link) onLink({ link: r.invite_link, purpose: "invite", emailed: r.emailed, email_error: r.email_error, expires_in_hours: 72 }, r.user.email);
      else toast.success(`Added ${r.user.name}`, { description: "Share the temporary password with them. They'll choose a new one at first sign-in." });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields.length) setErrors(Object.fromEntries(e.fields.map((f) => [f.field, f.message])));
      else setErrors({ form: errorMessage(e) });
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a user</DialogTitle>
          <DialogDescription>They&apos;ll get access to this workspace.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" error={errors.name}>
              <Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Role">
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as Role })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Email" error={errors.email}>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["invite", "Send an invite link", "They set their own password."],
                ["password", "Set a temporary password", "They change it at first sign-in."],
              ] as const
            ).map(([v, title, desc]) => (
              <button
                key={v}
                type="button"
                onClick={() => setForm({ ...form, mode: v })}
                className={cn("rounded-lg border p-3 text-left transition-colors", form.mode === v ? "border-foreground ring-1 ring-foreground" : "hover:border-foreground/30")}
              >
                <div className="text-[13px] font-medium">{title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>
              </button>
            ))}
          </div>
          {form.mode === "password" && (
            <Field label="Temporary password" error={errors.password}>
              <Input type="text" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} data-audit-ignore />
              {!errors.password && <PasswordHint />}
            </Field>
          )}
          {form.mode === "invite" && !me?.email_configured && (
            <p className="text-xs text-muted-foreground">Email isn&apos;t set up yet, so you&apos;ll get a link to share yourself.</p>
          )}
          {errors.form && <p className="text-[13px] text-destructive">{errors.form}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!form.name || !form.email || create.isPending}>
              {form.mode === "invite" ? "Send invite" : "Add user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function UsersPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/users") });
  const [q, setQ] = useState("");
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<{ r: LinkResult; email: string } | null>(null);
  const [confirm, setConfirm] = useState<{ user: User; kind: "delete" | "disable" } | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: Role; status?: "active" | "disabled" }) => api.put(`/users/${id}`, body),
    onSuccess: () => {
      refresh();
      toast.success("User updated");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/users/${id}`),
    onSuccess: () => {
      refresh();
      toast.success("User deleted");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const passwordLink = useMutation({
    mutationFn: (u: User) => api.post<LinkResult>(`/users/${u.id}/password-link`).then((r) => ({ r, email: u.email })),
    onSuccess: (x) => setLink(x),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const signOut = useMutation({
    mutationFn: (id: string) => api.post<{ signed_out: number }>(`/users/${id}/sign-out`),
    onSuccess: (r) => toast.success(`Signed out of ${r.signed_out} session(s)`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const unlock = useMutation({
    mutationFn: (id: string) => api.post(`/users/${id}/unlock`),
    onSuccess: () => {
      refresh();
      toast.success("Unlocked");
    },
  });

  const rows = (users.data ?? []).filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));
  const admins = users.data?.filter((u) => u.role === "admin").length ?? 0;

  return (
    <Page>
      <PageHeader
        title="Users"
        description={`${users.data?.length ?? 0} members · ${admins} admin${admins === 1 ? "" : "s"}`}
        actions={
          <Button onClick={() => setInviting(true)}>
            <UserPlus /> Invite user
          </Button>
        }
      />
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <p className="text-xs text-muted-foreground">Admins manage users, settings and audit logs. Users build and test agents.</p>
      </div>
      {users.isLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : !rows.length ? (
        <EmptyState icon={Users} title="No users found" />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="pl-4">User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last sign-in</TableHead>
                <TableHead className="pr-4 text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((u) => {
                const self = u.id === me?.user?.id;
                return (
                  <TableRow key={u.id}>
                    <TableCell className="py-3 pl-4">
                      <div className="flex items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-xs font-medium text-neutral-700">
                          {initials(u.name)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-[13.5px] font-medium">
                            {u.name}
                            {self && <span className="text-xs font-normal text-muted-foreground">(you)</span>}
                          </div>
                          <div className="text-xs text-muted-foreground">{u.email}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select value={u.role} disabled={self} onValueChange={(v) => update.mutate({ id: u.id, role: v as Role })}>
                        <SelectTrigger className="h-8 w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="user">User</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <StatusPill u={u} />
                    </TableCell>
                    <TableCell className="text-[13px] text-muted-foreground">{u.last_login_at ? timeAgo(u.last_login_at) : "Never"}</TableCell>
                    <TableCell className="pr-4 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" data-audit={`User actions for ${u.email}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          {u.status !== "disabled" && (
                            <DropdownMenuItem onClick={() => passwordLink.mutate(u)}>
                              {u.status === "invited" ? <Link2 /> : <KeyRound />}
                              {u.status === "invited" ? "Resend invite link" : "Send password reset link"}
                            </DropdownMenuItem>
                          )}
                          {u.locked && (
                            <DropdownMenuItem onClick={() => unlock.mutate(u.id)}>
                              <Lock /> Unlock account
                            </DropdownMenuItem>
                          )}
                          {u.status === "active" && (
                            <DropdownMenuItem onClick={() => signOut.mutate(u.id)}>
                              <LogOut /> Sign out everywhere
                            </DropdownMenuItem>
                          )}
                          {!self && (
                            <>
                              <DropdownMenuSeparator />
                              {u.status === "disabled" ? (
                                <DropdownMenuItem onClick={() => update.mutate({ id: u.id, status: "active" })}>
                                  <CircleCheck /> Enable
                                </DropdownMenuItem>
                              ) : (
                                u.status === "active" && (
                                  <DropdownMenuItem onClick={() => setConfirm({ user: u, kind: "disable" })}>
                                    <Ban /> Disable
                                  </DropdownMenuItem>
                                )
                              )}
                              <DropdownMenuItem variant="destructive" onClick={() => setConfirm({ user: u, kind: "delete" })}>
                                <Trash2 /> Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <InviteDialog open={inviting} onOpenChange={setInviting} onLink={(r, email) => setLink({ r, email })} />
      <LinkDialog result={link?.r ?? null} email={link?.email ?? ""} onClose={() => setLink(null)} />
      <AlertDialog open={!!confirm} onOpenChange={(v) => !v && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "delete" ? `Delete ${confirm.user.name}?` : `Disable ${confirm?.user.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "delete"
                ? "Their account is removed permanently and they're signed out everywhere. Their past activity stays in the audit logs."
                : "They're signed out everywhere and can't sign in until you enable them again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirm?.kind === "delete" ? "bg-destructive text-white hover:bg-destructive/90" : ""}
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "delete") remove.mutate(confirm.user.id);
                else update.mutate({ id: confirm.user.id, status: "disabled" });
                setConfirm(null);
              }}
            >
              {confirm?.kind === "delete" ? "Delete user" : "Disable user"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}
