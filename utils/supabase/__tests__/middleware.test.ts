const getUser = jest.fn();

jest.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, _opts: unknown) => ({
    auth: { getUser: () => getUser() },
  }),
}));

/**
 * middleware.ts reads process.env at module load, so each case must set env first and then
 * import the module fresh. A static import at the top of this file would pin one configuration
 * for every test.
 */
async function load(env: Record<string, string | undefined>) {
  jest.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import('../middleware');
  const { NextRequest } = await import('next/server');
  return {
    run: (path: string) =>
      mod.updateSession(new NextRequest(new Request(`https://shelfsprite.app${path}`))),
  };
}

const HOSTED = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk_test',
};
const LOCAL = {
  NEXT_PUBLIC_SUPABASE_URL: undefined,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
};

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  getUser.mockReset();
});

function signedOut() {
  getUser.mockResolvedValue({ data: { user: null } });
}
function signedIn() {
  getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
}

describe('updateSession — signed out', () => {
  it('rewrites / to /welcome instead of redirecting', async () => {
    signedOut();
    const { run } = await load(HOSTED);
    const res = await run('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toContain('/welcome');
  });

  it('still redirects every other page to /login', async () => {
    signedOut();
    const { run } = await load(HOSTED);
    for (const path of ['/library', '/profile', '/settings', '/admin']) {
      const res = await run(path);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://shelfsprite.app/login');
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    }
  });

  it('lets /welcome through untouched', async () => {
    signedOut();
    const { run } = await load(HOSTED);
    const res = await run('/welcome');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('lets /login and /auth through untouched', async () => {
    signedOut();
    const { run } = await load(HOSTED);
    for (const path of ['/login', '/auth/callback']) {
      const res = await run(path);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    }
  });

  it('rewrites only an exact /, not a path that merely starts with it', async () => {
    signedOut();
    const { run } = await load(HOSTED);
    const res = await run('/library/1');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.status).toBe(307);
  });
});

describe('updateSession — signed in', () => {
  it('serves / from the dashboard: no rewrite, no redirect', async () => {
    signedIn();
    const { run } = await load(HOSTED);
    const res = await run('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
  });

  it('still bounces /login to /', async () => {
    signedIn();
    const { run } = await load(HOSTED);
    const res = await run('/login');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://shelfsprite.app/');
  });
});

describe('updateSession — local mode (no Supabase env)', () => {
  it('never rewrites and never redirects', async () => {
    const { run } = await load(LOCAL);
    for (const path of ['/', '/welcome', '/library', '/login']) {
      const res = await run(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    }
    expect(getUser).not.toHaveBeenCalled();
  });
});
