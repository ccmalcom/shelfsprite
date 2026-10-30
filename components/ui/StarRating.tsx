'use client';
import { useId, useRef, useState, KeyboardEvent } from 'react';
import { RATING_MAX, RATING_STEP } from '@/lib/server/rating';

interface StarRatingProps {
  /** 0 = unrated; otherwise 0.5-5 (whole stars only when allowHalf is false). */
  value: number;
  onChange?: (value: number) => void;
  max?: number;
  label?: string;
  readOnly?: boolean;
  size?: number;
  /** Enable half-star selection: the left half of each star is its own .5 option. */
  allowHalf?: boolean;
}

function optionLabel(v: number) {
  if (v === 0.5) return 'Half a star';
  return v === 1 ? '1 star' : `${v} stars`;
}

export function StarRating({
  value,
  onChange,
  max = RATING_MAX,
  label = 'Rating',
  readOnly = false,
  size = 20,
  allowHalf = false,
}: StarRatingProps) {
  const [hovered, setHovered] = useState(0);
  const uid = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const step = allowHalf ? RATING_STEP : 1;
  const min = step;

  function select(next: number, moveFocus = false) {
    const v = Math.min(max, Math.max(min, next));
    onChange?.(v);
    if (moveFocus) {
      groupRef.current?.querySelector<HTMLButtonElement>(`[data-value="${v}"]`)?.focus();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (!onChange) return;
    // Snap to the step grid, so an off-grid value (a 4.5 shown without allowHalf) still
    // moves to a value this control offers.
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      select((Math.floor(value / step) + 1) * step, true);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      select((Math.ceil(value / step) - 1) * step, true);
    } else if (e.key === 'Home') {
      e.preventDefault();
      select(min, true);
    } else if (e.key === 'End') {
      e.preventDefault();
      select(max, true);
    } else if (e.key >= '1' && e.key <= String(max)) {
      e.preventDefault();
      select(Number(e.key), true);
    }
  }

  function starFill(star: number, display: number) {
    return display >= star ? 1 : display >= star - 0.5 ? 0.5 : 0;
  }

  if (readOnly) {
    return (
      <span
        role="img"
        aria-label={`${label}: ${value || 0} of ${max}`}
        className="flex items-center gap-1"
      >
        {Array.from({ length: max }, (_, i) => {
          const star = i + 1;
          return (
            <StarIcon key={star} fill={starFill(star, value)} size={size} index={star} uid={uid} />
          );
        })}
      </span>
    );
  }

  const display = hovered || value;
  // Every selectable value is its own radio: with allowHalf, each star holds a left-half
  // radio (x.5) and a right-half radio (x). A half star is one click or tap away, and
  // aria-checked marks exactly the value that is set, so a 4.5 no longer reads as "5 stars".
  const options = Array.from({ length: max / step }, (_, i) => (i + 1) * step);
  // Roving tabindex: the set value, or the nearest option above an unrated or off-grid one.
  const tabValue = options.find((v) => v >= value) ?? options[options.length - 1];

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={`${label}: ${value || 0} of ${max}`}
      className="flex items-center gap-1"
      onMouseLeave={() => setHovered(0)}
    >
      {Array.from({ length: max }, (_, i) => {
        const star = i + 1;
        const starOptions = allowHalf ? [star - 0.5, star] : [star];
        return (
          <span key={star} className="group relative inline-flex">
            <span className="inline-flex transition-transform group-hover:scale-110 group-active:scale-95">
              {/* 1 = full, 0.5 = half, 0 = empty. */}
              <StarIcon fill={starFill(star, display)} size={size} index={star} uid={uid} />
            </span>
            {starOptions.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                data-value={v}
                aria-checked={value === v}
                aria-label={optionLabel(v)}
                tabIndex={v === tabValue ? 0 : -1}
                onClick={() => select(v)}
                onMouseEnter={() => setHovered(v)}
                onKeyDown={handleKeyDown}
                className={[
                  'absolute inset-y-0 cursor-pointer rounded',
                  starOptions.length === 1
                    ? 'inset-x-0'
                    : v < star
                      ? 'left-0 w-1/2'
                      : 'right-0 w-1/2',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                  'focus-visible:ring-offset-1 focus-visible:ring-offset-base',
                ].join(' ')}
              />
            ))}
          </span>
        );
      })}
    </div>
  );
}

const STAR_PATH =
  'M10 1.5l2.47 5.02 5.54.8-4.01 3.91.95 5.52L10 14.27l-4.95 2.48.95-5.52L2 7.32l5.54-.8L10 1.5z';

function StarIcon({
  fill,
  size,
  index,
  uid,
}: {
  fill: number;
  size: number;
  index: number;
  uid: string;
}) {
  // Clip-path ids must be unique per StarRating component instance and per star.
  const clipId = `star-half-${uid}-${index}`;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width="10" height="20" />
        </clipPath>
      </defs>
      <path fill="none" stroke="var(--border)" strokeWidth="1.5" d={STAR_PATH} />
      {fill === 1 && <path fill="var(--accent)" d={STAR_PATH} />}
      {fill === 0.5 && <path fill="var(--accent)" d={STAR_PATH} clipPath={`url(#${clipId})`} />}
    </svg>
  );
}
