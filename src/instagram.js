'use strict';

/**
 * Schlanker Client für die "Instagram API mit Instagram-Login"
 * (graph.instagram.com). Benötigte Berechtigungen:
 *   - instagram_business_basic
 *   - instagram_business_manage_comments  (Kommentare lesen/beantworten, Private Replies)
 *   - instagram_business_manage_messages  (Direktnachrichten)
 */

// Fehlercodes der Graph API, bei denen sich ein erneuter Versuch lohnt
// (Rate-Limits, temporäre Störungen).
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613]);

class GraphApiError extends Error {
  constructor(message, { status = 0, code = null, subcode = null, transient = false, fbtraceId = null } = {}) {
    super(message);
    this.name = 'GraphApiError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.transient = transient;
    this.fbtraceId = fbtraceId;
  }

  toString() {
    const parts = [this.message];
    if (this.code !== null) parts.push(`Code ${this.code}${this.subcode ? `/${this.subcode}` : ''}`);
    if (this.status) parts.push(`HTTP ${this.status}`);
    return parts.join(' · ');
  }
}

class InstagramClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl     z. B. https://graph.instagram.com
   * @param {string} opts.version     z. B. v25.0
   * @param {() => string|null} opts.getToken  liefert den aktuellen Access Token
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({ baseUrl, version, getToken, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    this.baseUrl = baseUrl;
    this.version = version;
    this.getToken = getToken;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, { query = {}, json, token, versioned = true } = {}) {
    const accessToken = token ?? this.getToken();
    if (!accessToken) {
      throw new GraphApiError('Kein Instagram Access Token hinterlegt. Bitte in den Einstellungen eintragen.');
    }

    const prefix = versioned ? `/${this.version}` : '';
    const url = new URL(`${this.baseUrl}${prefix}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('access_token', accessToken);

    const init = { method, headers: {}, signal: AbortSignal.timeout(this.timeoutMs) };
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    }

    let res;
    try {
      res = await this.fetch(url, init);
    } catch (err) {
      // Netzwerkfehler / Timeout -> später nochmal versuchen
      throw new GraphApiError(`Netzwerkfehler: ${err.message}`, { transient: true });
    }

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!res.ok || (body && body.error)) {
      const e = (body && body.error) || {};
      const code = typeof e.code === 'number' ? e.code : null;
      const transient = res.status >= 500 || res.status === 429 || e.is_transient === true || TRANSIENT_CODES.has(code);
      throw new GraphApiError(e.error_user_msg || e.message || `HTTP ${res.status}`, {
        status: res.status,
        code,
        subcode: e.error_subcode ?? null,
        transient,
        fbtraceId: e.fbtrace_id ?? null,
      });
    }
    return body;
  }

  /** Infos zum verbundenen Instagram-Konto. */
  getMe(token) {
    return this.request('GET', '/me', {
      query: { fields: 'id,user_id,username,name,account_type,profile_picture_url' },
      token,
    });
  }

  /** Die letzten Beiträge des Kontos (für die Auswahl in einer Automation). */
  async listMedia(limit = 30) {
    const body = await this.request('GET', '/me/media', {
      query: {
        fields: 'id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count',
        limit,
      },
    });
    return body?.data ?? [];
  }

  /** Kommentare (inkl. Antworten im Thread) eines Beitrags – für den Abfrage-Modus. */
  async listComments(mediaId, limit = 50) {
    const fields = 'id,text,timestamp,username,from,parent_id';
    const body = await this.request('GET', `/${encodeURIComponent(mediaId)}/comments`, {
      query: { fields: `${fields},replies.limit(50){${fields}}`, limit },
    });
    return body?.data ?? [];
  }

  /** Öffentliche Antwort unter einen Kommentar. */
  replyToComment(commentId, message) {
    return this.request('POST', `/${encodeURIComponent(commentId)}/replies`, { query: { message } });
  }

  /**
   * Private Antwort (DM) an die Person, die kommentiert hat.
   * Pro Kommentar ist nur EINE private Antwort möglich, innerhalb von 7 Tagen.
   */
  sendPrivateReply(commentId, { text, button }) {
    const message = button
      ? {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'button',
              text,
              buttons: [{ type: 'web_url', url: button.url, title: button.title }],
            },
          },
        }
      : { text };
    return this.request('POST', '/me/messages', {
      json: { recipient: { comment_id: commentId }, message },
    });
  }

  /** Abonniert die Kommentar-Webhooks für das verbundene Konto. */
  subscribeWebhooks(fields = ['comments']) {
    return this.request('POST', '/me/subscribed_apps', { query: { subscribed_fields: fields.join(',') } });
  }

  /** Verlängert einen Long-Lived Token um weitere 60 Tage. */
  refreshToken() {
    return this.request('GET', '/refresh_access_token', {
      query: { grant_type: 'ig_refresh_token' },
      versioned: false,
    });
  }
}

module.exports = { InstagramClient, GraphApiError };
