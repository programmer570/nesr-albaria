/* ============================================================
   db-sync — دالة المزامنة والأرشفة بين قواعد البيانات (سيرفر)
   ------------------------------------------------------------
   التركيب: supabase functions deploy db-sync  (في كل مشروع من التلاتة)
   الأسرار المطلوبة في كل مشروع:
     ADMIN_EMAILS = "you@email.com"            (مين يقدر ينادي الدالة)
     STANDBYS = '[{"url":"https://xxx.supabase.co","service_key":"sb_secret_..."}]'
                (القواعد التانية — في مشروع #1 ضيف التلاتة؟ لا: ضيف التانيين فقط
                 وفي #2 ضيف #1 و#3 وهكذا — أو ضيف الكل والدالة بتتجاهل نفسها)
   ------------------------------------------------------------
   actions:
     sync    → نسخ كل الجداول + الصور + المستخدمين من النشط للمرتبتين
     archive → أرشفة البيانات القديمة (أقدم من N يوم) + مسحها (حل الـ 500MB)
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* الجداول المُمزامنة + مفتاحها الأساسي (بالترتيب: الأولاد قبل الآباء) */
const TABLES = [
  { name: "categories", pk: "id" },
  { name: "products", pk: "id" },
  { name: "site_settings", pk: "key" },
  { name: "payment_settings", pk: "method" },
  { name: "shipping_rates", pk: "city" },
  { name: "orders", pk: "id" },
  { name: "order_items", pk: "id" },
  { name: "order_payments", pk: "id" },
  { name: "payment_audit_log", pk: "id" },
  { name: "customer_addresses", pk: "id" },
  { name: "push_subscriptions", pk: "endpoint" },
  { name: "admin_notifications", pk: "id" },
  { name: "broadcast_notifications", pk: "id" },
  { name: "ai_knowledge", pk: "id" },
  { name: "admin_stat_events", pk: "id" },
];

/* جداول الأرشفة (بتتمسح من القاعدة بعد التصدير) */
const ARCHIVE_TABLES = [
  { name: "orders", dateCol: "created_at" },
  { name: "payment_audit_log", dateCol: "created_at" },
  { name: "admin_stat_events", dateCol: "created_at" },
  { name: "admin_notifications", dateCol: "created_at" },
];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function getStandbys(): { url: string; service_key: string }[] {
  try {
    const raw = Deno.env.get("STANDBYS") || "[]";
    const list = JSON.parse(raw);
    return (Array.isArray(list) ? list : []).filter(
      (s) => s && s.url && s.service_key && s.url !== SUPABASE_URL
    );
  } catch {
    return [];
  }
}

