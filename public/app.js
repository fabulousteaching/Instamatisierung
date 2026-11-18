'use strict';

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Erzeugt DOM-Elemente sicher (kein innerHTML mit Nutzerdaten). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function api(method, path, body) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new ApiError('Bitte erneut anmelden.', 401);
  }
  if (!res.ok) throw new ApiError(data?.error || `Fehler ${res.status}`, res.status, data?.details);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('toast-err', isError);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 6000 : 3000);
}

function formatDate(ts) {
  if (!ts) return '–';
  return new Date(Number(ts)).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

function relativeTime(ts) {
  const diff = Date.now() - Number(ts);
  const abs = Math.abs(diff);
  const future = diff < 0;
  let text;
  if (abs < 45 * 1000) text = 'wenigen Sekunden';
  else if (abs < 60 * 60 * 1000) text = `${Math.round(abs / 60000)} Min.`;
  else if (abs < 24 * 60 * 60 * 1000) text = `${Math.round(abs / 3600000)} Std.`;
  else return formatDate(ts);
  return future ? `in ${text}` : `vor ${text}`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

const state = {
  status: null,
  rules: [],
  editingId: null,
  activityCount: 30,
  activityTimer: null,
  media: null,
};

// ---------------------------------------------------------------------------
// Anmeldung
// ---------------------------------------------------------------------------

function showLogin() {
  stopActivityPolling();
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  $('#login-password').focus();
}

async function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  await loadStatus();
  showTab('rules');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#login-error');
  errorEl.classList.add('hidden');
  try {
    await api('POST', '/login', { password: $('#login-password').value });
    $('#login-password').value = '';
    await showApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/logout', {}).catch(() => {});
  showLogin();
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function showTab(name) {
  for (const panel of $$('.tab-panel')) panel.classList.toggle('hidden', panel.id !== `tab-${name}`);
  for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.tab === name || (name === 'editor' && tab.dataset.tab === 'rules'));
  stopActivityPolling();
  if (name === 'rules') loadRules();
  if (name === 'activity') startActivityPolling();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) showTab(tab.dataset.tab);
});

// ---------------------------------------------------------------------------
// Status / Konto
// ---------------------------------------------------------------------------

async function loadStatus() {
  try {
    state.status = await api('GET', '/status');
  } catch {
    return;
  }
  renderAccountBadge();
  renderBanner();
}

function renderAccountBadge() {
  const badge = $('#account-badge');
  badge.replaceChildren();
  const acc = state.status?.account;
  if (acc?.connected && acc.username) {
    if (acc.profile_picture_url) badge.append(el('img', { src: acc.profile_picture_url, alt: '' }));
    badge.append(el('span', { class: 'dot dot-ok' }), el('span', { text: `@${acc.username}` }));
  } else {
    badge.append(el('span', { class: 'dot dot-err' }), el('span', { class: 'muted', text: 'Nicht verbunden' }));
  }
}

function renderBanner() {
  const banner = $('#banner');
  banner.replaceChildren();
  const s = state.status;
  if (!s) return;
  const problems = [];
  if (!s.account.connected) problems.push('Kein Instagram-Konto verbunden');
  if (!s.polling.enabled) {
    if (!s.webhook.app_secret_set) problems.push('IG_APP_SECRET fehlt');
    if (!s.webhook.verify_token_set) problems.push('IG_VERIFY_TOKEN fehlt');
  }
  if (s.account.token_refresh_error) problems.push('Token-Verlängerung fehlgeschlagen');
  if (problems.length === 0) return;
  const link = el('a', { href: '#', text: 'Zu den Einstellungen →' });
  link.addEventListener('click', (e) => {
    e.preventDefault();
    showTab('settings');
  });
  banner.append(el('div', { class: 'banner banner-warn' }, `⚠️ ${problems.join(' · ')}. `, link));
}

// ---------------------------------------------------------------------------
// Automationen
// ---------------------------------------------------------------------------

const MATCH_LABELS = {
  contains: 'Kommentar enthält',
  exact: 'Kommentar ist genau',
  any: 'Jeder Kommentar',
};

