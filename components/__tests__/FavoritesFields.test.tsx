/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import FavoritesFields from '@/components/FavoritesFields';
import { MAX_PREFER_ENTRIES } from '@/lib/api';

const suggestions = {
  authors: [{ value: 'Gene Wolfe', count: 4 }],
  subjects: [{ value: 'space opera', count: 7 }],
};

type Props = React.ComponentProps<typeof FavoritesFields>;

const fields = (onChange: Props['onChange'], over: Partial<Props> = {}) => (
  <FavoritesFields
    authors={[]}
    subjects={[]}
    excludeAuthors={[]}
    excludeSubjects={[]}
    suggestions={suggestions}
    onChange={onChange}
    {...over}
  />
);

function setup(over: Partial<Props> = {}) {
  const onChange = jest.fn();
  // rerender, not a second render(): a second render() leaves the first tree mounted
  // and every getByRole then matches two nodes.
  const { rerender } = render(fields(onChange, over));
  return { onChange, rerender: (next: Partial<Props>) => rerender(fields(onChange, next)) };
}

const authorInput = () => screen.getByLabelText('Favorite authors');
const subjectInput = () => screen.getByLabelText('Favorite genres & subjects');

it('adds an author via the Add button and fires onChange with the full next value', () => {
  const { onChange } = setup({ subjects: ['space opera'] });
  fireEvent.change(authorInput(), { target: { value: '  Ursula K.  Le Guin  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add favorite author' }));
  // Whitespace collapsed, case preserved, and BOTH lists come back — not a delta.
  expect(onChange).toHaveBeenCalledWith({
    authors: ['Ursula K. Le Guin'],
    subjects: ['space opera'],
  });
});

it('adds a subject on Enter, lowercased to match what the server will store', () => {
  const { onChange } = setup();
  fireEvent.change(subjectInput(), { target: { value: 'Translated Fiction' } });
  fireEvent.keyDown(subjectInput(), { key: 'Enter' });
  // cleanDirectiveConstraints lowercases prefer_subjects, so the chip must not flip
  // case on the reader's next page load.
  expect(onChange).toHaveBeenCalledWith({ authors: [], subjects: ['translated fiction'] });
});

it('does NOT lowercase an author', () => {
  const { onChange } = setup();
  fireEvent.change(authorInput(), { target: { value: 'Ursula K. Le Guin' } });
  fireEvent.keyDown(authorInput(), { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith({ authors: ['Ursula K. Le Guin'], subjects: [] });
});

it('removes an entry', () => {
  const { onChange } = setup({ authors: ['Gene Wolfe', 'Ursula K. Le Guin'] });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Gene Wolfe' }));
  expect(onChange).toHaveBeenCalledWith({ authors: ['Ursula K. Le Guin'], subjects: [] });
});

it('clicking a suggestion adds it, and it leaves the suggestion row', () => {
  const { onChange, rerender } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Add Gene Wolfe' }));
  expect(onChange).toHaveBeenCalledWith({ authors: ['Gene Wolfe'], subjects: [] });

  // The row is derived from the current lists, so an already-chosen value is gone
  // once the parent feeds the new value back down.
  rerender({ authors: ['Gene Wolfe'] });
  expect(screen.queryByRole('button', { name: 'Add Gene Wolfe' })).toBeNull();
});

it('blocks adding past MAX_PREFER_ENTRIES with an inline message', () => {
  const full = Array.from({ length: MAX_PREFER_ENTRIES }, (_, i) => `Author ${i}`);
  const { onChange } = setup({ authors: full });
  fireEvent.change(authorInput(), { target: { value: 'One Too Many' } });
  fireEvent.keyDown(authorInput(), { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
  expect(
    screen.getByText(`You can save up to ${MAX_PREFER_ENTRIES}. Remove one first.`)
  ).toBeTruthy();
});

// exclude_authors holds SURNAMES (DISTILL_TOOL says so, and applyDirectiveConstraints
// matches surname(candidate.author) against them), so the warning has to match the way
// the recommender matches. A full-string compare here let 'Brandon Sanderson' through
// against an exclusion of 'sanderson'; the server then dropped the favorite on save and
// the reader was told nothing.
it('refuses an author whose surname is on the avoid list', () => {
  const { onChange } = setup({ excludeAuthors: ['sanderson'] });
  fireEvent.change(authorInput(), { target: { value: 'Brandon Sanderson' } });
  fireEvent.keyDown(authorInput(), { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
  expect(
    screen.getByText('"Brandon Sanderson" is already on your avoid list. Remove it there first.')
  ).toBeTruthy();
});

// Subject exclusions match a whole word INSIDE a subject, so 'opera' really does empty
// out 'space opera' downstream. Exact equality missed it.
it('refuses a subject that a broader exclusion term already covers', () => {
  const { onChange } = setup({ excludeSubjects: ['opera'] });
  fireEvent.change(subjectInput(), { target: { value: 'Space Opera' } });
  fireEvent.keyDown(subjectInput(), { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
  expect(
    screen.getByText('"space opera" is already on your avoid list. Remove it there first.')
  ).toBeTruthy();
});

// The inherited quirk, pinned: an exclusion stored as a full name matches no surname and
// therefore filters nothing, so the favorite must be ACCEPTED. Blocking it would cost the
// reader a favorite over an exclusion that was never going to fire.
it('accepts an author when the avoid entry is a full name, which filters nothing', () => {
  const { onChange } = setup({ excludeAuthors: ['brandon sanderson'] });
  fireEvent.change(authorInput(), { target: { value: 'Brandon Sanderson' } });
  fireEvent.keyDown(authorInput(), { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith({ authors: ['Brandon Sanderson'], subjects: [] });
});

it('disables every control while the directive record is still loading', () => {
  setup({ disabled: true });
  expect((authorInput() as HTMLInputElement).disabled).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Add favorite author' }) as HTMLButtonElement).disabled
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Add Gene Wolfe' }) as HTMLButtonElement).disabled
  ).toBe(true);
});

it('renders nothing extra when suggestions have not loaded', () => {
  setup({ suggestions: undefined });
  expect(screen.queryByText('From your library')).toBeNull();
});
