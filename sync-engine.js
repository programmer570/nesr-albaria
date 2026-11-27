/* ============================================================
   NasrSync — محرك المزامنة والأرشفة (عميل)
   ------------------------------------------------------------
   • runSync()     → بينادي دالة db-sync على السيرفر لنسخ كل البيانات والصور
   • runArchive()  → يأرشف الطلبات/اللوجات القديمة (حل مشكلة الـ 500MB)
   • autoStart()   → مزامنة تلقائية كل 6 ساعات + إشعار بالحالة
   الدالة db-sync شغالة على السيرفر بمفاتيح service_role
   (مفيش أي مفتاح سري في المتصفح ✅)
   ============================================================ */
(function (global) {
  'use strict';

  var AUTO_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // كل 6 ساعات
  var lastResult = null;
  var busy = false;
  var timer = null;

  function client() {
    return global.NasrRouter || global.NasrRouterClient || global.supabaseClient || null;
  }

  function notify(msg, kind) {
    try {
      if (typeof global.toast === 'function') global.toast(msg, null, 6000);
      else if (global.console) console.log('[NasrSync]', msg);
    } catch (e) {}
    try {
      if (global.document && global.CustomEvent) {
        global.document.dispatchEvent(new global.CustomEvent('nasr-sync-status', {
          detail: { message: msg, kind: kind || 'info', result: lastResult }
        }));
      }
    } catch (e) {}
  }

  function invoke(action, payload) {
    var c = client();
    if (!c || !c.functions || typeof c.functions.invoke !== 'function') {
      return Promise.resolve({ data: null, error: { message: 'supabase client غير جاهز' } });
    }
    return c.functions.invoke('db-sync', { body: Object.assign({ action: action }, payload || {}) });
  }

  /* ---------- المزامنة الكاملة ---------- */
  function runSync(opts) {
    if (busy) return Promise.resolve({ data: null, error: { message: 'مزامنة جارية بالفعل' } });
    busy = true;
    notify('🔄 بدأت المزامنة بين قواعد البيانات...', 'sync-start');
    return invoke('sync', opts).then(function (res) {
      busy = false;
      lastResult = res && res.data ? res.data : null;
      if (res && res.error) {
        var msg = res.error.message || '';
        if (/Failed to fetch|not found|404|FunctionsRelay|FunctionsHttpError/i.test(msg) && !/denied|401|403/i.test(msg)) {
          notify('⚠️ دالة db-sync لسه مش مركّبة — ركّبها من SETUP-GUIDE.md (خطوة 3)', 'need-setup');
        } else {
          notify('❌ المزامنة فشلت: ' + msg, 'sync-error');
        }
        return res;
      }
      var d = lastResult || {};
      notify('✅ المزامنة خلصت — ' + (d.syncedRows || 0) + ' صف و' + (d.syncedFiles || 0) + ' ملف اتضافوا', 'sync-done');
      return res;
    }).catch(function (e) {
      busy = false;
      notify('❌ المزامنة فشلت: ' + (e && e.message || e), 'sync-error');
      return { data: null, error: e };
    });
  }

  /* ---------- الأرشفة (حل مشكلة الـ 500MB) ---------- */
  function runArchive(beforeDays) {
    if (busy) return Promise.resolve({ data: null, error: { message: 'عملية جارية بالفعل' } });
    busy = true;
    var days = Number(beforeDays) > 0 ? Number(beforeDays) : 90;
    notify('📦 بدأت الأرشفة (بيانات أقدم من ' + days + ' يوم)...', 'archive-start');
    return invoke('archive', { before_days: days }).then(function (res) {
      busy = false;
      lastResult = res && res.data ? res.data : null;
      if (res && res.error) {
        notify('❌ الأرشفة فشلت: ' + (res.error.message || ''), 'archive-error');
        return res;
      }
      var d = lastResult || {};
      notify('✅ الأرشفة خلصت — ' + (d.archivedRows || 0) + ' صف اتأرشفوا واتمسحوا من القواعد', 'archive-done');
      return res;
    }).catch(function (e) {
      busy = false;
      notify('❌ الأرشفة فشلت: ' + (e && e.message || e), 'archive-error');
      return { data: null, error: e };
    });
  }

  /* ---------- الأرشيف: عرض + استرجاع (مفيش حاجة بتتمسح نهائيًا) ---------- */
  function listArchives() {
    busy = true;
    return invoke('list-archives', {}).then(function (res) {
      busy = false;
      if (res && res.error) { notify('❌ تعذر عرض الأرشيف: ' + (res.error.message || ''), 'archive-error'); return res; }
      var d = res && res.data ? res.data : {};
      var names = (d.files || []).map(function (f) { return f.name; }).slice(0, 8).join('، ');
      notify('📦 الأرشيف فيه ' + (d.count || 0) + ' ملف محفوظ: ' + (names || '—'), 'archive-list');
      return res;
    }).catch(function (e) { busy = false; notify('❌ ' + (e && e.message || e), 'archive-error'); return { data: null, error: e }; });
  }

  function restoreArchive(fileName) {
    var file = fileName;
    try { if (!file && global.prompt) file = global.prompt('اسم ملف الأرشيف اللي عايز ترجّعه (من زر عرض الأرشيف):'); } catch (e) {}
    if (!file) return Promise.resolve({ data: null, error: { message: 'ملغي' } });
    if (busy) return Promise.resolve({ data: null, error: { message: 'عملية جارية بالفعل' } });
    busy = true;
    notify('🔄 بارجع بيانات الأرشيف...', 'restore-start');
    return invoke('restore', { file: file }).then(function (res) {
      busy = false;
      if (res && res.error) { notify('❌ الاسترجاع فشل: ' + (res.error.message || ''), 'restore-error'); return res; }
      var d = res && res.data ? res.data : {};
      notify('✅ رجّعنا ' + (d.restored || 0) + ' صف من "' + (d.file || file) + '" — البيانات موجودة تاني 👌', 'restore-done');
      return res;
    }).catch(function (e) { busy = false; notify('❌ ' + (e && e.message || e), 'restore-error'); return { data: null, error: e }; });
  }

  /* ---------- التشغيل التلقائي ---------- */
  function autoStart() {
    if (timer) return;
    // أول مزامنة بعد 90 ثانية من التحميل (سيب الصفحة تفتح الأول)
    setTimeout(function () { runSync(); }, 90 * 1000);
    timer = setInterval(function () {
      // مزامنة فقط لو فيه جلسة (الأدمن) — مش كل زائر
      try {
        var c = client();
        if (c && c.auth && typeof c.auth.getSession === 'function') {
          c.auth.getSession().then(function (r) {
            if (r && r.data && r.data.session) runSync();
          }).catch(function () {});
        }
      } catch (e) {}
    }, AUTO_SYNC_INTERVAL_MS);
  }

  /* ---------- ربط أزرار لوحة الإدارة (لو موجودة) ---------- */
  function bindAdminUi() {
    if (!global.document) return;
    global.document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-nasr-sync-action]') : null;
      if (!t) return;
      e.preventDefault();
      var act = t.getAttribute('data-nasr-sync-action');
      if (act === 'sync') runSync();
      else if (act === 'archive') runArchive(t.getAttribute('data-nasr-days') || 90);
      else if (act === 'list-archives') listArchives();
      else if (act === 'restore') restoreArchive(t.getAttribute('data-nasr-file') || '');
      else if (act === 'health' && global.NasrRouter) {
        global.NasrRouter.checkHealth().then(function (r) {
          var h = r && r.data;
          notify(h ? ('📊 حجم القاعدة: ' + h.size_mb + ' ميجا (' + h.pct + '% من الحد)') : '⚠️ دالة db_health مش مركّبة', 'health');
        });
      } else if (act === 'switch' && global.NasrRouter) {
        var to = t.getAttribute('data-nasr-db');
        var ok = global.NasrRouter.switchTo(to);
        notify(ok ? '✅ تم النقل اليدوي' : '⚠️ القاعدة المطلوبة غير مهيأة', 'switch');
      }
    });
  }

  global.NasrSync = {
    runSync: runSync,
    runArchive: runArchive,
    listArchives: listArchives,
    restoreArchive: restoreArchive,
    autoStart: autoStart,
    status: function () { return { busy: busy, lastResult: lastResult }; }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.NasrSync;

  // تجهيز تلقائي في المتصفح
  if (global.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { bindAdminUi(); autoStart(); });
    } else {
      bindAdminUi(); autoStart();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
