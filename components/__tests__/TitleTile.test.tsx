/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import TitleTile from '@/components/screen/TitleTile';

const URL_A = 'https://upload.wikimedia.org/wikipedia/en/0/00/heat.jpg';
const URL_B = 'https://static.tvmaze.com/uploads/images/original_untouched/1/2.jpg';

describe('TitleTile', () => {
  it('hotlinks the poster unchanged', () => {
    render(<TitleTile title="Heat" year={1995} mediaType="movie" imageUrl={URL_A} />);
    expect(screen.getByAltText('Poster for Heat')).toHaveAttribute('src', URL_A);
  });

  it('loads lazily unless it is marked eager', () => {
    const { rerender } = render(
      <TitleTile title="Heat" year={1995} mediaType="movie" imageUrl={URL_A} />
    );
    expect(screen.getByAltText('Poster for Heat')).toHaveAttribute('loading', 'lazy');
    rerender(<TitleTile title="Heat" year={1995} mediaType="movie" imageUrl={URL_A} eager />);
    expect(screen.getByAltText('Poster for Heat')).toHaveAttribute('loading', 'eager');
  });

  it('falls back when the image fails', () => {
    render(<TitleTile title="Heat" year={1995} mediaType="movie" imageUrl={URL_A} />);
    fireEvent.error(screen.getByAltText('Poster for Heat'));
    const tile = screen.getByTestId('title-tile-fallback');
    expect(tile).toHaveTextContent('Heat');
    expect(tile).toHaveTextContent('1995');
    expect(tile).toHaveTextContent('Film');
    expect(screen.queryByAltText('Poster for Heat')).toBeNull();
  });

  it('retries when the url changes', () => {
    const { rerender } = render(
      <TitleTile title="Heat" year={1995} mediaType="movie" imageUrl={URL_A} />
    );
    fireEvent.error(screen.getByAltText('Poster for Heat'));
    rerender(<TitleTile title="Heat" year={1995} mediaType="movie" imageUrl={URL_B} />);
    expect(screen.getByAltText('Poster for Heat')).toHaveAttribute('src', URL_B);
  });

  it('renders the typographic tile when there is no image', () => {
    render(<TitleTile title="Severance" year={null} mediaType="tv" imageUrl={null} />);
    const tile = screen.getByTestId('title-tile-fallback');
    expect(tile).toHaveTextContent('TV');
    expect(tile).toHaveTextContent('Severance');
  });
});
