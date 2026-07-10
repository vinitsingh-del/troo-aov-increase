// supabase/functions/analyze-aov/index.ts
//
// TROO AOV INCREASE — main entry point.
// Deploy: supabase functions deploy analyze-aov
// Requires env vars (set via `supabase secrets set`):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected by Supabase)
//   ANTHROPIC_API_KEY
//   RENDER_SERVICE_URL   (optional — see fetchPage() note below)
//   MAX_CONCURRENT_REPORTS (optional, default 3)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const RENDER_SERVICE_URL = Deno.env.get("RENDER_SERVICE_URL"); // e.g. a Browserless/Playwright microservice
const MAX_CONCURRENT_REPORTS = Number(Deno.env.get("MAX_CONCURRENT_REPORTS") ?? 3);
const FETCH_TIMEOUT_MS = 15000;

type PageKey = "pdp" | "home" | "collection";

interface PageResult {
  status: "fetched" | "partial" | "not_accessible" | "not_provided";
  reason?: string;
  content?: string; // trimmed extracted text, only present if fetched/partial
}

// ---------- entry point ----------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "POST only" }, 405);
  }

  let body: {
    brand_name?: string;
    pdp_url?: string;
    home_url?: string;
    collection_url?: string;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  const { brand_name, pdp_url, home_url, collection_url } = body;

  // ---- input validation ----
  if (!brand_name?.trim()) {
    return jsonResponse({ error: "brand_name is required" }, 400);
  }
  if (!pdp_url || !isValidUrlShape(pdp_url)) {
    return jsonResponse({ error: "a valid pdp_url is required" }, 400);
  }
  if (home_url && !isValidUrlShape(home_url)) {
    return jsonResponse({ error: "home_url is not a valid URL" }, 400);
  }
  if (collection_url && !isValidUrlShape(collection_url)) {
    return jsonResponse({ error: "collection_url is not a valid URL" }, 400);
  }

  // ---- concurrency cap ----
  const { count, error: countError } = await supabase
    .from("aov_reports")
    .select("id", { count: "exact", head: true })
    .eq("status", "processing");

  if (countError) {
    return jsonResponse({ error: "internal error checking capacity" }, 500);
  }
  if ((count ?? 0) >= MAX_CONCURRENT_REPORTS) {
    return jsonResponse(
      { error: "another report is generating, try again shortly" },
      429,
    );
  }

  // ---- create the row up front so it's trackable/pollable ----
  const { data: reportRow, error: insertError } = await supabase
    .from("aov_reports")
    .insert({
      brand_name,
      pdp_url,
      home_url: home_url ?? null,
      collection_url: collection_url ?? null,
      status: "processing",
    })
    .select()
    .single();

  if (insertError || !reportRow) {
    return jsonResponse({ error: "internal error creating report" }, 500);
  }

  try {
    const result = await generateReport({
      brand_name,
      pdp_url,
      home_url,
      collection_url,
    });

    // hard stop: PDP is required, if it wasn't accessible at all, fail the report
    if (result.accessStatus.pdp.status === "not_accessible") {
      await supabase
        .from("aov_reports")
        .update({
          status: "failed",
          error_message: `PDP not accessible: ${result.accessStatus.pdp.reason}`,
          access_status: result.accessStatus,
          completed_at: new Date().toISOString(),
        })
        .eq("id", reportRow.id);

      return jsonResponse(
        {
          error: "couldn't read the PDP",
          reason: result.accessStatus.pdp.reason,
          report_id: reportRow.id,
        },
        422,
      );
    }

    await supabase
      .from("aov_reports")
      .update({
        status: "completed",
        access_status: result.accessStatus,
        report: result.report,
        completed_at: new Date().toISOString(),
      })
      .eq("id", reportRow.id);

    return jsonResponse({
      report_id: reportRow.id,
      access_status: result.accessStatus,
      report: result.report,
    });
  } catch (err) {
    await supabase
      .from("aov_reports")
      .update({
        status: "failed",
        error_message: String(err),
        completed_at: new Date().toISOString(),
      })
      .eq("id", reportRow.id);

    return jsonResponse({ error: "report generation failed, try again" }, 500);
  }
});

