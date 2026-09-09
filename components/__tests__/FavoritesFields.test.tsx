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

it('refuses an entry that is already on the matching avoid list', () => {
  const { onChange } = setup({ excludeAuthors: ['brandon sanderson'] });
  fireEvent.change(authorInput(), { target: { value: 'Brandon Sanderson' } });
  fireEvent.keyDown(authorInput(), { key: 'Enter' });
  expect(onChange).not.toHaveBeenCalled();
  expect(
    screen.getByText('"Brandon Sanderson" is already on your avoid list. Remove it there first.')
  ).toBeTruthy();
});

it('renders nothing extra when suggestions have not loaded', () => {
  setup({ suggestions: undefined });
  expect(screen.queryByText('From your library')).toBeNull();
});
