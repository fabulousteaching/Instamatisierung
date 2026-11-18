'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InstagramClient, detectMode } = require('../src/instagram');
const { openDatabase } = require('../src/db');
const { saveAccessToken, getAccessToken, getApiMode, getAccountId, refreshTokenIfDue } = require('../src/account');

/** Fake-fetch: beantwortet Anfragen anhand von "METHODE host+pfad" und merkt sich alle Aufrufe. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.host}${u.pathname}`;
    calls.push({ key, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : null });
    const handler = routes[key];
    const [status, body] = handler ? handler(u) : [404, { error: { message: `unbekannt: ${key}`, code: 803 } }];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

function makeClient(store, fetchImpl) {
  return new InstagramClient({
    baseUrl: 'https://graph.instagram.com',
    facebookBaseUrl: 'https://graph.facebook.com',
    version: 'v25.0',
    getToken: () => getAccessToken(store),
    getMode: () => getApiMode(store),
    getAccountId: () => getAccountId(store),
    fetchImpl,
  });
}

test('detectMode erkennt die Token-Art', () => {
  assert.equal(detectMode('IGAAabc'), 'instagram');
  assert.equal(detectMode(' IGQVJ… '), 'instagram');
  assert.equal(detectMode('EAAGabc'), 'facebook');
});

test('Instagram-Login: /me auf graph.instagram.com', async () => {
  const store = openDatabase(':memory:');
  const fetchImpl = fakeFetch({
    'GET graph.instagram.com/v25.0/me': () => [200, { id: '777', user_id: '1000', username: 'meinkonto' }],
    'GET graph.instagram.com/v25.0/me/media': () => [200, { data: [{ id: 'm1' }] }],
    'POST graph.instagram.com/v25.0/me/messages': () => [200, { message_id: 'x' }],
  });
  const client = makeClient(store, fetchImpl);
  const me = await saveAccessToken(store, client, 'IGAA-123');
  assert.equal(me.username, 'meinkonto');
  assert.equal(getApiMode(store), 'instagram');
  assert.equal(getAccountId(store), '1000');
  assert.equal((await client.listMedia()).length, 1);
  await client.sendPrivateReply('c1', { text: 'Hi' });
  assert.deepEqual(fetchImpl.calls.at(-1).body, { recipient: { comment_id: 'c1' }, message: { text: 'Hi' } });
});

test('Unified login: Konto wird über assigned_instagram_accounts gefunden, alles läuft über graph.facebook.com', async () => {
  const store = openDatabase(':memory:');
  const fetchImpl = fakeFetch({
    'GET graph.facebook.com/v25.0/me/assigned_instagram_accounts': () => [200, { data: [{ id: '178414' }] }],
    'GET graph.facebook.com/v25.0/178414': () => [200, { id: '178414', username: 'meinkonto', name: 'Mein Konto' }],
    'GET graph.facebook.com/v25.0/178414/media': () => [200, { data: [{ id: 'm1' }, { id: 'm2' }] }],
    'GET graph.facebook.com/v25.0/m1/comments': () => [200, { data: [] }],
    'POST graph.facebook.com/v25.0/c1/replies': () => [200, { id: 'r1' }],
    'POST graph.facebook.com/v25.0/178414/messages': () => [200, { message_id: 'x' }],
    'POST graph.facebook.com/v25.0/178414/subscribed_apps': () => [200, { success: true }],
  });
  const client = makeClient(store, fetchImpl);
  const me = await saveAccessToken(store, client, 'EAA-SYSTEMUSER');
  assert.equal(me.username, 'meinkonto');
  assert.equal(getApiMode(store), 'facebook');
  assert.equal(getAccountId(store), '178414');

  assert.equal((await client.listMedia()).length, 2);
  await client.listComments('m1');
  await client.replyToComment('c1', 'Danke!');
  await client.sendPrivateReply('c1', { text: 'Hi' });
  await client.subscribeWebhooks();
  assert.ok(fetchImpl.calls.every((c) => c.key.includes('graph.facebook.com')));
  assert.ok(fetchImpl.calls.every((c) => c.query.access_token === 'EAA-SYSTEMUSER'));

  // System-User-Tokens laufen nicht ab -> keine Verlängerung
  assert.equal((await refreshTokenIfDue(store, client, { now: Date.now() + 30 * 86400000, logger: console })).refreshed, false);
});

test('Unified login: Konto-ID kann von Hand angegeben werden', async () => {
  const store = openDatabase(':memory:');
  const fetchImpl = fakeFetch({
    'GET graph.facebook.com/v25.0/me/assigned_instagram_accounts': () => [200, { data: [] }],
    'GET graph.facebook.com/v25.0/me/accounts': () => [200, { data: [] }],
    'GET graph.facebook.com/v25.0/999': () => [200, { id: '999', username: 'handeingabe' }],
  });
  const client = makeClient(store, fetchImpl);
  await assert.rejects(() => saveAccessToken(store, client, 'EAA-X'), /Konto-ID/);
  const me = await saveAccessToken(store, client, 'EAA-X', { accountId: ' 999 ' });
  assert.equal(me.username, 'handeingabe');
  assert.equal(getAccountId(store), '999');
  await assert.rejects(() => saveAccessToken(store, client, 'EAA-X', { accountId: 'abc' }), /Ziffern/);
});

test('Unified login: ungültiger Token wird als solcher gemeldet', async () => {
  const store = openDatabase(':memory:');
  const fetchImpl = fakeFetch({
    'GET graph.facebook.com/v25.0/me/assigned_instagram_accounts': () => [
      400,
      { error: { message: 'Invalid OAuth access token - Cannot parse access token', code: 190 } },
    ],
  });
  const client = makeClient(store, fetchImpl);
  await assert.rejects(() => saveAccessToken(store, client, 'EAA-KAPUTT'), /Invalid OAuth/);
  assert.equal(getAccessToken(store), null, 'ungültiger Token wird nicht gespeichert');
});
