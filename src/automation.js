'use strict';

const { findMatchingRule, buildActions } = require('./matcher');

/** Abstand zwischen DM und öffentlicher Antwort, damit es natürlicher wirkt. */
const REPLY_GAP_MS = 3000;

function jitter(ms, random) {
  // ±25 % Zufall, damit nicht jede Antwort exakt gleich schnell kommt
  return Math.round(ms * (0.75 + random() * 0.5));
}

function isOwnComment(comment, own) {
  if (comment.from_id && comment.account_id && comment.from_id === comment.account_id) return true;
  if (comment.from_id && own.userIds.includes(comment.from_id)) return true;
  if (comment.from_username && own.username && comment.from_username.toLowerCase() === own.username.toLowerCase()) {
    return true;
  }
  return false;
}

/**
 * Verarbeitet einen eingehenden Kommentar:
 * passende Automation suchen, Kommentar protokollieren, Antworten einplanen.
 *
 * @returns {{status: string, note?: string, rule_id?: number, jobs?: number[]}}
 */
function handleComment(store, comment, { now = Date.now(), random = Math.random } = {}) {
  const own = {
    userIds: [store.getSetting('ig_user_id'), store.getSetting('ig_app_scoped_id')].filter(Boolean),
    username: store.getSetting('ig_username'),
  };

  return store.transaction(() => {
    const record = { ...comment, received_at: now };

    if (isOwnComment(comment, own)) {
      const inserted = store.insertComment({ ...record, status: 'ignored', note: 'Eigener Kommentar' });
      return inserted ? { status: 'ignored', note: 'Eigener Kommentar' } : { status: 'duplicate' };
    }

    const match = findMatchingRule(store.listEnabledRules(), comment);
    if (!match) {
      const inserted = store.insertComment({ ...record, status: 'no_match' });
      return inserted ? { status: 'no_match' } : { status: 'duplicate' };
    }

    const { rule, keyword } = match;
    if (rule.once_per_user && store.hasUserTriggeredRule(rule.id, comment.from_id)) {
      const note = 'Person hat diese Automation schon einmal ausgelöst';
      const inserted = store.insertComment({ ...record, rule_id: rule.id, status: 'skipped', note });
      return inserted ? { status: 'skipped', note, rule_id: rule.id } : { status: 'duplicate' };
    }

    const note = keyword === '*' ? 'Jeder Kommentar' : `Schlüsselwort: ${keyword}`;
    const inserted = store.insertComment({ ...record, rule_id: rule.id, status: 'matched', note });
    if (!inserted) return { status: 'duplicate' };

    const actions = buildActions(rule, comment, random);
    const baseDelay = jitter(rule.delay_seconds * 1000, random);
    const jobs = [];
    if (actions.dm) {
      jobs.push(
        store.enqueueJob({ comment_id: comment.id, rule_id: rule.id, type: 'dm', payload: actions.dm, run_at: now + baseDelay }),
      );
    }
    if (actions.reply) {
      const gap = actions.dm ? REPLY_GAP_MS : 0;
      jobs.push(
        store.enqueueJob({
          comment_id: comment.id,
          rule_id: rule.id,
          type: 'reply',
          payload: actions.reply,
          run_at: now + baseDelay + gap,
        }),
      );
    }
    return { status: 'matched', note, rule_id: rule.id, jobs };
  });
}

module.exports = { handleComment, isOwnComment };
