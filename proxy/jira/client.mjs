import { ApiError, ERROR_CODES } from '../../shared/contracts.mjs';
import { validateJiraUrl } from '../../shared/jira-url.mjs';

/**
 * Jira Cloud read-only client (architecture 6.1, 6.2).
 *
 * There is no generic request function in the public surface: one function per allowed endpoint.
 * Every request goes through the injected `fetchImpl`, which in production is the guarded fetch
 * (egress allowlist). The Basic credential is built here from the configured email and
 * `secrets.getJiraToken()`; it never appears in errors, details or logs (this module never logs).
 *
 * Ported from the reference (its Jira proxy script): the
 * `nextPageToken` walk (`buscarIssues`) and the TTL metadata cache (`createFieldMetadataCache`).
 * Not ported: header-supplied credentials, 400 -> empty page, name-based detection, `total`.
 */

const DEFAULT_PAGE_SIZE = 100;
const METADATA_TTL_MS = 10 * 60 * 1000;
const BACKOFF_BASE_MS = 500;
const JITTER_MAX_MS = 250;
const MAX_DELAY_MS = 60 * 1000;
const MAX_DETAIL_CHARS = 300;

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const FIELD_NAME = /^[A-Za-z0-9_.*-]+$/;
const EXPAND_LIST = /^[A-Za-z0-9_.,]+$/;
const TLS_CODE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/i;

/** Spanish user messages per classified code. */
const MESSAGES = Object.freeze({
  [ERROR_CODES.UNREACHABLE]: 'No se pudo conectar con Jira. Revisá tu conexión y la URL configurada.',
  [ERROR_CODES.TLS]: 'No se pudo establecer una conexión segura (TLS) con Jira.',
  [ERROR_CODES.AUTH]: 'Jira rechazó las credenciales. Revisá el email y el token.',
  [ERROR_CODES.FORBIDDEN]: 'Tu usuario de Jira no tiene permiso para esta operación.',
  [ERROR_CODES.NOT_FOUND]: 'Jira no encontró el recurso pedido.',
  [ERROR_CODES.BAD_QUERY]: 'Jira rechazó la consulta (JQL o parámetros inválidos).',
  [ERROR_CODES.TIMEOUT]: 'Jira tardó demasiado en responder.',
  [ERROR_CODES.RATE_LIMIT]: 'Jira limitó las solicitudes (demasiadas peticiones). Reintentá en unos minutos.',
  [ERROR_CODES.SERVER_ERROR]: 'Jira devolvió un error de servidor. Reintentá más tarde.',
  [ERROR_CODES.UNKNOWN]: 'Ocurrió un error inesperado al consultar Jira.',
});

/** HTTP status the proxy answers with for each classified code. */
const HTTP_STATUS = Object.freeze({
  [ERROR_CODES.UNREACHABLE]: 502,
  [ERROR_CODES.TLS]: 502,
  [ERROR_CODES.AUTH]: 401,
  [ERROR_CODES.FORBIDDEN]: 403,
  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.BAD_QUERY]: 400,
  [ERROR_CODES.TIMEOUT]: 504,
  [ERROR_CODES.RATE_LIMIT]: 429,
  [ERROR_CODES.SERVER_ERROR]: 502,
  [ERROR_CODES.UNKNOWN]: 502,
});

/**
 * @param {string} code
 * @param {any} [details]
 */
function jiraError(code, details) {
  return new ApiError(HTTP_STATUS[code], code, MESSAGES[code], details);
}

/** @param {string} message */
const invalid = (message) => new ApiError(400, ERROR_CODES.VALIDATION_ERROR, message);

/** @param {number} status */
function classifyStatus(status) {
  if (status === 400) return ERROR_CODES.BAD_QUERY;
  if (status === 401) return ERROR_CODES.AUTH;
  if (status === 403) return ERROR_CODES.FORBIDDEN;
  if (status === 404) return ERROR_CODES.NOT_FOUND;
  if (status === 429) return ERROR_CODES.RATE_LIMIT;
  if (status >= 500) return ERROR_CODES.SERVER_ERROR;
  return ERROR_CODES.UNKNOWN;
}

/**
 * A short, safe summary of a Jira error body. Only `errorMessages` / `errors` values are read, so
 * no header or credential can end up in it.
 * @param {any} body
 * @returns {{ jira: string } | undefined}
 */
function summarizeBody(body) {
  const parts = [];
  if (Array.isArray(body?.errorMessages)) parts.push(...body.errorMessages);
  if (body?.errors && typeof body.errors === 'object') parts.push(...Object.values(body.errors));
  const text = parts.filter((p) => typeof p === 'string').join(' ').trim();
  return text ? { jira: text.slice(0, MAX_DETAIL_CHARS) } : undefined;
}

/**
 * Milliseconds to wait from a `Retry-After` header (delta-seconds or HTTP-date), or null.
 * @param {string | null} header
 * @param {number} nowMs
 */
