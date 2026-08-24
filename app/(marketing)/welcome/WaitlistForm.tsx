'use client';

import { useState } from 'react';
import { Button, Field, Input } from '@/components/ui';

type State = 'idle' | 'submitting' | 'success' | 'error';

/**
 * Calls fetch('/api/invite-requests') directly rather than going through lib/api.ts. The API
 * client attaches a Supabase session token to every request, which would pull the Supabase
 * browser client into a bundle whose entire audience is signed out.
 *
 * The endpoint answers 200 {"ok": true} for a new email, a duplicate, and a honeypot alike, so
 * there is nothing here to branch on. Only 422 and 429 are distinguishable, on purpose.
 */
export default function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState('submitting');
    setMessage('');
    try {
      const res = await fetch('/api/invite-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, website }),
      });
      if (res.ok) {
        setState('success');
        return;
      }
      setState('error');
      if (res.status === 422) setMessage('That does not look like an email address.');
      else if (res.status === 429) setMessage('Too many requests from here. Try again in an hour.');
      else setMessage('Something went wrong on our end. Try again in a minute.');
    } catch {
      setState('error');
      setMessage('Could not reach the server. Check your connection and try again.');
    }
  }

  // Success replaces the form rather than sitting above it, so nobody submits twice.
  if (state === 'success') {
    return (
      <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text">
        You are on the list. I will email you when there is a spot.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-md flex-col gap-3">
      <Field label="Email" error={state === 'error' ? message : undefined}>
        {(p) => (
          <Input
            {...p}
            type="email"
            name="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            disabled={state === 'submitting'}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </Field>

      {/* Honeypot. Real users never see or tab to this; anything in it means a bot. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input
          id="website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      <Button type="submit" size="lg" loading={state === 'submitting'}>
        {state === 'submitting' ? 'Sending…' : 'Ask for an invite'}
      </Button>
    </form>
  );
}
