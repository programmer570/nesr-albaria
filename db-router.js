/* ============================================================
   NasrDBRouter — موجّه قواعد البيانات الذكي (فشل آلي + استشفاء)
   ------------------------------------------------------------
   استبدال مباشر لـ supabaseClient بنفس الـ API بالظبط:
     supabaseClient.from(...) / .rpc(...) / .auth / .storage / .functions
   بس دلوقتي هو بيجسّد الحالات دي:
     • أي خطأ "حدود/امتلاء/قراءة فقط" → ينقل للقاعدة التالية تلقائيًا ويعيد المحاولة
     • فحص استباقي للحجم (db_health) ونقل عند ≥ 85%
     • يفضل على النشط المحفوظ بين الجلسات
   المفاتيح هنا publishable (مصممة للظهور) — مفيش أسرار في المتصفح ✅
   ============================================================ */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'nasr_router_active_db';
  var HEALTH_INTERVAL_MS = 6 * 60 * 60 * 1000; // كل 6 ساعات
  var HEALTH_SWITCH_PCT = 85;

  /* مراتب القواعد — املأ url/key بتوع المشروعين الجداد بعد إنشائهم */
  var DEFAULT_PROVIDERS = [
    {
      id: 'db1',
      label: '⭐ الأساسي',
      url: 'https://jknvoihcxgdpcctvnhab.supabase.co',
      key: 'sb_publishable_ScBUjfRWrmlmPPiquO_FHg_RFOv8j6N'
    },
    { id: 'db2', label: '🟡 الاحتياطي الأول', url: '', key: '' },
    { id: 'db3', label: '🟢 الاحتياطي الثاني', url: '', key: '' }
  ];

  /* ---------- أدوات مساعدة ---------- */
  function lsGet(k) { try { return global.localStorage ? global.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (global.localStorage) global.localStorage.setItem(k, v); } catch (e) {} }

  /* تصنيف الخطأ: هل ده خطأ "حدود/امتلاء" يستدعي النقل؟ */
  function isFailoverError(err) {
    if (!err) return false;
    var code = String(err.code != null ? err.code : (err.status != null ? err.status : ''));
    if (/^(429|507|508|402)$/.test(code)) return true;           // throttling / insufficient storage / billing
    if (/^(53100|53300|53400)$/.test(code)) return true;          // disk full / too many connections
    if (/^(401|403|404|400|406|409|422|42501)$/.test(code)) return false; // أخطاء عادية مش للنقل
    var msg = String(err.message || err.error_description || err.error || err.details || '').toLowerCase();
    if (!msg) return false;
    return /(quota|exceed|read.?only|read only|disk|space left|billing|free.?tier|project.{0,12}(paused|inactive|suspended)|usage.?limit|resource.?exhausted|storage.{0,8}(full|limit)|too many (requests|connections)|temporarily unavailable|over (the )?limit|limit reached|53100|53300|exceeded|not enough)/.test(msg);
  }

  /* ---------- الموجّه ---------- */
  function Router(providers, createClientFn, authOptions) {
    this.providers = (providers || DEFAULT_PROVIDERS).map(function (p) {
      return { id: p.id, label: p.label || p.id, url: p.url || '', key: p.key || '' };
    });
    this._createClient = createClientFn;
    this._authOptions = authOptions || { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: global.localStorage };
    this._clients = {};
    this._listeners = [];
    this.lastHealth = null;
    this.switchCount = 0;

    // استرجاع النشط المحفوظ (لو كان معرّف ومضبوط)
    var saved = lsGet(STORAGE_KEY);
    this.activeIndex = 0;
    if (saved) {
      for (var i = 0; i < this.providers.length; i++) {
        if (this.providers[i].id === saved && this.providers[i].url) { this.activeIndex = i; break; }
      }
    }
    this._healthTimer = null;
  }

  Router.prototype._configured = function (i) {
    var p = this.providers[i];
    return !!(p && p.url && p.key);
  };

  Router.prototype._client = function (i) {
    if (!this._clients[i]) {
      var p = this.providers[i];
      this._clients[i] = this._createClient(p.url, p.key, { auth: this._authOptions });
    }
    return this._clients[i];
  };

  Router.prototype._active = function () { return this._client(this.activeIndex); };

  Router.prototype._emit = function (type, detail) {
    var ev = { type: type, detail: detail };
    this._listeners.forEach(function (fn) { try { fn(ev); } catch (e) {} });
    try {
      if (global.document && global.CustomEvent) {
        global.document.dispatchEvent(new global.CustomEvent('nasr-db-' + type, { detail: detail }));
      }
    } catch (e) {}
  };

  Router.prototype._nextIndex = function () {
    var n = this.providers.length;
    for (var step = 1; step < n; step++) {
      var i = (this.activeIndex + step) % n;
      if (this._configured(i)) return i;
    }
    return -1;
  };

  Router.prototype._switch = function (next, reason) {
    if (next === this.activeIndex || !this._configured(next)) return false;
    var from = this.providers[this.activeIndex];
    this.activeIndex = next;
    this.switchCount++;
    lsSet(STORAGE_KEY, this.providers[next].id);
    this._emit('switch', {
      reason: reason || 'manual',
      from: from.id, fromLabel: from.label,
      to: this.providers[next].id, toLabel: this.providers[next].label
    });
    return true;
  };

  /* التنفيذ مع إعادة المحاولة على القواعد التالية */
  Router.prototype._withRetry = function (fn) {
    var self = this;
    var tried = {};
    var attempts = 0;
    var lastErr = null;

    function attempt() {
      var idx = self.activeIndex;
      tried[idx] = true;
      attempts++;
      return Promise.resolve()
        .then(function () { return fn(self._client(idx)); })
        .then(function (res) {
          // supabase بيرجع {data, error} — لو error حدود نكمل نقل
          if (res && res.error && isFailoverError(res.error)) {
            lastErr = res.error;
            throw { __failover: true, cause: res.error };
          }
          return res;
        });
    }

    function recover(err) {
      if (err && err.__failover) err = err.cause;
      lastErr = err;
      if (isFailoverError(err) && attempts < self.providers.length) {
        var next = self._nextIndex();
        if (next >= 0 && !tried[next]) {
          self._switch(next, 'error');
          return attempt().catch(recover);
        }
        // جرّب أي مراتب متبقية
        for (var i = 0; i < self.providers.length; i++) {
          if (!tried[i] && self._configured(i)) {
            self._switch(i, 'error');
            return attempt().catch(recover);
          }
        }
        // خلصوا — رجّع شكل supabase القياسي بدل ما نكسر التطبيق
        return { data: null, error: lastErr };
      }
      throw err;
    }

    return attempt().catch(recover);
  };

  /* تغليف builder (thenable) بتاع supabase */
  Router.prototype._wrapBuilder = function (table) {
    var self = this;
    var chain = [];
    var wrapper = new Proxy({}, {
      get: function (t, prop) {
        if (prop === 'then') {
          return function (onOk, onErr) {
            return self._run(table, chain).then(onOk, onErr);
          };
        }
        if (prop === 'catch' || prop === 'finally') {
          return function (a, b) { return self._run(table, chain)[prop](a, b); };
        }
        if (typeof prop === 'symbol') return undefined;
        return function () {
          chain.push({ m: prop, args: Array.prototype.slice.call(arguments) });
          return wrapper;
        };
      }
    });
    return wrapper;
  };

  Router.prototype._run = function (table, chain) {
    var self = this;
    return self._withRetry(function (client) {
      var b = client.from(table);
      for (var i = 0; i < chain.length; i++) {
        b = b[chain[i].m].apply(b, chain[i].args);
      }
      return Promise.resolve(b);
    });
  };

  /* تغليف كائن فيه دوال promises (auth / storage / functions) */
  Router.prototype._wrapObject = function (getObj, methodNames) {
    var self = this;
    return new Proxy({}, {
      get: function (t, prop) {
        var obj = getObj();
        if (!obj) return undefined;
        var val = obj[prop];
        if (typeof val === 'function' && (!methodNames || methodNames.indexOf(prop) !== -1)) {
          return function () {
            var args = Array.prototype.slice.call(arguments);
            return self._withRetry(function (client) {
              var target = getObj(client);
              return target[prop].apply(target, args);
            });
          };
        }
        return typeof val === 'function' ? val.bind(obj) : val;
      }
    });
  };

  /* ---------- الواجهة العامة (نفس شكل supabaseClient) ---------- */
  Router.prototype.from = function (table) { return this._wrapBuilder(table); };

  Router.prototype.rpc = function (name, params, opts) {
    var self = this;
    return self._withRetry(function (client) { return client.rpc(name, params, opts); });
  };

  Router.prototype.storage = {
    get from() {
      /* placeholder — بيتعوّض وقت الإنشاء */
      return null;
    }
  };

  Router.prototype.functions = null;
  Router.prototype.auth = null;
  Router.prototype.channel = null;

  /* ---------- أدوات الإدارة (window.NasrRouter) ---------- */
  Router.prototype.status = function () {
    return {
      activeIndex: this.activeIndex,
      activeId: this.providers[this.activeIndex].id,
      activeLabel: this.providers[this.activeIndex].label,
      providers: this.providers.map(function (p, i) {
        return { id: p.id, label: p.label, configured: !!(p.url && p.key), active: i === this.activeIndex };
      }, this),
      switchCount: this.switchCount,
      lastHealth: this.lastHealth
    };
  };

  Router.prototype.switchTo = function (indexOrId) {
    var idx = typeof indexOrId === 'string'
      ? this.providers.findIndex(function (p) { return p.id === indexOrId; })
      : indexOrId;
    if (idx < 0 || !this._configured(idx)) return false;
    return this._switch(idx, 'manual');
  };

  Router.prototype.subscribe = function (fn) {
    this._listeners.push(fn);
    var self = this;
    return function () {
      self._listeners = self._listeners.filter(function (f) { return f !== fn; });
    };
  };

  /* فحص صحة القواعد (db_health RPC — اختياري) */
  Router.prototype.checkHealth = function () {
    var self = this;
    return this.rpc('db_health').then(function (res) {
      if (res && res.data) {
        self.lastHealth = res.data;
        self._emit('health', res.data);
        if (typeof res.data.pct === 'number' && res.data.pct >= HEALTH_SWITCH_PCT) {
          var next = self._nextIndex();
          if (next >= 0) self._switch(next, 'health-threshold');
        }
      }
      return res;
    }).catch(function () { return { data: null, error: null }; });
  };

  Router.prototype.startAutoHealth = function () {
    var self = this;
    if (this._healthTimer) return;
    this.checkHealth();
    this._healthTimer = setInterval(function () { self.checkHealth(); }, HEALTH_INTERVAL_MS);
  };

  /* ---------- الإنشاء والتثبيت ---------- */
  function create(createClientFn, options) {
    options = options || {};
    var r = new Router(options.providers || DEFAULT_PROVIDERS, createClientFn, options.auth);
    // توصيل الواجهات المغلّفة
    r.functions = r._wrapObject(function (c) { return (c || r._active()).functions; });
    r.auth = r._wrapObject(function (c) { return (c || r._active()).auth; }, [
      'signUp', 'signInWithPassword', 'signInWithOtp', 'signInWithOAuth', 'signOut',
      'resetPasswordForEmail', 'updateUser', 'verifyOtp', 'exchangeCodeForSession', 'resend', 'refreshSession', 'setSession'
    ]);
    r.storage = {
      from: function (bucket) {
        return r._wrapObject(function (c) { return (c || r._active()).storage.from(bucket); }, [
          'upload', 'update', 'remove', 'list', 'createSignedUrl', 'createSignedUploadUrl', 'download', 'move', 'copy'
        ]);
      },
      listBuckets: function () {
        return r._withRetry(function (c) { return c.storage.listBuckets(); });
      },
      createBucket: function (id, opts) {
        return r._withRetry(function (c) { return c.storage.createBucket(id, opts); });
      }
    };
    r.channel = function () { return r._active().channel.apply(r._active(), arguments); };
    r.removeChannel = function () { return r._active().removeChannel.apply(r._active(), arguments); };
    r.getChannels = function () { return r._active().getChannels ? r._active().getChannels() : []; };
    return r;
  }

  function install(win, options) {
    options = options || {};
    if (!win.supabase || typeof win.supabase.createClient !== 'function') {
      throw new Error('NasrDBRouter: supabase-js غير محمّل');
    }
    var client = create(win.supabase.createClient, options);
    win.NasrRouter = client;
    win.NasrRouterClient = client;
    client.startAutoHealth();
    return client;
  }

  global.NasrDBRouter = {
    create: create,
    install: install,
    isFailoverError: isFailoverError,
    DEFAULT_PROVIDERS: DEFAULT_PROVIDERS
  };

  // للتصدير في بيئة الاختبارات (Node)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.NasrDBRouter;
  }
})(typeof window !== 'undefined' ? window : globalThis);
