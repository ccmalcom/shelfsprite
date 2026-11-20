'use client';

import { useState } from 'react';
import { Button, Modal } from '@/components/ui';

export type NextReadChoice = 'shelf' | 'new';

interface Props {
  /** Books on the reader's to-read shelf. */
  toReadCount: number;
  /** Either choice; `dontAsk` is the checkbox at the moment of choosing. */
  onChoose: (choice: NextReadChoice, dontAsk: boolean) => void;
  /** Escape or the backdrop: nothing runs and nothing is saved. */
  onCancel: () => void;
}

/**
 * Shown on "Find my next books" when the to-read shelf is long: offer to pick the next read
 * from it before spending a run on more new books. "Don't ask again" applies to either choice
 * and can be undone in Settings.
 */
export default function NextReadPromptModal({ toReadCount, onChoose, onCancel }: Props) {
  const [dontAsk, setDontAsk] = useState(false);

  return (
    <Modal
      labelId="next-read-prompt-title"
      onClose={onCancel}
      className="fade-in w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-2xl"
    >
      <p className="mb-1 font-mono text-xs font-semibold uppercase tracking-widest text-accent">
        Your to-read shelf
      </p>
      <h2 id="next-read-prompt-title" className="text-lg font-bold leading-tight text-text">
        You have {toReadCount} books waiting.
      </h2>
      <p className="mt-2 text-sm text-muted">
        Want help choosing which of them to read next, instead of finding more?
      </p>

      <div className="mt-5 flex flex-col gap-2">
        <Button onClick={() => onChoose('shelf', dontAsk)}>Pick from my to-read shelf</Button>
        <Button variant="secondary" onClick={() => onChoose('new', dontAsk)}>
          Find new books anyway
        </Button>
      </div>

      <label className="mt-4 flex min-h-11 items-center gap-3 text-sm text-muted">
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        Don&apos;t ask again
      </label>
      {dontAsk && <p className="text-xs text-faint">You can turn this back on in Settings.</p>}
    </Modal>
  );
}
