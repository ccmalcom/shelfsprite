'use client';

import { useState } from 'react';
import { getSupabaseClient } from '@/utils/supabase/client';
import { Field, Input, Button } from '@/components/ui';
import EntryFrame from '@/components/EntryFrame';
import InviteHashRedirect from '@/components/InviteHashRedirect';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const supabase = getSupabaseClient();
    if (!supabase) {
      setError('Auth is not configured (no Supabase env).');
      return;
    }
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    window.location.assign('/');
  }

  return (
    <EntryFrame>
      <InviteHashRedirect />
      <div>
        <p className="eyebrow mb-3">Your reading room</p>
        <h1 className="mb-6 font-display text-3xl font-bold tracking-tight text-text">
          Welcome back
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Email">
            {(p) => (
              <Input
                {...p}
                type="email"
                required
                autoFocus
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            )}
          </Field>
          <Field label="Password">
            {(p) => (
              <Input
                {...p}
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" loading={loading} className="w-full">
            {loading ? 'Signing in\u2026' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-4 text-center font-mono text-xs text-muted">
          Invite-only.{' '}
          <a href="/welcome#join" className="text-accent underline underline-offset-4">
            Ask for an invite
          </a>
          .
        </p>
      </div>
    </EntryFrame>
  );
}
