// Thin typed client for the FastAPI admin API (proxied at /api by next.config.ts).

// Set when the app is served under a sub-path (e.g. /numen behind nginx). Next.js prefixes
// <Link> and router paths itself, but not raw URLs like fetch(), so those use API_BASE.
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
export const API_BASE = `${BASE_PATH}/api`;

export class ApiError extends Error {
  status: number;
  fields: { field: string; message: string }[];
  constructor(status: number, message: string, fields: { field: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/auth")) {
    window.dispatchEvent(new Event("numen:unauthorized"));
  }
  if (!res.ok) {
    let detail: unknown = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {}
    if (Array.isArray(detail)) {
      const fields = detail as { field: string; message: string }[];
      throw new ApiError(res.status, fields.map((f) => `${f.field}: ${f.message}`).join("; "), fields);
    }
    throw new ApiError(res.status, String(detail));
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) return (await res.json()) as T;
  return (await res.blob()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
