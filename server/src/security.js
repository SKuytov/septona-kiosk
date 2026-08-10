'use strict';
/**
 * Hardening for instances that are reachable from outside the LAN.
 *
 * The server was originally written for a switch in a factory: one flat network, no
 * hostile clients, no TLS. Publishing the panel through a tunnel changes every one of
 * those assumptions, so the pieces below are the difference between "on our network"
 * and "on the internet". They are deliberately dependency-free — a handful of static
 * headers and two in-memory counters are easier to audit than another supply chain,
 * and there is exactly one server process.
 *
 * `PUBLIC_ORIGIN` (e.g. https://docs.example.com) is the switch: when it is set the
 * instance is treated as internet-facing, which turns on HSTS and turns weak secrets
 * from a warning into a refusal to start.
 */
const bcrypt = require('bcryptjs');
const { q } = require('./db');

const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
const IS_PUBLIC = PUBLIC_ORIGIN !== '';

/** Origins the browser build may be loaded from, besides the server's own. */
const NATIVE_ORIGINS = [
  // Capacitor serves the APK bundle from a local origin and calls the API cross-site.
  'https://localhost',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
];

const CONFIGURED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

// ---------------------------------------------------------------- weak secrets

const WEAK_SECRETS = new Set([
  'change-me-in-production', 'changeme', 'change-me', 'secret', 'password',
  'septona', 'septona-kiosk', 'testsecret0123456789', 'dev', 'development',
]);

const DEFAULT_ADMIN_PASSWORD = 'septona-admin';

/**
 * Refuses to start a public instance that anyone could walk into. A forgeable JWT
 * secret is the worst of the two: it does not merely allow guessing a password, it
 * lets a stranger mint an admin token without one.
 */
async function assertSafeToExpose() {
  if (!IS_PUBLIC) return;
  const problems = [];

  const secret = process.env.JWT_SECRET || '';
  if (!secret || WEAK_SECRETS.has(secret.toLowerCase()) || secret.length < 24) {
    problems.push(
      'JWT_SECRET липсва, познат е или е по-къс от 24 знака. Генерирайте нов с:\n' +
      '        openssl rand -base64 48'
    );
  }

  // A default password on a LAN box is untidy; on a public URL it is an open door.
  try {
    const { rows } = await q(
      "SELECT email, password_hash FROM users WHERE active = TRUE AND role = 'admin'"
    );
    for (const u of rows) {
      if (await bcrypt.compare(DEFAULT_ADMIN_PASSWORD, u.password_hash)) {
        problems.push(
          `Администраторът ${u.email} все още използва фабричната парола. ` +
          'Влезте от локалната мрежа, сменете я и стартирайте отново.'
        );
      }
    }
  } catch (e) {
    // A schema that is not there yet is init()'s problem, not ours.
    if (e.code !== '42P01') throw e;
  }

  if (problems.length) {
    console.error(
      '\n[security] Отказвам да стартирам с PUBLIC_ORIGIN=' + PUBLIC_ORIGIN + ':\n' +
      problems.map((p) => '  • ' + p).join('\n') +
      '\n\n  Премахнете PUBLIC_ORIGIN, за да стартирате само за локалната мрежа.\n'
    );
    process.exit(1);
  }
}

// -------------------------------------------------------------------- headers

/**
 * The Content-Security-Policy is the one header here that can break the product, so
 * it is written against what the two bundles actually do: same-origin scripts, inline
 * styles from the bundler, and blob: URLs for pdf.js workers and rendered pages.
 */
function contentSecurityPolicy() {
  const connect = ["'self'", ...(IS_PUBLIC ? [PUBLIC_ORIGIN] : []), ...CONFIGURED_ORIGINS];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    // Inline PDF previews are same-origin iframes; pdf.js also renders into blob: URLs.
    "object-src 'self' blob:",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    `connect-src ${[...new Set(connect)].join(' ')}`,
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

const CSP = contentSecurityPolicy();

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  // Keeps the `?token=` preview URL out of the Referer sent to any third party.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), usb=()');
  res.setHeader('Content-Security-Policy', CSP);
  // Announced only over TLS: pinning HSTS onto a plain-HTTP LAN address would make
  // http://192.168.0.160:8080 unreachable in that browser for a year.
  if (IS_PUBLIC && (req.secure || req.headers['x-forwarded-proto'] === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api/')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}

// ------------------------------------------------------------------------ CORS

/**
 * The panel and the browser kiosk are served by this same process, so their requests
 * are same-origin and need no CORS at all. Only the APK genuinely calls across
 * origins, and only into /api/kiosk. Everything else is closed.
 */
function corsPolicy(req, res, next) {
  const origin = req.headers.origin;
  res.setHeader('Vary', 'Origin');
  if (!origin) return next(); // curl, the APK's native layer, server-to-server

  const selfOrigin = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
  const kioskApi = req.path.startsWith('/api/kiosk');
  const allowed =
    origin === selfOrigin ||
    origin === PUBLIC_ORIGIN ||
    NATIVE_ORIGINS.includes(origin) ||
    CONFIGURED_ORIGINS.includes(origin) ||
    // A display may be provisioned against any address its owner typed in; the device
    // key, not the origin, is what authorises it.
    kioskApi;

  if (!allowed) {
    if (req.method === 'OPTIONS') return res.status(403).end();
    return next();
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Key, If-None-Match');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'ETag');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

// ---------------------------------------------------------------- rate limits

/** Fixed-window counter. Windows are short, so the boundary burst is not worth a
 *  sliding log and the extra memory it costs. */
function createWindowCounter(windowMs) {
  const hits = new Map();
  // Without this the map grows for every IP that ever connects. Unref'd so the timer
  // never holds the process open.
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs).unref();
  return {
    /** @returns {{count:number, resetAt:number}} state after counting this hit */
    bump(key) {
      const now = Date.now();
      let e = hits.get(key);
      if (!e || e.resetAt <= now) {
        e = { count: 0, resetAt: now + windowMs };
        hits.set(key, e);
      }
      e.count += 1;
      return e;
    },
    peek(key) {
      const e = hits.get(key);
      return e && e.resetAt > Date.now() ? e : null;
    },
    clear(key) {
      hits.delete(key);
    },
  };
}

const tooMany = (res, resetAt, message) => {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
  res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
};

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_IP = 10;
const LOGIN_MAX_PER_ACCOUNT = 8;
// The socket is the one thing a client cannot forge, but behind a tunnel every remote
// user shares it — so this ceiling is the whole world's failure budget and has to be
// loose enough not to lock out a colleague who mistypes twice.
const LOGIN_MAX_PER_SOCKET = 30;

/**
 * Counts only failures, so a busy day of legitimate logins can never lock anyone out.
 * Three keys, because each defeats a different attack: per-account stops a distributed
 * run at one known address, per-IP stops one host grinding a password list, and
 * per-socket stops someone who reaches the port directly and rotates X-Forwarded-For to
 * make every guess look like it came from a new address.
 */
function loginRateLimit() {
  const byIp = createWindowCounter(LOGIN_WINDOW_MS);
  const byAccount = createWindowCounter(LOGIN_WINDOW_MS);
  const bySocket = createWindowCounter(LOGIN_WINDOW_MS);
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const sock = req.socket?.remoteAddress || 'unknown';
    const email = String(req.body?.email || '').toLowerCase().trim();
    const over = (counter, key, max) => {
      const e = key ? counter.peek(key) : null;
      return e && e.count >= max ? e : null;
    };
    const blocked =
      over(byIp, ip, LOGIN_MAX_PER_IP) ||
      over(byAccount, email, LOGIN_MAX_PER_ACCOUNT) ||
      over(bySocket, sock, LOGIN_MAX_PER_SOCKET);
    if (blocked) {
      const mins = Math.ceil((blocked.resetAt - Date.now()) / 60000);
      return tooMany(res, blocked.resetAt,
        `Твърде много неуспешни опити. Опитайте отново след ${mins} мин.`);
    }
    res.on('finish', () => {
      if (res.statusCode === 401) {
        byIp.bump(ip);
        bySocket.bump(sock);
        if (email) byAccount.bump(email);
      } else if (res.statusCode < 400) {
        // A correct password clears the account's counter but not the IP's: the point
        // of the IP limit is the guessing, and one hit does not excuse the rest.
        if (email) byAccount.clear(email);
      }
    });
    next();
  };
}

const API_WINDOW_MS = 60 * 1000;
const API_MAX = parseInt(process.env.API_RATE_LIMIT || '300', 10);

/**
 * A blunt ceiling on the admin API. /api/kiosk is exempt: a site's displays share one
 * public IP, they poll on a timer, and they are already gated by a device key.
 */
function apiRateLimit() {
  const byIp = createWindowCounter(API_WINDOW_MS);
  return (req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path.startsWith('/api/kiosk') ||
        req.path === '/api/health') return next();
    const e = byIp.bump(req.ip || 'unknown');
    if (e.count > API_MAX) {
      return tooMany(res, e.resetAt, 'Твърде много заявки. Изчакайте малко.');
    }
    next();
  };
}

module.exports = {
  PUBLIC_ORIGIN, IS_PUBLIC,
  assertSafeToExpose, securityHeaders, corsPolicy, loginRateLimit, apiRateLimit,
  // exported for tests
  createWindowCounter, contentSecurityPolicy,
};
