"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type Role = "admin" | "user";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "invited" | "disabled";
  must_change_password: boolean;
  last_login_at: string | null;
  created_at: string | null;
  created_by: string | null;
  locked: boolean;
}

export interface Me {
  authenticated: boolean;
  user: User | null;
  needs_setup: boolean;
  workspace: string;
  email_configured: boolean;
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/auth/me"), staleTime: 60_000 });
}

export function useIsAdmin() {
  const { data } = useMe();
  return data?.user?.role === "admin";
}

export function initials(name: string | undefined) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
