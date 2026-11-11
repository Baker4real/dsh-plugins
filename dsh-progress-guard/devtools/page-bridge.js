import { randomUUID } from 'node:crypto';

export function canonicalPageUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('INVALID_PAGE_URL');
  const url = new URL(value);
  if (['app://./index.html', 'dsh-app://app/'].includes(value)) return value;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('INVALID_PAGE_URL');
  return url.origin + url.pathname;
}

export function pageIdentity(value) {
  if (!value || typeof value !== 'object') throw new Error('INVALID_PAGE_IDENTITY');
  const result = {};
  for (const key of ['pageId', 'documentId', 'graphRevision']) {
    if (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > 128 || !/^[A-Za-z0-9_.:-]+$/u.test(value[key])) throw new Error('INVALID_PAGE_IDENTITY');
    result[key] = value[key];
  }
  result.url = canonicalPageUrl(value.url);
  if (value.sessionId !== null && (typeof value.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value.sessionId))) throw new Error('INVALID_SESSION_ID');
  result.sessionId = value.sessionId;
  result.ready = value.ready === true;
  return result;
}

export function samePage(left, right) {
  return ['pageId', 'documentId', 'url', 'sessionId', 'graphRevision'].every(key => left[key] === right[key]);
}

// This channel carries one fixed operation. Inspect providers never enqueue it.
export class PageBridge {
  constructor({ timeoutMs = 15000, pollMs = 20000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.operations = new Map();
    this.waiters = new Map();
    this.disposed = false;
  }

  reload(rawTarget, options = {}) {
    return this.enqueue('reload', rawTarget, undefined, options);
  }

  click(rawTarget, element, options = {}) {
    if (typeof element?.selector !== 'string' || !element.selector.length || element.selector.length > 256 || typeof element.elementToken !== 'string' || !element.elementToken.length || element.elementToken.length > 4096) throw new Error('INVALID_CLICK_TARGET');
    return this.enqueue('click', rawTarget, { selector: element.selector, elementToken: element.elementToken }, options);
  }

  enqueue(action, rawTarget, element, { signal } = {}) {
    const target = pageIdentity(rawTarget);
    if (!target.sessionId || !target.ready) return Promise.resolve({ status: 'rejected', code: 'PAGE_NOT_READY' });
    if (this.disposed) return Promise.resolve({ status: 'rejected', code: 'DISPOSED' });
    if (this.connected === false) return Promise.resolve({ status: 'rejected', code: 'PAGE_CHANNEL_UNAVAILABLE' });
    if (signal?.aborted) return Promise.resolve({ status: 'rejected', code: 'CANCELLED' });
    if ([...this.operations.values()].some(op => op.target.pageId === target.pageId)) return Promise.resolve({ status: 'rejected', code: 'PAGE_BUSY' });
    if (this.operations.size >= 16) return Promise.resolve({ status: 'rejected', code: 'CAPACITY_REACHED' });
    const requestId = randomUUID();
    let finish;
    const promise = new Promise(resolve => { finish = resolve; });
    const op = { requestId, target, action, element, deadlineAt: Date.now() + this.timeoutMs, phase: 'queued', finish: value => {
      if (!this.operations.delete(requestId)) return;
      clearTimeout(op.timer);
      signal?.removeEventListener('abort', op.abort);
      finish(action === 'click' ? { ...value, mayHaveExecuted: value.status === 'clicked' || op.phase === 'acknowledged' } : value);
    } };
    op.abort = () => op.finish({ status: 'unverified', code: 'CANCELLED', requestId });
    op.timer = setTimeout(() => op.finish({ status: 'unverified', code: action === 'reload' ? 'RELOAD_NOT_CONFIRMED' : 'CLICK_NOT_CONFIRMED', requestId, phase: op.phase }), this.timeoutMs);
    this.operations.set(requestId, op);
    signal?.addEventListener('abort', op.abort, { once: true });
    const waiting = this.waiters.get(target.pageId);
    if (waiting) waiting.finish(samePage(waiting.page, target) && waiting.page.ready ? this.dispatch(waiting.page) : { action: null, retryAfterMs: 100 });
    return promise;
  }

  dispatch(page) {
    const op = [...this.operations.values()].find(item => item.target.pageId === page.pageId);
    if (!op) return { action: null };
    if (!samePage(op.target, page) || !page.ready) {
      op.finish({ status: 'rejected', code: 'PAGE_IDENTITY_CHANGED', requestId: op.requestId });
      return { action: null };
    }
    if (op.phase !== 'queued') return { action: null };
    op.phase = 'dispatched';
    return { action: op.action, requestId: op.requestId, target: op.target, ...(op.element ? { element: op.element } : {}) };
  }

  async poll(rawPage, { signal } = {}) {
    const page = pageIdentity(rawPage);
    if (this.disposed || signal?.aborted) return { action: null };
    if (!page.ready) return { action: null, retryAfterMs: 100 };
    const receipt = rawPage.receipt;
    const op = receipt && this.operations.get(receipt.requestId);
    if (op?.action === 'reload' && op.phase === 'acknowledged' && receipt.previousPageId === op.target.pageId && receipt.previousDocumentId === op.target.documentId && page.documentId !== op.target.documentId && page.pageId !== op.target.pageId && page.url === op.target.url && page.sessionId === op.target.sessionId && page.ready) {
      op.finish({ status: 'reloaded', requestId: op.requestId, page });
    }
    const action = this.dispatch(page);
    if (action.action) return action;
    this.waiters.get(page.pageId)?.finish({ action: null });
    if (this.waiters.size >= 32) return { action: null };
    return await new Promise(resolve => {
      const waiter = { page, finish: value => {
        if (this.waiters.get(page.pageId) !== waiter) return;
        this.waiters.delete(page.pageId);
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', waiter.abort);
        resolve(value);
      } };
      waiter.abort = () => waiter.finish({ action: null });
      waiter.timer = setTimeout(() => waiter.finish({ action: null }), this.pollMs);
      this.waiters.set(page.pageId, waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
    });
  }

  acknowledge({ requestId, page: rawPage, rejected = false, completed = false }) {
    const page = pageIdentity(rawPage);
    const op = this.operations.get(requestId);
    if (!op || !['dispatched', 'acknowledged'].includes(op.phase)) return { accepted: false, code: 'REQUEST_EXPIRED' };
    if (completed) {
      if (op.action !== 'click' || op.phase !== 'acknowledged' || !samePage(op.target, page) || !page.ready || rejected) {
        op.finish({ status: 'unverified', code: 'PAGE_OR_ELEMENT_CHANGED', requestId });
        return { accepted: false, code: 'PAGE_OR_ELEMENT_CHANGED' };
      }
      op.finish({ status: 'clicked', requestId, page });
      return { accepted: true, requestId };
    }
    if (op.phase !== 'dispatched') return { accepted: false, code: 'REQUEST_EXPIRED' };
    if (rejected || !samePage(op.target, page) || !page.ready) {
      op.finish({ status: 'rejected', code: 'PAGE_IDENTITY_CHANGED', requestId });
      return { accepted: false, code: 'PAGE_IDENTITY_CHANGED' };
    }
    op.phase = 'acknowledged';
    return { accepted: true, requestId, expiresAt: op.deadlineAt };
  }

  cancel(code) {
    for (const op of [...this.operations.values()]) op.finish({ status: 'unverified', code, requestId: op.requestId });
    for (const waiter of [...this.waiters.values()]) waiter.finish({ action: null });
  }

  dispose() {
    this.disposed = true;
    this.cancel('DISPOSED');
  }
}

function admittedRequestOrigin(request) {
  const url = new URL(request.url);
  if (url.origin !== 'http://dsh.internal') return url;
  // HostConnectionService preserves the admitted Host header while normalizing Request.url.
  const authority = request.headers.get('host');
  if (!authority || /[\s\\/?#@]/u.test(authority)) throw new Error('INVALID_REQUEST_AUTHORITY');
  const origin = request.headers.get('origin');
  if (origin !== null) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('INVALID_REQUEST_ORIGIN');
    const host = new URL(`${parsed.protocol}//${authority}`);
    if (parsed.host !== host.host) throw new Error('INVALID_REQUEST_ORIGIN');
    return parsed;
  }
  return new URL(`http://${authority}`);
}

export function registerPageRoutes(connection, bridge, { desktopForwarding = false } = {}) {
  if (typeof connection?.fetch?.register !== 'function') throw new Error('AUTHENTICATED_FETCH_UNAVAILABLE');
  const disposers = ['poll', 'ack'].map(operation => connection.fetch.register({
    path: `/api/dsh-devtools/page/${operation}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const raw = await request.text();
        if (raw.length > 8192) return Response.json({ code: 'INVALID_PAGE_REQUEST' }, { status: 413 });
        const input = JSON.parse(raw);
        const identity = pageIdentity(operation === 'poll' ? input : input.page);
        const requestUrl = admittedRequestOrigin(request);
        const sameOrigin = /^https?:\/\//u.test(identity.url) && new URL(identity.url).origin === requestUrl.origin;
        // Desktop's authenticated forwarder rewrites its exact app origin to loopback HTTP and strips Origin.
        const forwardedDesktop = desktopForwarding && identity.url === 'dsh-app://app/' && requestUrl.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(requestUrl.hostname) && request.headers.get('origin') === null;
        if (!sameOrigin && !forwardedDesktop) return Response.json({ code: 'PAGE_ORIGIN_MISMATCH' }, { status: 400 });
        const result = operation === 'poll' ? await bridge.poll(input, { signal: request.signal }) : bridge.acknowledge(input);
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch {
        return Response.json({ code: 'INVALID_PAGE_REQUEST' }, { status: 400 });
      }
    },
  }));
  bridge.connected = true;
  return async () => { bridge.connected = false; bridge.cancel('CHANNEL_DISCONNECTED'); await Promise.all(disposers.map(dispose => dispose())); };
}
