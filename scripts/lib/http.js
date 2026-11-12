// Thin wrapper around the built-in fetch: explicit User-Agent, timeout,
// and an error that carries the HTTP status so stats stay readable.

import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

// Node's default happy-eyeballs attempt timeout (250 ms) is too short for
// slow routes (seen with core.telegram.org): the IPv4 connect is abandoned
// before it completes even though curl succeeds.
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const DEFAULT_TIMEOUT_MS = 60_000;

let userAgent = 'tech-scout/1.0';

export function setUserAgent(ua) {
  userAgent = ua;
}

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

const MAX_RETRY_WAIT_MS = 30_000;

// One retry on network errors, timeouts, 429 and 5xx. 4xx other than 429
// (e.g. Reddit's 403 for datacenter IPs) fails immediately.
export async function get(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, method = 'GET', body } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': userAgent, ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(2000);
      continue;
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= retries) throw new HttpError(res.status, url);
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    await sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5000, MAX_RETRY_WAIT_MS));
  }
}

export async function getJson(url, opts) {
  return (await get(url, opts)).json();
}

export async function getText(url, opts) {
  return (await get(url, opts)).text();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
