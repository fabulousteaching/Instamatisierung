'use strict';

const { handleComment } = require('./automation');

/**
 * Abfrage-Modus (Polling): holt neue Kommentare regelmäßig selbst über die API,
 * statt auf Webhooks zu warten.
 *
 * Nützlich, solange die Meta-App noch nicht live ist bzw. keinen "Advanced Access"
 * für Kommentar-Webhooks hat – und als Absicherung, falls Webhooks verloren gehen.
 * Doppelte Kommentare (Webhook + Abfrage) werden automatisch erkannt.
 *
 * Es werden nur Kommentare verarbeitet, die NACH dem ersten Start des Abfrage-Modus
 * geschrieben wurden – alte Kommentare bekommen also keine nachträglichen Antworten.
 */

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // Private Antworten gehen nur 7 Tage lang

function flattenComments(comments) {
  const out = [];
  for (const c of comments) {
    out.push(c);
    for (const r of c.replies?.data ?? []) out.push({ ...r, parent_id: r.parent_id ?? c.id });
  }
  return out;
}

class Poller {
  constructor({ store, client, intervalMs, mediaCount = 5, logger = console, now = () => Date.now() }) {
    this.store = store;
    this.client = client;
    this.intervalMs = intervalMs;
    this.mediaCount = mediaCount;
    this.logger = logger;
    this.now = now;
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (!this.intervalMs) return;
    this.logger.log(`Abfrage-Modus aktiv: alle ${Math.round(this.intervalMs / 1000)} s nach neuen Kommentaren schauen.`);
    const run = () => this.poll().catch((err) => this.logger.warn(`Abfrage fehlgeschlagen: ${err}`));
    this.timer = setInterval(run, this.intervalMs);
    setTimeout(run, 3000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Welche Beiträge abgefragt werden: die neuesten + alle, die in einer aktiven Automation ausgewählt sind. */
  async mediaToCheck() {
    const recent = await this.client.listMedia(this.mediaCount);
    const ids = new Map();
    for (const m of recent) {
      if (m.comments_count !== 0) ids.set(m.id, m);
    }
    for (const rule of this.store.listEnabledRules()) {
      for (const id of rule.media_ids) if (!ids.has(id)) ids.set(id, { id });
    }
    return [...ids.keys()];
  }

  async poll() {
    if (this.busy || !this.store.getSetting('access_token')) return { checked: 0, new: 0 };
    this.busy = true;
    try {
      const now = this.now();
      let since = Number(this.store.getSetting('poll_since') || 0);
      if (!since) {
        since = now;
        this.store.setSetting('poll_since', since);
      }
      const cutoff = Math.max(since, now - MAX_AGE_MS);
      const accountId = this.store.getSetting('ig_user_id');

      let checked = 0;
      let fresh = 0;
      for (const mediaId of await this.mediaToCheck()) {
        let comments;
        try {
          comments = flattenComments(await this.client.listComments(mediaId));
        } catch (err) {
          this.logger.warn(`Kommentare für Beitrag ${mediaId} nicht abrufbar: ${err}`);
          continue;
        }
        checked++;
        for (const c of comments) {
          const ts = Date.parse(c.timestamp);
          if (!c.id || !Number.isFinite(ts) || ts < cutoff) continue;
          if (this.store.hasComment(String(c.id))) continue;
          const outcome = handleComment(this.store, {
            id: String(c.id),
            account_id: accountId,
            text: c.text ?? '',
            parent_id: c.parent_id != null ? String(c.parent_id) : null,
            from_id: c.from?.id != null ? String(c.from.id) : null,
            from_username: c.from?.username ?? c.username ?? null,
            media_id: String(mediaId),
          });
          if (outcome.status !== 'duplicate') {
            fresh++;
            this.logger.log(`[Abfrage] Kommentar von @${c.from?.username ?? c.username ?? '?'} -> ${outcome.status}`);
          }
        }
      }
      return { checked, new: fresh };
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Poller, flattenComments };
