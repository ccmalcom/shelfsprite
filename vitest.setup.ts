/**
 * Server-suite default posture: the deliberate local single-user mode.
 *
 * lib/server/authMode.ts refuses to infer local mode from absent Supabase variables — that
 * inference is exactly the SEC-01 hole where a misconfigured production deploy served anonymous
 * requests as the local administrator. Tests that want local mode must therefore ask for it, the
 * same as a developer would. Set with `??=` so a test file that pins the flag (auth.test.ts
 * deletes it to prove the fail-closed path) still wins.
 */
process.env.ALLOW_LOCAL_AUTH ??= 'true';
