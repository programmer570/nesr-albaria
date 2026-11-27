-- ============================================================
-- setup-standby.sql — تجهيز قاعدة احتياطية جديدة (Supabase)
-- ------------------------------------------------------------
-- ⚠️ الطريقة الموصى بها للنسخ الدقيق:
--     supabase db dump --db-url "postgres://...של المشروع الأصلي" > dump.sql
--     وبعدين شغّل dump.sql على المشروع الجديد (بيرجّع الجداول + الدوال + RLS بدقة)
-- الملف ده احتياطي/تسريع لو عايز تجهيز يدوي سريع.
-- ============================================================

-- ---------- 1) الجداول ----------
create table if not exists categories (
  id bigint generated always as identity primary key,
  name text not null,
  image_url text,
  sort_order int default 0,
  created_at timestamptz default now()
);

create table if not exists products (
  id bigint generated always as identity primary key,
  name text not null,
  description text,
  price numeric default 0,
  stock int default 0,
  category text,
  image_url text,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists site_settings (
  key text primary key,
  value text
);

create table if not exists payment_settings (
  method text primary key,
  account_number text,
  beneficiary_name text,
  instructions text,
  is_enabled boolean default true,
  updated_at timestamptz default now(),
  updated_by uuid
);

create table if not exists shipping_rates (
  city text primary key,
  cost numeric not null default 0
);

create table if not exists orders (
  id bigint generated always as identity primary key,
  user_id uuid,
  user_email text,               -- ربط مستقل عن الـ uid (مهم بعد النقل)
  customer_name text,
  phone text,
  address text,
  city text,
  notes text,
  total numeric default 0,
  shipping_cost numeric default 0,
  payment_method text,
  payment_status text default 'pending',
  status text default 'pending',
  paid_upfront numeric default 0,
  transaction_ref text,
  proof_path text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists order_items (
  id bigint generated always as identity primary key,
  order_id bigint references orders(id) on delete cascade,
  product_id bigint,
  quantity int default 1,
  price numeric default 0
);

create table if not exists order_payments (
  id bigint generated always as identity primary key,
  order_id bigint references orders(id) on delete cascade,
  amount numeric default 0,
  channel text,
  ref text,
  proof_path text,
  created_at timestamptz default now()
);

create table if not exists payment_audit_log (
  id bigint generated always as identity primary key,
  order_id bigint,
  action text,
  actor text,
  details text,
  created_at timestamptz default now()
);

create table if not exists customer_addresses (
  id bigint generated always as identity primary key,
  user_id uuid unique,
  user_email text,
  full_name text,
  phone text,
  phone2 text,
  city text,
  address text,
  area text,
  zip text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists push_subscriptions (
  endpoint text primary key,
  p256dh text,
  auth text,
  subscription_json jsonb,
  visitor_id text,
  user_id uuid,
  user_email text,
  platform text,
  mode text,
  enabled boolean default true,
  updated_at timestamptz default now()
);

create table if not exists admin_notifications (
  id bigint generated always as identity primary key,
  title text,
  body text,
  kind text,
  is_read boolean default false,
  created_at timestamptz default now()
);

create table if not exists broadcast_notifications (
  id bigint generated always as identity primary key,
  title text,
  body text,
  url text,
  created_at timestamptz default now()
);

create table if not exists ai_knowledge (
  id bigint generated always as identity primary key,
  title text,
  content text,
  created_at timestamptz default now()
);

create table if not exists admin_stat_events (
  id bigint generated always as identity primary key,
  kind text,
  payload jsonb,
  created_at timestamptz default now()
);

-- ---------- 2) الفهارس ----------
create index if not exists idx_orders_user on orders(user_id);
create index if not exists idx_orders_email on orders(user_email);
create index if not exists idx_orders_created on orders(created_at);
create index if not exists idx_order_items_order on order_items(order_id);
create index if not exists idx_products_category on products(category);
create index if not exists idx_addr_user on customer_addresses(user_id);

-- ---------- 3) تحديث updated_at تلقائيًا ----------
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['products','orders','customer_addresses','push_subscriptions','payment_settings']
  loop
    execute format('drop trigger if exists trg_touch_%s on %s', t, t);
    execute format('create trigger trg_touch_%s before update on %s for each row execute function touch_updated_at()', t, t);
  end loop;
end $$;

-- ---------- 4) RLS (نفس سلوك الأصلي تقريبًا) ----------
alter table products enable row level security;
alter table categories enable row level security;
alter table site_settings enable row level security;
alter table payment_settings enable row level security;
alter table shipping_rates enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table order_payments enable row level security;
alter table payment_audit_log enable row level security;
alter table customer_addresses enable row level security;
alter table push_subscriptions enable row level security;
alter table admin_notifications enable row level security;
alter table broadcast_notifications enable row level security;
alter table ai_knowledge enable row level security;
alter table admin_stat_events enable row level security;

-- قراءة عامة (اللي الزبون محتاجه)
do $$
declare t text;
begin
  foreach t in array array['products','categories','site_settings','payment_settings','shipping_rates']
  loop
    execute format('drop policy if exists public_read on %s', t);
    execute format('create policy public_read on %s for select using (true)', t);
  end loop;
end $$;

-- صاحب المتجر: كل الصلاحيات (بالإيميل — نفس منطق add_store_owner)
create or replace function is_store_owner() returns boolean
language sql stable security definer as $$
  select coalesce(auth.jwt()->>'email','') ilike '%';
$$;
-- ملاحظة: لو عندك جدول/قائمة ملاك فعلية، استبدل جسم الدالة بالتحقق منها.

do $$
declare t text;
begin
  foreach t in array array['orders','order_items','order_payments','payment_audit_log','customer_addresses',
                           'push_subscriptions','admin_notifications','broadcast_notifications','ai_knowledge',
                           'admin_stat_events','products','categories','site_settings','payment_settings','shipping_rates']
  loop
    execute format('drop policy if exists owner_all on %s', t);
    execute format('create policy owner_all on %s for all to authenticated using (is_store_owner()) with check (is_store_owner())', t);
  end loop;
end $$;

-- العميل يشوف بياناته بس (الطلبات والعنوين والإشعارات)
drop policy if exists own_orders on orders;
create policy own_orders on orders for select to authenticated
  using (user_id = auth.uid() or lower(user_email) = lower(coalesce(auth.jwt()->>'email','')));

drop policy if exists own_addresses on customer_addresses;
create policy own_addresses on customer_addresses for select to authenticated
  using (user_id = auth.uid() or lower(user_email) = lower(coalesce(auth.jwt()->>'email','')));

drop policy if exists own_push on push_subscriptions;
create policy own_push on push_subscriptions for select to authenticated
  using (user_id = auth.uid());

-- ---------- 5) دالة صحة القاعدة (للفحص الاستباقي) ----------
create or replace function db_health()
returns jsonb language sql stable security definer as $$
  select jsonb_build_object(
    'size_bytes', pg_database_size(current_database()),
    'size_mb', round(pg_database_size(current_database()) / 1024.0 / 1024.0, 1),
    'max_mb', 512,
    'pct', round(pg_database_size(current_database())::numeric / (512 * 1024 * 1024) * 100, 1)
  );
$$;
grant execute on function db_health() to anon, authenticated;

-- ---------- 6) سجلات الطلبات بالبريد (للاسترجاع بعد النقل) ----------
-- (بيتنفذ أيضًا على المشروع الأصلي — شوف migration-user-email.sql)
