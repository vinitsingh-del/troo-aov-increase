# PRD: TROO AOV INCREASE

**Internal tool — Troopod**
**Owner:** Neeraj Joshi
**Status:** Draft for build
**Version:** 1.0

---

## 1. Problem

KAM and strategy team manually audits client PDP/home/collection pages to figure out why AOV is capped, then manually researches competitors. Takes 2-3 hours per brand, output quality depends on who's writing it. This tool automates the read, diagnosis, and competitor research into one report in Troopod's format, in under a minute.

## 2. Goal

Given a PDP link (+ optional home/collection links) and a brand name, produce a prioritized AOV strategy report that is:
- grounded only in what was actually read from the live pages (no invented prices, offers, or copy)
- explicit about what it could and couldn't access
- benchmarked against 3 real, verifiable competitors

## 3. Non-goals

- Not a CRO audit tool (that's TrooCRO engine's job — this is AOV-specific)
- Not a live monitoring/tracking tool. One-shot report per submission.
- Not implementing the recommendations. Output is a report, not code or a deployed page.
- No login-gated or paywalled page support in v1.

## 4. Users

Internal only (KAM team — Poulami, Saakshi, Shivanshu — and strategy). Not client-facing in v1. No auth beyond existing Troopod internal access.

## 5. Inputs

| Field | Required | Validation |
|---|---|---|
| PDP link | Yes | Must be a valid URL, must resolve (HTTP 200 on fetch) |
| Home page link | No | Same validation, skipped if blank |
| Collection page link | No | Same validation, skipped if blank |
| Brand name | Yes | Free text, used for competitor search framing |

Submit is disabled until PDP link + brand name are present and PDP link passes a basic URL-shape check client-side (regex, not a live fetch) before hitting the backend.

## 6. Core flow

1. User pastes links + brand name, hits submit.
2. Backend fetches each provided URL.
3. For each successfully fetched page, extract: price(s), variant/offer structure, visible CTAs, any bundle/quantity-break/subscription mechanics, page sections present.
4. Backend calls Claude API (web search enabled) with the extracted content + brand name, asks it to:
   - diagnose why AOV is capped
   - generate the prioritized report sections (see §9)
   - search for and validate 3 real competitors in the same category, summarizing their AOV mechanics
5. Report renders in Troopod's black/purple/crimson style, with a per-page access-status banner at the top.
6. User can copy or download the report.

## 7. Architecture

- **Frontend:** single-page React app. Form → loading state → report view.
- **Backend:** one endpoint (`/analyze`) that:
  - fetches the 1-3 URLs server-side (not client-side, to avoid CORS and to control timeouts/retries)
  - passes fetched HTML/text + brand name to Claude API with `web_search` tool enabled
  - returns structured JSON matching the report schema (§9), which the frontend renders — not raw markdown, so partial/error states can be handled per-section
- **No persistent storage in v1.** Each report is generated fresh, not saved server-side. If the person wants report history, that's a v2 ask (flag it, don't build it now).

## 8. Edge cases and handling

This is the part that actually needs to work, so it's split by failure surface.

### 8.1 Input edge cases

| Case | Handling |
|---|---|
| Malformed URL | Client-side validation blocks submit, inline error: "that doesn't look like a valid link" |
| Only PDP given, no home/collection | Valid. Report proceeds, competitor/cross-reference sections note "home page not provided, structural comparison limited to PDP" |
| Same URL pasted in multiple fields | Backend dedupes fetches, report treats it as one page, notes it was reused |
| Non-D2C / non-ecommerce URL pasted (e.g. a blog) | Model is instructed to detect this from page content, not URL pattern. If no product/price/CTA structure is found, report flags: "this page doesn't appear to be a product/home/collection page. Diagnosis not possible from this input" and stops rather than fabricating a product analysis |
| Brand name doesn't match domain (e.g. brand "Mia" but URL is a marketplace listing) | Proceeds, but report notes the mismatch and treats the page as-is rather than assuming brand identity from the name |

### 8.2 Fetch/access edge cases

This is the most important section — it's the actual "no hallucination" enforcement mechanism, not just a prompt instruction.

| Case | Handling |
|---|---|
| Page fetch times out (set at 15s) | Marked "couldn't access" for that page. Report still generates using whatever pages did succeed. If PDP itself fails, report cannot proceed (PDP is required) — return a clear error to the user instead of a partial report, since PDP is the anchor page |
| Page returns non-200 (404, 403, 500) | Same as above — "couldn't access," reason shown (e.g. "site returned 403, likely bot-blocked") |
| Page is JS-rendered (React/Vue SPA, empty initial HTML) | Backend fetch uses a headless-render step (Playwright), not a raw HTTP GET, specifically because Troopod's own PDP builds and most D2C sites are JS-heavy. If even the rendered DOM has no visible price/product content after render, mark "partial read" and say what was and wasn't visible |
| Page is geo-blocked or region-locked | Fetch attempted, if blocked, marked "couldn't access," reason noted. No retry-through-proxy in v1 — flag as a known limitation rather than building region-spoofing |
| Page loads but price is hidden behind a variant selector / JS interaction (not in initial DOM even after render) | Marked "partial read" — report explicitly states "price not visible in static read, variant-level pricing not captured" rather than guessing a price from the category or competitor average |
| Page has multiple prices (variants, currencies) | Model instructed to report the range as seen, not average or pick one arbitrarily. If ambiguous, state the ambiguity in the report rather than silently choosing one |
| robots.txt disallows fetching | Respect it — mark "couldn't access, blocked by site's robots.txt" rather than bypassing |
| URL redirects (short link, UTM-tagged link) | Follow up to 3 redirects, use final resolved URL for the report's reference. If it redirects to something clearly unrelated (link rot), mark "couldn't access — resolved to an unrelated page" |
| Page is a Shopify password-protected/pre-launch page | Marked "couldn't access — page is gated," no attempt to bypass |

