'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const { config: defaultConfig, validateConfig } = require('./config');
const { openDatabase } = require('./db');
const { InstagramClient } = require('./instagram');
const { verifySignature, extractComments } = require('./webhook');
const { handleComment } = require('./automation');
const { findMatchingRule, buildActions, validateRule } = require('./matcher');
const {
  getAccessToken,
  getApiMode,
  getAccountId,
  saveAccessToken,
  syncEnvToken,
  refreshTokenIfDue,
  accountStatus,
} = require('./account');
const { oauthSettings, saveOAuthSettings, buildLoginUrl, parseRedirectInput, completeLogin } = require('./oauth');
const { Worker } = require('./worker');
const { Poller } = require('./poller');
const {
  COOKIE_NAME,
  SESSION_TTL_MS,
  safeEqual,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  LoginLimiter,
} = require('./auth');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, 'Ungültige ID.');
  return id;
}

function createApp({ config, store, client, poller = null, logger = console }) {
  const app = express();
  const limiter = new LoginLimiter();

  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  // -------------------------------------------------------------------------
  // Webhook (wird von Meta aufgerufen)
  // -------------------------------------------------------------------------

  // Bestätigung bei der Einrichtung im Meta-Entwicklerportal
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && config.verifyToken && typeof token === 'string' && safeEqual(token, config.verifyToken)) {
      logger.log('Webhook erfolgreich bestätigt.');
      return res.type('text/plain').send(String(challenge ?? ''));
    }
    logger.warn('Webhook-Bestätigung abgelehnt (Verify Token stimmt nicht).');
    return res.sendStatus(403);
  });

  app.post('/webhook', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    if (!config.appSecret) {
      logger.error('IG_APP_SECRET ist nicht gesetzt – Webhooks können nicht geprüft werden.');
      return res.sendStatus(503);
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(rawBody, req.get('x-hub-signature-256'), config.appSecret)) {
      logger.warn('Webhook mit ungültiger Signatur abgelehnt.');
      return res.sendStatus(401);
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }

    for (const comment of extractComments(payload)) {
      const outcome = handleComment(store, comment);
      if (outcome.status !== 'duplicate') {
        logger.log(
          `Kommentar von @${comment.from_username ?? '?'}: "${comment.text.slice(0, 80)}" -> ${outcome.status}` +
            (outcome.note ? ` (${outcome.note})` : ''),
        );
      }
    }
    return res.status(200).send('EVENT_RECEIVED');
  });

  // -------------------------------------------------------------------------
  // Dashboard-API
  // -------------------------------------------------------------------------

  const api = express.Router();
  api.use(express.json({ limit: '200kb' }));

  const isSecure = (req) => req.secure;
  const isAuthenticated = (req) =>
    verifySessionToken(parseCookies(req.headers.cookie)[COOKIE_NAME], {
      secret: config.sessionSecret,
      password: config.adminPassword,
    });

  api.post('/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (limiter.isBlocked(ip)) throw new HttpError(429, 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.');
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!config.adminPassword || !safeEqual(password, config.adminPassword)) {
      limiter.recordFailure(ip);
      throw new HttpError(401, 'Falsches Passwort.');
    }
    limiter.reset(ip);
    const token = createSessionToken({ secret: config.sessionSecret, password: config.adminPassword });
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure(req),
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    res.json({ ok: true });
  });

  api.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  api.get('/session', (req, res) => res.json({ authenticated: isAuthenticated(req) }));

  // Ab hier nur mit Anmeldung
  api.use((req, res, next) => {
    if (!isAuthenticated(req)) throw new HttpError(401, 'Bitte anmelden.');
    // Zusätzlicher CSRF-Schutz: schreibende Anfragen nur als JSON (erzwingt CORS-Preflight)
    if (req.method !== 'GET' && !req.is('application/json')) {
      throw new HttpError(415, 'Anfragen müssen als JSON gesendet werden.');
    }
    next();
  });

  api.get('/status', (req, res) => {
    res.json({
      account: accountStatus(store),
      webhook: {
        url: `${req.protocol}://${req.get('host')}/webhook`,
        app_secret_set: !!config.appSecret,
        verify_token_set: !!config.verifyToken,
      },
      polling: {
        enabled: !!(poller && poller.intervalMs),
        interval_seconds: poller ? Math.round(poller.intervalMs / 1000) : 0,
        since: Number(store.getSetting('poll_since')) || null,
      },
      jobs: store.jobCounts(),
      comments_total: store.countComments(),
      graph_version: config.graphVersion,
    });
  });

  // ----- Automationen -----
  api.get('/rules', (req, res) => {
    const stats = store.ruleStats();
    res.json(
      store.listRules().map((r) => ({ ...r, stats: stats[r.id] || { matched: 0, replies_sent: 0, dms_sent: 0 } })),
    );
  });

  api.post('/rules', (req, res) => {
    const { rule, errors } = validateRule(req.body);
    if (errors.length) throw new HttpError(400, errors[0], errors);
    res.status(201).json(store.createRule(rule));
  });

  api.get('/rules/:id', (req, res) => {
    const rule = store.getRule(parseId(req.params.id));
    if (!rule) throw new HttpError(404, 'Automation nicht gefunden.');
    res.json(rule);
  });

  api.put('/rules/:id', (req, res) => {
    const id = parseId(req.params.id);
    const { rule, errors } = validateRule(req.body);
    if (errors.length) throw new HttpError(400, errors[0], errors);
    const updated = store.updateRule(id, rule);
    if (!updated) throw new HttpError(404, 'Automation nicht gefunden.');
    res.json(updated);
  });

  api.delete('/rules/:id', (req, res) => {
    if (!store.deleteRule(parseId(req.params.id))) throw new HttpError(404, 'Automation nicht gefunden.');
    res.json({ ok: true });
  });

  // ----- Aktivität -----
  api.get('/comments', (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    res.json({ items: store.listComments({ limit, offset }), total: store.countComments() });
  });

  api.post('/jobs/:id/retry', (req, res) => {
    if (!store.requeueJob(parseId(req.params.id))) {
      throw new HttpError(404, 'Nur fehlgeschlagene Aktionen können erneut gesendet werden.');
    }
    res.json({ ok: true });
  });

  // ----- Testen (ohne echte Nachrichten zu senden) -----
  api.post('/test', (req, res) => {
    const text = String(req.body?.text ?? '');
    const comment = {
      text,
      from_username: String(req.body?.username || 'testperson').replace(/^@/, ''),
      media_id: req.body?.media_id ? String(req.body.media_id).trim() : null,
    };
    const rules = store.listRules();
    const match = findMatchingRule(rules, comment);
    if (!match) {
      const disabled = findMatchingRule(
        rules.filter((r) => !r.enabled).map((r) => ({ ...r, enabled: true })),
        comment,
      );
      return res.json({
        matched: false,
        hint: disabled ? `Die Automation „${disabled.rule.name}“ würde passen, ist aber deaktiviert.` : null,
      });
    }
    res.json({
      matched: true,
      rule: { id: match.rule.id, name: match.rule.name, once_per_user: match.rule.once_per_user },
      keyword: match.keyword,
      delay_seconds: match.rule.delay_seconds,
      actions: buildActions(match.rule, comment),
    });
  });

  // ----- Instagram-Konto -----
  api.get('/media', async (req, res) => {
    try {
      res.json(await client.listMedia(36));
    } catch (err) {
      throw new HttpError(502, `Beiträge konnten nicht geladen werden: ${err.message}`);
    }
  });

  api.post('/account/token', async (req, res) => {
    try {
      const me = await saveAccessToken(store, client, req.body?.access_token, { accountId: req.body?.account_id });
      res.json({ ok: true, username: me.username, account: accountStatus(store) });
    } catch (err) {
      throw new HttpError(400, `Token konnte nicht gespeichert werden: ${err.message}`);
    }
  });

  api.post('/account/refresh-token', async (req, res) => {
    try {
      await refreshTokenIfDue(store, client, { force: true, logger });
      res.json({ ok: true, account: accountStatus(store) });
    } catch (err) {
      throw new HttpError(502, `Verlängerung fehlgeschlagen: ${err.message}`);
    }
  });

  api.post('/account/subscribe', async (req, res) => {
    try {
      const result = await client.subscribeWebhooks(['comments']);
      res.json({ ok: true, result });
    } catch (err) {
      throw new HttpError(502, `Abonnieren fehlgeschlagen: ${err.message}`);
    }
  });

  api.post('/poll-now', async (req, res) => {
    if (!poller) throw new HttpError(400, 'Abfrage-Modus ist nicht aktiv (POLL_INTERVAL_SECONDS).');
    try {
      res.json({ ok: true, ...(await poller.poll()) });
    } catch (err) {
      throw new HttpError(502, `Abfrage fehlgeschlagen: ${err.message}`);
    }
  });

  // ----- Anmeldung über Meta (Unified login) -----
  api.get('/oauth/settings', (req, res) => {
    const s = oauthSettings(store);
    // Meta akzeptiert nur https-Adressen – auch für localhost.
    res.json({ ...s, redirect_uri: s.redirect_uri || `https://${req.get('host')}/auth/callback` });
  });

  api.post('/oauth/start', (req, res) => {
    try {
      saveOAuthSettings(store, req.body || {});
    } catch (err) {
      throw new HttpError(400, err.message, err.details);
    }
    res.json({ login_url: buildLoginUrl(store, { version: config.graphVersion }) });
  });

  api.post('/oauth/exchange', async (req, res) => {
    const parsed = parseRedirectInput(req.body?.input);
    if (parsed.error) throw new HttpError(400, `Meta meldet: ${parsed.error}`);
    try {
      const me = await completeLogin(store, client, { ...parsed, requireState: false });
      res.json({ ok: true, username: me.username, account: accountStatus(store) });
    } catch (err) {
      throw new HttpError(400, `Verbinden fehlgeschlagen: ${err.message}`);
    }
  });

  api.post('/account/reload', async (req, res) => {
    const token = getAccessToken(store);
    if (!token) throw new HttpError(400, 'Kein Access Token hinterlegt.');
    try {
      await saveAccessToken(store, client, token, { accountId: getAccountId(store) });
    } catch (err) {
      throw new HttpError(502, `Konto konnte nicht geladen werden: ${err.message}`);
    }
    res.json({ ok: true, account: accountStatus(store) });
  });

  api.use((req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

  app.use('/api', api);

  // Rücksprung von Meta nach der Anmeldung (Unified login)
  app.get('/auth/callback', async (req, res) => {
    const back = (params) => res.redirect(`/?${new URLSearchParams(params)}`);
    if (!isAuthenticated(req)) return back({ oauth_error: 'Bitte zuerst im Dashboard anmelden und dann erneut verbinden.' });
    const { code, state } = req.query;
    const error = req.query.error_description || req.query.error_message || req.query.error;
    if (error) return back({ oauth_error: `Meta meldet: ${String(error).slice(0, 300)}` });
    try {
      const me = await completeLogin(store, client, { code: String(code || ''), state: String(state || '') });
      logger.log(`Mit Meta verbunden: @${me.username}`);
      return back({ oauth: 'ok', username: me.username || '' });
    } catch (err) {
      logger.warn(`Verbinden über Meta fehlgeschlagen: ${err}`);
      return back({ oauth_error: String(err.message || err).slice(0, 400) });
    }
  });

  // Dashboard (statische Dateien)
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));

  // Fehlerbehandlung
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Ungültiges JSON.');
    if (err.type === 'entity.too.large') err = new HttpError(413, 'Anfrage zu groß.');
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500 && !(err instanceof HttpError)) logger.error(err);
    res.status(status).json({ error: err instanceof HttpError ? err.message : 'Interner Fehler.', details: err.details });
  });

  return app;
}

