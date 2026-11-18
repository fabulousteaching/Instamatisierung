'use strict';

const crypto = require('node:crypto');

/**
 * Prüft die Signatur, die Meta bei jedem Webhook mitschickt
 * (Header "X-Hub-Signature-256: sha256=<HMAC des Rohinhalts mit dem App-Geheimschlüssel>").
 *
 * appSecret darf mehrere, durch Komma getrennte Schlüssel enthalten
 * (z. B. Instagram-App-Geheimschlüssel und Meta-App-Geheimschlüssel).
 */
function verifySignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !signatureHeader || !Buffer.isBuffer(rawBody)) return false;
  const [algo, received] = String(signatureHeader).split('=');
  if (algo !== 'sha256' || !received || !/^[0-9a-f]{64}$/i.test(received)) return false;
  const b = Buffer.from(received.toLowerCase(), 'hex');
  const secrets = String(appSecret)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let valid = false;
  for (const secret of secrets) {
    const a = crypto.createHmac('sha256', secret).update(rawBody).digest();
    if (crypto.timingSafeEqual(a, b)) valid = true;
  }
  return valid;
}

function signPayload(rawBody, appSecret) {
  return 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

/**
 * Holt alle neuen Kommentare aus einem Webhook-Payload.
 *
 * Beispiel-Payload:
 * { "object": "instagram", "entry": [{ "id": "<IG-Konto-ID>", "time": 1700000000,
 *   "changes": [{ "field": "comments", "value": {
 *     "id": "<Kommentar-ID>", "text": "Info", "parent_id": "...",
 *     "from": { "id": "<Nutzer-ID>", "username": "max" },
 *     "media": { "id": "<Beitrags-ID>", "media_product_type": "FEED" } } }] }] }
 */
function extractComments(payload) {
  const result = [];
  if (!payload || payload.object !== 'instagram' || !Array.isArray(payload.entry)) return result;

  for (const entry of payload.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'comments') continue;
      const v = change.value || {};
      if (!v.id) continue;
      result.push({
        id: String(v.id),
        account_id: entry.id != null ? String(entry.id) : null,
        text: typeof v.text === 'string' ? v.text : '',
        parent_id: v.parent_id != null ? String(v.parent_id) : null,
        from_id: v.from?.id != null ? String(v.from.id) : null,
        from_username: v.from?.username ?? null,
        media_id: v.media?.id != null ? String(v.media.id) : null,
        media_product_type: v.media?.media_product_type ?? null,
      });
    }
  }
  return result;
}

module.exports = { verifySignature, signPayload, extractComments };