**Hard rule enforced in the prompt and checked in post-processing:** if the model's diagnosis or offer architecture references a price, discount percentage, or specific copy that doesn't trace back to fetched content, that section is rejected and regenerated with a note instead of shipped silently. This is a backend check (grep the model's output for currency/percentage patterns and cross-reference against extracted page content), not just a prompt instruction, since prompt instructions alone don't reliably stop this.

### 8.3 Competitor research edge cases

| Case | Handling |
|---|---|
| Model can't find 3 clearly comparable competitors (very niche category) | Ships with however many it can verify (could be 1-2), states this explicitly rather than padding with weak or unrelated matches |
| Competitor's own site can't be fetched for verification | Uses web search snippet-level info only, marks that competitor's section as "based on search results, not a direct page read" — different confidence tier than the client's own pages, which get a full fetch |
| Competitor turns out to be a Troopod client itself | No special handling needed, but the model is told not to fabricate confidentiality concerns — it just reports what's publicly visible on the live page, same as any competitor |
| Category is ambiguous from one PDP alone (e.g. a ring could be "fine jewelry" or "fashion jewelry" with very different competitor sets) | Model uses brand name + price point + page content together to infer category, and states its category assumption in the report so it can be corrected |

### 8.4 Model/API edge cases

| Case | Handling |
|---|---|
| Claude API call fails/times out | Retry once, then surface a clear error to the user ("report generation failed, try again") rather than a blank or broken report |
| Model returns malformed JSON (breaks frontend rendering) | Backend validates against the schema before sending to frontend; on failure, retry the call once with the same input before failing out |
| Model output exceeds expected length / rambles | Schema-constrained output (§9 fields, not free-form) keeps this bounded structurally |
| Report generation partially succeeds (e.g. competitor section fails, rest succeeds) | Sections render independently on the frontend — one failed section shows an inline retry button, doesn't block the rest of the report |
| Two people submit at once (rate/cost control) | Simple queue or concurrent-request cap server-side; if hit, user sees "another report is generating, try again shortly" rather than a silent failure |

### 8.5 Output/report edge cases

| Case | Handling |
|---|---|
| All 3 pages fail to fetch | Report doesn't generate at all — clear error state, not a hallucinated "generic AOV advice" report |
| Only PDP succeeds, home/collection fail or weren't given | Report generates, clearly scoped to PDP-only, cross-page recommendations (e.g. "collection page doesn't reinforce PDP's bundle") are omitted rather than guessed |
| Nothing about AOV mechanics is currently on the page (no bundles, no quantity breaks, single SKU) | This isn't an error — it's expected and becomes part of the diagnosis itself ("zero AOV mechanics currently present" is a valid, common finding) |

## 9. Output schema (report sections)

Returned as structured JSON, rendered by frontend:

1. **Access status** — per page: fetched / partial / couldn't access, plus reason if not full
2. **CRO diagnosis** — why AOV is capped, grounded in what was read
3. **Top 15-20 AOV improvements** — each with a named mechanism (quantity break, bundle, order bump, subscription, progress bar, etc.) and which page it applies to
4. **Recommended above-the-fold structure**
5. **Top 5 tests to run first** — priority table
6. **Ideal offer architecture**
7. **Competitor AOV playbook** — 3 competitors, confidence tier per competitor (direct read vs. search-based)

## 10. Design spec

Troopod system: black background, purple/white type, crimson (`#d14a61`) accents. Clean report layout. Copy and download (PDF) actions on the finished report. Loading state shows real progress ("fetching PDP", "reading collection page", "researching competitors") rather than a generic spinner, since the 30-60s wait is real and unhidden progress reduces the "is this stuck" instinct.

## 11. Out of scope for v1

- Report history/save
- Client-facing version
- Auto-retry through proxies for geo/bot-blocked pages
- Multi-language page support (assume English pages for v1, flag if non-English content detected rather than mistranslating)

## 12. Open questions for you to confirm before build

- Confirm Playwright-based fetch (needed for JS-rendered pages) vs. simple HTTP fetch — recommend Playwright given most Troopod client sites are JS-heavy
- Confirm PDF download is needed for v1 or copy-to-clipboard is enough
- Confirm whether this lives as a standalone internal URL or inside an existing Troopod internal tool shell
