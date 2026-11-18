'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { InstagramClient } = require('../src/instagram');
const { getAccessToken, getApiMode, getAccountId } = require('../src/account');
const { saveOAuthSettings, buildLoginUrl, parseRedirectInput, completeLogin, oauthSettings } = require('../src/oauth');

const SECRET = '0123456789abcdef0123456789abcdef';

function setup() {
  const store = openDatabase(':memory:');
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const routes = {
      '/v25.0/oauth/access_token': [200, { access_token: 'EAA-SYSTEM', token_type: 'bearer' }],
      '/v25.0/me/assigned_instagram_accounts': [200, { data: [{ id: '178414' }] }],
      '/v25.0/178414': [200, { id: '178414', username: 'meinkonto' }],
    };
    const [status, body] = routes[u.pathname] || [404, { error: { message: 'nope', code: 803 } }];
    return new Response(JSON.stringify(body), { status });
  };
  const client = new InstagramClient({
    version: 'v25.0',
    getToken: () => getAccessToken(store),
    getMode: () => getApiMode(store),
    getAccountId: () => getAccountId(store),
    fetchImpl,
  });
  saveOAuthSettings(store, {
    app_id: '1004342882734337',
    app_secret: SECRET,
    config_id: '555555555555',
    redirect_uri: 'http://localhost:3000/auth/callback',
  });
  return { store, client, calls };
}

test('Login-URL enthält App-ID, Konfiguration, Weiterleitung und State', () => {
  const { store } = setup();
  const url = new URL(buildLoginUrl(store, { version: 'v25.0' }));
  assert.equal(url.origin + url.pathname, 'https://www.facebook.com/v25.0/dialog/oauth');
  assert.equal(url.searchParams.get('client_id'), '1004342882734337');
  assert.equal(url.searchParams.get('config_id'), '555555555555');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.match(url.searchParams.get('state'), /^[0-9a-f]{32}$/);
  assert.deepEqual(oauthSettings(store), {
    app_id: '1004342882734337',
    config_id: '555555555555',
    redirect_uri: 'http://localhost:3000/auth/callback',
    has_secret: true,
  });
});

test('Eingaben werden geprüft, gespeicherter Geheimschlüssel bleibt erhalten', () => {
  const { store } = setup();
  assert.throws(() => saveOAuthSettings(store, { app_id: 'abc', config_id: '1', redirect_uri: 'x' }), /App-ID/);
  saveOAuthSettings(store, { app_id: '123456', config_id: '654321', redirect_uri: 'https://example.com/cb' });
  assert.equal(store.getSetting('fb_app_secret'), SECRET);
});

test('Code wird gegen Token getauscht und das Konto verbunden', async () => {
  const { store, client, calls } = setup();
  const state = new URL(buildLoginUrl(store, { version: 'v25.0' })).searchParams.get('state');
  await assert.rejects(() => completeLogin(store, client, { code: 'abc', state: 'falsch' }), /abgelaufen oder ungültig/);

  const me = await completeLogin(store, client, { code: 'abc', state });
  assert.equal(me.username, 'meinkonto');
  assert.equal(getAccessToken(store), 'EAA-SYSTEM');
  assert.equal(getApiMode(store), 'facebook');
  const exchange = calls.find((u) => u.pathname.endsWith('/oauth/access_token'));
  assert.equal(exchange.host, 'graph.facebook.com');
  assert.equal(exchange.searchParams.get('client_secret'), SECRET);
  assert.equal(exchange.searchParams.get('code'), 'abc');
  assert.equal(exchange.searchParams.get('access_token'), null);

  // State ist nur einmal gültig
  await assert.rejects(() => completeLogin(store, client, { code: 'abc', state }), /abgelaufen oder ungültig/);
});

test('Eingefügte Weiterleitungs-Adresse wird ausgelesen', () => {
  assert.deepEqual(parseRedirectInput('https://localhost/auth/callback?code=XYZ&state=s1#_=_'), { code: 'XYZ', state: 's1', error: undefined });
  assert.deepEqual(parseRedirectInput('  rohcode123 '), { code: 'rohcode123' });
  assert.equal(parseRedirectInput('https://x/cb?error=access_denied&error_description=Abgebrochen').error, 'Abgebrochen');
});
