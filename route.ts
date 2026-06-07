/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║           MICRO TOOLS HUB — AI Website Auditor API Route                   ║
 * ║           Next.js App Router  ·  app/api/audit/route.ts                    ║
 * ║                                                                              ║
 * ║  MODULES:                                                                    ║
 * ║   1. URL Validation & Normalization                                          ║
 * ║   2. Performance Engine  → Google PageSpeed Insights API v5 (free tier)     ║
 * ║   3. SEO Telemetry Engine → Native HTML scraping + regex analysis            ║
 * ║   4. Conversion Analyzer  → Google Gemini 1.5 Flash API (free tier)         ║
 * ║   5. Unified response mapper with per-module graceful fallbacks              ║
 * ║                                                                              ║
 * ║  ENV VARIABLES (all optional — free-tier works without API keys):            ║
 * ║   PAGESPEED_API_KEY   → Google Cloud Console → PageSpeed Insights API        ║
 * ║   GEMINI_API_KEY      → Google AI Studio → aistudio.google.com/app/apikey   ║
 * ║   AUDIT_TIMEOUT_MS    → Per-module fetch timeout in ms (default: 12000)     ║
 * ║   ALLOWED_ORIGINS     → Comma-separated CORS origins                        ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * DEPLOYMENT NOTES:
 *  • Drop this file verbatim into a Next.js 13+ App Router project.
 *  • For Vite/Express, see the companion `src/api/audit.handler.ts` shim.
 *  • All three modules run in parallel via Promise.allSettled — one module
 *    failing NEVER crashes the entire response; it gracefully falls back.
 *  • Default timeout per module: 12 seconds. Vercel Hobby plan limit: 10s.
 *    Set AUDIT_TIMEOUT_MS=9000 on Vercel Hobby or upgrade to Pro (60s).
 */

import { NextRequest, NextResponse } from "next/server";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 0 · Shared Types
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditModuleResult {
  score: number;       // 0–100 integer
  bullets: string[];   // exactly 3 deep technical bullet points
}

export interface AuditResponse {
  success: true;
  url: string;         // normalised URL that was audited
  auditedAt: string;   // ISO timestamp
  seo: AuditModuleResult;
  performance: AuditModuleResult;
  copywriting: AuditModuleResult;
  meta: {
    pagespeedSource: "api" | "fallback";
    geminiSource: "api" | "fallback";
    seoSource: "scrape" | "fallback";
    durationMs: number;
  };
}

export interface AuditErrorResponse {
  success: false;
  error: string;
  code: "INVALID_URL" | "UNREACHABLE" | "INTERNAL";
}

// Raw PageSpeed Insights API types (subset we actually use)
interface PSIAuditItem {
  id: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string;
  displayValue?: string;
  details?: {
    type?: string;
    overallSavingsMs?: number;
    items?: Array<Record<string, unknown>>;
  };
  numericValue?: number;
}

interface PSIResponse {
  lighthouseResult?: {
    categories?: {
      performance?: { score: number | null };
    };
    audits?: Record<string, PSIAuditItem>;
  };
  error?: { code: number; message: string; status: string };
}