// ---------- core pipeline ----------

async function generateReport(input: {
  brand_name: string;
  pdp_url: string;
  home_url?: string;
  collection_url?: string;
}) {
  const [pdp, home, collection] = await Promise.all([
    fetchPage(input.pdp_url),
    input.home_url ? fetchPage(input.home_url) : Promise.resolve(notProvided()),
    input.collection_url
      ? fetchPage(input.collection_url)
      : Promise.resolve(notProvided()),
  ]);

  const accessStatus: Record<PageKey, PageResult> = { pdp, home, collection };

  // if PDP failed, don't bother calling the model — return early
  if (pdp.status === "not_accessible") {
    return { accessStatus, report: null };
  }

  const report = await callClaudeAndBuildReport(input.brand_name, accessStatus);
  return { accessStatus, report };
}

// ---------- page fetching ----------

function notProvided(): PageResult {
  return { status: "not_provided" };
}

async function fetchPage(url: string): Promise<PageResult> {
  // Try a rendered fetch first if a render service is configured
  // (Deno edge runtime has no headless browser — most Troopod/D2C sites
  // are JS-rendered, so a plain fetch alone will often return an empty shell).
  // RENDER_SERVICE_URL should point at something like Browserless or a
  // small internal Playwright microservice that accepts { url } and
  // returns { html }.
  if (RENDER_SERVICE_URL) {
    const rendered = await tryFetch(async () => {
      const res = await withTimeout(
        fetch(RENDER_SERVICE_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url }),
        }),
        FETCH_TIMEOUT_MS,
      );
      if (!res.ok) throw new Error(`render service returned ${res.status}`);
      const { html } = await res.json();
      return html as string;
    });

    if (rendered.ok) {
      return classifyContent(rendered.value);
    }
    // fall through to plain fetch if the render service itself failed
  }

  const plain = await tryFetch(async () => {
    const res = await withTimeout(
      fetch(url, {
        redirect: "follow",
        headers: {
          "user-agent":
            "Mozilla/5.0 (compatible; TroopodAOVBot/1.0; +internal-tool)",
        },
      }),
      FETCH_TIMEOUT_MS,
    );

    if (res.status === 403 || res.status === 401) {
      throw new FetchError(`site returned ${res.status}, likely bot-blocked`);
    }
    if (!res.ok) {
      throw new FetchError(`site returned ${res.status}`);
    }
    return await res.text();
  });

  if (!plain.ok) {
    return { status: "not_accessible", reason: plain.reason };
  }

  return classifyContent(plain.value);
}

function classifyContent(html: string): PageResult {
  const text = stripToText(html);

  // crude signal: does the page look like it has any product/price content?
  const hasPriceSignal = /(₹|\$|Rs\.?\s?\d|[0-9][.,][0-9]{2})/.test(text);
  const hasSubstance = text.length > 500;

  if (!hasSubstance) {
    return {
      status: "not_accessible",
      reason: "page returned little to no content, likely JS-rendered and blocked, or empty",
    };
  }
  if (!hasPriceSignal) {
    return {
      status: "partial",
      reason: "page loaded but no price/product signal found in static read",
      content: text.slice(0, 15000),
    };
  }
  return { status: "fetched", content: text.slice(0, 15000) };
}

function stripToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

class FetchError extends Error {}

async function tryFetch<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    if (err instanceof FetchError) return { ok: false, reason: err.message };
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, reason: "request timed out after 15s" };
    }
    return { ok: false, reason: "could not reach the page" };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return promise.finally(() => clearTimeout(timeout));
}

