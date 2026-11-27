/* ============================================================
   test-router.js — اختبارات محرك الفشل الآلي (NasrDBRouter)
   التشغيل: node test-router.js
   ============================================================ */
'use strict';

/* محاكاة localStorage لبيئة Node (المتصفح فيه أصلًا) */
if (!globalThis.localStorage) {
  const __store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (__store.has(k) ? __store.get(k) : null),
    setItem: (k, v) => __store.set(k, String(v)),
    removeItem: (k) => __store.delete(k),
    clear: () => __store.clear(),
  };
}

const { create, isFailoverError } = require('./db-router.js');

/* ---------- أدوات مسخرة (Mock) ---------- */
function makeBuilder(result) {
  const calls = [];
  const b = {
    calls,
    select() { calls.push(['select', [...arguments]]); return b; },
    eq() { calls.push(['eq', [...arguments]]); return b; },
    or() { calls.push(['or', [...arguments]]); return b; },
    order() { calls.push(['order', [...arguments]]); return b; },
    limit() { calls.push(['limit', [...arguments]]); return b; },
    maybeSingle() { calls.push(['maybeSingle', []]); return b; },
    single() { calls.push(['single', []]); return b; },
    upsert() { calls.push(['upsert', [...arguments]]); return b; },
    insert() { calls.push(['insert', [...arguments]]); return b; },
    update() { calls.push(['update', [...arguments]]); return b; },
    delete() { calls.push(['delete', []]); return b; },
    in() { calls.push(['in', [...arguments]]); return b; },
    then(onOk, onErr) {
      return Promise.resolve()
        .then(() => (typeof result === 'function' ? result() : result))
        .then(onOk, onErr);
    },
  };
  return b;
}

function makeCreateClient(behaviors) {
  // behaviors[url] = { from: (table)=>result|fn, rpc: (name)=>result|fn }
  const log = [];
  const fn = function (url, key) {
    log.push({ url, key });
    const beh = behaviors[url] || {};
    return {
      __url: url,
      from: (table) => {
        const r = beh.from ? beh.from(table) : { data: [], error: null };
        fn.lastBuilder = makeBuilder(r);
        return fn.lastBuilder;
      },
      rpc: (name, params) => {
        log.push({ url, rpc: name, params });
        const r = beh.rpc ? beh.rpc(name) : { data: null, error: null };
        return Promise.resolve(typeof r === 'function' ? r() : r);
      },
      auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
      storage: { from: () => ({ upload: () => Promise.resolve({ data: null, error: null }) }) },
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    };
  };
  fn.log = log;
  return fn;
}

const PROVIDERS = [
  { id: 'db1', label: 'main', url: 'https://db1.test', key: 'k1' },
  { id: 'db2', label: 'backup1', url: 'https://db2.test', key: 'k2' },
  { id: 'db3', label: 'backup2', url: 'https://db3.test', key: 'k3' },
];