/* قراءة كل صفوف جدول (بالصفحات) */
async function readAll(db: any, table: string, pk: string): Promise<any[]> {
  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select("*").order(pk, { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`read ${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

/* ---------- المزامنة ---------- */
async function doSync(local: any) {
  const standbys = getStandbys();
  if (!standbys.length) {
    return json({ ok: false, error: "مفيش قواعد احتياطية مضافة في سر STANDBYS بعد" }, 400);
  }
  const remote = standbys.map((s) => ({ meta: s, db: createClient(s.url, s.service_key, { auth: { persistSession: false } }) }));
  const report: any = { syncedRows: 0, syncedFiles: 0, deletedStale: 0, tables: {}, users: 0 };
  const myUrl = SUPABASE_URL;

  for (const t of TABLES) {
    const rows = await readAll(local, t.name, t.pk);
    report.tables[t.name] = rows.length;
    for (const r of remote) {
      /* upsert بالدفعات */
      for (const part of chunk(rows, 400)) {
        const { error } = await r.db.from(t.name).upsert(part, { onConflict: t.pk });
        if (error) throw new Error(`upsert ${t.name} -> ${r.meta.url}: ${error.message}`);
        report.syncedRows += part.length;
      }
      /* مسح الصفوف المفقودة (ليست في المصدر) */
      const { data: remoteRows, error: rerr } = await r.db.from(t.name).select(t.pk);
      if (!rerr && remoteRows) {
        const sourceSet = new Set(rows.map((x: any) => String(x[t.pk])));
        const stale = remoteRows.map((x: any) => x[t.pk]).filter((k: any) => !sourceSet.has(String(k)));
        for (const part of chunk(stale, 200)) {
          const { error } = await r.db.from(t.name).delete().in(t.pk, part);
          if (error) throw new Error(`cleanup ${t.name}: ${error.message}`);
          report.deletedStale += part.length;
        }
      }
    }
  }

  /* ---- مزامنة الصور (Storage) ---- */
  const { data: buckets } = await local.storage.listBuckets();
  for (const b of buckets || []) {
    const files = await walkStorage(local, b.name, "");
    for (const f of files) {
      const { data: blob, error } = await local.storage.from(b.name).download(f.path);
      if (error || !blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      for (const r of remote) {
        const { error: upErr } = await r.db.storage.from(b.name).upload(f.path, bytes, {
          upsert: true,
          contentType: f.mime || "application/octet-stream",
        });
        if (!upErr) report.syncedFiles++;
      }
    }
  }

  /* ---- مزامنة المستخدمين (حسابات بالإيميل — بدون كلمات سر) ---- */
  try {
    let page = 1;
    for (;;) {
      const { data: lu } = await (local as any).auth.admin.listUsers({ page, perPage: 200 });
      const users = lu?.users || [];
      if (!users.length) break;
      for (const u of users) {
        if (!u.email) continue;
        for (const r of remote) {
          const { error } = await (r.db as any).auth.admin.createUser({
            email: u.email,
            email_confirm: true,
            password: crypto.randomUUID() + "Aa1!", // مؤقت — المستخدم يدخل بـ OTP
          });
          if (!error) report.users++;
        }
      }
      if (users.length < 200) break;
      page++;
    }
  } catch { /* أخطاء المستخدمين مش بتوقف المزامنة */ }

  return json({ ok: true, ...report, source: myUrl, standbys: standbys.map((s) => s.url) });
}

/* مشي شجرة الملفات في Storage */
async function walkStorage(db: any, bucket: string, prefix: string): Promise<{ path: string; mime?: string }[]> {
  const out: { path: string; mime?: string }[] = [];
  const { data, error } = await db.storage.from(bucket).list(prefix, { limit: 1000 });
  if (error || !data) return out;
  for (const item of data) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id === null || item.id === undefined) {
      out.push(...(await walkStorage(db, bucket, path)));
    } else {
      out.push({ path, mime: (item.metadata && item.metadata.mimetype) || undefined });
    }
  }
  return out;
}

/* ---------- الأرشفة ---------- */
async function doArchive(local: any, beforeDays: number) {
  const days = beforeDays > 0 ? beforeDays : 90;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const report: any = { archivedRows: 0, files: [], cutoff };

  for (const t of ARCHIVE_TABLES) {
    const { data: rows, error } = await local.from(t.name).select("*").lt(t.dateCol, cutoff).order(t.dateCol, { ascending: true }).limit(20000);
    if (error) throw new Error(`archive read ${t.name}: ${error.message}`);
    if (!rows || !rows.length) continue;

    /* صدّر كملف JSON في bucket archives */
    await local.storage.createBucket("archives", { public: false }).catch(() => {});
    const stamp = new Date().toISOString().slice(0, 7);
    const fileName = `${t.name}-${stamp}-${Date.now()}.json`;
    const blob = new Blob([JSON.stringify({ table: t.name, cutoff, count: rows.length, rows }, null, 1)], { type: "application/json" });
    const { error: upErr } = await local.storage.from("archives").upload(fileName, blob, { upsert: true, contentType: "application/json" });
    if (upErr) throw new Error(`archive upload: ${upErr.message}`);
    report.files.push(fileName);

    /* امسح الصفوف الأصلية (بالمجموعات) */
    const ids = rows.map((r: any) => r.id).filter((x: any) => x != null);
    for (const part of chunk(ids, 500)) {
      const { error: delErr } = await local.from(t.name).delete().in("id", part);
      if (delErr) throw new Error(`archive delete ${t.name}: ${delErr.message}`);
    }
    report.archivedRows += rows.length;
  }

  /* بعد الأرشفة شغّل مزامنة عادية → المرتبتين هتمسح نفس الصفوف تلقائيًا */
  report.note = "شغّل action=sync دلوقتي لمزامنة المسح مع المرتبتين";
  return json({ ok: true, ...report });
}

/* ---------- نقطة الدخول ---------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    /* تحقق من الهوية: لازم مسجّل دخول + إيميله ضمن ADMIN_EMAILS */
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const local = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: ud, error: uerr } = await local.auth.getUser(jwt);
    const email = (ud?.user?.email || "").toLowerCase();
    const admins = (Deno.env.get("ADMIN_EMAILS") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

    if (uerr || !email) return json({ ok: false, error: "لازم تسجّل دخول الأول" }, 401);
    if (!admins.length) return json({ ok: false, error: "اضبط سر ADMIN_EMAILS في إعدادات الدالة" }, 403);
    if (!admins.includes(email)) return json({ ok: false, error: "غير مصرح لك" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "sync";
    if (action === "sync") return await doSync(local);
    if (action === "archive") return await doArchive(local, Number(body.before_days) || 90);
    return json({ ok: false, error: `action غير معروفة: ${action}` }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