function isValidUrlShape(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------- Claude API call + hallucination guard ----------

const REPORT_SCHEMA_KEYS = [
  "diagnosis",
  "improvements",
  "above_fold_structure",
  "top_tests",
  "offer_architecture",
  "competitors",
];

async function callClaudeAndBuildReport(
  brandName: string,
  accessStatus: Record<PageKey, PageResult>,
) {
  const systemPrompt = buildSystemPrompt(accessStatus);
  const userPrompt = buildUserPrompt(brandName, accessStatus);

  const raw = await callClaude(systemPrompt, userPrompt);
  let parsed = safeParseJson(raw);

  // retry once on malformed JSON
  if (!parsed) {
    const retry = await callClaude(
      systemPrompt,
      userPrompt + "\n\nYour last response was not valid JSON. Return ONLY valid JSON, no markdown fences, no preamble.",
    );
    parsed = safeParseJson(retry);
  }

  if (!parsed || !REPORT_SCHEMA_KEYS.every((k) => k in parsed)) {
    throw new Error("model did not return a valid report schema after retry");
  }

  // hallucination guard: strip any currency/percentage figures in the
  // diagnosis/improvements/offer sections that don't trace back to fetched content
  const fetchedContent = [
    accessStatus.pdp.content,
    accessStatus.home.content,
    accessStatus.collection.content,
  ]
    .filter(Boolean)
    .join(" ");

  parsed = scrubUngroundedFigures(parsed, fetchedContent);

  return parsed;
}

async function callClaude(system: string, user: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: user }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  if (!res.ok) {
    throw new Error(`claude api error: ${res.status}`);
  }

  const data = await res.json();
  const textBlocks = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text);

  return textBlocks.join("\n");
}

function safeParseJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// pulls out ₹/$ figures and % figures that appear in the model's output
// but never appeared anywhere in the actually-fetched page content.
// flags rather than silently deletes, so the report stays legible.
function scrubUngroundedFigures(
  report: Record<string, unknown>,
  fetchedContent: string,
): Record<string, unknown> {
  const figureRegex = /(₹\s?[\d,]+|\$\s?[\d,]+|[\d]+%)/g;

  function scanAndFlag(value: unknown): unknown {
    if (typeof value === "string") {
      return value.replace(figureRegex, (match) => {
        return fetchedContent.includes(match.trim())
          ? match
          : `${match} [unverified — not found in fetched page content]`;
      });
    }
    if (Array.isArray(value)) return value.map(scanAndFlag);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          scanAndFlag(v),
        ]),
      );
    }
    return value;
  }

  return scanAndFlag(report) as Record<string, unknown>;
}

// ---------- prompt building ----------

function buildSystemPrompt(accessStatus: Record<PageKey, PageResult>): string {
  return `You are generating an AOV (average order value) strategy report for Troopod, a D2C website growth agency.

HARD RULES:
- Never invent a price, discount percentage, or specific page copy that isn't present in the page content given to you below.
- If a page's content is marked "not_provided" or "not_accessible", do not describe or analyze that page. State plainly that it wasn't available.
- If a page is "partial", say explicitly what wasn't visible (e.g. price, offer mechanics) instead of guessing.
- For competitor research, only include competitors you can verify are real and currently operating in this category. State your confidence level for each: "direct page read" if you fetched their site, "search-based" if only from search snippets.
- Return ONLY valid JSON matching this exact shape, no markdown fences, no preamble:

{
  "diagnosis": "string",
  "improvements": [{"mechanism": "string", "applies_to": "pdp|home|collection", "detail": "string"}],
  "above_fold_structure": "string",
  "top_tests": [{"priority": 1, "test": "string", "why": "string"}],
  "offer_architecture": "string",
  "competitors": [{"name": "string", "confidence": "direct page read|search-based", "tactics": "string"}]
}

Page access status for this run: ${JSON.stringify(accessStatus, (k, v) => (k === "content" ? undefined : v))}`;
}

function buildUserPrompt(
  brandName: string,
  accessStatus: Record<PageKey, PageResult>,
): string {
  const sections = (Object.entries(accessStatus) as [PageKey, PageResult][])
    .map(([key, page]) => {
      if (page.status === "not_provided") return `### ${key}\nnot provided`;
      if (page.status === "not_accessible")
        return `### ${key}\nnot accessible: ${page.reason}`;
      const note = page.status === "partial" ? ` (partial: ${page.reason})` : "";
      return `### ${key}${note}\n${page.content}`;
    })
    .join("\n\n");

  return `Brand: ${brandName}\n\n${sections}\n\nGenerate the AOV strategy report per the schema and rules in the system prompt.`;
}

function corsHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, apikey",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(),
  });
}