/* ---------- harness ---------- */
let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name); }
}
async function run() {
  /* 1) تصنيف الأخطاء */
  console.log('\n🧪 1) تصنيف الأخطاء (isFailoverError)');
  assert(isFailoverError({ code: '53100', message: 'disk full' }), '53100 disk full → نقل');
  assert(isFailoverError({ message: 'Quota exceeded for project' }), 'quota exceeded → نقل');
  assert(isFailoverError({ message: 'Project is paused due to inactivity' }), 'project paused → نقل');
  assert(isFailoverError({ status: 507 }), '507 → نقل');
  assert(!isFailoverError({ code: '42501', message: 'permission denied' }), '42501 → عادي (بدون نقل)');
  assert(!isFailoverError({ code: '404', message: 'not found' }), '404 → عادي');
  assert(!isFailoverError(null), 'null → عادي');

  /* 2) عادي: مفيش نقل */
  console.log('\n🧪 2) عملية عادية — مفيش نقل');
  {
    globalThis.localStorage.clear();
    const cf = makeCreateClient({ 'https://db1.test': { from: () => ({ data: [{ id: 1 }], error: null }) } });
    const r = create(cf, { providers: PROVIDERS });
    const res = await r.from('products').select('*').eq('id', 1);
    assert(res.data && res.data.length === 1, 'البيانات رجعت سليمة');
    assert(r.status().activeIndex === 0, 'فضل على الأساسي');
    assert(r.status().switchCount === 0, 'صفر عمليات نقل');
  }

  /* 3) خطأ حدود → نقل آلي + إعادة محاولة */
  console.log('\n🧪 3) خطأ "امتلاء" → نقل آلي وإعادة محاولة');
  {
    globalThis.localStorage.clear();
    const cf = makeCreateClient({
      'https://db1.test': { from: () => ({ data: null, error: { code: '53100', message: 'no space left on device' } }) },
      'https://db2.test': { from: () => ({ data: [{ id: 2 }], error: null }) },
    });
    const r = create(cf, { providers: PROVIDERS });
    const res = await r.from('products').select('*');
    assert(res.data && res.data.length === 1, 'المحاولة التانية نجحت على db2');
    assert(r.status().activeIndex === 1, 'اتنقل لـ db2');
    assert(r.status().switchCount === 1, 'نقل واحد بس');
  }

  /* 4) خطأ عادي (42501) → مفيش نقل */
  console.log('\n🧪 4) خطأ عادي → مفيش نقل');
  {
    globalThis.localStorage.clear();
    const cf = makeCreateClient({ 'https://db1.test': { from: () => ({ data: null, error: { code: '42501', message: 'permission denied' } }) } });
    const r = create(cf, { providers: PROVIDERS });
    const res = await r.from('orders').select('*');
    assert(res.error && res.error.code === '42501', 'الخطأ رجع زي ما هو');
    assert(r.status().switchCount === 0, 'مفيش نقل');
  }

  /* 5) استثناء مرمي (network + quota) → نقل */
  console.log('\n🧪 5) استثناء مرمي → نقل وإعادة محاولة');
  {
    let first = true;
    globalThis.localStorage.clear();
    const cf = makeCreateClient({
      'https://db1.test': {
        from: () => () => {
          if (first) { first = false; throw new Error('Failed to fetch: quota exceeded'); }
          return { data: [9], error: null };
        },
      },
    });
    const r = create(cf, { providers: PROVIDERS });
    const res = await r.from('products').select('*');
    // db1 أول مرة يرمي → يتنقل لـ db2 (اللي مفيهوش تعريف → بيانات فاضية)
    assert(r.status().switchCount === 1, 'اتنقل بعد الاستثناء');
    assert(r.status().activeIndex === 1, 'النشط بقى db2');
  }

  /* 6) الفحص الاستباقي (db_health ≥ 85%) → نقل */
  console.log('\n🧪 6) الفحص الاستباقي — حجم 90% → نقل');
  {
    globalThis.localStorage.clear();
    const cf = makeCreateClient({
      'https://db1.test': { rpc: () => ({ data: { pct: 90, size_mb: 460, max_mb: 512 }, error: null }) },
    });
    const r = create(cf, { providers: PROVIDERS });
    await r.checkHealth();
    assert(r.status().activeIndex === 1, 'اتنقل للاحتياطي عند 90%');
    assert(r.lastHealth && r.lastHealth.pct === 90, 'سجل الحالة الصحية');
  }

  /* 7) النقل اليدوي + الاستمرارية */
  console.log('\n🧪 7) النقل اليدوي + الحفظ بين الجلسات');
  {
    const cf = makeCreateClient({});
    const r = create(cf, { providers: PROVIDERS });
    assert(r.switchTo('db3') === true, 'نقل يدوي لـ db3');
    assert(r.status().activeId === 'db3', 'النشط بقى db3');
    assert(globalThis.localStorage.getItem('nasr_router_active_db') === 'db3', 'اتحفظ في localStorage');
    // جلسة جديدة تحترم الاختيار
    const r2 = create(cf, { providers: PROVIDERS });
    assert(r2.status().activeId === 'db3', 'الجلسة الجديدة بدأت من db3');
  }

  /* 8) تسلسل الاستعلامات محفوظ */
  console.log('\n🧪 8) سلسلة الـ builder بتوصل كاملة');
  {
    globalThis.localStorage.clear();
    const cf = makeCreateClient({ 'https://db1.test': { from: () => ({ data: [], error: null }) } });
    const r = create(cf, { providers: PROVIDERS });
    const builder = r.from('orders').select('*').eq('user_id', 'u1').order('created_at', { ascending: false }).limit(10);
    await builder;
    const calls = cf.lastBuilder.calls.map((c) => c[0]);
    assert(JSON.stringify(calls) === JSON.stringify(['select', 'eq', 'order', 'limit']), 'التسلسل select>eq>order>limit محفوظ');
  }

  /* 9) إشعارات الأحداث */
  console.log('\n🧪 9) أحداث النقل (subscribe)');
  {
    const events = [];
    globalThis.localStorage.clear();
    const cf = makeCreateClient({
      'https://db1.test': { from: () => ({ data: null, error: { message: 'Quota exceeded' } }) },
      'https://db2.test': { from: () => ({ data: [], error: null }) },
    });
    const r = create(cf, { providers: PROVIDERS });
    r.subscribe((e) => events.push(e.type));
    await r.from('products').select('*');
    assert(events.indexOf('switch') !== -1, 'حدث switch اتصدر');
  }

  console.log('\n' + '='.repeat(50));
  console.log(`📊 النتيجة: ${passed} نجحت / ${failed} فشلت`);
  if (failed === 0) console.log('🏆 محرك الفشل الآلي جاهز 100%');
  console.log('='.repeat(50) + '\n');
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
