'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { Button, Modal, useToast } from '@/components/ui';

// ── Heading map ────────────────────────────────────────────────────────────────

const HEADINGS: Record<string, string> = {
  'post-setup': 'How was getting set up?',
  'post-first-profile': 'Does your reader profile feel like you?',
  'post-recs': 'How were these recommendations?',
};

// ── Shared field styles (mirrored from FeedbackModal) ─────────────────────────

const inputClass = [
  'w-full rounded-lg border border-border bg-base px-3 py-2 text-sm text-text',
  'placeholder-faint focus:border-accent focus:outline-none',
  'focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');

// ── Inner modal component ─────────────────────────────────────────────────────
// Renders the targeted prompt modal with Submit / Ask me later / Don't ask again.

interface TargetedModalProps {
  trigger: string;
  runId?: string;
  heading: string;
  onClose: () => void;
}

function TargetedModal({ trigger, runId, heading, onClose }: TargetedModalProps) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const bodyTrimmed = body.trim();
  const canSubmit = bodyTrimmed.length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.submitFeedback({
        category: 'targeted',
        body: bodyTrimmed,
        trigger,
        run_id: runId ?? null,
        page: typeof window !== 'undefined' ? window.location.pathname : null,
        app_version: process.env.NEXT_PUBLIC_APP_VERSION ?? 'unknown',
      });
      toast.success('Got it, thank you. This is how the beta gets better.');
      onClose();
    } catch {
      toast.error("That didn't send. Try again in a moment.");
      setSubmitting(false);
    }
  }

  // Ask me later: snooze this trigger (per run for post-recs, global for one-time)
  async function handleAskLater() {
    try {
      await api.dismissFeedback({
        trigger,
        run_id: runId ?? '',
        mode: 'ask_later',
      });
    } catch {
      // Silent - snooze failure is not user-visible
    }
    onClose();
  }

  // Don't ask again: terminal dismiss (run_id='' = global off-switch for this trigger)
  async function handleDontAsk() {
    try {
      await api.dismissFeedback({
        trigger,
        run_id: '',
        mode: 'dont_ask',
      });
    } catch {
      // Silent
    }
    onClose();
  }

  // Escape / X / backdrop = Ask me later (not silent close)
  function handleClose() {
    void handleAskLater();
  }

  return (
    <Modal
      labelId="targeted-feedback-modal"
      onClose={handleClose}
      className="fade-in flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-2xl"
    >
      {/* Header */}
      <div className="mb-6">
        <h2 id="targeted-feedback-modal" className="text-lg font-bold leading-tight text-text">
          {heading}
        </h2>
      </div>

      {/* Body textarea */}
      <div className="mb-6 flex-1">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder={'Rough edges, wrong recommendations, small joys. All useful.'}
          disabled={submitting}
          className={[inputClass, 'resize-y disabled:opacity-50 disabled:cursor-not-allowed'].join(
            ' '
          )}
        />
      </div>

      {/* Footer: Submit + Ask me later + Don't ask again */}
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void handleAskLater()} disabled={submitting}>
            Ask me later
          </Button>
          <Button onClick={() => void handleSubmit()} loading={submitting} disabled={!canSubmit}>
            Submit
          </Button>
        </div>
        <button
          type="button"
          onClick={() => void handleDontAsk()}
          disabled={submitting}
          className="self-start text-xs text-faint underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
        >
          Don&apos;t ask again
        </button>
      </div>
    </Modal>
  );
}

// ── Session pacing ────────────────────────────────────────────────────────────
// A new reader once met three prompts in their first session (after setup, after the
// first batch, on the first Profile visit). At most one prompt now opens per browser
// session, and none opens over another dialog.

/** sessionStorage: a targeted prompt has opened in this browser session. */
const SHOWN_KEY = 'shelfsprite:feedback-prompt-shown';
/** localStorage: a deferred trigger waiting for a later session. */
const DEFERRED_KEY = 'shelfsprite:feedback-prompt-deferred';
/** sessionStorage: the deferral was recorded in this session, so it must wait. */
const DEFERRED_HERE_KEY = 'shelfsprite:feedback-prompt-deferred-here';

/**
 * Triggers whose firing moment is a bad moment to ask. post-setup fires as the setup
 * wizard's last step mounts, where its modal covered "Show me what you found"; it is
 * recorded instead, and asked at the first prompt opportunity of a later session.
 */
const DEFERRED_TRIGGERS = new Set(['post-setup']);

/** Fallback for the session flag when storage throws (private mode, blocked storage). */
let shownThisPageLoad = false;

type StorageKind = 'localStorage' | 'sessionStorage';

function readStore(kind: StorageKind, key: string): string | null {
  try {
    return window[kind].getItem(key);
  } catch {
    return null;
  }
}

