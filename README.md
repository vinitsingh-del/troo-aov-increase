# TROO AOV INCREASE

Internal Troopod tool. Paste a PDP (+ optional home/collection page) and a brand name,
get back a grounded AOV strategy report with a competitor playbook. See `PRD.md` for
the full spec.

## Architecture

- **Frontend** — `index.html` at the repo root, a static single-file page. Hosted via
  GitHub Pages. It never calls Claude directly — it only calls your deployed backend
  function.
- **Backend** — `supabase/functions/analyze-aov`, a Supabase edge function. It fetches
  the given URLs server-side (avoids CORS, controls timeouts), calls Claude with web
  search enabled, and returns structured JSON. This has to run on Supabase — GitHub
  Pages cannot execute server functions.
- **Database** — `supabase/migrations/0001_troo_aov_schema.sql`, one table
  (`aov_reports`) that logs each run and its status.
- **Supabase config** — `supabase/config.toml` exposes `analyze-aov` without JWT
  verification so the GitHub Pages frontend can call it directly. The function itself
  still uses the service role key server-side for database writes.

## 1. Deploy the backend (required before the page will actually generate anything)

```bash
supabase link --project-ref <your-project-ref>
supabase db push
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set RENDER_SERVICE_URL=https://your-render-service   # optional, see note below
supabase secrets set MAX_CONCURRENT_REPORTS=3                          # optional, default 3
supabase functions deploy analyze-aov
```

This gives you a URL like:
`https://<project-ref>.supabase.co/functions/v1/analyze-aov`

### RENDER_SERVICE_URL note

Deno edge functions can't run a headless browser. Most D2C sites (JS-rendered SPAs)
return an empty shell on a plain fetch, no price in the initial HTML. `RENDER_SERVICE_URL`
should point at a small renderer (Browserless, ScrapingBee, or your own Playwright
microservice accepting `{ url }` and returning `{ html }`). Without it, JS-heavy pages
will often come back "partial" or "not accessible" rather than fully fetched — flagged
as a known v1 gap in the PRD, worth deciding on before relying on this for real client PDPs.

## 2. Point the frontend at your backend

Open the deployed GitHub Pages URL, paste your Supabase function URL into the
**Supabase Edge Function URL** field at the top. It's saved in that browser's local
storage, so you only set it once per browser.

## 3. Calling the backend directly (for testing without the UI)

```
POST /functions/v1/analyze-aov
Content-Type: application/json

{
  "brand_name": "Mia by Tanishq",
  "pdp_url": "https://...",
  "home_url": "https://...",       // optional
  "collection_url": "https://..." // optional
}
```

Responses:
- `200` — `{ report_id, access_status, report }`
- `422` — PDP wasn't accessible, report was not generated (PDP is the required anchor page)
- `429` — hit the concurrency cap, retry shortly
- `400` — bad input
- `500` — internal/model failure after one retry

## What's deliberately not here (v1 scope, see PRD §11)

- No report history / save endpoint
- No client-facing version, internal only
- No auto-retry through proxies for geo/bot-blocked pages
- English-language pages assumed

## Hosting note

This repo's `index.html` is served as-is by GitHub Pages (Settings → Pages → branch
`main`, folder `/`). The `supabase/` folder is just source code sitting in the same
repo for convenience — Pages ignores it, it only gets used when you run the
`supabase functions deploy` command above.
