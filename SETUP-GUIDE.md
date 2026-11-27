# 🛠️ دليل التركيب — قواعد البيانات الاحتياطية (15 دقيقة)

## الخطوة 1️⃣ — أنشئ مشروعين Supabase جداد (5 دقايق)
1. ادخل [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**
2. المشروع التاني: اسمه `nasr-db2` (أي منطقة — الأقرب لمصر: Frankfurt)
3. المشروع التالت: اسمه `nasr-db3`
4. من صفحة كل مشروع: **Settings → API** واكتب في مكان آمن:
   - `Project URL` (زي `https://xxxx.supabase.co`)
   - `anon/publishable key` (بتبدأ بـ `sb_publishable_`)

## الخطوة 2️⃣ — انسخ قاعدة البيانات الأصلية (3 دقايق)
### الطريقة الأدق (موصى بها):
```bash
# من جهازك (محتاج supabase CLI + رابط قاعدة البيانات من Settings → Database)
supabase db dump --db-url "postgres://postgres:PASSWORD@db.jknvoihcxgdpcctvnhab.supabase.co:5432/postgres" > nasr-dump.sql

# بعدين على كل مشروع جديد (من SQL Editor الصق محتوى nasr-dump.sql)
# أو بالأمر:
psql "postgres://...של db2..." -f nasr-dump.sql
psql "postgres://...של db3..." -f nasr-dump.sql
```
### الطريقة الاحتياطية:
شغّل `SQL/setup-standby.sql` في SQL Editor لكل مشروع جديد.

## الخطوة 3️⃣ — شغّل الهجرة على التلاتة
شغّل `SQL/migration-user-email.sql` في SQL Editor على **db1 وdb2 وdb3**.

## الخطوة 4️⃣ — ركّب دالة db-sync في التلاتة
من كل مشروع: **Edge Functions → Deploy new function → اسمها `db-sync`** → الصق محتوى
`supabase/functions/db-sync/index.ts`.
بعدين من **Settings → Edge Functions → Secrets** ضيف:

| السر | القيمة |
|-----|-------|
| `ADMIN_EMAILS` | إيميلك (أو أكتر بفاصلة) |
| `STANDBYS` | شوف الأسفل 👇 |

**القيمة `STANDBYS`** (JSON) — في مشروع **db1** ضيف عناوين ومفاتيح **db2 وdb3**:
```json
[{"url":"https://XXXX.supabase.co","service_key":"sb_secret_..."},{"url":"https://YYYY.supabase.co","service_key":"sb_secret_..."}]
```
> مفتاح `service_key` (sb_secret_) تاخده من Settings → API → **service_role** — **ماتحطهوش أبدًا في كود الموقع** — السيرفر بس اللي بيشوفه.

## الخطوة 5️⃣ — ضيف القواعد في الموقع
افتح `db-router.js` واملأ سطور `db2` و`db3`:
```js
{ id: 'db2', label: '🟡 الاحتياطي الأول', url: 'https://XXXX.supabase.co', key: 'sb_publishable_...' },
{ id: 'db3', label: '🟢 الاحتياطي الثاني', url: 'https://YYYY.supabase.co', key: 'sb_publishable_...' },
```

## الخطوة 6️⃣ — المزامنة الأولى 🎉
1. ارفع التعديلات (git push)
2. ادخل لوحة الإدارة → قسم **"قاعدة البيانات والمزامنة"** → اضغط **"🔄 مزامنة الآن"**
3. خلاص! النقل بقى آلي — والزرار بيبان فيه القاعدة النشطة ونسبة الحجم

---

## ❓ أسئلة سريعة

**إزاي أعرف إن النقل حصل؟**
Toast في الموقع: "تم النقل لقاعدة احتياطية ✅" + العداد في لوحة الإدارة.

**الطلبات القديمة بتضيع؟**
لا — مزامنة كاملة دايمًا + الأرشفة بتفضل ملفات JSON قابلة للتحميل.

**لو عايز أرجع للأساسي؟**
لوحة الإدارة → "نقل يدوي" → ⭐ الأساسي (بعد ما تظبطه).

**كلمات السر بعد النقل؟**
الحساب موجود بالإيميل — ادخل بـ **كود OTP** أو "نسيت كلمة المرور" مرة واحدة.
دخول Google بيشتغل تلقائيًا.