function writeStore(kind: StorageKind, key: string, value: string | null): void {
  try {
    if (value === null) window[kind].removeItem(key);
    else window[kind].setItem(key, value);
  } catch {
    // Storage is a pacing aid; without it the page-load flag still holds a session to one.
  }
}

function sessionSlotTaken(): boolean {
  return shownThisPageLoad || readStore('sessionStorage', SHOWN_KEY) === '1';
}

function claimSessionSlot(): void {
  shownThisPageLoad = true;
  writeStore('sessionStorage', SHOWN_KEY, '1');
}

function deferTrigger(trigger: string): void {
  writeStore('localStorage', DEFERRED_KEY, trigger);
  writeStore('sessionStorage', DEFERRED_HERE_KEY, '1');
}

/** A trigger deferred in an EARLIER session, ready to ask now. */
function readyDeferredTrigger(): string | null {
  if (readStore('sessionStorage', DEFERRED_HERE_KEY) === '1') return null;
  const trigger = readStore('localStorage', DEFERRED_KEY);
  return trigger && DEFERRED_TRIGGERS.has(trigger) ? trigger : null;
}

/** Any modal dialog on the page (components/ui Modal and the reveal both set it). */
function dialogOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** Test-only: forget the page-load flag between cases. */
export function _resetFeedbackPromptSession(): void {
  shownThisPageLoad = false;
}

interface PromptTarget {
  trigger: string;
  runId?: string;
}

/** The prompt to ask, if any: one deferred from an earlier session first, then our own. */
async function choosePrompt(trigger: string, runId?: string): Promise<PromptTarget | null> {
  const deferred = readyDeferredTrigger();
  if (deferred) {
    try {
      const resp = await api.feedbackPrompt(deferred);
      // Asked about either way: an answered or switched-off prompt never comes back.
      writeStore('localStorage', DEFERRED_KEY, null);
      if (resp.show) return { trigger: deferred };
    } catch {
      // Keep it for the next opportunity.
    }
  }
  try {
    const resp = await api.feedbackPrompt(trigger, runId);
    if (resp.show) return { trigger, runId };
  } catch {
    // Eligibility check failures are silent - never block the user
  }
  return null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export interface UseFeedbackPromptResult {
  fire: () => void;
  modal: ReactNode | null;
}

/**
 * Encapsulates eligibility checking + fire-once guard for targeted feedback prompts.
 * Call `fire()` at the right moment; the hook calls GET /feedback/prompt and, if
 * show=true, surfaces a targeted modal with Submit / Ask me later / Don't ask again.
 *
 * Pacing (see above): nothing opens once a prompt has opened this session, an eligible
 * prompt waits until no other dialog is open, and a DEFERRED trigger never opens where
 * it fires.
 *
 * The fire-once guard resets when `runId` changes so different post-recs runs
 * each get one chance.
 */
export function useFeedbackPrompt(trigger: string, runId?: string): UseFeedbackPromptResult {
  const firedRef = useRef(false);
  const lastRunId = useRef<string | undefined>(undefined);
  // Eligible and waiting for the page to be clear of other dialogs.
  const [waiting, setWaiting] = useState<PromptTarget | null>(null);
  const [open, setOpen] = useState<PromptTarget | null>(null);

  // Reset guard when runId changes (new rec run)
  useEffect(() => {
    if (runId !== lastRunId.current) {
      lastRunId.current = runId;
      firedRef.current = false;
    }
  }, [runId]);

  const fire = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;

    if (DEFERRED_TRIGGERS.has(trigger)) {
      deferTrigger(trigger);
      return;
    }
    if (sessionSlotTaken()) return;
    void choosePrompt(trigger, runId).then((target) => {
      if (target) setWaiting(target);
    });
  }, [trigger, runId]);

  // Open only over a clear page: if a dialog is up, watch the DOM until it closes.
  useEffect(() => {
    if (!waiting) return;
    const tryOpen = (): boolean => {
      if (sessionSlotTaken()) {
        setWaiting(null); // another prompt opened first
        return true;
      }
      if (dialogOpen()) return false;
      claimSessionSlot();
      setOpen(waiting);
      setWaiting(null);
      return true;
    };
    if (tryOpen()) return;
    const observer = new MutationObserver(() => {
      if (tryOpen()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    return () => observer.disconnect();
  }, [waiting]);

  const modal: ReactNode | null = open ? (
    <TargetedModal
      trigger={open.trigger}
      runId={open.runId}
      heading={HEADINGS[open.trigger] ?? 'How is ShelfSprite working for you?'}
      onClose={() => setOpen(null)}
    />
  ) : null;

  return { fire, modal };
}
