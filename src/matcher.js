'use strict';

/**
 * Regel-Logik: Prüft, ob ein Kommentar eine Automation auslöst,
 * und erzeugt die Antworttexte.
 */

const MATCH_TYPES = ['contains', 'exact', 'any'];

const LIMITS = {
  name: 100,
  keyword: 100,
  keywords: 50,
  replyVariant: 2200, // Instagram-Limit für Kommentare
  replyVariants: 20,
  dmText: 1000, // Instagram-Limit für Nachrichten
  dmTextWithButton: 640, // Limit für Text in einer Button-Vorlage
  buttonTitle: 20,
  url: 2000,
  delaySeconds: 3600,
};

function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('de-DE')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Satzzeichen und Leerzeichen am Anfang/Ende entfernen (Emojis bleiben erhalten). */
function stripEdgePunctuation(text) {
  return text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "contains": Das Schlüsselwort muss als ganzes Wort vorkommen.
 * "info" passt also zu "Info bitte!", aber nicht zu "Informationen".
 */
function containsKeyword(normalizedText, keyword) {
  const kw = normalize(keyword);
  if (!kw) return false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(kw)}(?![\\p{L}\\p{N}_])`, 'u');
  return pattern.test(normalizedText);
}

function exactKeyword(normalizedText, keyword) {
  const kw = stripEdgePunctuation(normalize(keyword));
  if (!kw) return false;
  return stripEdgePunctuation(normalizedText) === kw;
}

/** Gibt das passende Schlüsselwort zurück (oder "*" bei "jeder Kommentar"), sonst null. */
function matchKeywords(rule, text) {
  const normalized = normalize(text);
  if (rule.match_type === 'any') return '*';
  const test = rule.match_type === 'exact' ? exactKeyword : containsKeyword;
  for (const keyword of rule.keywords || []) {
    if (test(normalized, keyword)) return keyword;
  }
  return null;
}

function appliesToMedia(rule, mediaId) {
  const ids = rule.media_ids || [];
  if (ids.length === 0) return true;
  return mediaId != null && ids.includes(String(mediaId));
}

/**
 * Reihenfolge: Automationen für bestimmte Beiträge vor allgemeinen,
 * danach nach Priorität (kleinere Zahl zuerst), danach nach Alter.
 */
function sortRules(rules) {
  return [...rules].sort((a, b) => {
    const aSpecific = (a.media_ids || []).length > 0 ? 0 : 1;
    const bSpecific = (b.media_ids || []).length > 0 ? 0 : 1;
    if (aSpecific !== bSpecific) return aSpecific - bSpecific;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id - b.id;
  });
}

/** Findet die erste passende, aktive Automation. */
function findMatchingRule(rules, { text, media_id }) {
  for (const rule of sortRules(rules)) {
    if (!rule.enabled) continue;
    if (!appliesToMedia(rule, media_id)) continue;
    const keyword = matchKeywords(rule, text);
    if (keyword !== null) return { rule, keyword };
  }
  return null;
}

/** Ersetzt Platzhalter wie {username} im Text. */
function renderTemplate(template, vars) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key) => {
    const value = vars[key.toLowerCase()];
    return value === undefined || value === null ? whole : String(value);
  });
}

function pickVariant(variants, random = Math.random) {
  if (!variants || variants.length === 0) return null;
  return variants[Math.floor(random() * variants.length) % variants.length];
}

function templateVars(comment) {
  return {
    username: comment.from_username || '',
    kommentar: comment.text || '',
    comment: comment.text || '',
  };
}

/** Baut die konkreten Nachrichten, die für einen Kommentar verschickt würden. */
function buildActions(rule, comment, random = Math.random) {
  const vars = templateVars(comment);
  const actions = {};
  if (rule.dm_enabled && rule.dm_text) {
    actions.dm = {
      text: renderTemplate(rule.dm_text, vars),
      button:
        rule.dm_button_title && rule.dm_button_url
          ? { title: renderTemplate(rule.dm_button_title, vars), url: rule.dm_button_url }
          : null,
    };
  }
  if (rule.reply_enabled && rule.reply_variants.length > 0) {
    actions.reply = { message: renderTemplate(pickVariant(rule.reply_variants, random), vars) };
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Eingaben aus dem Dashboard prüfen
// ---------------------------------------------------------------------------

function toList(value, splitter) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(splitter);
  return [];
}

function toBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 'true' || value === 1 || value === '1' || value === 'on';
}

function toInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Prüft und bereinigt eine Automation. Gibt { rule, errors } zurück. */
function validateRule(input) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};

  const rule = {
    name: String(src.name ?? '').trim(),
    enabled: toBool(src.enabled, true),
    match_type: MATCH_TYPES.includes(src.match_type) ? src.match_type : null,
    keywords: [...new Set(toList(src.keywords, ',').map((k) => String(k).trim()).filter(Boolean))],
    media_ids: [...new Set(toList(src.media_ids, /[\s,]+/).map((m) => String(m).trim()).filter(Boolean))],
    reply_enabled: toBool(src.reply_enabled, false),
    reply_variants: toList(src.reply_variants, '\n').map((v) => String(v).trim()).filter(Boolean),
    dm_enabled: toBool(src.dm_enabled, false),
    dm_text: String(src.dm_text ?? '').trim(),
    dm_button_title: String(src.dm_button_title ?? '').trim(),
    dm_button_url: String(src.dm_button_url ?? '').trim(),
    once_per_user: toBool(src.once_per_user, true),
    delay_seconds: toInt(src.delay_seconds, 10),
    priority: toInt(src.priority, 100),
  };

  if (!rule.name) errors.push('Bitte gib der Automation einen Namen.');
  if (rule.name.length > LIMITS.name) errors.push(`Der Name darf höchstens ${LIMITS.name} Zeichen lang sein.`);

  if (!rule.match_type) errors.push('Ungültige Auslöser-Art.');
  if (rule.match_type !== 'any' && rule.keywords.length === 0) {
    errors.push('Bitte mindestens ein Schlüsselwort angeben (oder „Jeder Kommentar“ wählen).');
  }
  if (rule.keywords.length > LIMITS.keywords) errors.push(`Höchstens ${LIMITS.keywords} Schlüsselwörter.`);
  if (rule.keywords.some((k) => k.length > LIMITS.keyword)) {
    errors.push(`Ein Schlüsselwort darf höchstens ${LIMITS.keyword} Zeichen lang sein.`);
  }
  if (rule.media_ids.some((m) => !/^\d{1,40}$/.test(m))) {
    errors.push('Beitrags-IDs dürfen nur aus Ziffern bestehen.');
  }

  if (!rule.reply_enabled && !rule.dm_enabled) {
    errors.push('Aktiviere mindestens eine Aktion: öffentliche Antwort oder Direktnachricht.');
  }
  if (rule.reply_enabled) {
    if (rule.reply_variants.length === 0) errors.push('Bitte mindestens eine Antwort-Variante eintragen.');
    if (rule.reply_variants.length > LIMITS.replyVariants) {
      errors.push(`Höchstens ${LIMITS.replyVariants} Antwort-Varianten.`);
    }
    if (rule.reply_variants.some((v) => v.length > LIMITS.replyVariant)) {
      errors.push(`Eine Antwort darf höchstens ${LIMITS.replyVariant} Zeichen lang sein.`);
    }
  }
  if (rule.dm_enabled) {
    const hasButton = rule.dm_button_title || rule.dm_button_url;
    const maxText = hasButton ? LIMITS.dmTextWithButton : LIMITS.dmText;
    if (!rule.dm_text) errors.push('Bitte einen Text für die Direktnachricht eintragen.');
    if (rule.dm_text.length > maxText) {
      errors.push(`Der DM-Text darf ${hasButton ? 'mit Button ' : ''}höchstens ${maxText} Zeichen lang sein.`);
    }
    if (hasButton) {
      if (!rule.dm_button_title || !rule.dm_button_url) {
        errors.push('Für den Button werden sowohl Beschriftung als auch Link benötigt.');
      }
      if (rule.dm_button_title.length > LIMITS.buttonTitle) {
        errors.push(`Die Button-Beschriftung darf höchstens ${LIMITS.buttonTitle} Zeichen lang sein.`);
      }
      if (rule.dm_button_url && (!isHttpUrl(rule.dm_button_url) || rule.dm_button_url.length > LIMITS.url)) {
        errors.push('Der Button-Link muss eine gültige http(s)-Adresse sein.');
      }
    }
  }

  if (rule.delay_seconds < 0 || rule.delay_seconds > LIMITS.delaySeconds) {
    errors.push(`Die Verzögerung muss zwischen 0 und ${LIMITS.delaySeconds} Sekunden liegen.`);
  }
  if (rule.priority < 0 || rule.priority > 100000) errors.push('Die Priorität muss zwischen 0 und 100000 liegen.');

  return { rule, errors };
}

module.exports = {
  MATCH_TYPES,
  LIMITS,
  normalize,
  matchKeywords,
  appliesToMedia,
  sortRules,
  findMatchingRule,
  renderTemplate,
  pickVariant,
  buildActions,
  validateRule,
};
