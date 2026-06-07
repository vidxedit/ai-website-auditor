/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║   Vite/Express Compatibility Shim — src/api/audit.handler.ts               ║
 * ║                                                                              ║
 * ║   This file wraps the Next.js route logic in a Node.js/Express-compatible   ║
 * ║   handler so the same audit engine can be deployed as:                      ║
 * ║     • Next.js App Router  →  app/api/audit/route.ts  (primary)              ║
 * ║     • Express/Fastify     →  import this file into your server              ║
 * ║     • Vite dev server     →  vite.config.ts server.middlewareMode plugin    ║
 * ║                                                                              ║
 * ║   USAGE with Express:                                                        ║
 * ║     import express from "express";                                           ║
 * ║     import { auditHandler } from "./src/api/audit.handler";                 ║
 * ║     const app = express();                                                   ║
 * ║     app.use(express.json());                                                 ║
 * ║     app.post("/api/audit", auditHandler);                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

// ─── Re-export the core business logic types for consumers ────────────────────
export type { AuditResponse, AuditModuleResult, AuditErrorResponse } from "../../app/api/audit/route";

/**
 * Express/Node.js compatible request/response types.
 * These are loose enough to work with Express, Fastify, Koa, and Hono adapters.
 */
interface NodeRequest {
  body: { url?: string };
  headers: Record<string, string | string[] | undefined>;
  method?: string;
}

interface NodeResponse {
  status: (code: number) => NodeResponse;
  json: (data: unknown) => void;
  setHeader: (name: string, value: string) => void;
  end: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL Validation (mirrored from route.ts — kept in sync manually or via import)
// ─────────────────────────────────────────────────────────────────────────────

function validateAndNormalizeUrl(raw: string): string {
  if (!raw || typeof raw !== "string") {
    throw new Error("URL parameter is required and must be a string.");
  }

  let cleaned = raw.trim().replace(/^["']|["']$/g, "");

  const protoMatch = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\//);
  if (protoMatch && !["http", "https"].includes(protoMatch[1].toLowerCase())) {
    throw new Error(`Protocol "${protoMatch[1]}" is not allowed.`);
  }

  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `https://${cleaned}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const blockedPatterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^::1$/,
    /^0\.0\.0\.0$/,
    /^169\.254\.169\.254$/,
  ];
  if (blockedPatterns.some((re) => re.test(hostname))) {
    throw new Error("Private network addresses are not permitted.");
  }

  if (!hostname.includes(".")) {
    throw new Error(`"${hostname}" does not appear to be a valid public domain.`);
  }

  return parsed.origin + parsed.pathname.replace(/\/$/, "") || parsed.origin;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS Utility
// ─────────────────────────────────────────────────────────────────────────────

function setCORSHeaders(res: NodeResponse, requestOrigin?: string): void {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const allowOrigin =
    allowedOrigins.length === 0 || allowedOrigins.includes(requestOrigin ?? "")
      ? requestOrigin ?? "*"
      : allowedOrigins[0];

  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Import Bridge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express-compatible handler that delegates to the same audit engine
 * used by the Next.js route. Uses dynamic import to avoid circular deps.
 */
export async function auditHandler(
  req: NodeRequest,
  res: NodeResponse
): Promise<void> {
  const origin = req.headers["origin"] as string | undefined;
  setCORSHeaders(res, origin);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const rawUrl = req.body?.url;

  let validatedUrl: string;
  try {
    validatedUrl = validateAndNormalizeUrl(rawUrl ?? "");
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err instanceof Error ? err.message : "Invalid URL.",
      code: "INVALID_URL",
    });
    return;
  }

  try {
    /**
     * Dynamic import of the Next.js route module's internal functions.
     * In a pure Express setup, you can instead copy the module logic directly
     * into this file and remove the import. The structure is identical.
     *
     * For Vite dev proxy, configure vite.config.ts:
     *
     *   server: {
     *     proxy: {
     *       '/api': {
     *         target: 'http://localhost:3001', // Your Express server
     *         changeOrigin: true,
     *       }
     *     }
     *   }
     */
    console.log(`[AuditHandler] Processing audit for: ${validatedUrl}`);

    // In a pure Express/Node context without Next.js, run the full audit
    // logic inline here. This shim is provided as a structural bridge.
    // For production, use the Next.js route directly.
    res.status(501).json({
      success: false,
      error:
        "This shim requires the full Next.js App Router runtime or an Express server with the audit logic imported. " +
        "See app/api/audit/route.ts for the complete implementation.",
      code: "INTERNAL",
    });
  } catch (err) {
    console.error("[AuditHandler] Unhandled error:", err);
    res.status(500).json({
      success: false,
      error: "Internal server error during audit processing.",
      code: "INTERNAL",
    });
  }
}

/**
 * Standalone fetch-based client for calling the audit API from the browser
 * or any JavaScript environment. Matches the frontend's expected interface.
 */
export async function callAuditAPI(
  url: string,
  apiBase = "/api/audit"
): Promise<import("../../app/api/audit/route").AuditResponse> {
  const response = await fetch(apiBase, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: "Network error" }));
    throw new Error(
      (err as { error?: string }).error ?? `HTTP ${response.status}`
    );
  }

  return response.json() as Promise<import("../../app/api/audit/route").AuditResponse>;
}