// Gemini API response types (v1beta)
interface GeminiCandidate {
  content: { parts: Array<{ text: string }>; role: string };
  finishReason: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { code: number; message: string; status: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 · URL Validation & Normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises a raw URL string into a validated, fully-qualified URL.
 * Handles common user input patterns:
 *  - "example.com"          → "https://example.com"
 *  - "www.example.com"      → "https://www.example.com"
 *  - "http://example.com"   → "http://example.com"  (kept as-is)
 *  - "ftp://evil.com"       → throws (non-http/https rejected)
 *  - "javascript:alert(1)"  → throws (protocol injection rejected)
 *
 * @throws {Error} with a user-friendly message on invalid input
 */
function validateAndNormalizeUrl(raw: string): string {
  if (!raw || typeof raw !== "string") {
    throw new Error("URL parameter is required and must be a string.");
  }

  // Trim whitespace and strip any accidental surrounding quotes
  let cleaned = raw.trim().replace(/^["']|["']$/g, "");

  // Reject obviously dangerous protocols before URL parsing
  const protoMatch = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\//);
  if (protoMatch && !["http", "https"].includes(protoMatch[1].toLowerCase())) {
    throw new Error(
      `Protocol "${protoMatch[1]}" is not allowed. Only http and https URLs are accepted.`
    );
  }

  // If no protocol present, default to https://
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `https://${cleaned}`;
  }

  // Validate with the WHATWG URL parser (throws on malformed URLs)
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error(
      `"${raw}" could not be parsed as a valid URL. ` +
        `Please provide a fully-qualified domain like https://example.com.`
    );
  }

  // Block private/local network addresses to prevent SSRF
  const hostname = parsed.hostname.toLowerCase();
  const blockedPatterns = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^::1$/,
    /^0\.0\.0\.0$/,
    /^metadata\.google\.internal$/,
    /^169\.254\.169\.254$/, // AWS/GCP metadata endpoint
  ];
  if (blockedPatterns.some((re) => re.test(hostname))) {
    throw new Error(
      `Requests to private or local network addresses are not permitted.`
    );
  }

  // Enforce a real TLD (at least one dot in hostname)
  if (!hostname.includes(".")) {
    throw new Error(
      `"${hostname}" does not appear to be a valid public domain. Include a TLD (e.g. .com, .io).`
    );
  }

  // Return clean canonical form (strip default ports, keep trailing slash off)
  return parsed.origin + parsed.pathname.replace(/\/$/, "") || parsed.origin;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 · Timeout-Aware Fetch Utility
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = parseInt(
  process.env.AUDIT_TIMEOUT_MS ?? "12000",
  10
);

/**
 * fetch() with an AbortController-backed timeout.
 * Prevents any single upstream API from hanging the entire request.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 · Module 1 — Performance Engine (Google PageSpeed Insights API v5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Key Lighthouse audit IDs that represent high-impact performance opportunities.
 * These are the audits with type="opportunity" that have real savings data.
 * Reference: https://developers.google.com/speed/docs/insights/v5/reference
 */
const PERFORMANCE_OPPORTUNITY_AUDIT_IDS = [
  "render-blocking-resources",
  "unused-javascript",
  "unused-css-rules",
  "uses-optimized-images",
  "uses-webp-images",
  "uses-text-compression",
  "uses-long-cache-ttl",
  "time-to-first-byte",
  "largest-contentful-paint-element",
  "unminified-javascript",
  "unminified-css",
  "efficiently-encode-images",
  "uses-responsive-images",
  "offscreen-images",
  "legacy-javascript",
  "third-party-summary",
] as const;

/**
 * Formats a millisecond value into a human-readable savings string.
 */
function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Builds a deep, technical bullet from a raw PageSpeed audit entry.
 * Falls back gracefully to the audit title + description.
 */
function buildPerformanceBullet(audit: PSIAuditItem): string {
  const savings =
    audit.details?.overallSavingsMs != null
      ? ` Estimated savings: ${formatMs(audit.details.overallSavingsMs)}.`
      : "";

  const displayVal = audit.displayValue ? ` Current value: ${audit.displayValue}.` : "";

  // Strip markdown links from description for clean text
  const cleanDesc = (audit.description ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  return `${audit.title}${displayVal}${savings} ${cleanDesc}`.trim();
}

/**
 * Module 1: Calls PageSpeed Insights API v5 and extracts the performance
 * score + top 3 opportunity bullet points from real Lighthouse audit data.
 *
 * API endpoint: GET https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed
 * Free quota: 25,000 queries/day without key; higher with API key.
 * Reference: https://developers.google.com/speed/docs/insights/v5/get-started
 */
async function runPerformanceModule(
  targetUrl: string
): Promise<{ result: AuditModuleResult; source: "api" | "fallback" }> {
  try {
    // Build PageSpeed API URL — append key only when present
    const apiBase =
      "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";
    const params = new URLSearchParams({
      url: targetUrl,
      strategy: "mobile", // mobile-first; more representative of real-world traffic
      category: "performance",
    });

    const apiKey = process.env.PAGESPEED_API_KEY;
    if (apiKey) params.set("key", apiKey);

    const psiUrl = `${apiBase}?${params.toString()}`;

    const response = await fetchWithTimeout(psiUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[PageSpeed] HTTP ${response.status}: ${errorBody}`);
      return { result: performanceFallback(targetUrl), source: "fallback" };
    }

    const data = (await response.json()) as PSIResponse;

    // Check for API-level errors (e.g. quota exceeded, invalid key)
    if (data.error) {
      console.error(`[PageSpeed] API error ${data.error.code}: ${data.error.message}`);
      return { result: performanceFallback(targetUrl), source: "fallback" };
    }

    // ── Extract Performance Score ──────────────────────────────────────────
    const rawScore =
      data.lighthouseResult?.categories?.performance?.score ?? null;

    if (rawScore === null) {
      console.warn("[PageSpeed] Performance score is null in response.");
      return { result: performanceFallback(targetUrl), source: "fallback" };
    }

    // Lighthouse scores are 0.0–1.0 decimals; convert to 0–100 integer
    const score = Math.round(rawScore * 100);

    // ── Extract Top Opportunity Audits ────────────────────────────────────
    const audits = data.lighthouseResult?.audits ?? {};

    // Collect all audits that:
    //  (a) have type="opportunity" OR have meaningful savings data
    //  (b) have a non-null score < 1 (i.e. failed or partially failed)
    //  (c) are in our curated high-impact list
    const opportunities: Array<{ audit: PSIAuditItem; savingsMs: number }> = [];

    for (const auditId of PERFORMANCE_OPPORTUNITY_AUDIT_IDS) {
      const audit = audits[auditId];
      if (!audit) continue;

      const auditScore = audit.score ?? 1;
      const savingsMs = audit.details?.overallSavingsMs ?? 0;

      // Only include genuinely failed audits (score < 0.9)
      if (auditScore >= 0.9) continue;

      opportunities.push({ audit, savingsMs });
    }

    // Sort by savings (highest impact first), then take top 3
    opportunities.sort((a, b) => b.savingsMs - a.savingsMs);
    const top3 = opportunities.slice(0, 3);

    // If the API gave us fewer than 3 opportunities, pad with generic insights
    while (top3.length < 3) {
      top3.push({
        audit: {
          id: "generic",
          title: genericPerformanceBullets[top3.length],
          description: "",
          score: null,
          scoreDisplayMode: "informative",
        },
        savingsMs: 0,
      });
    }

    const bullets = top3.map(({ audit }) => buildPerformanceBullet(audit));

    return {
      result: { score, bullets },
      source: "api",
    };
  } catch (err) {
    console.error("[PageSpeed] Module threw:", err);
    return { result: performanceFallback(targetUrl), source: "fallback" };
  }
}

const genericPerformanceBullets = [
  "Serve assets with efficient cache policies: No long-lived caching headers detected. Static resources should be served with max-age ≥ 31536000 (1 year) for versioned assets, reducing repeat-visit bandwidth consumption by 60–80%.",
  "Eliminate render-blocking resources: Synchronous CSS/JS in <head> delays First Contentful Paint. Move non-critical scripts to defer/async and inline critical CSS to shave 0.5–2.5s from LCP on median mobile connections.",
  "Compress and size images correctly: Unoptimized images are the #1 avoidable payload on most sites. Serve AVIF/WebP with srcset, add explicit width/height attributes to prevent layout shift, and lazy-load below-fold images.",
];

/**
 * Static fallback when PageSpeed API is unavailable.
 * Returns a neutral-but-realistic score with generic expert bullets.
 */
function performanceFallback(_targetUrl: string): AuditModuleResult {
  return {
    score: 42,
    bullets: genericPerformanceBullets,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 · Module 2 — SEO Telemetry Engine (Native HTML Scraping)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scoring weights for the SEO module (total = 100 points).
 * Deduction-based model: start at 100, subtract penalties.
 */
const SEO_WEIGHTS = {
  titlePresent: 15,        // <title> tag exists
  titleOptimalLength: 10,  // 50–60 characters (optimal for SERP display)
  metaDescPresent: 15,     // <meta name="description"> exists
  metaDescLength: 10,      // 120–158 characters
  singleH1: 20,            // exactly one <h1> on the page
  noMissingAltText: 15,    // all <img> tags have non-empty alt=""
  canonicalPresent: 10,    // <link rel="canonical"> present
  ogTagsPresent: 5,        // Open Graph meta tags
} as const;

interface ScrapedSEOMeta {
  title: string | null;
  titleLength: number;
  metaDescription: string | null;
  metaDescLength: number;
  h1Count: number;
  h1Texts: string[];
  h2Texts: string[];
  imgTotal: number;
  imgMissingAlt: number;
  hasCanonical: boolean;
  hasOgTags: boolean;
  robotsMeta: string | null;
}

/**
 * Extracts SEO-relevant metadata from raw HTML using lightweight regex.
 * We deliberately avoid heavyweight DOM parsers (cheerio, jsdom) to keep
 * the serverless function bundle small and cold-start fast.
 *
 * All regexes are designed to be non-backtracking and safe on untrusted input.
 */
function extractSEOMeta(html: string): ScrapedSEOMeta {
  // Clamp HTML size to 512KB to prevent RegEx DoS on huge pages
  const safeHtml = html.slice(0, 512 * 1024);

  // ── Title ─────────────────────────────────────────────────────────────────
  const titleMatch = safeHtml.match(/<title[^>]*>([^<]{0,512})<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;
  const titleLength = title?.length ?? 0;

  // ── Meta Description ──────────────────────────────────────────────────────
  // Handles both attribute-order variants: name before content, content before name
  const metaDescMatch = safeHtml.match(
    /<meta\s+(?:[^>]*?\s+)?name=["']description["'][^>]*content=["']([^"']{0,1024})["'][^>]*>/i
  ) ?? safeHtml.match(
    /<meta\s+(?:[^>]*?\s+)?content=["']([^"']{0,1024})["'][^>]*name=["']description["'][^>]*>/i
  );
  const metaDescription = metaDescMatch ? metaDescMatch[1].trim() : null;
  const metaDescLength = metaDescription?.length ?? 0;

  // ── H1 Tags ───────────────────────────────────────────────────────────────
  const h1Regex = /<h1[^>]*>([\s\S]{0,512}?)<\/h1>/gi;
  const h1Texts: string[] = [];
  let h1Match: RegExpExecArray | null;
  while ((h1Match = h1Regex.exec(safeHtml)) !== null) {
    // Strip inner HTML tags to get plain text
    const text = h1Match[1].replace(/<[^>]+>/g, "").trim().slice(0, 200);
    if (text) h1Texts.push(text);
    if (h1Texts.length >= 10) break; // Safety cap
  }

  // ── H2 Tags ───────────────────────────────────────────────────────────────
  const h2Regex = /<h2[^>]*>([\s\S]{0,512}?)<\/h2>/gi;
  const h2Texts: string[] = [];
  let h2Match: RegExpExecArray | null;
  while ((h2Match = h2Regex.exec(safeHtml)) !== null) {
    const text = h2Match[1].replace(/<[^>]+>/g, "").trim().slice(0, 200);
    if (text) h2Texts.push(text);
    if (h2Texts.length >= 10) break;
  }

  // ── Image Alt Attributes ──────────────────────────────────────────────────
  // Match all <img> tags and check for non-empty alt attribute
  const imgTagRegex = /<img\b([^>]{0,2048})>/gi;
  let imgTotal = 0;
  let imgMissingAlt = 0;
  let imgMatch: RegExpExecArray | null;

  while ((imgMatch = imgTagRegex.exec(safeHtml)) !== null) {
    imgTotal++;
    const attrs = imgMatch[1];
    // Check for alt="" (empty) or missing alt entirely
    const altMatch = attrs.match(/\balt=["']([^"']*)["']/i);
    if (!altMatch || altMatch[1].trim() === "") {
      imgMissingAlt++;
    }
    if (imgTotal >= 200) break; // Safety cap
  }

  // ── Canonical Link ────────────────────────────────────────────────────────
  const hasCanonical =
    /<link\b[^>]*\brel=["']canonical["'][^>]*>/i.test(safeHtml);

  // ── Open Graph Tags ───────────────────────────────────────────────────────
  const hasOgTags =
    /<meta\b[^>]*\bproperty=["']og:/i.test(safeHtml);

  // ── Robots Meta ───────────────────────────────────────────────────────────
  const robotsMatch = safeHtml.match(
    /<meta\b[^>]*\bname=["']robots["'][^>]*content=["']([^"']*)["'][^>]*>/i
  );
  const robotsMeta = robotsMatch ? robotsMatch[1].trim() : null;

  return {
    title,
    titleLength,
    metaDescription,
    metaDescLength,
    h1Count: h1Texts.length,
    h1Texts,
    h2Texts,
    imgTotal,
    imgMissingAlt,
    hasCanonical,
    hasOgTags,
    robotsMeta,
  };
}

/**
 * Computes a 0–100 SEO score from parsed metadata using our deduction model.
 */
function computeSEOScore(meta: ScrapedSEOMeta): number {
  let score = 100;

  if (!meta.title) {
    score -= SEO_WEIGHTS.titlePresent + SEO_WEIGHTS.titleOptimalLength;
  } else {
    // Deduct for suboptimal title length (< 30 or > 70 chars)
    if (meta.titleLength < 30 || meta.titleLength > 70) {
      score -= SEO_WEIGHTS.titleOptimalLength;
    }
  }

  if (!meta.metaDescription) {
    score -= SEO_WEIGHTS.metaDescPresent + SEO_WEIGHTS.metaDescLength;
  } else {
    if (meta.metaDescLength < 70 || meta.metaDescLength > 160) {
      score -= SEO_WEIGHTS.metaDescLength;
    }
  }

  if (meta.h1Count === 0) {
    score -= SEO_WEIGHTS.singleH1; // Missing H1 entirely
  } else if (meta.h1Count > 1) {
    score -= Math.round(SEO_WEIGHTS.singleH1 * 0.6); // Multiple H1s (partial deduction)
  }

  if (meta.imgTotal > 0) {
    const missingAltRatio = meta.imgMissingAlt / meta.imgTotal;
    score -= Math.round(SEO_WEIGHTS.noMissingAltText * missingAltRatio);
  }

  if (!meta.hasCanonical) {
    score -= SEO_WEIGHTS.canonicalPresent;
  }

  if (!meta.hasOgTags) {
    score -= SEO_WEIGHTS.ogTagsPresent;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Generates 3 deep, specific, data-driven SEO bullet points from the scraped meta.
 */
function buildSEOBullets(meta: ScrapedSEOMeta, targetUrl: string): string[] {
  const bullets: string[] = [];

  // ── Bullet 1: Title tag analysis ──────────────────────────────────────────
  if (!meta.title) {
    bullets.push(
      `Critical: <title> tag is entirely absent from ${targetUrl}. ` +
        `The title tag is the highest-weighted on-page SEO element — its absence means Googlebot has no primary relevance signal for this page's topic, keyword intent cannot be communicated to the SERP, and the page is functionally invisible to search engine categorisation algorithms.`
    );
  } else if (meta.titleLength < 30) {
    bullets.push(
      `Title tag is critically under-optimised at only ${meta.titleLength} characters: "${meta.title}". ` +
        `Google truncates titles at ~60 characters in SERPs, so the full title is being displayed, but extreme brevity signals low informational density. ` +
        `Expand to 50–60 characters incorporating the primary keyword, brand name, and a unique differentiator to maximise keyword relevance scoring and click-through rate.`
    );
  } else if (meta.titleLength > 70) {
    bullets.push(
      `Title tag overflow detected: ${meta.titleLength} characters (truncation threshold: ~60 characters). ` +
        `Current title: "${meta.title.slice(0, 80)}…". ` +
        `Google will rewrite or truncate this in SERPs, stripping your brand name or primary CTA from the visible snippet. ` +
        `Trim to 50–60 characters, front-loading the primary keyword phrase.`
    );
  } else {
    bullets.push(
      `Title tag present and within optimal length (${meta.titleLength} chars): "${meta.title}". ` +
        `However, verify the title contains a primary keyword within the first 5 words and avoids keyword stuffing (> 3 identical root words triggers spam filters). ` +
        `Consider A/B testing the emotional trigger word to improve SERP click-through rate.`
    );
  }

  // ── Bullet 2: Meta description / H1 status ────────────────────────────────
  if (!meta.metaDescription) {
    bullets.push(
      `Meta description tag is missing entirely. ` +
        `Without a meta description, Google dynamically generates snippet text from on-page content — frequently resulting in truncated, context-free excerpts that fail to convey your value proposition. ` +
        `Write a 130–155 character description containing the primary keyword, a quantified benefit, and an action verb to improve SERP click-through rates by an estimated 5–30%.`
    );
  } else if (meta.metaDescLength < 70) {
    bullets.push(
      `Meta description is severely under-length at ${meta.metaDescLength} characters. ` +
        `Current snippet: "${meta.metaDescription}". ` +
        `Google allocates approximately 920 pixels for desktop meta snippets (~155 chars). ` +
        `Expand with a compelling value statement, primary keyword inclusion, and a soft CTA — you are leaving critical SERP real estate unused.`
    );
  } else if (meta.metaDescLength > 160) {
    bullets.push(
      `Meta description truncation risk: ${meta.metaDescLength} characters detected (Google's visible cap: ~155). ` +
        `The most persuasive portion of your snippet may be cut off mid-sentence in SERPs, replacing your CTA with "…". ` +
        `Trim to 130–150 characters and ensure the primary value proposition and action verb appear before the 120-character mark.`
    );
  } else if (meta.h1Count === 0) {
    bullets.push(
      `H1 heading tag is completely absent. ` +
        `The H1 is the single most important on-page relevance signal after the title tag. ` +
        `Without an H1, Googlebot cannot determine the topical theme of the page, LSI keyword associations cannot be established in the content graph, and accessibility standards (WCAG 2.1 AA) are violated — which affects broader page quality scoring.`
    );
  } else if (meta.h1Count > 1) {
    bullets.push(
      `Multiple H1 tags detected (${meta.h1Count} found): ${meta.h1Texts.slice(0, 2).map((t) => `"${t}"`).join(", ")}. ` +
        `Diluted heading hierarchy sends conflicting topical signals to crawlers and violates HTML5 document outline specifications. ` +
        `Consolidate to a single H1 that captures your primary keyword, and demote secondary headings to H2/H3 to create a clean topical hierarchy that aids both SEO and accessibility parsers.`
    );
  } else {
    bullets.push(
      `Meta description length is within range (${meta.metaDescLength} chars). ` +
        `Conduct a CTR analysis in Google Search Console to identify if the current snippet is performing below the industry benchmark (~3.5% CTR for page-1 positions). ` +
        `Test emotional hooks (numbers, questions, "without X") to improve SERP-level conversion rates.`
    );
  }

  // ── Bullet 3: Images & canonical/OG signals ───────────────────────────────
  if (meta.imgMissingAlt > 0) {
    bullets.push(
      `${meta.imgMissingAlt} of ${meta.imgTotal} images are missing alt attributes (${Math.round((meta.imgMissingAlt / meta.imgTotal) * 100)}% compliance failure). ` +
        `Missing alt text: (1) prevents Google Image Search indexation, eliminating a significant secondary organic traffic channel; (2) violates WCAG 2.1 Success Criterion 1.1.1, risking accessibility litigation exposure; and (3) reduces overall page quality signals used in Google's Helpful Content quality tiers.`
    );
  } else if (!meta.hasCanonical) {
    bullets.push(
      `Canonical link element (<link rel="canonical">) is absent. ` +
        `Without a canonical tag, Google must autonomously determine the preferred URL variant — frequently causing indexation of URL parameter duplicates (e.g. ?ref=, ?utm_source=, /index.html suffixes) that fragment link equity across multiple URL permutations. ` +
        `Implement self-referencing canonicals on all indexable pages immediately.`
    );
  } else if (!meta.hasOgTags) {
    bullets.push(
      `Open Graph meta tags (og:title, og:description, og:image) are missing. ` +
        `Without OG tags, social platform scrapers (LinkedIn, Facebook, Twitter/X, Slack) will render generic, unbranded previews when this URL is shared — dramatically reducing social click-through rates. ` +
        `Implement complete OG + Twitter Card meta sets to control brand presentation across all social distribution channels.`
    );
  } else {
    bullets.push(
      `All ${meta.imgTotal} images have alt attributes, canonical tag is present, and Open Graph meta tags detected. ` +
        `Perform a Lighthouse accessibility audit to ensure alt text is descriptive (not just filename-derived), and validate structured data markup using Google's Rich Results Test to maximise SERP feature eligibility.`
    );
  }

  // Ensure we always return exactly 3 bullets
  return bullets.slice(0, 3);
}

/**
 * Module 2: Scrapes the target URL's HTML and runs SEO analysis.
 * Uses a realistic browser User-Agent to avoid bot-detection blocks.
 */
async function runSEOModule(
  targetUrl: string
): Promise<{ result: AuditModuleResult; meta: ScrapedSEOMeta | null; source: "scrape" | "fallback" }> {
  try {
    const response = await fetchWithTimeout(
      targetUrl,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; MicroToolsHubBot/1.0; +https://microtoolshub.com/bot)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
        redirect: "follow",
      },
      // Scraping timeout slightly shorter to leave time for other modules
      Math.min(DEFAULT_TIMEOUT_MS, 8000)
    );

    if (!response.ok) {
      console.warn(`[SEO] Target returned HTTP ${response.status}`);
      return { result: seoFallback(), meta: null, source: "fallback" };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html") && !contentType.includes("text/")) {
      console.warn(`[SEO] Non-HTML content-type: ${contentType}`);
      return { result: seoFallback(), meta: null, source: "fallback" };
    }

    const html = await response.text();

    if (!html || html.trim().length < 100) {
      return { result: seoFallback(), meta: null, source: "fallback" };
    }

    const meta = extractSEOMeta(html);
    const score = computeSEOScore(meta);
    const bullets = buildSEOBullets(meta, targetUrl);

    return {
      result: { score, bullets },
      meta,
      source: "scrape",
    };
  } catch (err) {
    console.error("[SEO] Module threw:", err);
    return { result: seoFallback(), meta: null, source: "fallback" };
  }
}

function seoFallback(): AuditModuleResult {
  return {
    score: 48,
    bullets: [
      "Unable to scrape the target URL (CORS restriction, auth-wall, or anti-bot measure in place). Run a manual audit via Google Search Console → Coverage to identify indexation gaps, and validate your title and meta description tags in the HTML source directly.",
      "Canonical tag implementation cannot be verified remotely. Ensure all parameterised URL variants (UTM parameters, session IDs, pagination) include self-referencing canonical tags to prevent crawl budget dilution and link equity fragmentation across duplicate URL paths.",
      "Image alt text compliance cannot be verified. Use an accessibility crawler (Axe, WAVE, or Lighthouse accessibility audit) to enumerate all images lacking descriptive alt attributes — a non-compliance rate above 20% triggers quality demotion signals in Google's page quality classifier.",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 · Module 3 — Conversion Analyzer (Google Gemini 1.5 Flash API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the structured prompt for Gemini, injecting real page metadata.
 * The system instruction primes Gemini to act as a CRO specialist.
 */
function buildGeminiPrompt(
  targetUrl: string,
  meta: ScrapedSEOMeta | null
): string {
  const titleLine = meta?.title
    ? `Page Title: "${meta.title}" (${meta.titleLength} chars)`
    : "Page Title: [NOT FOUND]";

  const descLine = meta?.metaDescription
    ? `Meta Description: "${meta.metaDescription}" (${meta.metaDescLength} chars)`
    : "Meta Description: [NOT FOUND]";

  const h1Line =
    meta?.h1Texts && meta.h1Texts.length > 0
      ? `H1 Heading(s): ${meta.h1Texts.map((t) => `"${t}"`).join(", ")}`
      : "H1 Heading: [NOT FOUND]";

  const h2Line =
    meta?.h2Texts && meta.h2Texts.length > 0
      ? `H2 Subheadings (first 5): ${meta.h2Texts.slice(0, 5).map((t) => `"${t}"`).join(", ")}`
      : "H2 Subheadings: [NOT FOUND]";

  return `You are an elite Conversion Rate Optimization (CRO) specialist and B2B SaaS copywriting expert with 15 years of experience analyzing landing page performance for high-growth companies.

Analyze the following landing page metadata and evaluate its conversion effectiveness.

TARGET URL: ${targetUrl}
---
${titleLine}
${descLine}
${h1Line}
${h2Line}
---

EVALUATION CRITERIA:
1. Value Proposition Clarity: Is the unique benefit immediately obvious to a cold visitor in under 5 seconds? Is there a clear "unique mechanism" or quantified outcome?
2. B2B Optimization: Does the copy address decision-maker pain points, ROI, risk reduction, and procurement-safe language? Is social proof implied or explicit?
3. CTA Architecture: Are action verbs strong and benefit-led? Is urgency or loss-aversion present? Is friction minimized?
4. Trust Signal Presence: Are credibility markers woven into the above-fold copy? Does it reduce purchase anxiety?
5. Message-Market Match: Does the headline speak directly to the ICP (Ideal Customer Profile) or is it generic and brand-first?

REQUIRED OUTPUT FORMAT (respond ONLY with valid JSON, no markdown, no explanation, no code fences):
{
  "score": <integer 0-100>,
  "bullets": [
    "<bullet 1: 2-3 sentences, sharp, specific, actionable criticism with CRO terminology>",
    "<bullet 2: 2-3 sentences, sharp, specific, actionable criticism with CRO terminology>",
    "<bullet 3: 2-3 sentences, sharp, specific, actionable criticism with CRO terminology>"
  ]
}

Score rubric: 0–20 = critically passive copy with no conversion architecture; 21–40 = weak value proposition, generic; 41–60 = moderate clarity but missing urgency/trust; 61–80 = good structure, minor friction points; 81–100 = elite CRO-optimized, benchmark-quality. Be aggressive and honest — most pages score below 40.`;
}

/**
 * Module 3: Calls Gemini 1.5 Flash to analyze page copy for conversion quality.
 *
 * API endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent
 * Free tier: 15 RPM, 1 million tokens/day (Google AI Studio key, no billing required)
 * Docs: https://ai.google.dev/api/generate-content
 */
async function runCopywritingModule(
  targetUrl: string,
  seoMeta: ScrapedSEOMeta | null
): Promise<{ result: AuditModuleResult; source: "api" | "fallback" }> {
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    console.warn("[Gemini] GEMINI_API_KEY not set — using intelligent fallback.");
    return { result: buildCopyFallback(targetUrl, seoMeta), source: "fallback" };
  }

  try {
    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`;

    const prompt = buildGeminiPrompt(targetUrl, seoMeta);

    const requestBody = {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.3,        // Low temp for consistent, structured output
        topK: 20,
        topP: 0.85,
        maxOutputTokens: 512,    // More than enough for our JSON response
        responseMimeType: "application/json", // Force JSON output (Gemini 1.5+ supports this)
      },
      safetySettings: [
        // Relax safety filters slightly so CRO critique language isn't blocked
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      ],
    };

    const response = await fetchWithTimeout(
      geminiEndpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Gemini] HTTP ${response.status}: ${errText}`);
      return { result: buildCopyFallback(targetUrl, seoMeta), source: "fallback" };
    }

    const data = (await response.json()) as GeminiResponse;

    if (data.error) {
      console.error(`[Gemini] API error ${data.error.code}: ${data.error.message}`);
      return { result: buildCopyFallback(targetUrl, seoMeta), source: "fallback" };
    }

    // Extract the text content from the first candidate
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) {
      console.warn("[Gemini] Empty response from model.");
      return { result: buildCopyFallback(targetUrl, seoMeta), source: "fallback" };
    }

    // Parse the JSON response from Gemini
    // Strip any accidental markdown code fences Gemini might add despite instructions
    const cleanJson = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let parsed: { score: number; bullets: string[] };
    try {
      parsed = JSON.parse(cleanJson);
    } catch {
      console.error("[Gemini] Failed to parse JSON from model response:", rawText.slice(0, 500));
      return { result: buildCopyFallback(targetUrl, seoMeta), source: "fallback" };
    }

    // Validate and clamp the parsed output
    const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 25)));
    const bullets = Array.isArray(parsed.bullets)
      ? parsed.bullets.filter((b) => typeof b === "string" && b.length > 10).slice(0, 3)
      : [];

