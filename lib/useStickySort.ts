'use client';

// Remembers a tab's chosen sort across visits. The library's sort dropdowns were
// resetting to a hardcoded default on every load (issue #63), so each one now
// keeps its own key here.
import { useCallback, useSyncExternalStore } from 'react';

// Session-local mirror of the persisted values. It is what keeps the control
// working when storage is unavailable — in private browsing or with site data
// disabled `setItem` throws, and the write still has to land somewhere or the
// dropdown would be inert for the rest of the visit. Module scope means it lives
// exactly as long as the page session, which is the intended lifetime.
const sessionValues = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  // 'storage' fires only in *other* tabs, so same-tab writes notify through the
  // listener set instead.
  window.addEventListener('storage', onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

function readRaw(storageKey: string): string | null {
  const session = sessionValues.get(storageKey);
  if (session !== undefined) return session;
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/**
 * A `useState` drop-in whose value is persisted in `localStorage`.
 *
 * Built on `useSyncExternalStore` so the prerender and the hydrating render both
 * see `fallback` and React swaps in the stored value itself — reading storage
 * during render would otherwise be a hydration mismatch. The list is still
 * SWR-loading on first paint, so the swap is not visible.
 *
 * A stored value is only accepted if it is still in `allowed`. That check is
 * load-bearing rather than defensive — each caller's comparator is an exhaustive
 * `switch` over its sort union, so a key left behind by a renamed option would
 * fall through, return `undefined`, and throw inside `Array.prototype.sort`.
 */
export function useStickySort<T extends string>(
  storageKey: string,
  fallback: T,
  allowed: readonly T[]
): [T, (value: T) => void] {
  const getSnapshot = useCallback((): T => {
    const stored = readRaw(storageKey);
    if (stored !== null && (allowed as readonly string[]).includes(stored)) {
      return stored as T;
    }
    return fallback;
  }, [storageKey, fallback, allowed]);

  const getServerSnapshot = useCallback(() => fallback, [fallback]);

  const sort = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setSort = useCallback(
    (value: T) => {
      try {
        window.localStorage.setItem(storageKey, value);
        sessionValues.delete(storageKey);
      } catch {
        // Preference just will not outlive the session; the sort still changes.
        sessionValues.set(storageKey, value);
      }
      listeners.forEach((notify) => notify());
    },
    [storageKey]
  );

  return [sort, setSort];
}
