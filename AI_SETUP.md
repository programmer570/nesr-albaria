# تشغيل المساعد الذكي (5 دقايق)

المساعد دلوقتي بيكلّم دالة Supabase اسمها `nasr-ai` (بدل سيرفر AI Studio القديم). لو الدالة لسه مش متركّبة بيرجع تلقائيًا للنظام القديم، فمفيش حاجة هتبوظ.

## 1) ركّب الدالة
من Supabase Dashboard ← Edge Functions ← Create function باسم `nasr-ai` والصق محتوى `supabase/functions/nasr-ai/index.ts`.
أو بالـ CLI:
```
supabase functions deploy nasr-ai --no-verify-jwt --project-ref jknvoihcxgdpcctvnhab
```
(لازم `--no-verify-jwt` أو من إعدادات الدالة أوقف "Verify JWT"، لأن المتصفح بيبعت المفتاح العام.)

## 2) أضف مفتاح الذكاء الاصطناعي (واحد بس)
```
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...      # Claude
# أو
supabase secrets set GEMINI_API_KEY=...                 # Gemini (فيه باقة مجانية)
```
اختياري: `AI_MODEL` لتغيير الموديل، `AI_WEB_SEARCH=0` لإيقاف البحث في الإنترنت.

## 3) (اختياري) ملاحظات تعلّم المساعد أي حاجة جديدة
شغّل `supabase/ai_knowledge.sql` في SQL Editor، وبعدها أي صف تضيفه في جدول `ai_knowledge` (عنوان + محتوى) المساعد يعرفه بعد دقيقة.

## المساعد بيعرف إيه تلقائيًا؟
كل منتج/سعر/مخزون/قسم/شحن/دفع/باقة/كارت واي فاي/إعلان، والأقسام الظاهرة في الموقع، أزرار التنقل، أرقام ووسائل التواصل، أحدث المنتجات والمتعدّلة آخر 14 يوم، والتاريخ والوقت. أي تعديل في لوحة الإدارة يوصله لحظيًا لأنه بياخد لقطة حية مع كل سؤال.

## التحكم في المقاسات (في آخر index.html، بلوك `:root` داخل `nasr-fit-v2`)
- `--nf-shell` عرض التطبيق الموحّد على كل الأجهزة (480px).
- `--nf-strip-ratio` نسبة إطار الأشرطة والإعلانات (4/5).
- `--nf-hero-ratio` نسبة الشاشة الرئيسية (3/2).
