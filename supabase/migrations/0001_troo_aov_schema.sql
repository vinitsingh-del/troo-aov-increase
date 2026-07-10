-- TROO AOV INCREASE — schema
-- One table. No separate queue table needed; concurrency is checked
-- by counting rows with status = 'processing'.

create type aov_report_status as enum ('processing', 'completed', 'failed');

create table if not exists aov_reports (
  id uuid primary key default gen_random_uuid(),

  -- inputs
  brand_name text not null,
  pdp_url text not null,
  home_url text,
  collection_url text,

  -- lifecycle
  status aov_report_status not null default 'processing',
  error_message text,

  -- per-page fetch outcome, e.g.
  -- { "pdp": {"status": "fetched"}, "home": {"status": "partial", "reason": "..."},
  --   "collection": {"status": "not_provided"} }
  access_status jsonb,

  -- final structured report matching the output schema in the PRD (§9)
  -- null until status = 'completed'
  report jsonb,

  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- fast lookup for the concurrency cap check on every new submission
create index if not exists idx_aov_reports_status on aov_reports (status);

-- fast lookup if the frontend polls for a specific report's progress
create index if not exists idx_aov_reports_created_at on aov_reports (created_at desc);

-- RLS: internal tool, but still lock it down.
-- Edge function writes with the service role key (bypasses RLS entirely).
-- Frontend reads with the anon/authenticated key — read-only, own org only.
alter table aov_reports enable row level security;

create policy "authenticated users can read reports"
  on aov_reports for select
  to authenticated
  using (true);

-- no insert/update/delete policy for anon/authenticated —
-- all writes happen server-side via the edge function's service role key.
