'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const { openDatabase } = require('../src/db');
const { signPayload } = require('../src/webhook');

const silent = { log() {}, warn() {}, error() {} };

const config = {
  adminPassword: 'test-passwort',
  sessionSecret: 'x'.repeat(32),
  appSecret: 'app-geheim',
  verifyToken: 'verify-123',
  graphVersion: 'v25.0',
};

async function startServer() {
  const store = openDatabase(':memory:');
  const client = {
    listMedia: async () => [{ id: '1', media_type: 'IMAGE' }],
  };
  const app = createApp({ config, store, client, logger: silent });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, server, base };
}

async function login(base) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: config.adminPassword }),
  });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

test('Server: Webhook, Anmeldung und Automationen', async (t) => {
  const { store, server, base } = await startServer();
  t.after(() => server.close());

  await t.test('Webhook-Bestätigung', async () => {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-123&hub.challenge=abc`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'abc');
    const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=falsch&hub.challenge=abc`);
    assert.equal(bad.status, 403);
  });

  await t.test('API ohne Anmeldung gesperrt, Login mit falschem Passwort scheitert', async () => {
    assert.equal((await fetch(`${base}/api/rules`)).status, 401);
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'nein' }),
    });
    assert.equal(res.status, 401);
  });

  const cookie = await login(base);
  const authed = (method, path, body) =>
    fetch(`${base}/api${path}`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  await t.test('Automation anlegen, testen, ändern', async () => {
    const bad = await authed('POST', '/rules', { name: '' });
    assert.equal(bad.status, 400);

    const created = await authed('POST', '/rules', {
      name: 'Freebie',
      match_type: 'contains',
      keywords: 'guide',
      reply_enabled: true,
      reply_variants: 'Check deine DMs @{username}',
      dm_enabled: true,
      dm_text: 'Hier ist dein Guide, {username}',
    });
    assert.equal(created.status, 201);
    const rule = await created.json();

    const testRes = await (await authed('POST', '/test', { text: 'Guide bitte!', username: '@anna' })).json();
    assert.equal(testRes.matched, true);
    assert.equal(testRes.actions.dm.text, 'Hier ist dein Guide, anna');

    const updated = await authed('PUT', `/rules/${rule.id}`, { ...rule, enabled: false });
    assert.equal(updated.status, 200);
    const testRes2 = await (await authed('POST', '/test', { text: 'guide' })).json();
    assert.equal(testRes2.matched, false);
    assert.match(testRes2.hint, /deaktiviert/);

    await authed('PUT', `/rules/${rule.id}`, { ...rule, enabled: true });
  });

  await t.test('Schreibende Anfragen ohne JSON werden abgelehnt (CSRF-Schutz)', async () => {
    const res = await fetch(`${base}/api/rules`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=x',
    });
    assert.equal(res.status, 415);
  });

  await t.test('Signierter Webhook wird verarbeitet, unsignierter abgelehnt', async () => {
    const payload = Buffer.from(
      JSON.stringify({
        object: 'instagram',
        entry: [
          {
            id: '1000',
            time: 1,
            changes: [{ field: 'comments', value: { id: '555', text: 'GUIDE 🙏', from: { id: '42', username: 'anna' }, media: { id: '9' } } }],
          },
        ],
      }),
    );
    const unsigned = await fetch(`${base}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    assert.equal(unsigned.status, 401);

    const signed = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signPayload(payload, config.appSecret) },
      body: payload,
    });
    assert.equal(signed.status, 200);

    const activity = await (await authed('GET', '/comments')).json();
    assert.equal(activity.total, 1);
    assert.equal(activity.items[0].status, 'matched');
    assert.equal(activity.items[0].rule_name, 'Freebie');
    assert.deepEqual(
      activity.items[0].jobs.map((j) => j.type),
      ['dm', 'reply'],
    );
    assert.equal(store.jobCounts().pending, 2);

    const rules = await (await authed('GET', '/rules')).json();
    assert.equal(rules[0].stats.matched, 1);
  });

  await t.test('Status und Beiträge', async () => {
    const status = await (await authed('GET', '/status')).json();
    assert.equal(status.webhook.app_secret_set, true);
    assert.equal(status.account.connected, false);
    assert.match(status.webhook.url, /\/webhook$/);
    const media = await (await authed('GET', '/media')).json();
    assert.equal(media.length, 1);
  });

  await t.test('Dashboard wird ausgeliefert', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Instamatisierung/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  });
});
