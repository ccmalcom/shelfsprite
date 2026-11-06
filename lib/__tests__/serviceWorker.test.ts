import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// Runs public/sw.js in a sandbox with a fake Cache Storage and fetch, and pins the one property
// that matters most: signed-in data is never stored, and only hashed build output is cached.

const ORIGIN = 'https://shelfsprite.app';
const SOURCE = readFileSync(join(__dirname, '../../public/sw.js'), 'utf8');

type Listener = (event: Record<string, unknown>) => void;

class FakeCache {
  entries = new Map<string, Response>();
  async match(request: { url: string } | string) {
    const key = typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
    return this.entries.get(key)?.clone();
  }
  async put(request: { url: string }, response: Response) {
    this.entries.set(request.url, response);
  }
  async addAll(requests: { url: string }[]) {
    for (const request of requests) {
      this.entries.set(request.url, new Response(`precached ${request.url}`, { status: 200 }));
    }
  }
}

class FakeCaches {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
  async match(request: { url: string } | string, options?: { cacheName?: string }) {
    const names = options?.cacheName ? [options.cacheName] : [...this.stores.keys()];
    for (const name of names) {
      const hit = await this.stores.get(name)?.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
  totalEntries() {
    return [...this.stores.values()].reduce((n, store) => n + store.entries.size, 0);
  }
}

class FakeRequest {
  url: string;
  method: string;
  mode: string;
  headers: Headers;
  cache?: string;
  constructor(
    url: string,
    init: { method?: string; mode?: string; headers?: Record<string, string>; cache?: string } = {}
  ) {
    this.url = new URL(url, ORIGIN).href;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'cors';
    this.headers = new Headers(init.headers);
    this.cache = init.cache;
  }
}

function loadWorker(fetchImpl: jest.Mock = jest.fn()) {
  const listeners: Record<string, Listener> = {};
  const caches = new FakeCaches();
  const self = {
    location: new URL(`${ORIGIN}/sw.js?v=build-2`),
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener;
    },
    skipWaiting: jest.fn(async () => undefined),
    clients: { claim: jest.fn(async () => undefined) },
    registration: { navigationPreload: { enable: jest.fn(async () => undefined) } },
  };
  vm.runInNewContext(SOURCE, {
    self,
    caches,
    fetch: fetchImpl,
    Request: FakeRequest,
    URL,
    Set,
    Promise,
    console,
  });

  async function dispatchFetch(request: FakeRequest, preloadResponse?: Promise<unknown>) {
    let responded: Promise<Response> | undefined;
    listeners.fetch({
      request,
      preloadResponse: preloadResponse ?? Promise.resolve(undefined),
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });
    return responded;
  }

  async function dispatchLifecycle(type: 'install' | 'activate') {
    let pending: Promise<unknown> = Promise.resolve();
    listeners[type]({
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
    });
    await pending;
  }

  return { self, caches, fetchImpl, dispatchFetch, dispatchLifecycle };
}

const ok = (body = 'ok', headers: Record<string, string> = {}) => {
  const response = new Response(body, { status: 200, headers });
  // Node's Response reports type 'default'; a same-origin browser fetch reports 'basic'.
  Object.defineProperty(response, 'type', { value: 'basic' });
  return response;
};

describe('service worker', () => {
  it('precaches only the offline page and icons, under a versioned cache, and activates at once', async () => {
    const sw = loadWorker();
    await sw.dispatchLifecycle('install');

    expect([...sw.caches.stores.keys()]).toEqual(['shelfsprite-shell-build-2']);
    const precached = [...sw.caches.stores.get('shelfsprite-shell-build-2')!.entries.keys()];
    expect(precached).toEqual([
      `${ORIGIN}/offline.html`,
      `${ORIGIN}/icons/icon-192.png`,
      `${ORIGIN}/icons/icon-512.png`,
      `${ORIGIN}/icons/maskable-192.png`,
      `${ORIGIN}/icons/maskable-512.png`,
    ]);
    expect(sw.self.skipWaiting).toHaveBeenCalled();
  });

  it("deletes earlier deploys' caches on activation and leaves other caches alone", async () => {
    const sw = loadWorker();
    await sw.caches.open('shelfsprite-static-build-1');
    await sw.caches.open('shelfsprite-shell-build-1');
    await sw.caches.open('someone-elses-cache');
    await sw.dispatchLifecycle('install');
    await sw.caches.open('shelfsprite-static-build-2');

    await sw.dispatchLifecycle('activate');

    expect((await sw.caches.keys()).sort()).toEqual([
      'shelfsprite-shell-build-2',
      'shelfsprite-static-build-2',
      'someone-elses-cache',
    ]);
    expect(sw.self.clients.claim).toHaveBeenCalled();
    expect(sw.self.registration.navigationPreload.enable).toHaveBeenCalled();
  });

  it.each([
    ['an API read', new FakeRequest('/api/books')],
    ['the auth callback', new FakeRequest('/auth/callback?code=x', { mode: 'navigate' })],
    ['a POST', new FakeRequest('/library', { method: 'POST' })],
    ['a Supabase call', new FakeRequest('https://abc.supabase.co/auth/v1/user')],
    [
      'a request carrying a bearer token',
      new FakeRequest('/library', { headers: { authorization: 'Bearer t' } }),
    ],
    ['an RSC payload', new FakeRequest('/library?_rsc=1a2b', { headers: { rsc: '1' } })],
    ['an optimized cover image', new FakeRequest('/_next/image?url=x&w=256&q=75')],
    ['the manifest', new FakeRequest('/manifest.webmanifest')],
  ])('leaves %s entirely to the network', async (_label, request) => {
    const sw = loadWorker();
    expect(await sw.dispatchFetch(request)).toBeUndefined();
    expect(sw.fetchImpl).not.toHaveBeenCalled();
  });

  it('passes page navigations through from the network and never stores them', async () => {
    const page = ok('<html>signed-in library</html>', { 'content-type': 'text/html' });
    const sw = loadWorker(jest.fn(async () => page));
    await sw.dispatchLifecycle('install');
    const before = sw.caches.totalEntries();

    const response = await sw.dispatchFetch(new FakeRequest('/library', { mode: 'navigate' }));

    expect(await response!.text()).toBe('<html>signed-in library</html>');
    expect(sw.caches.totalEntries()).toBe(before);
  });

  it('uses the navigation preload response when the browser started one', async () => {
    const sw = loadWorker();
    const response = await sw.dispatchFetch(
      new FakeRequest('/library', { mode: 'navigate' }),
      Promise.resolve(ok('preloaded'))
    );
    expect(await response!.text()).toBe('preloaded');
    expect(sw.fetchImpl).not.toHaveBeenCalled();
  });

  it('shows the offline page when a navigation cannot reach the network', async () => {
    const sw = loadWorker(jest.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await sw.dispatchLifecycle('install');

    const response = await sw.dispatchFetch(new FakeRequest('/library', { mode: 'navigate' }));

    expect(await response!.text()).toBe(`precached ${ORIGIN}/offline.html`);
  });

  it('returns a server error page as-is rather than the offline page', async () => {
    const sw = loadWorker(jest.fn(async () => new Response('down', { status: 503 })));
    await sw.dispatchLifecycle('install');
    const response = await sw.dispatchFetch(new FakeRequest('/library', { mode: 'navigate' }));
    expect(response!.status).toBe(503);
  });

  it('caches hashed build output on first use and serves it from the cache afterwards', async () => {
    const sw = loadWorker(
      jest.fn(async () => ok('chunk', { 'cache-control': 'public, max-age=31536000, immutable' }))
    );
    const chunk = () => new FakeRequest('/_next/static/chunks/app-3f9a.js');

    expect(await (await sw.dispatchFetch(chunk()))!.text()).toBe('chunk');
    expect(await (await sw.dispatchFetch(chunk()))!.text()).toBe('chunk');

    expect(sw.fetchImpl).toHaveBeenCalledTimes(1);
    expect([...sw.caches.stores.keys()]).toEqual(['shelfsprite-static-build-2']);
  });

  it.each([
    ['marked no-store', ok('x', { 'cache-control': 'no-store' })],
    ['marked private', ok('x', { 'cache-control': 'private, max-age=60' })],
    ['an error', new Response('missing', { status: 404 })],
  ])('does not store a build asset response %s', async (_label, response) => {
    const sw = loadWorker(jest.fn(async () => response));
    await sw.dispatchFetch(new FakeRequest('/_next/static/chunks/app-3f9a.js'));
    expect(sw.caches.totalEntries()).toBe(0);
  });
});
