'use strict';

const { refreshTokenIfDue } = require('./account');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(err) {
  return String(err && err.toString ? err.toString() : err).slice(0, 1000);
}

/**
 * Arbeitet die Warteschlange ab: verschickt DMs und öffentliche Antworten,
 * wiederholt bei temporären Fehlern und hält Abstand zwischen API-Aufrufen.
 */
class Worker {
  constructor({ store, client, minIntervalMs = 2000, maxAttempts = 3, logger = console, now = () => Date.now() }) {
    this.store = store;
    this.client = client;
    this.minIntervalMs = minIntervalMs;
    this.maxAttempts = maxAttempts;
    this.logger = logger;
    this.now = now;
    this.lastCallAt = 0;
    this.busy = false;
    this.timers = [];
  }

  start() {
    this.store.resetRunningJobs();
    this.timers.push(setInterval(() => this.tick().catch((e) => this.logger.error(e)), 1000));
    const refresh = () => refreshTokenIfDue(this.store, this.client, { logger: this.logger }).catch(() => {});
    this.timers.push(setInterval(refresh, 60 * 60 * 1000));
    setTimeout(refresh, 5000).unref?.();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Verarbeitet alle fälligen Jobs. Gibt die Anzahl bearbeiteter Jobs zurück. */
  async tick() {
    if (this.busy) return 0;
    this.busy = true;
    let processed = 0;
    try {
      let job;
      while ((job = this.store.claimNextJob(this.now()))) {
        await this.process(job);
        processed++;
      }
    } finally {
      this.busy = false;
    }
    return processed;
  }

  async throttle() {
    const wait = this.lastCallAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }

  async process(job) {
    try {
      const result = await this.execute(job);
      this.store.completeJob(job.id, result);
    } catch (err) {
      const message = errorText(err);
      if (err && err.transient && job.attempts < this.maxAttempts) {
        const backoff = 30000 * 2 ** (job.attempts - 1);
        this.store.retryJob(job.id, message, this.now() + backoff);
        this.logger.warn(`Job ${job.id} (${job.type}) fehlgeschlagen, neuer Versuch in ${backoff / 1000}s: ${message}`);
      } else {
        this.store.failJob(job.id, message);
        this.logger.warn(`Job ${job.id} (${job.type}) endgültig fehlgeschlagen: ${message}`);
      }
    }
  }

  async execute(job) {
    const { payload } = job;
    if (job.type === 'reply') {
      await this.throttle();
      const res = await this.client.replyToComment(job.comment_id, payload.message);
      return { id: res?.id ?? null };
    }

    if (job.type === 'dm') {
      await this.throttle();
      try {
        const res = await this.client.sendPrivateReply(job.comment_id, payload);
        return { message_id: res?.message_id ?? null };
      } catch (err) {
        // Falls Instagram die Button-Vorlage ablehnt: als reinen Text mit Link senden.
        if (!payload.button || err.transient) throw err;
        this.logger.warn(`Button-Nachricht abgelehnt (${errorText(err)}), sende Text mit Link.`);
        await this.throttle();
        const text = `${payload.text}\n\n${payload.button.title}: ${payload.button.url}`;
        const res = await this.client.sendPrivateReply(job.comment_id, { text });
        return { message_id: res?.message_id ?? null, fallback: 'text' };
      }
    }

    throw new Error(`Unbekannter Job-Typ: ${job.type}`);
  }
}

module.exports = { Worker };
