/* TM 追魅 / B&Q 蓝牙助手 - standalone mini-program runtime shim
 * Re-implements the subset of the WeChat mini-program runtime used by the
 * original app-service.js + page-frame.js, and bridges BLE to the native
 * Android layer.
 */
(function (global) {
  'use strict';

  var document = global.document;
  var console = global.console;

  /* ======================================================================
   * Small helpers
   * ==================================================================== */

  function isText(v) {
    return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  }

  function deepClone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      var arr = new Array(v.length);
      for (var i = 0; i < v.length; i++) arr[i] = deepClone(v[i]);
      return arr;
    }
    var o = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = deepClone(v[k]);
    return o;
  }

  function setPath(obj, path, val) {
    path = String(path).replace(/\[(\d+)\]/g, '.$1');
    var parts = path.split('.');
    var o = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = parts[i];
      if (o[k] === null || o[k] === undefined) o[k] = {};
      o = o[k];
    }
    o[parts[parts.length - 1]] = val;
  }

  function fixStyle(s) {
    if (!s) return '';
    s = String(s);
    s = s.replace(/(-?\d*\.?\d+)rpx/g, function (_, n) {
      return (parseFloat(n) / 7.5) + 'vw';
    });
    s = s.replace(/(-?\d*\.?\d+)vh/g, function (_, n) {
      return 'calc(var(--vh) * ' + parseFloat(n) + ')';
    });
    return s;
  }

  function b64ToArrayBuffer(b64) {
    var bin = global.atob(b64);
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  function arrayBufferToB64(buf) {
    var bytes = new Uint8Array(buf);
    var chunk = 0x8000;
    var out = '';
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return global.btoa(out);
  }

  /* ======================================================================
   * Module system (define / require)
   * ==================================================================== */

  var __modules = Object.create(null);
  var __moduleCache = Object.create(null);

  function normPath(p) {
    p = String(p).replace(/\\/g, '/');
    var out = [];
    var parts = p.split('/');
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (s === '' || s === '.') continue;
      if (s === '..') out.pop();
      else out.push(s);
    }
    return out.join('/');
  }

  function resolveModulePath(from, req) {
    if (req.charAt(0) === '/') return normPath(req);
    if (req.charAt(0) === '.') {
      var dir = from.split('/').slice(0, -1).join('/');
      return normPath(dir + '/' + req);
    }
    return normPath(req);
  }

  function requireModule(name, from) {
    name = normPath(name);
    if (!/\.js$/.test(name)) name += '.js';
    if (__moduleCache[name]) return __moduleCache[name].exports;
    var factory = __modules[name];
    if (typeof factory !== 'function') throw new Error('module not found: ' + name);
    var module = { exports: {} };
    __moduleCache[name] = module;
    var prevRoute = global.__wxRoute;
    if (name.indexOf('pages/') === 0) global.__wxRoute = name.replace(/\.js$/, '');
    var req = function (p) { return requireModule(resolveModulePath(name, p), name); };
    try {
      factory(req, module, module.exports, global, document, global.frames, global.self,
        global.location, global.navigator, global.localStorage, global.history, global.Caches,
        global.screen, global.alert, global.confirm, global.prompt, global.XMLHttpRequest,
        global.WebSocket, null, global, global.WeixinJSCore);
    } finally {
      global.__wxRoute = prevRoute;
    }
    return module.exports;
  }

  global.define = function (name, factory) { __modules[normPath(name)] = factory; };
  global.require = function (p) { return requireModule(p, ''); };

  /* ======================================================================
   * App / Page registry
   * ==================================================================== */

  var __app = null;
  var __pageOptions = Object.create(null);
  var __instances = Object.create(null);

  global.App = function (opts) { __app = opts || {}; };
  global.getApp = function () { return __app; };
  global.Page = function (opts) {
    var route = global.__wxRoute;
    if (!route) {
      console.warn('Page() called without route');
      return;
    }
    __pageOptions[route] = opts || {};
  };
  global.Component = function () {};
  global.Behavior = function () {};
  global.getCurrentPages = function () {
    var out = [];
    for (var k in __instances) out.push(__instances[k]);
    return out;
  };

  /* ======================================================================
   * Native bridge
   * ==================================================================== */

  var pendingCalls = Object.create(null);
  var callSeq = 1;

  var nativeListeners = {
    bleDeviceFound: [],
    bleAdapterStateChange: [],
    bleConnectionStateChange: [],
    bleCharacteristicValueChange: [],
    permissionResult: []
  };

  global.__nativeDispatch = function (id, json) {
    var p = pendingCalls[id];
    if (!p) return;
    delete pendingCalls[id];
    var res;
    try { res = JSON.parse(json); } catch (e) { res = { ok: false, errMsg: 'bad native response' }; }
    if (res && res.ok) p.resolve(res.data || {});
    else p.reject(res || { ok: false, errMsg: 'native error' });
  };

  global.__nativeEvent = function (name, json) {
    var list = nativeListeners[name];
    if (!list) return;
    var data;
    try { data = JSON.parse(json); } catch (e) { data = {}; }
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) { console.error('native event ' + name, e); }
    }
  };

  function nativeAvailable() {
    return !!(global.NativeBridge && typeof global.NativeBridge.post === 'function');
  }

  function callNative(method, args) {
    return new Promise(function (resolve, reject) {
      if (!nativeAvailable()) { reject({ ok: false, errMsg: method + ':fail no native bridge', errCode: -1 }); return; }
      var id = callSeq++;
      pendingCalls[id] = { resolve: resolve, reject: reject };
      try {
        global.NativeBridge.post(JSON.stringify({ id: id, method: method, args: args || {} }));
      } catch (e) {
        delete pendingCalls[id];
        reject({ ok: false, errMsg: method + ':fail ' + e.message, errCode: -1 });
      }
    });
  }

  function addNativeListener(name, cb) {
    if (!nativeListeners[name]) nativeListeners[name] = [];
    if (typeof cb === 'function') nativeListeners[name].push(cb);
  }
  function clearNativeListeners(name) {
    if (nativeListeners[name]) nativeListeners[name] = [];
  }

  /* ======================================================================
   * Page state
   * ==================================================================== */

  var currentInst = null;
  var currentRoute = '';
  var pageStack = [];
  var ptrState = { tracking: false, startY: 0, dy: 0, refreshing: false };

  var TAB_LIST = [
    { route: 'pages/device/device', text: '控制器状态', icon: 'img/tab0.png', sel: 'img/tab0_sel.png' },
    { route: 'pages/basicset/basicset', text: '基础参数设置', icon: 'img/tab1.png', sel: 'img/tab1_sel.png' },
    { route: 'pages/set/set', text: '高级参数设置', icon: 'img/tab2.png', sel: 'img/tab2_sel.png' },
    { route: 'pages/ota/ota', text: 'OTA升级', icon: 'img/tab3.png', sel: 'img/tab3_sel.png' }
  ];

  var PAGE_CONFIG = {
    'pages/index/index': { pullDownRefresh: true }
  };

  /* ======================================================================
   * Renderer
   * ==================================================================== */

  function mapTag(tag) {
    if (!tag) return 'wx-view';
    tag = String(tag).toLowerCase();
    if (tag === 'virtual') return 'wx-virtual';
    if (tag === 'wx-page') return 'page';
    return tag;
  }

  function resolveSrc(src) {
    if (!src) return '';
    src = String(src);
    if (src.charAt(0) === '/') return src.slice(1);
    return src;
  }

  function datasetOf(v) {
    var d = {};
    var a = (v && v.attr) || {};
    for (var k in a) {
      if (k.indexOf('data-') === 0) {
        var name = k.slice(5).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
        d[name] = a[k];
      }
    }
    return d;
  }

  function createNode(v, inst) {
    if (v === null || v === undefined || v === false || v === true) return document.createTextNode('');
    if (isText(v)) return document.createTextNode(String(v));
    var tag = mapTag(v.tag);
    var el = document.createElement(tag);
    el.__v = v;
    if (tag === 'wx-image') {
      var img = document.createElement('img');
      img.className = 'wx-image-inner';
      img.setAttribute('draggable', 'false');
      el.appendChild(img);
      el.__img = img;
    } else if (tag === 'wx-input') {
      var inp = document.createElement('input');
      inp.className = 'wx-input-inner';
      inp.setAttribute('autocomplete', 'off');
      inp.setAttribute('autocorrect', 'off');
      inp.setAttribute('autocapitalize', 'off');
      el.appendChild(inp);
      el.__input = inp;
    } else if (tag === 'wx-switch') {
      var sw = document.createElement('div');
      sw.className = 'wx-switch-input';
      el.appendChild(sw);
      el.__sw = sw;
    }
    applyAttrs(el, v, null, inst);
    el.__wxChildren = [];
    if (tag !== 'wx-image' && tag !== 'wx-input' && tag !== 'wx-switch') {
      var kids = v.children || [];
      for (var i = 0; i < kids.length; i++) {
        var c = createNode(kids[i], inst);
        el.appendChild(c);
        el.__wxChildren.push(c);
      }
    }
    return el;
  }

  function applyAttrs(el, v, oldV, inst) {
    var a = (v && v.attr) || {};
    var cls = a['class'] === undefined || a['class'] === null ? '' : String(a['class']);
    if (el.__cls !== cls) { el.__cls = cls; el.className = cls; }

    var st = fixStyle(a.style);
    if (el.__styleText !== st) {
      el.__styleText = st;
      el.style.cssText = st;
    }

    var hidden = a.hidden === true || a.hidden === 'true' || a.hidden === 1;
    if (hidden) el.style.display = 'none';
    else if (el.__wasHidden) el.style.display = '';
    el.__wasHidden = hidden;

    if (a.id !== undefined && a.id !== null && a.id !== '') el.id = String(a.id);
    else if (el.id) el.removeAttribute('id');

    var tag = mapTag(v.tag);

    if (tag === 'wx-image') {
      var src = resolveSrc(a.src);
      if (el.__src !== src) {
        el.__src = src;
        if (src) el.__img.src = src;
        else el.__img.removeAttribute('src');
      }
    } else if (tag === 'wx-input') {
      var inp = el.__input;
      var type = a.type === 'password' ? 'password' : (a.type === 'number' || a.type === 'digit' ? 'number' : 'text');
      if (inp.type !== type) inp.type = type;
      var ph = a.placeholder === undefined || a.placeholder === null ? '' : String(a.placeholder);
      if (inp.placeholder !== ph) inp.placeholder = ph;
      var pcls = 'wx-input-inner' + (a.placeholderClass ? ' ' + a.placeholderClass : '');
      if (inp.className !== pcls) inp.className = pcls;
      inp.disabled = a.disabled === true || a.disabled === 'true';
      var maxlen = parseInt(a.maxlength, 10);
      inp.maxLength = isNaN(maxlen) ? 140 : maxlen;
      if (a.value !== undefined && a.value !== null && document.activeElement !== inp) {
        var val = String(a.value);
        if (inp.value !== val) inp.value = val;
      }
    } else if (tag === 'wx-switch') {
      var checked = a.checked === true || a.checked === 'true' || a.checked === 1;
      if (el.__sw.classList.contains('wx-switch-input-checked') !== checked) {
        el.__sw.classList.toggle('wx-switch-input-checked', checked);
      }
    } else if (tag === 'wx-scroll-view') {
      var scrollY = a.scrollY === true || a.scrollY === 'true' || a.scrollY === '';
      if (scrollY) el.setAttribute('scroll-y', ''); else el.removeAttribute('scroll-y');
      if (a.scrollIntoView !== undefined && a.scrollIntoView !== null && a.scrollIntoView !== '' &&
          (!oldV || !oldV.attr || oldV.attr.scrollIntoView !== a.scrollIntoView)) {
        scrollIntoView(el, String(a.scrollIntoView));
      }
    } else if (tag === 'wx-button') {
      if (a.type) el.setAttribute('type', a.type); else el.removeAttribute('type');
      if (a.disabled === true || a.disabled === 'true') el.setAttribute('disabled', ''); else el.removeAttribute('disabled');
    } else if (tag === 'wx-text') {
      var sel = a.userSelect === true || a.userSelect === 'true' || a.selectable === true || a.selectable === 'true';
      el.style.webkitUserSelect = sel ? 'text' : '';
      el.style.userSelect = sel ? 'text' : '';
    }
  }

  function scrollIntoView(el, id) {
    setTimeout(function () {
      var target = null;
      try { target = el.querySelector('#' + (global.CSS && CSS.escape ? CSS.escape(id) : id)); } catch (e) { target = null; }
      if (!target) {
        var all = el.querySelectorAll('[id]');
        for (var i = 0; i < all.length; i++) if (all[i].id === id) { target = all[i]; break; }
      }
      if (!target) return;
      var er = el.getBoundingClientRect();
      var tr = target.getBoundingClientRect();
      el.scrollTop += (tr.top - er.top) - (el.clientHeight - tr.height);
    }, 0);
  }

  function patchChildren(parentEl, oldV, newV, inst) {
    var oldKids = (oldV && oldV.children) || [];
    var newKids = (newV && newV.children) || [];
    var dom = parentEl.__wxChildren || [];
    var out = [];
    var n = Math.max(oldKids.length, newKids.length);
    for (var i = 0; i < n; i++) {
      var o = oldKids[i];
      var nk = newKids[i];
      var d = dom[i];
      if (i >= newKids.length) {
        if (d && d.parentNode === parentEl) parentEl.removeChild(d);
        continue;
      }
      if (i >= oldKids.length) {
        d = createNode(nk, inst);
        parentEl.appendChild(d);
        out.push(d);
        continue;
      }
      if ((o === null || o === undefined) && (nk === null || nk === undefined)) { out.push(d); continue; }
      if (isText(o) && isText(nk)) {
        var txt = String(nk);
        if (d.nodeValue !== txt) d.nodeValue = txt;
        out.push(d);
        continue;
      }
      if (!isText(o) && !isText(nk) && mapTag(o.tag) === mapTag(nk.tag)) {
        updateNode(d, o, nk, inst);
        out.push(d);
        continue;
      }
      var nd = createNode(nk, inst);
      parentEl.replaceChild(nd, d);
      out.push(nd);
    }
    parentEl.__wxChildren = out;
  }

  function updateNode(el, oldV, newV, inst) {
    el.__v = newV;
    applyAttrs(el, newV, oldV, inst);
    var tag = mapTag(newV.tag);
    if (tag === 'wx-image' || tag === 'wx-input' || tag === 'wx-switch') return;
    patchChildren(el, oldV, newV, inst);
  }

  function renderPage(inst) {
    if (!inst || inst.__destroyed) return;
    var fn = global.__wxAppCode__[inst.route + '.wxml'];
    if (typeof fn !== 'function') {
      console.warn('no wxml renderer for ' + inst.route);
      return;
    }
    var tree;
    try {
      tree = fn(inst.data);
    } catch (e) {
      console.error('render error ' + inst.route + ': ' + (e && e.stack ? e.stack : e));
      return;
    }
    if (!inst.__rootEl) {
      inst.__rootEl = createNode(tree, inst);
      inst.__host.appendChild(inst.__rootEl);
    } else {
      updateNode(inst.__rootEl, inst.__rootV, tree, inst);
    }
    inst.__rootV = tree;
    if (!inst.__readyCalled) {
      inst.__readyCalled = true;
      setTimeout(function () {
        if (!inst.__destroyed && typeof inst.onReady === 'function') {
          try { inst.onReady(); } catch (e) { console.error('onReady', e); }
        }
      }, 0);
    }
  }

  function scheduleRender(inst) {
    if (!inst || inst.__destroyed || inst.__renderPending) return;
    inst.__renderPending = true;
    global.requestAnimationFrame(function () {
      inst.__renderPending = false;
      if (inst === currentInst) renderPage(inst);
    });
  }

  /* ======================================================================
   * Page instance management
   * ==================================================================== */

  function createPage(route) {
    var opts = __pageOptions[route];
    if (!opts) throw new Error('page not registered: ' + route);
    var inst = {
      route: route,
      data: deepClone(opts.data || {}),
      __destroyed: false,
      __loaded: false,
      __readyCalled: false,
      __renderPending: false,
      __rootEl: null,
      __rootV: null
    };
    for (var k in opts) {
      if (k === 'data') continue;
      inst[k] = opts[k];
    }
    inst.setData = function (patch, cb) {
      if (inst.__destroyed) return;
      if (patch && typeof patch === 'object') {
        for (var key in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, key)) setPath(inst.data, key, patch[key]);
        }
      }
      scheduleRender(inst);
      if (typeof cb === 'function') setTimeout(cb, 0);
    };
    var host = document.createElement('div');
    host.className = 'wx-page-host';
    host.setAttribute('data-route', route);
    attachHostEvents(host, inst);
    inst.__host = host;
    var pages = document.getElementById('pages');
    if (pages) pages.appendChild(host);
    return inst;
  }

  function showHost(inst) {
    var pages = document.getElementById('pages');
    if (!pages) return;
    for (var i = 0; i < pages.children.length; i++) pages.children[i].classList.remove('wx-active');
    inst.__host.classList.add('wx-active');
  }

  function hidePage(inst) {
    if (!inst || inst.__destroyed) return;
    try { if (typeof inst.onHide === 'function') inst.onHide(); } catch (e) { console.error('onHide ' + inst.route, e); }
    if (inst.__host) inst.__host.classList.remove('wx-active');
  }

  function destroyPage(inst) {
    if (!inst) return;
    try { if (typeof inst.onUnload === 'function') inst.onUnload(); } catch (e) { console.error('onUnload ' + inst.route, e); }
    inst.__destroyed = true;
    if (inst.__host && inst.__host.parentNode) inst.__host.parentNode.removeChild(inst.__host);
    if (__instances[inst.route] === inst) delete __instances[inst.route];
  }

  function activate(route, query) {
    if (!__pageOptions[route]) {
      console.warn('unknown route ' + route);
      return;
    }
    if (currentInst) hidePage(currentInst);
    var inst = __instances[route];
    if (!inst) {
      inst = createPage(route);
      __instances[route] = inst;
    }
    currentInst = inst;
    currentRoute = route;

    ensurePageCss(route);
    showHost(inst);
    updateChrome(route);

    if (!inst.__loaded) {
      inst.__loaded = true;
      try { if (typeof inst.onLoad === 'function') inst.onLoad(query || {}); } catch (e) { console.error('onLoad ' + route, e); }
    }
    renderPage(inst);
    try { if (typeof inst.onShow === 'function') inst.onShow(); } catch (e) { console.error('onShow ' + route, e); }
    renderPage(inst);
  }

  /* ======================================================================
   * CSS injection (one page stylesheet at a time)
   * ==================================================================== */

  var injectedCss = Object.create(null);

  function ensurePageCss(route) {
    var wanted = './' + route + '.wxss';
    var styles = document.querySelectorAll('style[wxss\\:path]');
    var found = false;
    for (var i = 0; i < styles.length; i++) {
      var p = styles[i].getAttribute('wxss:path');
      if (p === wanted) {
        found = true;
      } else if (p && p.indexOf('./pages/') === 0 && styles[i].parentNode) {
        styles[i].parentNode.removeChild(styles[i]);
      }
    }
    if (found) return;
    var fn = global.__wxAppCode__[route + '.wxss'];
    if (typeof fn !== 'function') return;
    try { fn(); } catch (e) { console.error('wxss error ' + route, e); return; }
    fixVhInStyle(wanted);
  }

  function fixVhInStyle(path) {
    var styles = document.querySelectorAll('style');
    for (var i = 0; i < styles.length; i++) {
      if (styles[i].getAttribute('wxss:path') === path) {
        var txt = styles[i].textContent || '';
        var out = txt;
        if (out.indexOf('body') !== -1) {
          out = out.replace(/(^|[,{}\s])body(?=[\s,{:])/g, '$1page');
        }
        if (out.indexOf('vh') !== -1) {
          out = out.replace(/(-?\d*\.?\d+)vh/g, function (_, n) {
            return 'calc(var(--vh) * ' + parseFloat(n) + ')';
          });
        }
        if (out !== txt) styles[i].textContent = out;
        return;
      }
    }
  }

  /* ======================================================================
   * Chrome (tabbar)
   * ==================================================================== */

  function buildTabbar() {
    var bar = document.getElementById('tabbar');
    if (!bar) return;
    bar.innerHTML = '';
    for (var i = 0; i < TAB_LIST.length; i++) {
      (function (tab, idx) {
        var item = document.createElement('div');
        item.className = 'wx-tab';
        item.setAttribute('data-index', String(idx));
        var img = document.createElement('img');
        img.src = tab.icon;
        var label = document.createElement('span');
        label.textContent = tab.text;
        item.appendChild(img);
        item.appendChild(label);
        item.addEventListener('click', function () {
          if (tab.route !== currentRoute) wx.switchTab({ url: '/' + tab.route });
        });
        bar.appendChild(item);
      })(TAB_LIST[i], i);
    }
  }

  function updateChrome(route) {
    var bar = document.getElementById('tabbar');
    var idx = -1;
    for (var i = 0; i < TAB_LIST.length; i++) if (TAB_LIST[i].route === route) idx = i;
    if (bar) {
      bar.classList.toggle('wx-show', idx >= 0);
      for (var j = 0; j < bar.children.length; j++) {
        var item = bar.children[j];
        var active = j === idx;
        item.classList.toggle('wx-tab-active', active);
        var img = item.querySelector('img');
        if (img) img.src = active ? TAB_LIST[j].sel : TAB_LIST[j].icon;
      }
    }
    document.body.classList.toggle('wx-has-tabbar', idx >= 0);
    updateVh();
  }

  /* ======================================================================
   * Events
   * ==================================================================== */

  function fireEvent(inst, v, type, el, detail) {
    var a = (v && v.attr) || {};
    var name = a['bind' + type] || a['catch' + type];
    if (!name) return false;
    var fn = inst[name];
    if (typeof fn !== 'function') {
      console.warn('missing handler ' + name);
      return true;
    }
    var ds = datasetOf(v);
    var ev = {
      type: type,
      timeStamp: Date.now(),
      target: { id: a.id || '', dataset: ds, offsetLeft: 0, offsetTop: 0 },
      currentTarget: { id: a.id || '', dataset: ds, offsetLeft: 0, offsetTop: 0 },
      detail: detail || {},
      touches: [],
      changedTouches: []
    };
    try { fn.call(inst, ev); } catch (e) { console.error('handler ' + name, e); }
    return true;
  }

  function attachHostEvents(host, inst) {
    host.addEventListener('click', function (e) {
      if (currentInst !== inst) return;
      var node = e.target;
      while (node && node !== host) {
        var v = node.__v;
        if (v && v.attr) {
          if (node.tagName === 'WX-SWITCH') { toggleSwitch(node, inst); return; }
          if (node.tagName === 'WX-PICKER') { openPicker(node, inst); return; }
          if (v.attr.bindtap || v.attr.catchtap) fireEvent(inst, v, 'tap', node, {});
          if (v.attr.catchtap) return;
        }
        node = node.parentNode;
      }
    });

    host.addEventListener('input', function (e) {
      if (currentInst !== inst) return;
      var node = e.target;
      while (node && node !== host && node.tagName !== 'WX-INPUT') node = node.parentNode;
      if (!node || node === host) return;
      var v = node.__v;
      if (!v || !v.attr) return;
      fireEvent(inst, v, 'input', node, { value: e.target.value, cursor: e.target.selectionStart || 0 });
    });

    host.addEventListener('touchstart', function (e) {
      if (currentInst !== inst) return;
      var node = e.target;
      while (node && node !== host) {
        var v = node.__v;
        if (v && v.attr && v.attr.hoverClass) {
          (function (n, cls) {
            n.classList.add(cls);
            n.__hoverTimer = setTimeout(function () {
              n.classList.remove(cls);
            }, 400);
          })(node, v.attr.hoverClass);
        }
        node = node.parentNode;
      }
      if (e.touches.length === 1 && PAGE_CONFIG[inst.route] && PAGE_CONFIG[inst.route].pullDownRefresh) {
        var sc = findScrollParent(e.target, host);
        if (!sc || sc.scrollTop <= 0) {
          ptrState.tracking = true;
          ptrState.startY = e.touches[0].clientY;
          ptrState.dy = 0;
        }
      }
    }, { passive: true });

    host.addEventListener('touchmove', function (e) {
      if (currentInst !== inst) return;
      var node = e.target;
      while (node && node !== host) {
        var v = node.__v;
        if (v && v.attr && v.attr.catchtouchmove) { e.preventDefault(); return; }
        node = node.parentNode;
      }
      if (!ptrState.tracking || ptrState.refreshing) return;
      var dy = e.touches[0].clientY - ptrState.startY;
      if (dy <= 0) { ptrState.dy = 0; return; }
      ptrState.dy = dy;
      e.preventDefault();
      var d = Math.min(dy * 0.5, 80);
      host.style.transform = 'translateY(' + d + 'px)';
      var ptr = document.getElementById('ptr');
      if (ptr) { ptr.style.height = d + 'px'; ptr.style.opacity = String(Math.min(d / 60, 1)); }
    }, { passive: false });

    host.addEventListener('touchend', function () {
      if (currentInst !== inst) return;
      var wasTracking = ptrState.tracking;
      ptrState.tracking = false;
      if (!wasTracking) return;
      if (ptrState.dy > 55 && !ptrState.refreshing) {
        ptrState.refreshing = true;
        var ptr = document.getElementById('ptr');
        if (ptr) { ptr.style.height = '50px'; ptr.style.opacity = '1'; }
        try { if (typeof inst.onPullDownRefresh === 'function') inst.onPullDownRefresh(); } catch (e) { console.error('onPullDownRefresh', e); }
      } else {
        resetPtr(host);
      }
      ptrState.dy = 0;
    });
  }

  function findScrollParent(node, host) {
    while (node && node !== host) {
      if (node.tagName === 'WX-SCROLL-VIEW' && node.hasAttribute('scroll-y')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function resetPtr(host) {
    if (host) host.style.transform = '';
    var ptr = document.getElementById('ptr');
    if (ptr) { ptr.style.height = '0px'; ptr.style.opacity = '0'; }
    ptrState.refreshing = false;
  }

  function toggleSwitch(el, inst) {
    var sw = el.__sw;
    var checked = !sw.classList.contains('wx-switch-input-checked');
    sw.classList.toggle('wx-switch-input-checked', checked);
    fireEvent(inst, el.__v, 'change', el, { value: checked });
  }

  function openPicker(el, inst) {
    var v = el.__v;
    var a = (v && v.attr) || {};
    var range = a.range || [];
    var value = parseInt(a.value, 10);
    if (isNaN(value)) value = 0;
    var title = a.headerText || '请选择';
    showSheet(title, range, value, function (idx) {
      fireEvent(inst, v, 'change', el, { value: idx });
    });
  }

  /* ======================================================================
   * Overlays: toast / modal / picker sheet
   * ==================================================================== */

  var toastTimer = null;

  function showToast(opts) {
    opts = opts || {};
    var el = document.getElementById('wx-toast');
    if (!el) return;
    var icon = el.querySelector('.wx-toast-icon');
    var text = el.querySelector('.wx-toast-text');
    var box = el.querySelector('.wx-toast-box');
    icon.innerHTML = '';
    var title = opts.title === undefined || opts.title === null ? '' : String(opts.title);
    text.textContent = title;
    var isLoad = opts.icon === 'loading';
    if (isLoad) {
      var sp = document.createElement('div');
      sp.className = 'wx-spinner';
      icon.appendChild(sp);
      box.style.minWidth = '120px';
    } else if (opts.icon === 'success' || opts.icon === 'error') {
      var mark = document.createElement('div');
      mark.className = 'wx-toast-mark ' + (opts.icon === 'success' ? 'ok' : 'err');
      mark.textContent = opts.icon === 'success' ? '\u2713' : '!';
      icon.appendChild(mark);
      box.style.minWidth = '120px';
    } else {
      icon.style.display = 'none';
    }
    if (icon.children.length) icon.style.display = '';
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    var duration = typeof opts.duration === 'number' ? opts.duration : 1500;
    if (isLoad) duration = Math.min(duration, 30000);
    toastTimer = setTimeout(function () { el.hidden = true; }, Math.max(duration, 300));
  }

  function hideToast() {
    var el = document.getElementById('wx-toast');
    if (el) el.hidden = true;
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  }

  function showModal(opts) {
    opts = opts || {};
    var el = document.getElementById('wx-modal');
    if (!el) return;
    var titleEl = el.querySelector('.wx-modal-title');
    var contentEl = el.querySelector('.wx-modal-content');
    var inputEl = el.querySelector('.wx-modal-input');
    var cancelBtn = el.querySelector('.wx-modal-cancel');
    var confirmBtn = el.querySelector('.wx-modal-confirm');
    var title = opts.title === undefined ? '' : String(opts.title);
    var content = opts.content === undefined ? '' : String(opts.content);
    titleEl.textContent = title;
    titleEl.style.display = title ? '' : 'none';
    contentEl.textContent = content;
    contentEl.style.display = content ? '' : 'none';
    var editable = !!opts.editable;
    inputEl.style.display = editable ? '' : 'none';
    inputEl.value = '';
    inputEl.placeholder = opts.placeholderText ? String(opts.placeholderText) : '';
    var showCancel = opts.showCancel === undefined ? true : !!opts.showCancel;
    cancelBtn.style.display = showCancel ? '' : 'none';
    confirmBtn.textContent = opts.confirmText ? String(opts.confirmText) : '确定';
    cancelBtn.textContent = opts.cancelText ? String(opts.cancelText) : '取消';
    el.hidden = false;
    if (editable) setTimeout(function () { try { inputEl.focus(); } catch (e) {} }, 50);

    function done(confirm) {
      el.hidden = true;
      var res = { confirm: confirm, cancel: !confirm, content: inputEl.value };
      if (typeof opts.success === 'function') { try { opts.success(res); } catch (e) { console.error('modal success', e); } }
      if (typeof opts.complete === 'function') { try { opts.complete(res); } catch (e) { console.error('modal complete', e); } }
    }
    confirmBtn.onclick = function () { done(true); };
    cancelBtn.onclick = function () { done(false); };
  }

  var sheetSelectCb = null;

  function showSheet(title, range, value, onSelect) {
    var el = document.getElementById('wx-sheet');
    if (!el) return;
    var titleEl = el.querySelector('.wx-sheet-title');
    var body = el.querySelector('.wx-sheet-body');
    var cancel = el.querySelector('.wx-sheet-cancel');
    var done = el.querySelector('.wx-sheet-done');
    titleEl.textContent = title || '';
    body.innerHTML = '';
    sheetSelectCb = onSelect;
    var activeItem = null;
    for (var i = 0; i < range.length; i++) {
      var item = document.createElement('div');
      item.className = 'wx-sheet-item' + (i === value ? ' wx-sheet-item-active' : '');
      var label = range[i];
      if (label && typeof label === 'object') label = label.name !== undefined ? label.name : JSON.stringify(label);
      item.textContent = String(label);
      item.setAttribute('data-value', String(i));
      if (i === value) activeItem = item;
      body.appendChild(item);
    }
    body.onclick = function (e) {
      var t = e.target;
      while (t && t !== body && !t.hasAttribute('data-value')) t = t.parentNode;
      if (!t || t === body) return;
      var idx = parseInt(t.getAttribute('data-value'), 10);
      closeSheet();
      if (sheetSelectCb) sheetSelectCb(idx);
    };
    cancel.onclick = closeSheet;
    done.onclick = closeSheet;
    el.hidden = false;
    if (activeItem) {
      setTimeout(function () {
        body.scrollTop = activeItem.offsetTop - body.clientHeight / 2 + activeItem.offsetHeight / 2;
      }, 0);
    }
  }

  function closeSheet() {
    var el = document.getElementById('wx-sheet');
    if (el) el.hidden = true;
    sheetSelectCb = null;
  }

  /* ======================================================================
   * wx API
   * ==================================================================== */

  var wx = global.wx = global.wx || {};

  function callbackify(promise, opts, apiName) {
    opts = opts || {};
    promise.then(function (data) {
      if (typeof opts.success === 'function') { try { opts.success(data); } catch (e) { console.error(apiName + ' success', e); } }
      if (typeof opts.complete === 'function') { try { opts.complete(data); } catch (e) {} }
    }, function (err) {
      var e = err || {};
      if (!e.errMsg) e.errMsg = apiName + ':fail';
      if (typeof opts.fail === 'function') { try { opts.fail(e); } catch (er) { console.error(apiName + ' fail', er); } }
      if (typeof opts.complete === 'function') { try { opts.complete(e); } catch (er) {} }
    });
  }

  wx.getAccountInfoSync = function () {
    return { miniProgram: { appId: 'wxbdb8438686a2f0dd', envVersion: 'release', version: '1.0.0' } };
  };

  wx.getSystemInfoSync = function () {
    if (nativeAvailable() && typeof global.NativeBridge.systemInfo === 'function') {
      try {
        var s = global.NativeBridge.systemInfo();
        if (s) return JSON.parse(s);
      } catch (e) { /* ignore */ }
    }
    var w = global.innerWidth || 375;
    var h = global.innerHeight || 812;
    return {
      platform: 'android', system: 'Android', brand: 'Android', model: 'Android',
      pixelRatio: global.devicePixelRatio || 2,
      windowWidth: w, windowHeight: h, screenWidth: w, screenHeight: h,
      statusBarHeight: 0,
      safeArea: { top: 0, bottom: h, left: 0, right: w, width: w, height: h },
      SDKVersion: '3.5.0', version: '8.0.0', language: 'zh_CN',
      bluetoothEnabled: true, locationEnabled: true, locationAuthorized: true
    };
  };

  wx.getSetting = function (opts) {
    opts = opts || {};
    var done = function (granted) {
      var res = { authSetting: { 'scope.bluetooth': granted, 'scope.userLocation': granted } };
      if (opts.success) opts.success(res);
      if (opts.complete) opts.complete(res);
    };
    if (!nativeAvailable()) { done(true); return; }
    callNative('getSetting', {}).then(function (r) { done(!!r.granted); }, function () { done(false); });
  };

  wx.authorize = function (opts) {
    opts = opts || {};
    if (!nativeAvailable()) {
      if (opts.success) opts.success({});
      if (opts.complete) opts.complete({});
      return;
    }
    callNative('requestPermissions', {}).then(function (r) {
      if (r.granted) { if (opts.success) opts.success({}); if (opts.complete) opts.complete({}); }
      else {
        var err = { errMsg: 'authorize:fail auth deny', errCode: 10001 };
        if (opts.fail) opts.fail(err);
        if (opts.complete) opts.complete(err);
      }
    }, function (e) {
      if (opts.fail) opts.fail(e);
      if (opts.complete) opts.complete(e);
    });
  };

  wx.openSetting = function (opts) {
    opts = opts || {};
    if (nativeAvailable()) callNative('openAppSettings', {}).then(function () {}, function () {});
    if (opts.success) opts.success({ authSetting: {} });
    if (opts.complete) opts.complete({ authSetting: {} });
  };
  wx.openAppAuthorizeSetting = function (opts) {
    opts = opts || {};
    if (nativeAvailable()) callNative('openAppSettings', {}).then(function () {}, function () {});
    if (opts.success) opts.success({});
    if (opts.complete) opts.complete({});
  };
  wx.openSystemBluetoothSetting = function (opts) {
    opts = opts || {};
    if (nativeAvailable()) callNative('openBluetoothSettings', {}).then(function () {}, function () {});
    if (opts.success) opts.success({});
    if (opts.complete) opts.complete({});
  };

  /* ---------------- BLE ---------------- */

  wx.openBluetoothAdapter = function (opts) {
    callbackify(callNative('openAdapter', {}), opts, 'openBluetoothAdapter');
  };

  wx.startBluetoothDevicesDiscovery = function (opts) {
    callbackify(callNative('startScan', {
      allowDuplicatesKey: !!(opts && opts.allowDuplicatesKey)
    }), opts, 'startBluetoothDevicesDiscovery');
  };

  wx.stopBluetoothDevicesDiscovery = function (opts) {
    callbackify(callNative('stopScan', {}), opts, 'stopBluetoothDevicesDiscovery');
  };

  wx.createBLEConnection = function (opts) {
    opts = opts || {};
    callbackify(callNative('connect', { deviceId: opts.deviceId, timeout: opts.timeout || 10000 }), opts, 'createBLEConnection');
  };

  wx.closeBLEConnection = function (opts) {
    opts = opts || {};
    callbackify(callNative('disconnect', { deviceId: opts.deviceId }), opts, 'closeBLEConnection');
  };

  wx.getBLEDeviceServices = function (opts) {
    opts = opts || {};
    callbackify(callNative('getServices', { deviceId: opts.deviceId }), opts, 'getBLEDeviceServices');
  };

  wx.getBLEDeviceCharacteristics = function (opts) {
    opts = opts || {};
    callbackify(callNative('getCharacteristics', {
      deviceId: opts.deviceId, serviceId: opts.serviceId
    }), opts, 'getBLEDeviceCharacteristics');
  };

  wx.notifyBLECharacteristicValueChange = function (opts) {
    opts = opts || {};
    callbackify(callNative('notify', {
      deviceId: opts.deviceId,
      serviceId: opts.serviceId,
      characteristicId: opts.characteristicId,
      state: opts.state !== false
    }), opts, 'notifyBLECharacteristicValueChange');
  };

  wx.setBLEMTU = function (opts) {
    opts = opts || {};
    callbackify(callNative('setMtu', {
      deviceId: opts.deviceId, mtu: opts.mtu || 23
    }), opts, 'setBLEMTU');
  };

  wx.writeBLECharacteristicValue = function (opts) {
    opts = opts || {};
    var value = opts.value;
    var b64 = '';
    try {
      if (value instanceof ArrayBuffer) b64 = arrayBufferToB64(value);
      else if (value && value.buffer instanceof ArrayBuffer) b64 = arrayBufferToB64(value.buffer);
      else if (Array.isArray(value)) b64 = arrayBufferToB64(new Uint8Array(value).buffer);
      else if (typeof value === 'string') {
        var bytes = new Uint8Array(value.length);
        for (var i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
        b64 = arrayBufferToB64(bytes.buffer);
      }
    } catch (e) {
      if (opts.fail) opts.fail({ errMsg: 'writeBLECharacteristicValue:fail ' + e.message, errCode: -1 });
      if (opts.complete) opts.complete({});
      return;
    }
    callbackify(callNative('write', {
      deviceId: opts.deviceId,
      serviceId: opts.serviceId,
      characteristicId: opts.characteristicId,
      value: b64,
      writeType: opts.writeType || 'write'
    }), opts, 'writeBLECharacteristicValue');
  };

  wx.onBluetoothDeviceFound = function (cb) { addNativeListener('bleDeviceFound', cb); };
  wx.offBluetoothDeviceFound = function () { clearNativeListeners('bleDeviceFound'); };
  wx.onBluetoothAdapterStateChange = function (cb) { addNativeListener('bleAdapterStateChange', cb); };
  wx.offBluetoothAdapterStateChange = function () { clearNativeListeners('bleAdapterStateChange'); };
  wx.onBLEConnectionStateChange = function (cb) { addNativeListener('bleConnectionStateChange', cb); };
  wx.offBLEConnectionStateChange = function () { clearNativeListeners('bleConnectionStateChange'); };
  wx.onBLECharacteristicValueChange = function (cb) { addNativeListener('bleCharacteristicValueChange', cb); };
  wx.offBLECharacteristicValueChange = function () { clearNativeListeners('bleCharacteristicValueChange'); };

  global.__nativeEvent = (function (orig) {
    return function (name, json) {
      if (name === 'bleCharacteristicValueChange') {
        var data;
        try { data = JSON.parse(json); } catch (e) { data = {}; }
        if (data && typeof data.value === 'string') {
          try { data.value = b64ToArrayBuffer(data.value); } catch (e) { data.value = new ArrayBuffer(0); }
        }
        var list = nativeListeners[name] || [];
        for (var i = 0; i < list.length; i++) {
          try { list[i](data); } catch (e) { console.error('char event', e); }
        }
        return;
      }
      orig(name, json);
    };
  })(global.__nativeEvent);

  /* ---------------- UI ---------------- */

  wx.showToast = function (opts) { showToast(opts || {}); };
  wx.hideToast = function () { hideToast(); };
  wx.showLoading = function (opts) {
    opts = opts || {};
    showToast({ title: opts.title || '', icon: 'loading', duration: 30000, mask: opts.mask });
  };
  wx.hideLoading = function () { hideToast(); };
  wx.showModal = function (opts) { showModal(opts || {}); };

  wx.stopPullDownRefresh = function (opts) {
    resetPtr(currentInst && currentInst.__host);
    if (opts && opts.success) opts.success({});
    if (opts && opts.complete) opts.complete({});
  };

  wx.setNavigationBarTitle = function (opts) {
    opts = opts || {};
    if (opts.title) {
      var t = document.getElementById('nav-title');
      if (t) t.textContent = opts.title;
    }
    if (opts.success) opts.success({});
    if (opts.complete) opts.complete({});
  };

  /* ---------------- File system ---------------- */

  wx.chooseMessageFile = function (opts) {
    opts = opts || {};
    callbackify(callNative('chooseFile', {
      count: opts.count || 1,
      type: opts.type || 'file',
      extension: opts.extension || []
    }), opts, 'chooseMessageFile');
  };

  var fsManager = {
    readFile: function (opts) {
      opts = opts || {};
      callNative('readFile', { filePath: opts.filePath }).then(function (r) {
        var buf;
        try { buf = b64ToArrayBuffer(r.data || ''); } catch (e) { buf = new ArrayBuffer(0); }
        var position = opts.position || 0;
        if (position > 0 && position < buf.byteLength) buf = buf.slice(position);
        var res = { data: buf };
        if (opts.success) opts.success(res);
        if (opts.complete) opts.complete(res);
      }, function (e) {
        if (opts.fail) opts.fail(e);
        if (opts.complete) opts.complete(e);
      });
    },
    readFileSync: function () { throw new Error('readFileSync not supported'); },
    writeFile: function (opts) { if (opts && opts.fail) opts.fail({ errMsg: 'writeFile:fail not supported' }); },
    access: function (opts) { if (opts && opts.fail) opts.fail({ errMsg: 'access:fail' }); }
  };
  wx.getFileSystemManager = function () { return fsManager; };

  /* ---------------- Navigation ---------------- */

  function resolveUrl(url) {
    url = String(url || '');
    url = url.replace(/\.html$/, '');
    if (url.charAt(0) === '/') return url.slice(1);
    var base = currentRoute.split('/').slice(0, -1).join('/');
    var joined = base + '/' + url;
    var parts = joined.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i];
      if (s === '' || s === '.') continue;
      if (s === '..') out.pop();
      else out.push(s);
    }
    return out.join('/');
  }

  function navResult(opts, ok, errMsg) {
    var res = ok ? { errMsg: errMsg + ':ok' } : { errMsg: errMsg + ':fail ' + (errMsg || '') };
    if (ok) {
      if (opts && opts.success) { try { opts.success(res); } catch (e) {} }
    } else if (opts && opts.fail) { try { opts.fail(res); } catch (e) {} }
    if (opts && opts.complete) { try { opts.complete(res); } catch (e) {} }
  }

  wx.switchTab = function (opts) {
    opts = opts || {};
    var route = resolveUrl(opts.url);
    var isTab = false;
    for (var i = 0; i < TAB_LIST.length; i++) if (TAB_LIST[i].route === route) isTab = true;
    if (!isTab) { navResult(opts, false, 'switchTab'); return; }
    if (currentInst && currentInst.route === route) {
      renderPage(currentInst);
      navResult(opts, true, 'switchTab');
      return;
    }
    activate(route);
    navResult(opts, true, 'switchTab');
  };

  wx.redirectTo = function (opts) {
    opts = opts || {};
    var route = resolveUrl(opts.url);
    if (!__pageOptions[route]) { navResult(opts, false, 'redirectTo'); return; }
    var old = currentInst;
    currentInst = null;
    if (old) destroyPage(old);
    activate(route);
    navResult(opts, true, 'redirectTo');
  };

  wx.navigateTo = function (opts) {
    opts = opts || {};
    var route = resolveUrl(opts.url);
    if (!__pageOptions[route]) { navResult(opts, false, 'navigateTo'); return; }
    if (currentInst) { pageStack.push(currentInst.route); hidePage(currentInst); }
    activate(route);
    navResult(opts, true, 'navigateTo');
  };

  wx.navigateBack = function (opts) {
    opts = opts || {};
    var prev = pageStack.pop();
    if (!prev) { navResult(opts, false, 'navigateBack'); return; }
    if (currentInst) { var old = currentInst; currentInst = null; destroyPage(old); }
    activate(prev);
    navResult(opts, true, 'navigateBack');
  };

  wx.reLaunch = function (opts) {
    opts = opts || {};
    var route = resolveUrl(opts.url);
    if (!__pageOptions[route]) { navResult(opts, false, 'reLaunch'); return; }
    for (var k in __instances) { if (__instances[k] !== currentInst) destroyPage(__instances[k]); }
    if (currentInst) { var old = currentInst; currentInst = null; destroyPage(old); }
    pageStack = [];
    activate(route);
    navResult(opts, true, 'reLaunch');
  };

  /* ---------------- misc no-ops ---------------- */

  var noop = function () {};
  ['onAppShow', 'onAppHide', 'onError', 'onPageNotFound', 'onUnhandledRejection',
    'onNetworkStatusChange', 'onAccelerometerChange', 'onCompassChange', 'onDeviceMotionChange',
    'offAppShow', 'offAppHide', 'offError', 'offPageNotFound', 'offUnhandledRejection',
    'offNetworkStatusChange', 'startPullDownRefresh', 'setBackgroundColor', 'setBackgroundTextStyle',
    'setNavigationBarColor', 'showNavigationBarLoading', 'hideNavigationBarLoading',
    'enableAlertBeforeUnload', 'disableAlertBeforeUnload', 'setKeepScreenOn', 'vibrateShort',
    'vibrateLong', 'setClipboardData', 'getClipboardData', 'makePhoneCall', 'scanCode',
    'previewImage', 'saveImageToPhotosAlbum', 'getUpdateManager', 'getLaunchOptionsSync',
    'onMemoryWarning', 'offMemoryWarning', 'reportAnalytics', 'getRealtimeLogManager'
  ].forEach(function (name) { if (!wx[name]) wx[name] = noop; });

  wx.canIUse = function () { return true; };
  wx.nextTick = function (fn) { setTimeout(fn, 0); };
  wx.getMenuButtonBoundingClientRect = function () {
    var w = global.innerWidth || 375;
    return { top: 4, right: w - 7, bottom: 36, left: w - 94, width: 87, height: 32 };
  };

  /* ======================================================================
   * Boot
   * ==================================================================== */

  function updateVh() {
    var area = document.getElementById('page-area');
    var h = area ? area.clientHeight : (global.innerHeight || 0);
    document.documentElement.style.setProperty('--vh', (h / 100) + 'px');
  }

  function initialRoute() {
    var hash = (global.location.hash || '').replace(/^#\/?/, '');
    hash = hash.replace(/\.html$/, '');
    if (hash && __pageOptions[hash]) return hash;
    if (__pageOptions['pages/index/index']) return 'pages/index/index';
    for (var k in __pageOptions) return k;
    return '';
  }

  global.__boot__ = function () {
    buildTabbar();
    updateVh();
    global.addEventListener('resize', function () { updateVh(); });

    if (__app && typeof __app.onLaunch === 'function') {
      try { __app.onLaunch({ path: initialRoute(), query: {}, scene: 1001 }); } catch (e) { console.error('onLaunch', e); }
    }
    if (__app && typeof __app.onShow === 'function') {
      try { __app.onShow({}); } catch (e) { console.error('onShow app', e); }
    }
    var route = initialRoute();
    if (route) activate(route);
    else console.error('no pages registered');
    if (nativeAvailable() && typeof global.NativeBridge.log === 'function') {
      var names = [];
      for (var k in __pageOptions) names.push(k);
      try { global.NativeBridge.log('BOOT route=' + route + ' pages=' + names.join(',')); } catch (e) {}
    }
  };

  global.__goto = function (route) {
    if (!__pageOptions[route]) return false;
    if (currentInst) destroyPage(currentInst);
    currentInst = null;
    activate(route);
    return true;
  };

  global.addEventListener('error', function (e) {
    if (nativeAvailable() && typeof global.NativeBridge.log === 'function') {
      try { global.NativeBridge.log('JSERR ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || 0)); } catch (er) {}
    }
  });

  global.__wxRuntimeReady__ = true;
})(window);