async function loadRules() {
  const list = $('#rules-list');
  try {
    state.rules = await api('GET', '/rules');
  } catch (err) {
    list.replaceChildren(el('p', { class: 'error', text: err.message }));
    return;
  }
  renderRules();
}

function renderRules() {
  const list = $('#rules-list');
  list.replaceChildren();
  if (state.rules.length === 0) {
    list.append(
      el(
        'div',
        { class: 'card empty' },
        el('div', { class: 'big', text: '🤖' }),
        el('p', { text: 'Noch keine Automation. Leg los mit deiner ersten!' }),
        el('button', { class: 'btn btn-primary', text: '+ Neue Automation', onclick: () => openEditor(null) }),
      ),
    );
    return;
  }

  for (const rule of state.rules) {
    const toggle = el('input', { type: 'checkbox', checked: rule.enabled, 'aria-label': 'Aktiv' });
    toggle.addEventListener('change', () => toggleRule(rule, toggle));

    const trigger =
      rule.match_type === 'any'
        ? el('span', { text: '⚡ Jeder Kommentar' })
        : el('span', {}, `⚡ ${MATCH_LABELS[rule.match_type]}: `, ...rule.keywords.map((k) => el('span', { class: 'chip', text: k })));

    const actions = [];
    if (rule.dm_enabled) actions.push('✉️ DM');
    if (rule.reply_enabled) actions.push(`💬 Antwort (${plural(rule.reply_variants.length, 'Variante', 'Varianten')})`);

    const scope = rule.media_ids.length === 0 ? '🖼️ Alle Beiträge' : `🖼️ ${plural(rule.media_ids.length, 'Beitrag', 'Beiträge')}`;
    const s = rule.stats;

    list.append(
      el(
        'div',
        { class: `rule${rule.enabled ? '' : ' disabled'}` },
        el('label', { class: 'switch', title: rule.enabled ? 'Aktiv' : 'Pausiert' }, toggle, el('span')),
        el(
          'div',
          {},
          el('div', { class: 'rule-title', text: rule.name }),
          el(
            'div',
            { class: 'rule-meta' },
            trigger,
            el('span', { text: scope }),
            el('span', { text: actions.join(' + ') }),
            el('span', { text: `📊 ${s.matched}× ausgelöst · ${plural(s.dms_sent, 'DM', 'DMs')} · ${plural(s.replies_sent, 'Antwort', 'Antworten')}` }),
          ),
        ),
        el(
          'div',
          { class: 'rule-actions' },
          el('button', { class: 'btn btn-sm', text: 'Bearbeiten', onclick: () => openEditor(rule) }),
          el('button', { class: 'btn btn-sm btn-ghost', text: 'Kopieren', onclick: () => duplicateRule(rule) }),
          el('button', { class: 'btn btn-sm btn-ghost btn-danger', text: 'Löschen', onclick: () => deleteRule(rule) }),
        ),
      ),
    );
  }
}

function ruleToPayload(rule) {
  const { id, stats, created_at, updated_at, ...rest } = rule;
  return rest;
}

async function toggleRule(rule, input) {
  try {
    await api('PUT', `/rules/${rule.id}`, { ...ruleToPayload(rule), enabled: input.checked });
    toast(input.checked ? `„${rule.name}“ ist aktiv` : `„${rule.name}“ ist pausiert`);
    loadRules();
  } catch (err) {
    input.checked = !input.checked;
    toast(err.message, true);
  }
}

