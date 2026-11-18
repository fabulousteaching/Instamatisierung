'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchKeywords, findMatchingRule, renderTemplate, buildActions, validateRule } = require('../src/matcher');

const rule = (overrides = {}) => ({
  id: 1,
  name: 'Test',
  enabled: true,
  match_type: 'contains',
  keywords: ['info'],
  media_ids: [],
  reply_enabled: true,
  reply_variants: ['Check deine DMs, @{username}!'],
  dm_enabled: true,
  dm_text: 'Hi {username}, hier ist der Link',
  dm_button_title: '',
  dm_button_url: '',
  once_per_user: true,
  delay_seconds: 10,
  priority: 100,
  ...overrides,
});

test('contains: ganzes Wort, unabhängig von Groß-/Kleinschreibung', () => {
  const r = rule();
  assert.equal(matchKeywords(r, 'Info bitte! 😍'), 'info');
  assert.equal(matchKeywords(r, 'Kann ich mehr INFO haben?'), 'info');
  assert.equal(matchKeywords(r, 'Informationen bitte'), null);
  assert.equal(matchKeywords(r, 'superinfo'), null);
});

test('contains: Umlaute, mehrere Wörter und Emojis', () => {
  assert.equal(matchKeywords(rule({ keywords: ['schön'] }), 'Wie SCHÖN!'), 'schön');
  assert.equal(matchKeywords(rule({ keywords: ['link bitte'] }), 'Link   bitte :)'), 'link bitte');
  assert.equal(matchKeywords(rule({ keywords: ['🔥'] }), '🔥🔥🔥'), '🔥');
  assert.equal(matchKeywords(rule({ keywords: ['a.b'] }), 'axb'), null, 'Sonderzeichen werden nicht als RegEx gewertet');
});

test('exact: nur der Kommentar selbst, Satzzeichen am Rand egal', () => {
  const r = rule({ match_type: 'exact', keywords: ['Rezept'] });
  assert.equal(matchKeywords(r, 'rezept!!'), 'Rezept');
  assert.equal(matchKeywords(r, '  REZEPT  '), 'Rezept');
  assert.equal(matchKeywords(r, 'Rezept bitte'), null);
  assert.equal(matchKeywords(rule({ match_type: 'exact', keywords: ['🔥'] }), '🔥'), '🔥');
});

test('any: jeder Kommentar', () => {
  assert.equal(matchKeywords(rule({ match_type: 'any', keywords: [] }), 'egal was'), '*');
});

test('findMatchingRule: deaktivierte und fremde Beiträge werden übersprungen', () => {
  const rules = [
    rule({ id: 1, enabled: false }),
    rule({ id: 2, media_ids: ['999'] }),
    rule({ id: 3, priority: 50, keywords: ['nix'] }),
    rule({ id: 4 }),
  ];
  assert.equal(findMatchingRule(rules, { text: 'info', media_id: '123' }).rule.id, 4);
  assert.equal(findMatchingRule(rules, { text: 'info', media_id: '999' }).rule.id, 2, 'Beitrags-Regel geht vor');
  assert.equal(findMatchingRule(rules, { text: 'hallo', media_id: '123' }), null);
});

test('findMatchingRule: Priorität entscheidet', () => {
  const rules = [rule({ id: 1, priority: 100 }), rule({ id: 2, priority: 10 })];
  assert.equal(findMatchingRule(rules, { text: 'info' }).rule.id, 2);
});

test('renderTemplate ersetzt bekannte Platzhalter', () => {
  assert.equal(renderTemplate('Hi @{username}! {unbekannt}', { username: 'anna' }), 'Hi @anna! {unbekannt}');
  assert.equal(renderTemplate('{USERNAME}', { username: 'anna' }), 'anna');
});

test('buildActions erzeugt DM und Antwort', () => {
  const actions = buildActions(
    rule({ dm_button_title: 'Los', dm_button_url: 'https://example.com' }),
    { from_username: 'anna', text: 'info' },
    () => 0,
  );
  assert.deepEqual(actions.dm, { text: 'Hi anna, hier ist der Link', button: { title: 'Los', url: 'https://example.com' } });
  assert.deepEqual(actions.reply, { message: 'Check deine DMs, @anna!' });
});

test('validateRule: gültige Eingabe aus dem Formular', () => {
  const { rule: r, errors } = validateRule({
    name: '  Freebie ',
    match_type: 'contains',
    keywords: 'info, Link , info',
    media_ids: '123, 456',
    reply_enabled: true,
    reply_variants: 'A\n\nB\n',
    dm_enabled: true,
    dm_text: 'Hallo',
    dm_button_title: 'Hier',
    dm_button_url: 'https://example.com/x',
    delay_seconds: '5',
  });
  assert.deepEqual(errors, []);
  assert.equal(r.name, 'Freebie');
  assert.deepEqual(r.keywords, ['info', 'Link']);
  assert.deepEqual(r.media_ids, ['123', '456']);
  assert.deepEqual(r.reply_variants, ['A', 'B']);
  assert.equal(r.delay_seconds, 5);
});

test('validateRule: Fehler werden gemeldet', () => {
  assert.ok(validateRule({}).errors.length > 0);
  assert.ok(validateRule({ name: 'x', match_type: 'contains', keywords: '', reply_enabled: true, reply_variants: 'a' }).errors.some((e) => e.includes('Schlüsselwort')));
  assert.ok(validateRule({ name: 'x', match_type: 'any', reply_enabled: false, dm_enabled: false }).errors.some((e) => e.includes('Aktion')));
  assert.ok(
    validateRule({ name: 'x', match_type: 'any', dm_enabled: true, dm_text: 'a', dm_button_title: 'b', dm_button_url: 'javascript:alert(1)' }).errors.some((e) =>
      e.includes('Link'),
    ),
  );
  assert.ok(validateRule({ name: 'x', match_type: 'any', reply_enabled: true, reply_variants: 'a', media_ids: 'abc' }).errors.some((e) => e.includes('Ziffern')));
});
