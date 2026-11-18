'use strict';

const crypto = require('node:crypto');

/**
 * Verwaltung des Instagram Access Tokens und der Kontodaten.
 *
 * Der Token wird in der Datenbank gespeichert, damit er automatisch
 * verlängert werden kann (Instagram-Login-Tokens laufen nach 60 Tagen ab;
 * System-User-Tokens aus "Unified login" laufen nicht ab).
 */

const DAY = 24 * 60 * 60 * 1000;
const REFRESH_EVERY_MS = 7 * DAY;
const REFRESH_RETRY_MS = 12 * 60 * 60 * 1000;

function fingerprint(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function getAccessToken(store) {
  return store.getSetting('access_token');
}

function getApiMode(store) {
  return store.getSetting('api_mode');
}

function getAccountId(store) {
  return store.getSetting('ig_user_id');
}

function storeAccountInfo(store, me) {
  store.setSetting('api_mode', me.mode ?? null);
  store.setSetting('ig_user_id', me.user_id ?? null);
  store.setSetting('ig_app_scoped_id', me.id ?? null);
  store.setSetting('ig_username', me.username ?? null);
  store.setSetting('ig_name', me.name ?? null);
  store.setSetting('ig_profile_picture_url', me.profile_picture_url ?? null);
}

/** Prüft den Token bei Instagram und speichert ihn samt Kontodaten. */
async function saveAccessToken(store, client, token, { accountId = null, now = Date.now() } = {}) {
  const trimmed = String(token || '').trim();
  if (!trimmed) throw new Error('Bitte einen Access Token eingeben.');
  const id = accountId ? String(accountId).trim() : '';
  if (id && !/^\d{1,40}$/.test(id)) throw new Error('Die Instagram-Konto-ID besteht nur aus Ziffern.');
  const me = await client.resolveAccount(trimmed, id || null);
  store.transaction(() => {
    store.setSetting('access_token', trimmed);
    store.setSetting('token_saved_at', now);
    store.setSetting('token_refreshed_at', null);
    store.setSetting('token_refresh_attempted_at', null);
    store.setSetting('token_refresh_error', null);
    store.setSetting('token_expires_at', null);
    storeAccountInfo(store, me);
  });
  return me;
}

/**
 * Übernimmt IG_ACCESS_TOKEN aus der Umgebung, wenn er neu ist
 * (sonst gewinnt der evtl. schon verlängerte Token aus der Datenbank).
 */
async function syncEnvToken(store, client, envToken, { accountId = null, logger = console } = {}) {
  if (!envToken) return;
  const fp = fingerprint(`${envToken}|${accountId || ''}`);
  if (store.getSetting('env_token_fingerprint') === fp) return;
  try {
    const me = await saveAccessToken(store, client, envToken, { accountId });
    logger.log(`Access Token aus IG_ACCESS_TOKEN übernommen (Konto @${me.username}).`);
  } catch (err) {
    // Trotzdem speichern – evtl. ist nur Instagram gerade nicht erreichbar.
    store.setSetting('access_token', envToken.trim());
    store.setSetting('token_saved_at', Date.now());
    logger.warn(`IG_ACCESS_TOKEN konnte nicht geprüft werden: ${err.message}`);
  }
  store.setSetting('env_token_fingerprint', fp);
}

/** Verlängert den Token, sobald er eine Woche nicht mehr verlängert wurde. */
async function refreshTokenIfDue(store, client, { now = Date.now(), force = false, logger = console } = {}) {
  const token = getAccessToken(store);
  if (!token) return { refreshed: false, reason: 'Kein Token' };
  if (getApiMode(store) === 'facebook') {
    if (force) throw new Error('Dieser Token (Unified login) läuft nicht ab und muss nicht verlängert werden.');
    return { refreshed: false, reason: 'Token läuft nicht ab' };
  }

  const last = Number(store.getSetting('token_refreshed_at') || store.getSetting('token_saved_at') || 0);
  const attempted = Number(store.getSetting('token_refresh_attempted_at') || 0);
  if (!force) {
    if (now - last < REFRESH_EVERY_MS) return { refreshed: false, reason: 'Noch nicht fällig' };
    if (now - attempted < REFRESH_RETRY_MS) return { refreshed: false, reason: 'Kürzlich versucht' };
  }

  store.setSetting('token_refresh_attempted_at', now);
  try {
    const res = await client.refreshToken();
    if (!res || !res.access_token) throw new Error('Antwort enthielt keinen neuen Token.');
    store.transaction(() => {
      store.setSetting('access_token', res.access_token);
      store.setSetting('token_refreshed_at', now);
      store.setSetting('token_refresh_error', null);
      store.setSetting('token_expires_at', res.expires_in ? now + Number(res.expires_in) * 1000 : null);
    });
    logger.log('Instagram Access Token wurde verlängert.');
    return { refreshed: true, expires_at: Number(store.getSetting('token_expires_at')) || null };
  } catch (err) {
    const message = String(err);
    store.setSetting('token_refresh_error', message);
    logger.warn(`Token-Verlängerung fehlgeschlagen: ${message}`);
    if (force) throw err;
    return { refreshed: false, reason: message };
  }
}

function accountStatus(store) {
  const num = (key) => {
    const v = store.getSetting(key);
    return v ? Number(v) : null;
  };
  return {
    connected: !!getAccessToken(store),
    api_mode: getApiMode(store),
    user_id: store.getSetting('ig_user_id'),
    username: store.getSetting('ig_username'),
    name: store.getSetting('ig_name'),
    profile_picture_url: store.getSetting('ig_profile_picture_url'),
    token_saved_at: num('token_saved_at'),
    token_refreshed_at: num('token_refreshed_at'),
    token_expires_at: num('token_expires_at'),
    token_refresh_error: store.getSetting('token_refresh_error'),
  };
}

module.exports = {
  getAccessToken,
  getApiMode,
  getAccountId,
  saveAccessToken,
  syncEnvToken,
  refreshTokenIfDue,
  accountStatus,
};
