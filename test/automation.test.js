'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { handleComment } = require('../src/automation');
const { Worker } = require('../src/worker');
const { GraphApiError } = require('../src/instagram');
const { verifySignature, signPayload, extractComments } = require('../src/webhook');
const { refreshTokenIfDue } = require('../src/account');

const silent = { log() {}, warn() {}, error() {} };

function setup() {
  const store = openDatabase(':memory:');
  store.setSetting('ig_user_id', '1000');
  store.setSetting('ig_username', 'meinkonto');
  const rule = store.createRule({
    name: 'Freebie',
    enabled: true,
    match_type: 'contains',
    keywords: ['info'],
    media_ids: [],
    reply_enabled: true,
    reply_variants: ['Schau in deine DMs, @{username} 📩'],
    dm_enabled: true,
    dm_text: 'Hi {username}! Hier dein Link',
    dm_button_title: 'Zum Guide',
    dm_button_url: 'https://example.com/guide',
    once_per_user: true,
    delay_seconds: 0,
    priority: 100,
  });
  return { store, rule };
}

const comment = (overrides = {}) => ({
  id: 'c1',
  account_id: '1000',
  text: 'Info bitte',
  parent_id: null,
  from_id: '42',
  from_username: 'anna',
  media_id: 'm1',
  ...overrides,
});

class FakeClient {
  constructor() {
    this.calls = [];
    this.failures = [];
  }
  failNext(err) {
    this.failures.push(err);
  }
  async maybeFail() {
    const err = this.failures.shift();
    if (err) throw err;
  }
  async replyToComment(commentId, message) {
    this.calls.push({ type: 'reply', commentId, message });
    await this.maybeFail();
    return { id: 'r1' };
  }
  async sendPrivateReply(commentId, payload) {
    this.calls.push({ type: 'dm', commentId, payload });
    await this.maybeFail();
    return { recipient_id: '42', message_id: 'mid1' };
  }
  async refreshToken() {
    this.calls.push({ type: 'refresh' });
    await this.maybeFail();
    return { access_token: 'NEU', token_type: 'bearer', expires_in: 5184000 };
  }
}

test('Webhook-Signatur wird geprüft', () => {
  const body = Buffer.from('{"object":"instagram"}');
  const sig = signPayload(body, 'geheim');
  assert.equal(verifySignature(body, sig, 'geheim'), true);
  assert.equal(verifySignature(body, sig, 'falsch'), false);
  assert.equal(verifySignature(Buffer.from('{"x":1}'), sig, 'geheim'), false);
  assert.equal(verifySignature(body, 'sha1=abc', 'geheim'), false);
  assert.equal(verifySignature(body, undefined, 'geheim'), false);
  assert.equal(verifySignature(body, sig, 'anderes, geheim'), true, 'mehrere Schlüssel erlaubt');
});

test('extractComments liest das Meta-Format', () => {
  const comments = extractComments({
    object: 'instagram',
    entry: [
      {
        id: '1000',
        time: 1,
        changes: [
          { field: 'comments', value: { id: '17', text: 'Info', from: { id: '42', username: 'anna' }, media: { id: '99', media_product_type: 'REELS' } } },
          { field: 'mentions', value: { id: 'x' } },
        ],
      },
    ],
  });
  assert.equal(comments.length, 1);
  assert.deepEqual(comments[0], {
    id: '17',
    account_id: '1000',
    text: 'Info',
    parent_id: null,
    from_id: '42',
    from_username: 'anna',
    media_id: '99',
    media_product_type: 'REELS',
  });
  assert.deepEqual(extractComments({ object: 'page', entry: [] }), []);
});

test('Passender Kommentar plant DM und Antwort ein, Duplikate werden ignoriert', () => {
  const { store, rule } = setup();
  const res = handleComment(store, comment(), { now: 1000, random: () => 0.5 });
  assert.equal(res.status, 'matched');
  assert.equal(res.rule_id, rule.id);
  assert.equal(res.jobs.length, 2);
  assert.equal(handleComment(store, comment(), { now: 2000 }).status, 'duplicate');
  assert.deepEqual(store.jobCounts(), { pending: 2, running: 0, done: 0, failed: 0 });
});

test('Eigene Kommentare und unpassende Kommentare lösen nichts aus', () => {
  const { store } = setup();
  assert.equal(handleComment(store, comment({ id: 'a', from_id: '1000' })).status, 'ignored');
  assert.equal(handleComment(store, comment({ id: 'b', from_id: '5', from_username: 'MeinKonto' })).status, 'ignored');
  assert.equal(handleComment(store, comment({ id: 'c', text: 'Schönes Bild' })).status, 'no_match');
  assert.equal(store.jobCounts().pending, 0);
});

test('Jede Person nur einmal pro Automation', () => {
  const { store } = setup();
  assert.equal(handleComment(store, comment({ id: 'c1' })).status, 'matched');
  assert.equal(handleComment(store, comment({ id: 'c2' })).status, 'skipped');
  assert.equal(handleComment(store, comment({ id: 'c3', from_id: '43', from_username: 'ben' })).status, 'matched');
});

