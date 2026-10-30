'use client';

import { useEffect, useRef, type ReactNode, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Full-screen dark card that every beat renders inside.
 *
 * Portaled to <body> so it covers the whole viewport: rendered in place, it inherited a
 * sibling margin from its parent's `space-y-*` and sat under the phone BottomNav (z-50).
 * It behaves as the modal it claims to be: focus moves into each beat as it appears, Tab
 * stays inside, Escape leaves, and focus returns to whatever opened it.
 */
export function RevealFrame({
  children,
  accent,
  progress,
  onSkip,
  onEscape,
}: {
  children: ReactNode;
  accent: string;
  progress?: { index: number; total: number };
  onSkip?: () => void;
  onEscape?: () => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Lock the page behind the overlay, and hand focus back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
      opener?.focus();
    };
  }, []);

  // Each beat remounts its content, which would otherwise drop focus to <body>.
  const beatIndex = progress?.index;
  useEffect(() => {
    contentRef.current?.focus({ preventScroll: true });
  }, [beatIndex]);

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape' && onEscape) {
      // Escape inside the trait editor belongs to the editor, not the whole reveal.
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') return;
      e.stopPropagation();
      onEscape();
      return;
    }
    if (e.key === 'Tab') {
      const frame = frameRef.current;
      if (!frame) return;
      const focusable = Array.from(frame.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === contentRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  return createPortal(
    <div
      ref={frameRef}
      style={{ ['--user-accent' as string]: accent }}
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center overflow-y-auto bg-base px-6 py-10 text-center"
      role="dialog"
      aria-modal="true"
      aria-label="Your reading profile reveal"
      onKeyDown={handleKeyDown}
    >
      <div
        ref={contentRef}
        tabIndex={-1}
        className="flex w-full max-w-xl flex-1 flex-col items-center justify-center focus:outline-none"
      >
        {children}
      </div>

      {progress && (
        <>
          <p className="sr-only" aria-live="polite">
            Part {progress.index + 1} of {progress.total}
          </p>
          <div className="mt-6 flex items-center gap-1.5" aria-hidden>
            {Array.from({ length: progress.total }).map((_, i) => (
              <span
                key={i}
                className={[
                  'h-1.5 rounded-full transition-all',
                  i === progress.index ? 'w-6 bg-user' : 'w-1.5 bg-border-strong',
                ].join(' ')}
              />
            ))}
          </div>
        </>
      )}

      {onSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="mt-4 rounded font-mono text-[13px] text-faint transition-colors hover:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base"
        >
          Skip to my profile
        </button>
      )}
    </div>,
    document.body
  );
}

/** Primary "advance" button, tinted with the archetype accent. */
export function RevealButton({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
}) {
  const base =
    'mt-8 inline-flex items-center justify-center rounded-lg px-6 py-3 text-sm font-semibold transition-all active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base disabled:cursor-wait disabled:opacity-70';
  const styles =
    variant === 'primary' ? 'bg-user text-base hover:opacity-90' : 'text-muted hover:text-text';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[base, styles].join(' ')}
    >
      {children}
    </button>
  );
}
