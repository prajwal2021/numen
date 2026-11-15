import type { NextConfig } from "next";

// The FastAPI server (server.py). The browser only talks to Next.js; /api is proxied.
const API_URL = process.env.NUMEN_API_URL ?? "http://127.0.0.1:7860";

// Optional sub-path, e.g. /numen when served behind nginx at https://host/numen. Build-time.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || undefined;

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  devIndicators: { position: "bottom-right" },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};

export default nextConfig;
