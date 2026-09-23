create table if not exists kofia_rates (
  tenor text primary key,
  rate numeric not null,
  change_bp numeric not null,
  as_of_date date not null,
  updated_at timestamptz not null default now()
);

alter table kofia_rates enable row level security;

create policy "anyone can read kofia_rates"
  on kofia_rates for select
  using (true);

create table if not exists credit_events (
  event_key text primary key,
  company_nm text not null,
  agency text not null,
  rating text,
  outlook text,
  bond_series text,
  estimate_day date not null,
  report_url text,
  updated_at timestamptz not null default now()
);

alter table credit_events enable row level security;

create policy "anyone can read credit_events"
  on credit_events for select
  using (true);