function parseRetryAfter(header, nowMs) {
  if (!header) return null;
  const text = header.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/**
 * @param {unknown} error
 * @returns {ApiError}
 */
function classifyThrown(error) {
  if (error instanceof ApiError) return error; // e.g. EGRESS_BLOCKED from the guarded fetch
  const name = /** @type {any} */ (error)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return jiraError(ERROR_CODES.TIMEOUT);
  if (name === 'SyntaxError') return jiraError(ERROR_CODES.UNKNOWN); // 2xx with a non-JSON body
  const cause = /** @type {any} */ (error)?.cause;
  const codeText = String(cause?.code ?? /** @type {any} */ (error)?.code ?? '');
  if (TLS_CODE.test(codeText)) return jiraError(ERROR_CODES.TLS);
  return jiraError(ERROR_CODES.UNREACHABLE);
}

/** @param {unknown} key */
function requireIssueKey(key) {
  if (typeof key !== 'string' || !ISSUE_KEY.test(key)) throw invalid('Invalid issue key.');
  return key;
}

/**
 * @param {unknown} list
 * @param {string} what
 * @returns {string[]}
 */
function requireNames(list, what) {
  if (
    !Array.isArray(list) ||
    list.length === 0 ||
    !list.every((v) => typeof v === 'string' && FIELD_NAME.test(v))
  ) {
    throw invalid(`${what} must be a non-empty list of field names.`);
  }
  return list;
}

/** @param {unknown} expand */
function optionalExpand(expand) {
  if (expand === undefined || expand === null || expand === '') return undefined;
  if (typeof expand !== 'string' || !EXPAND_LIST.test(expand)) throw invalid('Invalid expand value.');
  return expand;
}

/**
 * @typedef {{ jira: { baseUrl: string, email: string, timeoutMs: number, maxRetries: number } }} JiraClientConfig
 *
 * @param {{
 *   getConfig: () => JiraClientConfig,
 *   secrets: { getJiraToken(): string | null | undefined },
 *   fetchImpl: typeof fetch & { forHost?: (host: string) => typeof fetch },
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   random?: () => number,
 * }} deps `now` is epoch milliseconds; `random` supplies the backoff jitter in [0, 1).
 */
export function createJiraClient({
  getConfig,
  secrets,
  fetchImpl,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
}) {
  /** @type {Map<string, { promise: Promise<any>, expiresAt: number }>} */
  const metadata = new Map();

  /** @returns {{ origin: string, host: string, email: string, token: string, timeoutMs: number, maxRetries: number }} */
  function configured() {
    const { jira } = getConfig();
    const url = validateJiraUrl(jira.baseUrl);
    if (!url.ok) {
      throw new ApiError(
        409,
        ERROR_CODES.JIRA_NOT_CONFIGURED,
        'Todavía no hay una URL de Jira válida configurada.',
      );
    }
    const token = secrets.getJiraToken();
    if (!jira.email || !token) {
      throw jiraError(ERROR_CODES.AUTH, { reason: 'missing-credentials' });
    }
    return {
      origin: url.origin,
      host: url.host,
      email: jira.email,
      token,
      timeoutMs: jira.timeoutMs,
      maxRetries: jira.maxRetries,
    };
  }

  /**
   * The single network primitive; private to this module. `path` is always a literal built by an
   * endpoint function below. `anonymousBaseUrl` is only for `serverInfo` against a candidate URL:
   * no credential is sent and the fetch is limited to that one host.
   *
   * @param {{ method?: 'GET' | 'POST', path: string, query?: Record<string, string | number | undefined>, body?: any, anonymousBaseUrl?: string }} req
   */
  async function request({ method = 'GET', path, query, body, anonymousBaseUrl }) {
    /** @type {string} */ let origin;
    /** @type {typeof fetch} */ let send;
    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json' };
    let timeoutMs;
    let maxRetries;
    if (anonymousBaseUrl !== undefined) {
      const url = validateJiraUrl(anonymousBaseUrl);
      if (!url.ok) throw invalid('Invalid Jira URL.');
      origin = url.origin;
      send = fetchImpl.forHost ? fetchImpl.forHost(url.host) : fetchImpl;
      ({ timeoutMs, maxRetries } = getConfig().jira);
    } else {
      const cfg = configured();
      origin = cfg.origin;
      send = fetchImpl;
      headers.Authorization = `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}`;
      ({ timeoutMs, maxRetries } = cfg);
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const url = new URL(path, origin);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
    }

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      /** @type {Response} */ let response;
      /** @type {any} */ let payload = null;
      try {
        response = await send(url.toString(), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) {
          payload = await response.json();
        } else {
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
        }
      } catch (error) {
        throw classifyThrown(error);
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) return payload;

      const code = classifyStatus(response.status);
      const retryable = code === ERROR_CODES.RATE_LIMIT || code === ERROR_CODES.SERVER_ERROR;
      if (!retryable || attempt >= maxRetries) {
        throw jiraError(code, summarizeBody(payload));
      }
      const wait =
        parseRetryAfter(response.headers.get('Retry-After'), now()) ??
        BACKOFF_BASE_MS * 2 ** attempt + random() * JITTER_MAX_MS;
      await sleep(Math.min(wait, MAX_DELAY_MS));
    }
  }

  /**
   * TTL cache with single-flight; a failed lookup is evicted so the next call retries.
   * @param {string} kind
   * @param {() => Promise<any>} load
   */
  function cached(kind, load) {
    const { jira } = getConfig();
    const key = `${jira.baseUrl}|${jira.email}|${kind}`;
    const hit = metadata.get(key);
    if (hit && hit.expiresAt > now()) return hit.promise;
    const promise = load();
    metadata.set(key, { promise, expiresAt: now() + METADATA_TTL_MS });
    promise.catch(() => {
      if (metadata.get(key)?.promise === promise) metadata.delete(key);
    });
    return promise;
  }

  /**
   * Walks `/search/jql` page by page. Termination is driven only by Jira's cursor: no token, an
   * empty page or `isLast`. A short page never ends the walk (Jira serves fewer rows than
   * `maxResults` when many fields are requested). A repeated token is an error: stopping there
   * would silently truncate the result.
   * Results are eventually consistent and there is no total.
   *
   * @param {{ jql: string, fields: string[], expand?: string, maxResults?: number }} query
   * @returns {AsyncGenerator<any[]>}
   */
  async function* searchJqlPages({ jql, fields, expand, maxResults = DEFAULT_PAGE_SIZE }) {
    if (typeof jql !== 'string' || jql.trim() === '') throw invalid('JQL must be a non-empty string.');
    const names = requireNames(fields, 'fields');
    const expandList = optionalExpand(expand);
    const size = Number.isInteger(maxResults) && maxResults > 0 ? maxResults : DEFAULT_PAGE_SIZE;
    const seen = new Set();
    let nextPageToken;
    while (true) {
      const page = await request({
        method: 'POST',
        path: '/rest/api/3/search/jql',
        body: {
          jql,
          fields: names,
          maxResults: size,
          ...(expandList ? { expand: expandList } : {}),
          ...(nextPageToken ? { nextPageToken } : {}),
        },
      });
      const issues = Array.isArray(page?.issues) ? page.issues : [];
      if (issues.length === 0) return;
      yield issues;
      const token = typeof page.nextPageToken === 'string' ? page.nextPageToken.trim() : '';
      if (page.isLast === true || !token) return;
      if (seen.has(token)) {
        throw jiraError(ERROR_CODES.UNKNOWN, { reason: 'repeated-page-token' });
      }
      seen.add(token);
      nextPageToken = token;
    }
  }

  return {
    /**
     * `baseUrl` targets a candidate Jira URL (the verify flow): anonymous and one-host only.
     * Without it, the configured Jira is used.
     * @param {{ baseUrl?: string }} [options]
     */
    serverInfo: ({ baseUrl } = {}) =>
      request({ path: '/rest/api/3/serverInfo', anonymousBaseUrl: baseUrl }),

    myself: () => request({ path: '/rest/api/3/myself' }),

    searchJqlPages,

    /** @param {{ jql: string, fields: string[], expand?: string, maxResults?: number }} query */
    async searchJql(query) {
      const issues = [];
      for await (const page of searchJqlPages(query)) issues.push(...page);
      return issues;
    },

    fields: async () => cached('field', () => request({ path: '/rest/api/3/field' })),
    statuses: async () => cached('status', () => request({ path: '/rest/api/3/status' })),
    issueTypes: async () => cached('issuetype', () => request({ path: '/rest/api/3/issuetype' })),
    clearMetadataCache: () => metadata.clear(),

    /**
     * @param {string} key
     * @param {{ fields?: string[], expand?: string }} [options]
     */
    async issue(key, { fields, expand } = {}) {
      requireIssueKey(key);
      const names = fields === undefined ? undefined : requireNames(fields, 'fields');
      return request({
        path: `/rest/api/3/issue/${encodeURIComponent(key)}`,
        query: { fields: names?.join(','), expand: optionalExpand(expand) },
      });
    },

    /** @param {string} key */
    async issueChangelog(key) {
      requireIssueKey(key);
      const entries = [];
      let startAt = 0;
      while (true) {
        const page = await request({
          path: `/rest/api/3/issue/${encodeURIComponent(key)}/changelog`,
          query: { startAt, maxResults: DEFAULT_PAGE_SIZE },
        });
        const values = Array.isArray(page?.values) ? page.values : [];
        entries.push(...values);
        startAt += values.length;
        const total = Number.isInteger(page?.total) ? page.total : null;
        if (values.length === 0 || page?.isLast === true || (total !== null && startAt >= total)) {
          return entries;
        }
      }
    },

    /** @param {string} query */
    async userSearch(query) {
      if (typeof query !== 'string' || query.trim() === '') throw invalid('Query must be a non-empty string.');
      return request({ path: '/rest/api/3/user/search', query: { query, maxResults: 50 } });
    },

    /** @param {string} accountId */
    async user(accountId) {
      if (typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId)) throw invalid('Invalid accountId.');
      return request({ path: '/rest/api/3/user', query: { accountId } });
    },
  };
}
