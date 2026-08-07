/*
 * Runtime shims for older Android WebViews.
 *
 * ## Why this is a plain classic script and not a module
 *
 * A polyfill is only useful if it runs before the code that needs it. As an ES module
 * imported from the app entry it did not: Rollup emits the entry's static chunk imports
 * ahead of that chunk's own inline code, so the pdf.js chunk — and the core-js polyfills
 * bundled inside its legacy build — evaluated first. The shim was still installed, but it
 * was no longer the thing that made the engine work, and its report of what the WebView
 * lacked was wrong, because core-js had already patched the global.
 *
 * A blocking classic script in <head> has none of that ambiguity: it runs to completion
 * before the module graph is fetched, let alone evaluated. That ordering is the whole point
 * of this file, so it deliberately sits outside the bundle.
 *
 * ## Why any of it is needed
 *
 * These panels are industrial hardware. The System WebView is whatever the firmware
 * shipped with and often cannot be updated, so the app cannot assume a current Chromium.
 * pdf.js calls `Promise.withResolvers()`, added in Chrome/WebView 119; on an older panel
 * every document failed with `TypeError: Promise.withResolvers is not a function` while the
 * board itself rendered perfectly. The engine now uses the pdf.js legacy build, which
 * carries its own polyfills into its worker; this file covers the app's own code and
 * records what was missing so the diagnostics screen can report it.
 *
 * Written in conservative ES5 on purpose: it must parse on an engine older than anything
 * the bundle targets, because a syntax error here would take the whole app down.
 * Everything is additive and guarded — on a current WebView it changes nothing.
 */
(function () {
  'use strict';

  /* What this engine has natively, sampled before anything below patches it. */
  var native = {
    'Promise.withResolvers': typeof Promise.withResolvers === 'function',
    'Object.hasOwn': typeof Object.hasOwn === 'function',
    'Array.prototype.at': typeof Array.prototype.at === 'function',
    'Array.prototype.findLast': typeof Array.prototype.findLast === 'function',
    structuredClone: typeof self.structuredClone === 'function'
  };

  var shimmed = [];
  for (var key in native) {
    if (Object.prototype.hasOwnProperty.call(native, key) && !native[key]) shimmed.push(key);
  }

  /*
   * Published for the diagnostics screen, and readable straight from a `chrome://inspect`
   * console when triaging an unfamiliar panel.
   */
  self.__septonaCompat = { native: native, shimmed: shimmed };
  self.__septonaShimmed = shimmed;

  /* Defines a property only when genuinely absent, non-enumerably, as the spec has it. */
  function polyfill(target, name, value) {
    if (name in target) return;
    try {
      Object.defineProperty(target, name, {
        value: value,
        writable: true,
        configurable: true,
        enumerable: false
      });
    } catch (e) {
      /* Frozen intrinsic: nothing sensible to do, and throwing here would kill the app. */
    }
  }

  /* ---------------------------------------------------- Promise.withResolvers (Chrome 119) */
  polyfill(Promise, 'withResolvers', function withResolvers() {
    var resolve, reject;
    var promise = new this(function (res, rej) {
      resolve = res;
      reject = rej;
    });
    return { promise: promise, resolve: resolve, reject: reject };
  });

  /* ----------------------------------------------------------- Object.hasOwn (Chrome 93) */
  polyfill(Object, 'hasOwn', function hasOwn(o, v) {
    return Object.prototype.hasOwnProperty.call(Object(o), v);
  });

  /* ------------------------------------------------------ Array/String .at() (Chrome 92) */
  function at(index) {
    var len = this.length;
    var i = Math.trunc(index) || 0;
    if (i < 0) i += len;
    if (i < 0 || i >= len) return undefined;
    return this[i];
  }
  polyfill(Array.prototype, 'at', at);
  polyfill(String.prototype, 'at', at);

  /* ------------------------------------------- Array.prototype.findLast/Index (Chrome 97) */
  polyfill(Array.prototype, 'findLastIndex', function findLastIndex(pred, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) {
      if (pred.call(thisArg, this[i], i, this)) return i;
    }
    return -1;
  });
  polyfill(Array.prototype, 'findLast', function findLast(pred, thisArg) {
    for (var i = this.length - 1; i >= 0; i--) {
      if (pred.call(thisArg, this[i], i, this)) return this[i];
    }
    return undefined;
  });

  /*
   * ------------------------------------------------------- structuredClone (Chrome 98)
   * Only the shapes this app's data can take are handled: manifests, plain records and PDF
   * byte buffers. Anything exotic is returned as-is rather than throwing, which is the
   * safer failure for a display that has to keep working.
   */
  polyfill(self, 'structuredClone', function structuredClone(input) {
    var seen = new Map();

    function walk(v) {
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) return seen.get(v);

      if (v instanceof Date) return new Date(v.getTime());
      if (v instanceof ArrayBuffer) return v.slice(0);
      if (ArrayBuffer.isView(v)) return new v.constructor(v.buffer.slice(0), 0, v.length);

      var out;
      if (Array.isArray(v)) {
        out = [];
        seen.set(v, out);
        for (var i = 0; i < v.length; i++) out.push(walk(v[i]));
        return out;
      }
      if (v instanceof Map) {
        out = new Map();
        seen.set(v, out);
        v.forEach(function (val, k) { out.set(walk(k), walk(val)); });
        return out;
      }
      if (v instanceof Set) {
        out = new Set();
        seen.set(v, out);
        v.forEach(function (val) { out.add(walk(val)); });
        return out;
      }

      var proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v; /* class instance */

      out = {};
      seen.set(v, out);
      Object.keys(v).forEach(function (k) { out[k] = walk(v[k]); });
      return out;
    }

    return walk(input);
  });
})();
