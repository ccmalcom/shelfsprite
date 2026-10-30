/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { StarRating } from '@/components/ui/StarRating';

describe('StarRating', () => {
  it('sets a half star with one click on the left half of a star', () => {
    const onChange = jest.fn();
    render(<StarRating value={0} onChange={onChange} allowHalf />);

    fireEvent.click(screen.getByRole('radio', { name: '4.5 stars' }));

    expect(onChange).toHaveBeenCalledWith(4.5);
  });

  it('sets the whole star from its right half', () => {
    const onChange = jest.fn();
    render(<StarRating value={0} onChange={onChange} allowHalf />);

    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }));

    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('offers one radio per half step from half a star to five', () => {
    render(<StarRating value={0} onChange={jest.fn()} allowHalf />);

    const names = screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'));
    expect(names).toEqual([
      'Half a star',
      '1 star',
      '1.5 stars',
      '2 stars',
      '2.5 stars',
      '3 stars',
      '3.5 stars',
      '4 stars',
      '4.5 stars',
      '5 stars',
    ]);
  });

  it('offers whole stars only when half stars are not allowed', () => {
    render(<StarRating value={0} onChange={jest.fn()} />);

    expect(screen.getAllByRole('radio')).toHaveLength(5);
  });

  it('marks exactly the set value as checked, so 4.5 does not read as 5 stars', () => {
    render(<StarRating value={4.5} onChange={jest.fn()} allowHalf />);

    expect(screen.getByRole('radio', { name: '4.5 stars' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: '5 stars' })).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')
    ).toHaveLength(1);
  });

  it('checks nothing while unrated and keeps the first option tabbable', () => {
    render(<StarRating value={0} onChange={jest.fn()} allowHalf />);

    expect(
      screen.getAllByRole('radio').filter((r) => r.getAttribute('aria-checked') === 'true')
    ).toHaveLength(0);
    expect(screen.getByRole('radio', { name: 'Half a star' })).toHaveAttribute('tabindex', '0');
  });

  it('moves focus to the newly selected radio on arrow keys', () => {
    const onChange = jest.fn();
    const { rerender } = render(<StarRating value={4} onChange={onChange} allowHalf />);

    fireEvent.keyDown(screen.getByRole('radio', { name: '4 stars' }), { key: 'ArrowRight' });
    rerender(<StarRating value={4.5} onChange={onChange} allowHalf />);

    expect(onChange).toHaveBeenCalledWith(4.5);
    expect(screen.getByRole('radio', { name: '4.5 stars' })).toHaveFocus();
  });

  it('steps by half with arrow keys when half stars are allowed', () => {
    const onChange = jest.fn();
    render(<StarRating value={3} onChange={onChange} allowHalf />);

    fireEvent.keyDown(screen.getAllByRole('radio')[2], { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith(3.5);
  });

  it('steps by a whole star with arrow keys when half stars are not allowed', () => {
    const onChange = jest.fn();
    render(<StarRating value={3} onChange={onChange} />);

    fireEvent.keyDown(screen.getAllByRole('radio')[2], { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('snaps an off-grid value to a whole star when half stars are not allowed', () => {
    const onChange = jest.fn();
    render(<StarRating value={4.5} onChange={onChange} />);

    fireEvent.keyDown(screen.getByRole('radio', { name: '5 stars' }), { key: 'ArrowLeft' });

    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('never goes below half a star', () => {
    const onChange = jest.fn();
    render(<StarRating value={0.5} onChange={onChange} allowHalf />);

    fireEvent.keyDown(screen.getAllByRole('radio')[0], { key: 'ArrowLeft' });

    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it('never goes above the maximum', () => {
    const onChange = jest.fn();
    render(<StarRating value={5} onChange={onChange} allowHalf />);

    fireEvent.keyDown(screen.getAllByRole('radio')[4], { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith(5);
  });

  it('announces a read-only rating accessibly', () => {
    render(<StarRating value={3.5} readOnly allowHalf label="Your rating" />);

    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Your rating: 3.5 of 5');
  });

  it('renders no buttons when read-only', () => {
    render(<StarRating value={3.5} readOnly allowHalf label="Your rating" />);

    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('renders exactly one clipped star for a half value', () => {
    const { container } = render(<StarRating value={3.5} readOnly allowHalf />);

    expect(container.querySelectorAll('path[clip-path]')).toHaveLength(1);
  });

  it('uses unique clipPath ids across StarRating instances', () => {
    const { container } = render(
      <>
        <StarRating value={3.5} readOnly allowHalf />
        <StarRating value={3.5} readOnly allowHalf />
      </>
    );
    const ids = Array.from(container.querySelectorAll('clipPath'), (element) => element.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
