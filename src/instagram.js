'use strict';

/**
 * Schlanker Client für die Instagram-APIs von Meta. Unterstützt zwei Varianten:
 *
 * 1. "instagram" – Instagram API mit Instagram-Login (ältere Apps)
 *    Host graph.instagram.com, Token beginnt mit "IG…", Endpunkte über /me.
 *    Berechtigungen: instagram_business_basic, instagram_business_manage_comments,
 *    instagram_business_manage_messages
 *
 * 2. "facebook" – "API setup with Unified login" (neue Apps seit Ende Oktober 2026)
 *    bzw. Facebook-Login. Host graph.facebook.com, meist ein System-User-Token ("EAA…"),
 *    Endpunkte über die Instagram-Konto-ID.
 *    Berechtigungen: instagram_basic, instagram_manage_comments, instagram_manage_messages,
 *    business_management
 *
 * Welche Variante gilt, wird beim Speichern des Tokens automatisch erkannt.
 */

// Fehlercodes der Graph API, bei denen sich ein erneuter Versuch lohnt
// (Rate-Limits, temporäre Störungen).
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 368, 613]);

const IG_USER_FIELDS = 'id,username,name,profile_picture_url';

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

/** Erkennt anhand des Tokens, welche API-Variante gilt. */
function detectMode(token) {
  return /^IG/.test(String(token || '').trim()) ? 'instagram' : 'facebook';
}

class InstagramClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl          Host für Instagram-Login, z. B. https://graph.instagram.com
   * @param {string} opts.facebookBaseUrl  Host für Unified/Facebook-Login, z. B. https://graph.facebook.com
   * @param {string} opts.version          z. B. v25.0
   * @param {() => string|null} opts.getToken      aktueller Access Token
   * @param {() => string|null} [opts.getMode]     "instagram" oder "facebook"
   * @param {() => string|null} [opts.getAccountId] Instagram-Konto-ID (für "facebook")
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({
    baseUrl = 'https://graph.instagram.com',
    facebookBaseUrl = 'https://graph.facebook.com',
    version,
    getToken,
    getMode = () => null,
    getAccountId = () => null,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15000,
  }) {
    this.baseUrl = baseUrl;
    this.facebookBaseUrl = facebookBaseUrl;
    this.version = version;
    this.getToken = getToken;
    this.getMode = getMode;
    this.getAccountId = getAccountId;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  mode() {
    return this.getMode() || detectMode(this.getToken());
  }

  /** Pfad-Präfix für Konto-Endpunkte: "/me" bzw. "/<Instagram-Konto-ID>". */
  accountPath() {
    if (this.mode() === 'instagram') return '/me';
    const id = this.getAccountId();
    if (!id) throw new GraphApiError('Instagram-Konto-ID fehlt. Bitte Token in den Einstellungen neu speichern.');
    return `/${encodeURIComponent(id)}`;
  }

  async request(method, path, { query = {}, json, token, mode, versioned = true, noToken = false } = {}) {
    const accessToken = noToken ? null : token ?? this.getToken();
    if (!noToken && !accessToken) {
      throw new GraphApiError('Kein Instagram Access Token hinterlegt. Bitte in den Einstellungen eintragen.');
    }

    const base = (mode ?? this.mode()) === 'instagram' ? this.baseUrl : this.facebookBaseUrl;
    const prefix = versioned ? `/${this.version}` : '';
    const url = new URL(`${base}${prefix}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    if (accessToken) url.searchParams.set('access_token', accessToken);

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

  /**
   * Prüft einen Token und ermittelt das Instagram-Konto.
   * @returns {Promise<{mode, user_id, id, username, name, profile_picture_url}>}
   */
  async resolveAccount(token, accountId) {
    const mode = detectMode(token);

    if (mode === 'instagram') {
      const me = await this.request('GET', '/me', {
        query: { fields: 'id,user_id,username,name,account_type,profile_picture_url' },
        token,
        mode,
      });
      return { mode, ...me, user_id: me.user_id ?? me.id };
    }

    // Unified login / Facebook-Login
    // Ungültiger Token (Code 190) oder Netzwerkprobleme sofort melden; andere Fehler
    // (z. B. fehlende Berechtigung für diesen Suchweg) nur überspringen.
    const tolerate = (err) => {
      if (err.code === 190 || err.transient || err.code === null) throw err;
      return null;
    };
    let id = accountId ? String(accountId).trim() : null;
    if (!id) {
      const assigned = await this.request('GET', '/me/assigned_instagram_accounts', {
        query: { fields: 'id,username' },
        token,
        mode,
      }).catch(tolerate);
      id = assigned?.data?.[0]?.id ?? null;
    }
    if (!id) {
      const pages = await this.request('GET', '/me/accounts', {
        query: { fields: 'instagram_business_account{id}' },
        token,
        mode,
      }).catch(tolerate);
      id = pages?.data?.find((p) => p.instagram_business_account)?.instagram_business_account.id ?? null;
    }
    if (!id) {
      throw new GraphApiError(
        'Instagram-Konto nicht automatisch gefunden. Bitte zusätzlich die Instagram-Konto-ID eintragen ' +
          '(steht im Meta-Portal bei „API setup with Unified login“ bzw. in den Unternehmenseinstellungen unter Instagram-Konten).',
      );
    }
    const account = await this.request('GET', `/${encodeURIComponent(id)}`, { query: { fields: IG_USER_FIELDS }, token, mode });
    return { mode, ...account, user_id: account.id };
  }

  /** Die letzten Beiträge des Kontos (für die Auswahl in einer Automation). */
  async listMedia(limit = 30) {
    const body = await this.request('GET', `${this.accountPath()}/media`, {
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
    return this.request('POST', `${this.accountPath()}/messages`, {
      json: { recipient: { comment_id: commentId }, message },
    });
  }

  /** Abonniert die Kommentar-Webhooks für das verbundene Konto. */
  subscribeWebhooks(fields = ['comments']) {
    return this.request('POST', `${this.accountPath()}/subscribed_apps`, {
      query: { subscribed_fields: fields.join(',') },
    });
  }

  /** Tauscht den Code aus der Meta-Anmeldung (Unified login) gegen einen Token. */
  exchangeCode({ appId, appSecret, redirectUri, code }) {
    return this.request('GET', '/oauth/access_token', {
      query: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
      mode: 'facebook',
      noToken: true,
    });
  }

  /** Verlängert einen Long-Lived Token um weitere 60 Tage (nur Instagram-Login). */
  refreshToken() {
    if (this.mode() !== 'instagram') {
      throw new GraphApiError('Dieser Token (Unified/Facebook-Login) muss nicht verlängert werden.');
    }
    return this.request('GET', '/refresh_access_token', {
      query: { grant_type: 'ig_refresh_token' },
      versioned: false,
    });
  }
}

module.exports = { InstagramClient, GraphApiError, detectMode };
