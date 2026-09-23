/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { ScreenStats } from '@/components/profile/ScreenStats';
import { makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

function expectEmptyState() {
  expect(screen.getByText(/No films or shows yet/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Import from Letterboxd' })).toHaveAttribute(
    'href',
    '/settings#screen'
  );
  expect(screen.queryByText('Your screen library')).toBeNull();
}

describe('ScreenStats', () => {
  it('shows the import prompt for an empty library', () => {
    render(<ScreenStats titles={[]} />);
    expectEmptyState();
  });

  it('shows the import prompt when every title is a possible duplicate', () => {
    const dup = makeTitle({ id: 2 });
    dup.enrichment = { ...dup.enrichment!, duplicate_of_title_id: 1 };
    render(<ScreenStats titles={[dup]} />);
    expectEmptyState();
  });

  it('shows the stats once there is a title', () => {
    render(<ScreenStats titles={[makeTitle()]} />);
    expect(screen.getByText('Your screen library')).toBeInTheDocument();
    expect(screen.queryByText(/No films or shows yet/)).toBeNull();
  });
});
