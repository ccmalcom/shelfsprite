/**
 * @jest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import { useStickySort } from '@/lib/useStickySort';

const SORTS = ['rating-desc', 'title-asc', 'date-desc'] as const;
type Sort = (typeof SORTS)[number];

// The hook mirrors writes into a module-level session store that outlives an
// unmount, so each test gets its own key rather than a shared one.
let KEY = '';
let keyCounter = 0;

/** Renders the hook and exposes its value plus a setter for each allowed sort. */
function Harness({ fallback = 'rating-desc' as Sort }: { fallback?: Sort }) {
  const [sort, setSort] = useStickySort<Sort>(KEY, fallback, SORTS);
  return (
    <div>
      <output data-testid="sort">{sort}</output>
      {SORTS.map((s) => (
        <button key={s} onClick={() => setSort(s)}>
          {s}
        </button>
      ))}
    </div>
  );
}

function currentSort() {
  return screen.getByTestId('sort').textContent;
}

describe('useStickySort', () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
    KEY = `shelfsprite:library-sort:test-${(keyCounter += 1)}`;
  });

  it('uses the fallback when nothing is stored', () => {
    render(<Harness />);
    expect(currentSort()).toBe('rating-desc');
  });

  it('hydrates a previously stored sort', () => {
    window.localStorage.setItem(KEY, 'date-desc');
    render(<Harness />);
    expect(currentSort()).toBe('date-desc');
  });

  it('ignores a stored value that is no longer an allowed sort', () => {
    window.localStorage.setItem(KEY, 'rating-asc-removed-in-v2');
    render(<Harness />);
    expect(currentSort()).toBe('rating-desc');
  });

  it('persists the sort when it changes', () => {
    render(<Harness />);
    act(() => screen.getByRole('button', { name: 'date-desc' }).click());
    expect(currentSort()).toBe('date-desc');
    expect(window.localStorage.getItem(KEY)).toBe('date-desc');
  });

  it('keeps working when reading localStorage throws', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    render(<Harness />);
    expect(currentSort()).toBe('rating-desc');
  });

  it('keeps working when writing localStorage throws', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    render(<Harness />);
    act(() => screen.getByRole('button', { name: 'title-asc' }).click());
    expect(currentSort()).toBe('title-asc');
  });

  it('keeps separate tabs on separate keys', () => {
    window.localStorage.setItem('shelfsprite:library-sort:some-other-tab', 'title-asc');
    render(<Harness />);
    expect(currentSort()).toBe('rating-desc');
  });

  it('still shows the chosen sort after a remount when storage rejected the write', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const first = render(<Harness />);
    act(() => screen.getByRole('button', { name: 'date-desc' }).click());
    first.unmount();

    render(<Harness />);
    expect(currentSort()).toBe('date-desc');
  });
});
