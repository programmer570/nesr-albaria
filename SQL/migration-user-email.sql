-- ============================================================
-- migration-user-email.sql — شغّله على المشروع الأصلي + الاحتياطية
-- ------------------------------------------------------------
-- 1) عمود user_email للطلبات والعنوين (ربط مستقل عن uid بعد أي نقل)
-- 2) دالة place_store_order_v3 (نفس v2 + بتحفظ الإيميل)
-- 3) db_health() على المشروع الأصلي كمان
-- ============================================================

-- 1) الأعمدة
alter table orders add column if not exists user_email text;
alter table customer_addresses add column if not exists user_email text;
create index if not exists idx_orders_email on orders(user_email);

-- استرجاع الإيميلات القديمة من notes (كان بيتسجل فيها سطر "البريد: ...")
update orders
set user_email = lower(trim(substring(notes from 'البريد:\s*([^\s|]+)')))
where user_email is null
  and notes ~ 'البريد:\s*';

-- 2) غلاف v3 فوق v2 (نفس أسماء المعاملات اللي في الكود)
create or replace function place_store_order_v3(
  p_customer_name text,
  p_phone text,
  p_address text,
  p_city text,
  p_notes text,
  p_items jsonb,
  p_payment_method text,
  p_upfront_channel text default null,
  p_upfront_amount numeric default null,
  p_transaction_ref text default null,
  p_proof_path text default null,
  p_user_email text default null
) returns bigint
language plpgsql security definer as $$
declare
  v_id bigint;
begin
  select place_store_order_v2(
    p_customer_name, p_phone, p_address, p_city, p_notes,
    p_items, p_payment_method, p_upfront_channel,
    p_upfront_amount, p_transaction_ref, p_proof_path
  ) into v_id;

  if p_user_email is not null and v_id is not null then
    update orders set user_email = lower(p_user_email) where id = v_id;
  end if;
  return v_id;
end $$;

-- اسمح للـ anon والـ authenticated (زي v2)
grant execute on function place_store_order_v3(text,text,text,text,text,jsonb,text,text,numeric,text,text,text) to anon, authenticated;

-- 3) دالة صحة القاعدة
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

-- 4) سياسة القراءة للعميل بالإيميل (مكملة للي في setup-standby.sql)
drop policy if exists own_orders on orders;
create policy own_orders on orders for select to authenticated
  using (user_id = auth.uid() or lower(user_email) = lower(coalesce(auth.jwt()->>'email','')));