async function main() {
  const config = defaultConfig;
  const problems = validateConfig();
  if (problems.length) {
    console.error('Konfiguration unvollständig:\n  - ' + problems.join('\n  - '));
    console.error('Siehe .env.example und README.md.');
    process.exit(1);
  }
  if (config.pollIntervalSeconds === 0 && (!config.appSecret || !config.verifyToken)) {
    console.warn(
      'Hinweis: Weder Abfrage-Modus (POLL_INTERVAL_SECONDS) noch Webhook (IG_APP_SECRET + IG_VERIFY_TOKEN) ist eingerichtet –\n' +
        '         so kommen keine Kommentare an. Für den eigenen Computer: POLL_INTERVAL_SECONDS=60 setzen.',
    );
  }

  const store = openDatabase(config.databasePath);

  if (!config.sessionSecret) {
    let secret = store.getSetting('session_secret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      store.setSetting('session_secret', secret);
    }
    config.sessionSecret = secret;
  }
  const client = new InstagramClient({
    baseUrl: config.graphBaseUrl,
    facebookBaseUrl: config.facebookGraphBaseUrl,
    version: config.graphVersion,
    getToken: () => getAccessToken(store),
    getMode: () => getApiMode(store),
    getAccountId: () => getAccountId(store),
  });

  await syncEnvToken(store, client, config.initialAccessToken, { accountId: config.initialAccountId });

  const worker = new Worker({
    store,
    client,
    minIntervalMs: config.minSecondsBetweenApiCalls * 1000,
    maxAttempts: config.maxAttempts,
  });
  worker.start();

  const poller =
    config.pollIntervalSeconds > 0
      ? new Poller({ store, client, intervalMs: config.pollIntervalSeconds * 1000, mediaCount: config.pollMediaCount })
      : null;
  poller?.start();

  const app = createApp({ config, store, client, poller });
  const server = app.listen(config.port, () => {
    console.log(`Instamatisierung läuft – Dashboard: http://localhost:${config.port}`);
    console.log('Dieses Fenster offen lassen, solange das Tool laufen soll. Beenden mit Strg+C.');
  });

  const shutdown = () => {
    console.log('Fahre herunter …');
    worker.stop();
    poller?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp };
