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
