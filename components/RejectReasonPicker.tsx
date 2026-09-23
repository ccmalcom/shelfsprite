'use client';

import { useState } from 'react';
import { Button, Modal } from '@/components/ui';

export interface RejectReasonPickerProps {
  labelId: string;
  heading: string;
  hint: string;
  /** key -> label, in display order. */
  reasons: Record<string, string>;
  /** The submit label when no reason is picked. */
  skipLabel: string;
  /** The picked keys, in the order they were picked. */
  onSubmit: (reasons: string[]) => void;
  onCancel: () => void;
}

/**
 * "What missed?" (spec §7.2). Presentational: each caller owns its vocabulary and endpoint.
 * Extracted from the swipe page, whose behavior it keeps exactly.
 */
export default function RejectReasonPicker({
  labelId,
  heading,
  hint,
  reasons,
  skipLabel,
  onSubmit,
  onCancel,
}: RejectReasonPickerProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function submit() {
    onSubmit([...selected]);
  }

  return (
    <Modal
      labelId={labelId}
      onClose={onCancel}
      className="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl"
    >
      <p id={labelId} className="mb-1 text-sm font-semibold text-text">
        {heading}
      </p>
      <p className="mb-4 text-xs text-muted">{hint}</p>
      <div className="flex flex-wrap gap-2">
        {Object.entries(reasons).map(([key, label]) => {
          const active = selected.has(key);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(key)}
              className={[
                'rounded-full border px-3 py-1 text-xs font-medium transition',
                active
                  ? 'border-accent bg-accent/20 text-accent'
                  : 'border-border bg-base text-muted hover:border-accent hover:text-accent',
              ].join(' ')}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="mt-5 flex justify-end gap-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={submit}>
          {selected.size > 0 ? 'Skip with reason' : skipLabel}
        </Button>
      </div>
    </Modal>
  );
}
