'use strict';

const path = require('node:path');

// .env-Datei laden, falls vorhanden (Node >= 21.7 kann das ohne Zusatzpaket).
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // Keine .env-Datei – Umgebungsvariablen kommen dann vom Hoster.
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: int('PORT', 3000),

  // Zugang zum Dashboard
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',

  // Meta / Instagram App
  appSecret: process.env.IG_APP_SECRET || '',
  verifyToken: process.env.IG_VERIFY_TOKEN || '',
  initialAccessToken: process.env.IG_ACCESS_TOKEN || '',
  // Nur ändern, wenn du weißt, was du tust (z. B. für Tests gegen einen Mock-Server).
  graphBaseUrl: (process.env.IG_GRAPH_BASE_URL || 'https://graph.instagram.com').replace(/\/+$/, ''),
  graphVersion: process.env.IG_GRAPH_VERSION || 'v25.0',

  // Datenbank
  databasePath: process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'instamatisierung.db'),

  // Abfrage-Modus (Polling) – 0 = aus. Siehe README.
  pollIntervalSeconds: int('POLL_INTERVAL_SECONDS', 0),
  pollMediaCount: int('POLL_MEDIA_COUNT', 5),

  // Versand
  minSecondsBetweenApiCalls: int('MIN_SECONDS_BETWEEN_API_CALLS', 2),
  maxAttempts: int('MAX_ATTEMPTS', 3),
};

function validateConfig() {
  const problems = [];
  if (!config.adminPassword) problems.push('ADMIN_PASSWORD fehlt (Passwort für das Dashboard).');
  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    problems.push('SESSION_SECRET fehlt oder ist kürzer als 16 Zeichen.');
  }
  if (config.pollIntervalSeconds > 0 && config.pollIntervalSeconds < 30) {
    problems.push('POLL_INTERVAL_SECONDS muss 0 (aus) oder mindestens 30 sein (API-Limits).');
  }
  return problems;
}

module.exports = { config, validateConfig };
