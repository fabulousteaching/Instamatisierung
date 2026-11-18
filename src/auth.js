'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'insta_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  // Hashen, damit die Längen gleich sind und kein Timing-Leak entsteht.
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function sign(payload, secret, password) {
  // Das Passwort fließt mit ein: Passwort ändern = alle Sitzungen ungültig.
  return crypto.createHmac('sha256', secret).update(`${payload}|${sha256(password).toString('hex')}`).digest('hex');
}

function createSessionToken({ secret, password, now = Date.now(), ttlMs = SESSION_TTL_MS }) {
  const expires = now + ttlMs;
  return `${expires}.${sign(expires, secret, password)}`;
}

function verifySessionToken(token, { secret, password, now = Date.now() }) {
  if (!token || typeof token !== 'string') return false;
  const [expires, mac] = token.split('.');
  if (!expires || !mac || !/^\d+$/.test(expires)) return false;
  if (Number(expires) < now) return false;
  return safeEqual(mac, sign(expires, secret, password));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

/** Einfacher Schutz gegen Passwort-Raten: max. 10 Fehlversuche pro IP in 15 Minuten. */
class LoginLimiter {
  constructor({ maxFailures = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.failures = new Map();
  }

  isBlocked(ip, now = Date.now()) {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (now - entry.first > this.windowMs) {
      this.failures.delete(ip);
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(ip, now = Date.now()) {
    const entry = this.failures.get(ip);
    if (!entry || now - entry.first > this.windowMs) {
      this.failures.set(ip, { first: now, count: 1 });
    } else {
      entry.count++;
    }
    if (this.failures.size > 10000) this.failures.clear();
  }

  reset(ip) {
    this.failures.delete(ip);
  }
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  safeEqual,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  LoginLimiter,
};