async function duplicateRule(rule) {
  try {
    await api('POST', '/rules', { ...ruleToPayload(rule), name: `${rule.name} (Kopie)`.slice(0, 100), enabled: false });
    toast('Kopie erstellt (pausiert)');
    loadRules();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteRule(rule) {
  if (!confirm(`Automation „${rule.name}“ wirklich löschen?`)) return;
  try {
    await api('DELETE', `/rules/${rule.id}`);
    toast('Automation gelöscht');
    loadRules();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

const form = $('#rule-form');

function setField(name, value) {
  const fields = form.elements[name];
  if (fields instanceof RadioNodeList) {
    for (const f of fields) f.checked = f.value === value;
  } else if (fields.type === 'checkbox') {
    fields.checked = !!value;
  } else {
    fields.value = value ?? '';
  }
}

function openEditor(rule) {
  state.editingId = rule ? rule.id : null;
  $('#editor-title').textContent = rule ? 'Automation bearbeiten' : 'Neue Automation';
  $('#editor-errors').classList.add('hidden');
  form.reset();

  const r = rule || {
    name: '',
    enabled: true,
    match_type: 'contains',
    keywords: [],
    media_ids: [],
    reply_enabled: true,
    reply_variants: [],
    dm_enabled: true,
    dm_text: '',
    dm_button_title: '',
    dm_button_url: '',
    once_per_user: true,
    delay_seconds: 10,
    priority: 100,
  };
  setField('name', r.name);
  setField('enabled', r.enabled);
  setField('match_type', r.match_type);
  setField('keywords', r.keywords.join(', '));
  setField('scope', r.media_ids.length ? 'some' : 'all');
  setField('media_ids', r.media_ids.join(', '));
  setField('reply_enabled', r.reply_enabled);
  setField('reply_variants', r.reply_variants.join('\n'));
  setField('dm_enabled', r.dm_enabled);
  setField('dm_text', r.dm_text);
  setField('dm_button_title', r.dm_button_title);
  setField('dm_button_url', r.dm_button_url);
  setField('once_per_user', r.once_per_user);
  setField('delay_seconds', r.delay_seconds);
  setField('priority', r.priority);

  $('#media-grid').replaceChildren();
  $('#media-status').textContent = '';
  updateEditorVisibility();
  showTab('editor');
  if (r.media_ids.length) loadMedia();
}

function updateEditorVisibility() {
  const matchType = form.elements.match_type.value;
  $('#keywords-field').classList.toggle('hidden', matchType === 'any');
  $('#media-picker').classList.toggle('hidden', form.elements.scope.value !== 'some');
  $('#dm-fields').classList.toggle('hidden', !form.elements.dm_enabled.checked);
  $('#reply-fields').classList.toggle('hidden', !form.elements.reply_enabled.checked);
}

form.addEventListener('change', (e) => {
  updateEditorVisibility();
  if (e.target.name === 'scope' && e.target.value === 'some' && !state.media) loadMedia();
});

$('#new-rule-btn').addEventListener('click', () => openEditor(null));
$('#editor-cancel').addEventListener('click', () => showTab('rules'));

function selectedMediaIds() {
  return form.elements.media_ids.value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function loadMedia() {
  const status = $('#media-status');
  status.textContent = 'Lade Beiträge …';
  try {
    state.media = await api('GET', '/media');
    status.textContent = state.media.length ? `${state.media.length} Beiträge – anklicken zum Auswählen` : 'Keine Beiträge gefunden.';
    renderMediaGrid();
  } catch (err) {
    status.textContent = err.message;
  }
}

function renderMediaGrid() {
  const grid = $('#media-grid');
  grid.replaceChildren();
  const selected = new Set(selectedMediaIds());
  for (const m of state.media || []) {
    const thumb = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url || m.thumbnail_url;
    const item = el(
      'button',
      { type: 'button', class: `media-item${selected.has(m.id) ? ' selected' : ''}`, title: m.caption || m.id },
      thumb ? el('img', { src: thumb, alt: '', loading: 'lazy' }) : el('div', { class: 'placeholder', text: m.media_type }),
      el('div', { class: 'cap', text: m.caption || formatDate(Date.parse(m.timestamp)) }),
    );
    item.addEventListener('click', () => {
      const ids = new Set(selectedMediaIds());
      if (ids.has(m.id)) ids.delete(m.id);
      else ids.add(m.id);
      form.elements.media_ids.value = [...ids].join(', ');
      item.classList.toggle('selected', ids.has(m.id));
    });
    grid.append(item);
  }
}

$('#load-media-btn').addEventListener('click', loadMedia);
form.elements.media_ids.addEventListener('input', () => state.media && renderMediaGrid());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = form.elements;
  const scopeSome = f.scope.value === 'some';
  const payload = {
    name: f.name.value,
    enabled: f.enabled.checked,
    match_type: f.match_type.value,
    keywords: f.keywords.value,
    media_ids: scopeSome ? selectedMediaIds() : [],
    reply_enabled: f.reply_enabled.checked,
    reply_variants: f.reply_variants.value,
    dm_enabled: f.dm_enabled.checked,
    dm_text: f.dm_text.value,
    dm_button_title: f.dm_button_title.value,
    dm_button_url: f.dm_button_url.value,
    once_per_user: f.once_per_user.checked,
    delay_seconds: f.delay_seconds.value,
    priority: f.priority.value,
  };

  const errorsEl = $('#editor-errors');
  const showErrors = (list) => {
    errorsEl.replaceChildren(el('ul', {}, list.map((m) => el('li', { text: m }))));
    errorsEl.classList.remove('hidden');
    window.scrollTo(0, 0);
  };
  if (scopeSome && payload.media_ids.length === 0) {
    showErrors(['Bitte mindestens einen Beitrag auswählen – oder „Alle Beiträge“ wählen.']);
    return;
  }

  try {
    if (state.editingId) await api('PUT', `/rules/${state.editingId}`, payload);
    else await api('POST', '/rules', payload);
    toast('Automation gespeichert ✓');
    showTab('rules');
  } catch (err) {
    showErrors(err.details && err.details.length ? err.details : [err.message]);
  }
});

// ---------------------------------------------------------------------------
// Aktivität
// ---------------------------------------------------------------------------

const STATUS_BADGES = {
  matched: ['b-ok', '✓ Automation ausgelöst'],
  no_match: ['b-muted', 'Keine passende Automation'],
  skipped: ['b-warn', 'Übersprungen'],
  ignored: ['b-muted', 'Ignoriert'],
};

const JOB_LABELS = { dm: '✉️ DM', reply: '💬 Antwort' };

function jobBadge(job) {
  const label = JOB_LABELS[job.type] || job.type;
  switch (job.status) {
    case 'done':
      return el('span', { class: 'badge b-ok', text: `${label} gesendet` });
    case 'pending':
      return el('span', {
        class: 'badge b-info',
        text: job.attempts > 0 ? `${label}: neuer Versuch ${relativeTime(job.run_at)}` : `${label} geplant (${relativeTime(job.run_at)})`,
      });
    case 'running':
      return el('span', { class: 'badge b-info', text: `${label} wird gesendet …` });
    default:
      return el('span', { class: 'badge b-err', text: `${label} fehlgeschlagen` });
  }
}

function renderStats() {
  const s = state.status;
  const box = $('#stats');
  box.replaceChildren();
  if (!s) return;
  const items = [
    [s.comments_total, 'Kommentare empfangen'],
    [s.jobs.done, 'Nachrichten gesendet'],
    [s.jobs.pending + s.jobs.running, 'In der Warteschlange'],
    [s.jobs.failed, 'Fehlgeschlagen'],
  ];
  for (const [num, lbl] of items) box.append(el('div', { class: 'stat' }, el('div', { class: 'num', text: num }), el('div', { class: 'lbl', text: lbl })));
}

async function retryJob(job) {
  try {
    await api('POST', `/jobs/${job.id}/retry`, {});
    toast('Wird erneut gesendet');
    loadActivity();
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadActivity() {
  const list = $('#activity-list');
  let data;
  try {
    [data] = await Promise.all([api('GET', `/comments?limit=${state.activityCount}`), loadStatus()]);
  } catch (err) {
    list.replaceChildren(el('p', { class: 'error', text: err.message }));
    return;
  }
  renderStats();
  list.replaceChildren();
  if (data.items.length === 0) {
    list.append(
      el(
        'div',
        { class: 'card empty' },
        el('div', { class: 'big', text: '📭' }),
        el('p', { text: 'Noch keine Kommentare empfangen. Sobald der Webhook eingerichtet ist, erscheinen sie hier.' }),
      ),
    );
  }
  for (const c of data.items) {
    const [cls, label] = STATUS_BADGES[c.status] || ['b-muted', c.status];
    const foot = el('div', { class: 'event-foot' }, el('span', { class: `badge ${cls}`, text: label }));
    if (c.rule_name) foot.append(el('span', { class: 'chip', text: c.rule_name }));
    if (c.note) foot.append(el('span', { class: 'muted', text: c.note }));
    for (const job of c.jobs) {
      foot.append(jobBadge(job));
      if (job.status === 'failed') {
        foot.append(el('button', { class: 'btn btn-sm', text: 'Erneut senden', onclick: () => retryJob(job) }));
      }
      if (job.last_error && job.status !== 'done') foot.append(el('div', { class: 'job-error', text: `${JOB_LABELS[job.type]}: ${job.last_error}` }));
    }
    list.append(
      el(
        'div',
        { class: 'event' },
        el(
          'div',
          { class: 'event-head' },
          el('span', {}, el('span', { class: 'event-user', text: `@${c.from_username || 'unbekannt'}` }), c.parent_id ? ' · Antwort im Thread' : ''),
          el('span', { title: formatDate(c.received_at), text: relativeTime(c.received_at) }),
        ),
        el('div', { class: 'event-text', text: c.text || '(leer)' }),
        foot,
      ),
    );
  }
  $('#more-activity').classList.toggle('hidden', data.items.length >= data.total || state.activityCount >= 200);
}

function startActivityPolling() {
  loadActivity();
  state.activityTimer = setInterval(() => {
    if (!document.hidden) loadActivity();
  }, 10000);
}

function stopActivityPolling() {
  clearInterval(state.activityTimer);
  state.activityTimer = null;
}

$('#refresh-activity').addEventListener('click', loadActivity);
$('#more-activity').addEventListener('click', () => {
  state.activityCount = Math.min(state.activityCount + 30, 200);
  loadActivity();
});

// ---------------------------------------------------------------------------
// Testen
// ---------------------------------------------------------------------------

$('#test-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#test-result');
  out.replaceChildren();
  let res;
  try {
    res = await api('POST', '/test', {
      text: $('#test-text').value,
      username: $('#test-username').value,
      media_id: $('#test-media').value,
    });
  } catch (err) {
    out.append(el('p', { class: 'error', text: err.message }));
    return;
  }

  if (!res.matched) {
    out.append(
      el(
        'div',
        { class: 'card' },
        el('h2', { text: '✗ Keine Automation würde reagieren' }),
        res.hint ? el('p', { class: 'muted', text: res.hint }) : el('p', { class: 'muted', text: 'Prüfe Schlüsselwörter, Auslöser-Art und ausgewählte Beiträge.' }),
      ),
    );
    return;
  }

  const preview = el('div', { class: 'preview' });
  if (res.actions.dm) {
    const bubble = el('div', { class: 'bubble bubble-dm' }, res.actions.dm.text);
    if (res.actions.dm.button) bubble.append(el('span', { class: 'bubble-btn', text: res.actions.dm.button.title }));
    preview.append(el('div', { class: 'muted', text: '✉️ Direktnachricht' }), bubble);
  }
  if (res.actions.reply) {
    preview.append(el('div', { class: 'muted', text: '💬 Öffentliche Antwort (eine zufällige Variante)' }), el('div', { class: 'bubble', text: res.actions.reply.message }));
  }
  out.append(
    el(
      'div',
      { class: 'card' },
      el('h2', { text: `✓ „${res.rule.name}“ würde reagieren` }),
      el(
        'p',
        { class: 'muted' },
        res.keyword === '*' ? 'Auslöser: jeder Kommentar' : `Erkanntes Schlüsselwort: „${res.keyword}“`,
        ` · Verzögerung ca. ${res.delay_seconds} s`,
        res.rule.once_per_user ? ' · nur einmal pro Person' : '',
      ),
      preview,
    ),
  );
});

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

function check(ok, yes, no) {
  return el('span', { class: `badge ${ok ? 'b-ok' : 'b-err'}`, text: ok ? `✓ ${yes}` : `✗ ${no}` });
}

async function renderSettings() {
  await loadStatus();
  const s = state.status;
  const box = $('#settings-content');
  box.replaceChildren();
  if (!s) return;
  const acc = s.account;

  // --- Konto ---
  const tokenInput = el('input', { type: 'password', placeholder: 'IGAA…', autocomplete: 'off' });
  const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', text: 'Speichern & prüfen' });
  saveBtn.addEventListener('click', () =>
    withBusy(saveBtn, async () => {
      try {
        const res = await api('POST', '/account/token', { access_token: tokenInput.value });
        toast(`Verbunden mit @${res.username} ✓`);
        renderSettings();
      } catch (err) {
        toast(err.message, true);
      }
    }),
  );
  const refreshBtn = el('button', { class: 'btn btn-sm', type: 'button', text: 'Token jetzt verlängern' });
  refreshBtn.addEventListener('click', () =>
    withBusy(refreshBtn, async () => {
      try {
        await api('POST', '/account/refresh-token', {});
        toast('Token verlängert ✓');
        renderSettings();
      } catch (err) {
        toast(err.message, true);
      }
    }),
  );
  const reloadBtn = el('button', { class: 'btn btn-sm', type: 'button', text: 'Verbindung prüfen' });
  reloadBtn.addEventListener('click', () =>
    withBusy(reloadBtn, async () => {
      try {
        await api('POST', '/account/reload', {});
        toast('Verbindung funktioniert ✓');
        renderSettings();
      } catch (err) {
        toast(err.message, true);
      }
    }),
  );

  const accountInfo = acc.connected
    ? el(
        'dl',
        { class: 'kv' },
        el('dt', { text: 'Konto' }),
        el('dd', { text: acc.username ? `@${acc.username}${acc.name ? ` (${acc.name})` : ''}` : 'Token gespeichert, Konto unbekannt' }),
        el('dt', { text: 'Instagram-ID' }),
        el('dd', { text: acc.user_id || '–' }),
        el('dt', { text: 'Token gespeichert' }),
        el('dd', { text: formatDate(acc.token_saved_at) }),
        el('dt', { text: 'Zuletzt verlängert' }),
        el('dd', { text: acc.token_refreshed_at ? formatDate(acc.token_refreshed_at) : 'noch nie (passiert automatisch wöchentlich)' }),
        el('dt', { text: 'Gültig bis' }),
        el('dd', { text: acc.token_expires_at ? formatDate(acc.token_expires_at) : 'unbekannt (60 Tage ab Erstellung)' }),
        acc.token_refresh_error ? el('dt', { text: 'Letzter Fehler' }) : null,
        acc.token_refresh_error ? el('dd', { class: 'error', text: acc.token_refresh_error }) : null,
      )
    : el('p', { class: 'muted', text: 'Noch kein Konto verbunden.' });

  box.append(
    el(
      'div',
      { class: 'card' },
      el('h2', {}, 'Instagram-Konto ', check(acc.connected, 'verbunden', 'nicht verbunden')),
      accountInfo,
      acc.connected ? el('div', { class: 'row gap wrap' }, reloadBtn, refreshBtn) : null,
      el('label', { text: acc.connected ? 'Neuen Access Token eintragen' : 'Access Token eintragen' }),
      el('div', { class: 'copy-row' }, tokenInput, saveBtn),
      el('p', { class: 'hint', text: 'Den Token erzeugst du im Meta-Entwicklerportal unter „Instagram → API-Einrichtung mit Instagram-Login → Zugriffsschlüssel generieren“. Er wird automatisch alle 7 Tage verlängert.' }),
    ),
  );

  // --- Webhook ---
  const urlInput = el('input', { type: 'text', readonly: true, value: s.webhook.url });
  const copyBtn = el('button', { class: 'btn', type: 'button', text: 'Kopieren' });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(s.webhook.url);
      toast('Kopiert ✓');
    } catch {
      urlInput.select();
    }
  });
  const subscribeBtn = el('button', { class: 'btn', type: 'button', text: 'Kommentar-Webhooks abonnieren' });
  subscribeBtn.addEventListener('click', () =>
    withBusy(subscribeBtn, async () => {
      try {
        await api('POST', '/account/subscribe', {});
        toast('Webhooks für Kommentare abonniert ✓');
      } catch (err) {
        toast(err.message, true);
      }
    }),
  );

  box.append(
    el(
      'div',
      { class: 'card' },
      el('h2', { text: s.polling.enabled ? 'Webhook (optional – im Abfrage-Modus nicht nötig)' : 'Webhook' }),
      el('label', { text: 'Rückruf-URL (im Meta-Entwicklerportal eintragen)' }),
      el('div', { class: 'copy-row' }, urlInput, copyBtn),
      el('p', { class: 'hint', text: 'Muss eine öffentlich erreichbare https-Adresse sein. Als „Überprüfungstoken“ trägst du den Wert von IG_VERIFY_TOKEN ein.' }),
      el(
        'div',
        { class: 'row gap wrap' },
        check(s.webhook.app_secret_set, 'IG_APP_SECRET gesetzt', 'IG_APP_SECRET fehlt'),
        check(s.webhook.verify_token_set, 'IG_VERIFY_TOKEN gesetzt', 'IG_VERIFY_TOKEN fehlt'),
      ),
      el('p', { class: 'hint', text: 'Nach dem Verbinden des Kontos einmal abonnieren, damit Instagram neue Kommentare meldet:' }),
      subscribeBtn,
    ),
  );

  // --- Abfrage-Modus ---
  const pollBtn = el('button', { class: 'btn', type: 'button', text: 'Jetzt nach neuen Kommentaren schauen' });
  pollBtn.addEventListener('click', () =>
    withBusy(pollBtn, async () => {
      try {
        const res = await api('POST', '/poll-now', {});
        toast(`${plural(res.checked, 'Beitrag', 'Beiträge')} geprüft, ${plural(res.new, 'neuer Kommentar', 'neue Kommentare')}`);
      } catch (err) {
        toast(err.message, true);
      }
    }),
  );
  box.append(
    el(
      'div',
      { class: 'card' },
      el('h2', {}, 'Abfrage-Modus ', check(s.polling.enabled, `aktiv (alle ${s.polling.interval_seconds} s)`, 'aus')),
      el('p', {
        class: 'hint',
        text:
          'Holt neue Kommentare regelmäßig selbst ab – praktisch, solange deine Meta-App noch nicht live ist bzw. keinen „Advanced Access“ für Kommentar-Webhooks hat, und als Absicherung zum Webhook. ' +
          'Einschalten mit der Umgebungsvariable POLL_INTERVAL_SECONDS (z. B. 60).',
      }),
      s.polling.enabled && s.polling.since
        ? el('p', { class: 'hint', text: `Berücksichtigt Kommentare ab ${formatDate(s.polling.since)} (ältere bekommen keine nachträglichen Antworten).` })
        : null,
      s.polling.enabled ? pollBtn : null,
    ),
  );

  // --- Anleitung ---
  box.append(
    el(
      'div',
      { class: 'card' },
      el('h2', { text: 'Einrichtung in Kurzform' }),
      el(
        'ol',
        { class: 'steps' },
        el('li', { text: 'Instagram-Konto auf Business- oder Creator-Konto umstellen.' }),
        el('li', { text: 'Auf developers.facebook.com eine App vom Typ „Business“ anlegen und das Produkt „Instagram“ hinzufügen.' }),
        el('li', { text: 'Unter „API-Einrichtung mit Instagram-Login“ dein Konto hinzufügen und einen Access Token generieren – hier oben eintragen.' }),
        el('li', { text: 'Webhook konfigurieren: obige URL + Verify Token eintragen, dann das Feld „comments“ abonnieren.' }),
        el('li', { text: 'App-Geheimschlüssel (Instagram-App-Secret) als IG_APP_SECRET hinterlegen.' }),
        el('li', { text: 'Oben auf „Kommentar-Webhooks abonnieren“ klicken – fertig! Unter „Testen“ kannst du deine Automationen ausprobieren.' }),
      ),
      el('p', { class: 'hint', text: `Graph-API-Version: ${s.graph_version} · Ausführliche Anleitung: README.md` }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
  try {
    const { authenticated } = await api('GET', '/session');
    if (authenticated) await showApp();
    else showLogin();
  } catch {
    showLogin();
  }
})();