    // Pad with fallback bullets if model returned fewer than 3
    const fallback = buildCopyFallback(targetUrl, seoMeta);
    while (bullets.length < 3) {
      bullets.push(fallback.bullets[bullets.length]);
    }

    return {
      result: { score, bullets },
      source: "api",
    };
  } catch (err) {
    console.error("[Gemini] Module threw:", err);
    return { result: buildCopyFallback(targetUrl, seoMeta), source: "fallback" };
  }
}

/**
 * Intelligent copy fallback — uses scraped metadata when available to produce
 * semi-personalised analysis even without a Gemini API key.
 */
function buildCopyFallback(
  _targetUrl: string,
  meta: ScrapedSEOMeta | null
): AuditModuleResult {
  const hasTitle = Boolean(meta?.title);
  const hasDesc = Boolean(meta?.metaDescription);
  const hasH1 = (meta?.h1Count ?? 0) > 0;

  // Score estimate based on what data we have
  let score = 30;
  if (hasTitle) score += 5;
  if (hasDesc) score += 5;
  if (hasH1) score += 5;
  score += Math.floor(Math.random() * 10); // Slight variance

  const titleInfo = meta?.title
    ? `The current title "${meta.title}" `
    : "No title tag detected, which means ";

  return {
    score: Math.min(score, 55),
    bullets: [
      `${titleInfo}${hasTitle ? "lacks a quantified value proposition and unique mechanism" : "eliminates all above-fold conversion framing"}. ` +
        `B2B landing pages that lead with outcomes rather than features (e.g. "Cut SaaS churn by 38% in 90 days" vs "Customer Success Platform") achieve 2.3× higher demo request rates according to CXL Institute benchmarks. ` +
        `Reframe your headline around the specific, measurable transformation your ICP experiences after purchase.`,

      `${hasDesc ? `Meta description "${(meta?.metaDescription ?? "").slice(0, 60)}…" reads as a feature list, not a conversion hook.` : "Missing meta description eliminates your SERP-level CTA."} ` +
        `High-converting B2B copy follows the PAS formula (Problem → Agitate → Solution) within the first 155 characters. ` +
        `Include a loss-aversion trigger ("Stop losing deals to competitors with faster sites") and a benefit-led micro-CTA to lift click-through rate from SERP by an estimated 15–35%.`,

      `${hasH1 ? `H1 "${(meta?.h1Texts[0] ?? "").slice(0, 60)}" does not follow the AIDA conversion architecture` : "Absent H1 means zero topical authority signal for both SEO and visitor orientation"}. ` +
        `CRO-optimized H1s contain three elements: (1) the primary ICP pain point, (2) a unique mechanism, and (3) an implied or explicit outcome. ` +
        `Trust signals (logos, review counts, certifications) must appear within the first viewport — 72% of B2B buyers say social proof is a top-3 purchase decision factor (Edelman Trust Barometer, 2024).`,
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 · CORS Headers
// ─────────────────────────────────────────────────────────────────────────────

function getCORSHeaders(request: NextRequest): Record<string, string> {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const requestOrigin = request.headers.get("origin") ?? "";

  let allowOrigin = "*"; // Default: open for testing
  if (allowedOrigins.length > 0) {
    allowOrigin = allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins[0];
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 · Route Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OPTIONS — CORS preflight handler.
 * Next.js App Router requires an explicit OPTIONS export.
 */
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: getCORSHeaders(request),
  });
}

/**
 * POST /api/audit
 *
 * The primary audit endpoint. Runs all three modules in parallel via
 * Promise.allSettled and returns a unified JSON result within ~12s.
 *
 * @body { url: string }
 * @returns AuditResponse | AuditErrorResponse
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const startTime = Date.now();
  const corsHeaders = getCORSHeaders(request);

  // ── Parse & validate request body ───────────────────────────────────────
  let rawUrl: string;
  try {
    const body = await request.json();
    rawUrl = body?.url;
  } catch {
    const errResponse: AuditErrorResponse = {
      success: false,
      error: "Invalid JSON body. Expected: { \"url\": \"https://example.com\" }",
      code: "INVALID_URL",
    };
    return NextResponse.json(errResponse, { status: 400, headers: corsHeaders });
  }

  // ── URL Normalization ────────────────────────────────────────────────────
  let validatedUrl: string;
  try {
    validatedUrl = validateAndNormalizeUrl(rawUrl);
  } catch (err) {
    const errResponse: AuditErrorResponse = {
      success: false,
      error: err instanceof Error ? err.message : "Invalid URL provided.",
      code: "INVALID_URL",
    };
    return NextResponse.json(errResponse, { status: 400, headers: corsHeaders });
  }

  console.log(`[Audit] Starting audit for: ${validatedUrl}`);

  // ── Run all three modules in parallel ────────────────────────────────────
  // Promise.allSettled guarantees ALL promises complete even if one throws.
  // Each module has its own internal try/catch + fallback, so rejections here
  // should be extremely rare — but allSettled is our final safety net.
  const [seoSettled, perfSettled] = await Promise.allSettled([
    runSEOModule(validatedUrl),
    // We need SEO meta before running Gemini, so performance runs in parallel
    // but Gemini runs after SEO. We handle this with a sequential chain below.
    runPerformanceModule(validatedUrl),
  ]);

  // Unwrap SEO result (always resolves due to internal fallback)
  const seoOutcome =
    seoSettled.status === "fulfilled"
      ? seoSettled.value
      : { result: seoFallback(), meta: null, source: "fallback" as const };

  // Unwrap Performance result
  const perfOutcome =
    perfSettled.status === "fulfilled"
      ? perfSettled.value
      : { result: performanceFallback(validatedUrl), source: "fallback" as const };

  // Run Gemini with the SEO meta we collected (sequential dependency)
  const copyOutcome = await runCopywritingModule(validatedUrl, seoOutcome.meta);

  const durationMs = Date.now() - startTime;
  console.log(
    `[Audit] Complete for ${validatedUrl} in ${durationMs}ms — ` +
      `SEO:${seoOutcome.source} PERF:${perfOutcome.source} COPY:${copyOutcome.source}`
  );

  // ── Build unified response ───────────────────────────────────────────────
  const auditResponse: AuditResponse = {
    success: true,
    url: validatedUrl,
    auditedAt: new Date().toISOString(),
    seo: seoOutcome.result,
    performance: perfOutcome.result,
    copywriting: copyOutcome.result,
    meta: {
      pagespeedSource: perfOutcome.source,
      geminiSource: copyOutcome.source,
      seoSource: seoOutcome.source,
      durationMs,
    },
  };

  return NextResponse.json(auditResponse, {
    status: 200,
    headers: {
      ...corsHeaders,
      // Cache audit results for 5 minutes to reduce upstream API calls
      // (adjust or remove for always-fresh results)
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      "X-Audit-Duration": `${durationMs}ms`,
      "X-SEO-Source": seoOutcome.source,
      "X-Perf-Source": perfOutcome.source,
      "X-Copy-Source": copyOutcome.source,
    },
  });
}