test('Worker sendet DM vor der öffentlichen Antwort', async () => {
  const { store } = setup();
  const client = new FakeClient();
  handleComment(store, comment(), { now: 0, random: () => 0.5 });
  const worker = new Worker({ store, client, minIntervalMs: 0, logger: silent, now: () => 60_000 });
  assert.equal(await worker.tick(), 2);
  assert.deepEqual(
    client.calls.map((c) => c.type),
    ['dm', 'reply'],
  );
  assert.deepEqual(client.calls[0].payload, {
    text: 'Hi anna! Hier dein Link',
    button: { title: 'Zum Guide', url: 'https://example.com/guide' },
  });
  assert.equal(client.calls[1].message, 'Schau in deine DMs, @anna 📩');
  assert.deepEqual(store.jobCounts(), { pending: 0, running: 0, done: 2, failed: 0 });
});

test('Worker: temporäre Fehler werden wiederholt, dauerhafte nicht', async () => {
  const { store } = setup();
  const client = new FakeClient();
  let now = 60_000;
  const worker = new Worker({ store, client, minIntervalMs: 0, maxAttempts: 2, logger: silent, now: () => now });
  handleComment(store, comment(), { now: 0 });

  // DM: Rate-Limit -> neuer Versuch; Antwort: dauerhafter Fehler
  client.failNext(new GraphApiError('Rate limit', { code: 4, transient: true }));
  client.failNext(new GraphApiError('Ungültige Kommentar-ID', { code: 100 }));
  await worker.tick();
  assert.deepEqual(store.jobCounts(), { pending: 1, running: 0, done: 0, failed: 1 });

  now += 60_000; // Backoff abgewartet
  await worker.tick();
  assert.deepEqual(store.jobCounts(), { pending: 0, running: 0, done: 1, failed: 1 });

  // Fehlgeschlagenen Job erneut einplanen
  const failed = store.listComments()[0].jobs.find((j) => j.status === 'failed');
  assert.equal(store.requeueJob(failed.id, now), true);
  await worker.tick();
  assert.deepEqual(store.jobCounts(), { pending: 0, running: 0, done: 2, failed: 0 });
});

test('Worker: Button-Nachricht fällt auf Text mit Link zurück', async () => {
  const { store } = setup();
  const client = new FakeClient();
  const worker = new Worker({ store, client, minIntervalMs: 0, logger: silent, now: () => 60_000 });
  handleComment(store, comment(), { now: 0 });
  client.failNext(new GraphApiError('Template not supported', { code: 100 }));
  await worker.tick();
  const dms = client.calls.filter((c) => c.type === 'dm');
  assert.equal(dms.length, 2);
  assert.equal(dms[1].payload.text, 'Hi anna! Hier dein Link\n\nZum Guide: https://example.com/guide');
  assert.equal(store.jobCounts().done, 2);
});

test('Token wird nach 7 Tagen verlängert', async () => {
  const { store } = setup();
  const client = new FakeClient();
  const day = 24 * 60 * 60 * 1000;
  store.setSetting('access_token', 'ALT');
  store.setSetting('token_saved_at', 0);

  assert.equal((await refreshTokenIfDue(store, client, { now: 3 * day, logger: silent })).refreshed, false);
  const res = await refreshTokenIfDue(store, client, { now: 8 * day, logger: silent });
  assert.equal(res.refreshed, true);
  assert.equal(store.getSetting('access_token'), 'NEU');
  assert.equal(Number(store.getSetting('token_expires_at')), 8 * day + 5184000 * 1000);
});

test('Abfrage-Modus: nur neue Kommentare, Antworten im Thread, keine Duplikate', async () => {
  const { Poller } = require('../src/poller');
  const { store } = setup();
  store.setSetting('access_token', 'T');
  let now = Date.parse('2026-11-18T12:00:00Z');
  const comments = [
    { id: 'alt', text: 'info', timestamp: '2026-11-18T11:00:00+0000', from: { id: '7', username: 'frueher' } },
  ];
  const client = {
    listMedia: async () => [
      { id: 'm1', comments_count: 3 },
      { id: 'm2', comments_count: 0 },
    ],
    listComments: async (mediaId) => {
      assert.equal(mediaId, 'm1', 'Beiträge ohne Kommentare werden übersprungen');
      return comments;
    },
  };
  const poller = new Poller({ store, client, intervalMs: 60000, logger: silent, now: () => now });

  // Erster Lauf merkt sich den Startzeitpunkt – der alte Kommentar wird ignoriert.
  assert.deepEqual(await poller.poll(), { checked: 1, new: 0 });

  comments.push({
    id: 'neu',
    text: 'Info bitte',
    timestamp: '2026-11-18T12:00:30+0000',
    from: { id: '42', username: 'anna' },
    replies: { data: [{ id: 'antwort', text: 'danke', timestamp: '2026-11-18T12:00:40+0000', from: { id: '1000', username: 'meinkonto' } }] },
  });
  now += 60000;
  assert.deepEqual(await poller.poll(), { checked: 1, new: 2 });
  assert.deepEqual(await poller.poll(), { checked: 1, new: 0 });

  const items = store.listComments();
  assert.equal(items.find((c) => c.id === 'neu').status, 'matched');
  assert.equal(items.find((c) => c.id === 'antwort').status, 'ignored');
  assert.equal(items.find((c) => c.id === 'antwort').parent_id, 'neu');
  assert.equal(store.jobCounts().pending, 2);
});
