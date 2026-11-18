'use strict';

const crypto = require('node:crypto');
const { saveAccessToken } = require('./account');

/**
 * Anmeldung über Metas "API setup with Unified login" (Facebook Login for Business
 * mit Konfiguration). Ablauf:
 *   1. Dashboard baut die Login-URL (App-ID + Konfigurations-ID + Weiterleitungs-URL).
 *   2. Du meldest dich bei Meta an und gibst dein Instagram-Konto frei.
 *   3. Meta leitet zurück zu /auth/callback?code=…
 *   4. Das Tool tauscht den Code gegen einen (System-User-)Token und speichert ihn.
 */

const STATE_TTL_MS = 15 * 60 * 1000;

function oauthSettings(store) {
  return {
    app_id: store.getSetting('fb_app_id') || '',
    config_id: store.getSetting('fb_config_id') || '',
    redirect_uri: store.getSetting('fb_redirect_uri') || '',
    has_secret: !!store.getSetting('fb_app_secret'),
  };
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Speichert App-ID, App-Geheimschlüssel, Konfigurations-ID und Weiterleitungs-URL. */
function saveOAuthSettings(store, input = {}) {
  const appId = String(input.app_id ?? '').trim();
  const configId = String(input.config_id ?? '').trim();
  const redirectUri = String(input.redirect_uri ?? '').trim();
  const appSecret = String(input.app_secret ?? '').trim();

  const errors = [];
  if (!/^\d{5,40}$/.test(appId)) errors.push('Die App-ID besteht nur aus Ziffern (App-Einstellungen → Grundlegendes).');
  if (!/^\d{5,40}$/.test(configId)) errors.push('Die Konfigurations-ID besteht nur aus Ziffern.');
  if (!isHttpUrl(redirectUri)) errors.push('Die Weiterleitungs-URL muss mit http:// oder https:// beginnen.');
  if (appSecret && !/^[0-9a-f]{16,64}$/i.test(appSecret)) errors.push('Der App-Geheimschlüssel sieht nicht richtig aus (32 Zeichen, 0–9 und a–f).');
  if (!appSecret && !store.getSetting('fb_app_secret')) errors.push('Bitte den App-Geheimschlüssel eintragen.');
  if (errors.length) {
    const err = new Error(errors[0]);
    err.details = errors;
    throw err;
  }

  store.transaction(() => {
    store.setSetting('fb_app_id', appId);
    store.setSetting('fb_config_id', configId);
    store.setSetting('fb_redirect_uri', redirectUri);
    if (appSecret) store.setSetting('fb_app_secret', appSecret);
  });
}

/** Baut die Meta-Login-URL und merkt sich einen Einmal-Wert ("state") gegen Fälschungen. */
function buildLoginUrl(store, { version, now = Date.now() }) {
  const s = oauthSettings(store);
  const state = crypto.randomBytes(16).toString('hex');
  store.setSetting('oauth_state', `${state}.${now + STATE_TTL_MS}`);
  const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
  url.searchParams.set('client_id', s.app_id);
  url.searchParams.set('config_id', s.config_id);
  url.searchParams.set('redirect_uri', s.redirect_uri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('override_default_response_type', 'true');
  url.searchParams.set('state', state);
  return url.toString();
}

function checkState(store, state, now = Date.now()) {
  const saved = store.getSetting('oauth_state');
  if (!saved || !state) return false;
  const [value, expires] = saved.split('.');
  const a = Buffer.from(String(value));
  const b = Buffer.from(String(state));
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b) && Number(expires) >= now;
  if (ok) store.setSetting('oauth_state', null);
  return ok;
}

/**
 * Liest Code/State/Fehler aus einer eingefügten Adresse (komplette Weiterleitungs-URL)
 * oder nimmt die Eingabe direkt als Code.
 */
function parseRedirectInput(input) {
  const text = String(input ?? '').trim();
  if (!text) return {};
  if (/^https?:\/\//i.test(text) || text.includes('code=') || text.includes('error=')) {
    let params;
    try {
      const u = new URL(text, 'http://x');
      params = new URLSearchParams(u.search || u.hash.replace(/^#/, ''));
      if (!params.get('code') && u.hash) params = new URLSearchParams(u.hash.replace(/^#/, ''));
    } catch {
      params = new URLSearchParams(text.replace(/^[^?]*\?/, ''));
    }
    return {
      code: params.get('code') || undefined,
      state: params.get('state') || undefined,
      error: params.get('error_description') || params.get('error_message') || params.get('error') || undefined,
    };
  }
  return { code: text };
}

/** Tauscht den Code gegen einen Token und verbindet das Instagram-Konto. */
async function completeLogin(store, client, { code, state, requireState = true, now = Date.now() }) {
  if (!code) throw new Error('Kein Code von Meta erhalten.');
  if ((requireState || state) && !checkState(store, state, now)) {
    throw new Error('Die Anmeldung ist abgelaufen oder ungültig. Bitte im Dashboard erneut auf „Bei Meta anmelden“ klicken.');
  }
  const s = oauthSettings(store);
  const appSecret = store.getSetting('fb_app_secret');
  if (!s.app_id || !appSecret || !s.redirect_uri) {
    throw new Error('App-ID, App-Geheimschlüssel oder Weiterleitungs-URL fehlen in den Einstellungen.');
  }
  const res = await client.exchangeCode({ appId: s.app_id, appSecret, redirectUri: s.redirect_uri, code });
  if (!res || !res.access_token) throw new Error('Meta hat keinen Token zurückgegeben.');
  return saveAccessToken(store, client, res.access_token, { now });
}

module.exports = { oauthSettings, saveOAuthSettings, buildLoginUrl, parseRedirectInput, completeLogin, checkState };
