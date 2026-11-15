"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Records page views and clicks for the admin Audit logs panel.
 * Captures what was clicked (its visible label) and where, never what was typed.
 * Elements inside [data-audit-ignore] are skipped. Events are batched and flushed every
 * few seconds and when the tab is hidden.
 */
type Ev = { type: "click" | "page_view"; action: string; target?: string; path: string; at: string; meta?: Record<string, unknown> };

const ACTIONABLE =
  'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], input[type="checkbox"], input[type="radio"], input[type="submit"], summary, label, [data-audit]';

function describe(el: Element): { label: string; kind: string; href?: string } {
  const kind = el.getAttribute("role") || el.tagName.toLowerCase();
  const explicit = el.getAttribute("data-audit") || el.getAttribute("aria-label") || el.getAttribute("title");
  let label = explicit || (el as HTMLElement).innerText || el.textContent || "";
  label = label.replace(/\s+/g, " ").trim();
  if (!label) {
    const icon = el.querySelector("svg[class*='lucide']");
    const cls = icon?.getAttribute("class")?.match(/lucide-([a-z0-9-]+)/)?.[1];
    label = cls ? `${cls} icon` : kind;
  }
  if (label.length > 80) label = `${label.slice(0, 77)}…`;
  const href = el instanceof HTMLAnchorElement ? el.getAttribute("href") ?? undefined : undefined;
  return { label, kind, href };
}

const PAGES: [RegExp, string][] = [
  [/^\/$/, "Home"],
  [/^\/agents\/[^/]+/, "Agent editor"],
  [/^\/agents/, "Agents"],
  [/^\/knowledge-bases\/[^/]+/, "Knowledge base"],
  [/^\/knowledge-bases/, "Knowledge Base"],
  [/^\/phone-numbers/, "Phone Numbers"],
  [/^\/conversations\/[^/]+/, "Conversation"],
  [/^\/conversations/, "Conversations"],
  [/^\/settings/, "Settings"],
  [/^\/account/, "Account"],
  [/^\/admin\/users/, "Users"],
  [/^\/admin\/logs/, "Audit logs"],
];

function pageName(pathname: string) {
  return PAGES.find(([re]) => re.test(pathname))?.[1] ?? pathname;
}

function send(events: Ev[], beacon = false) {
  if (!events.length) return;
  const body = JSON.stringify({ events });
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/audit/events", new Blob([body], { type: "application/json" }));
    return;
  }
  fetch("/api/audit/events", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true, credentials: "same-origin" }).catch(() => {});
}

export function ActivityTracker() {
  const pathname = usePathname();
  const queue = useRef<Ev[]>([]);

  const lastView = useRef<{ path: string; at: number } | null>(null);

  useEffect(() => {
    const path = window.location.pathname + window.location.search;
    // One entry per navigation (React dev mode runs effects twice).
    if (lastView.current && lastView.current.path === path && Date.now() - lastView.current.at < 1500) return;
    lastView.current = { path, at: Date.now() };
    const tab = new URLSearchParams(window.location.search).get("tab");
    queue.current.push({ type: "page_view", action: `Opened ${pageName(window.location.pathname)}${tab ? ` (${tab} tab)` : ""}`, path, at: new Date().toISOString() });
  }, [pathname]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || t.closest("[data-audit-ignore]")) return;
      const el = t.closest(ACTIONABLE);
      if (!el) return;
      const { label, kind, href } = describe(el);
      const state = el.getAttribute("aria-checked") ?? el.getAttribute("data-state");
      queue.current.push({
        type: "click",
        action: `Clicked “${label}”`,
        target: href ?? kind,
        path: window.location.pathname + window.location.search,
        at: new Date().toISOString(),
        meta: { element: kind, ...(state ? { state_before: state } : {}), ...(href ? { href } : {}) },
      });
      if (queue.current.length >= 50) flush();
    };
    const flush = (beacon = false) => {
      const batch = queue.current.splice(0, 100);
      send(batch, beacon);
    };
    const onHide = () => document.visibilityState === "hidden" && flush(true);
    const onPageHide = () => flush(true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    const timer = setInterval(() => flush(), 4000);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      clearInterval(timer);
      flush();
    };
  }, []);

  return null;
}
