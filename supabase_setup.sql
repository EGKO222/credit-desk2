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

create table if not exists top_trades (
  trade_date date not null,
  issuer text not null,
  rating text,
  amount_eok numeric not null,
  trade_count integer not null,
  updated_at timestamptz not null default now(),
  primary key (trade_date, issuer)
);

alter table top_trades enable row level security;

create policy "anyone can read top_trades"
  on top_trades for select
  using (true);

create table if not exists sector_volume (
  trade_date date not null,
  sector text not null,
  volume_jo numeric not null,
  updated_at timestamptz not null default now(),
  primary key (trade_date, sector)
);

alter table sector_volume enable row level security;

create policy "anyone can read sector_volume"
  on sector_volume for select
  using (true);

create table if not exists spreads (
  trade_date date not null,
  category_type text not null,
  category_name text not null,
  spread_bp numeric not null,
  updated_at timestamptz not null default now(),
  primary key (trade_date, category_type, category_name)
);

alter table spreads enable row level security;

create policy "anyone can read spreads"
  on spreads for select
  using (true);

create table if not exists investment_opinions (
  research_id bigint primary key,
  title text not null,
  broker_name text not null,
  write_date date not null,
  url text not null,
  updated_at timestamptz not null default now()
);

alter table investment_opinions enable row level security;

create policy "anyone can read investment_opinions"
  on investment_opinions for select
  using (true);
