/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { DescriptionSource, ScreenCredits } from '@/components/screen/Attribution';

describe('DescriptionSource', () => {
  it('names and links the Wikipedia article with its licence', () => {
    render(
      <DescriptionSource
        source="wikipedia"
        url="https://en.wikipedia.org/wiki/Heat_(1995_film)"
        page="Heat (1995 film)"
      />
    );
    expect(screen.getByText(/From Wikipedia/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Heat (1995 film)' })).toHaveAttribute(
      'href',
      'https://en.wikipedia.org/wiki/Heat_(1995_film)'
    );
    expect(screen.getByRole('link', { name: 'CC BY-SA 4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/4.0/'
    );
  });

  it('builds the article link from the page name when the url is missing', () => {
    render(<DescriptionSource source="wikipedia" url={null} page="Heat (1995 film)" />);
    expect(screen.getByRole('link', { name: 'Heat (1995 film)' })).toHaveAttribute(
      'href',
      'https://en.wikipedia.org/wiki/Heat_(1995_film)'
    );
  });

  it('credits TVmaze with a link back', () => {
    render(
      <DescriptionSource
        source="tvmaze"
        url="https://www.tvmaze.com/shows/44778/severance"
        page={null}
      />
    );
    expect(screen.getByRole('link', { name: 'TVmaze' })).toHaveAttribute(
      'href',
      'https://www.tvmaze.com/shows/44778/severance'
    );
  });

  it('renders nothing without a source', () => {
    const { container } = render(<DescriptionSource source={null} url={null} page={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ScreenCredits', () => {
  it('credits Wikidata, Wikipedia and TVmaze', () => {
    render(<ScreenCredits />);
    for (const name of ['Wikidata', 'Wikipedia', 'TVmaze']) {
      expect(screen.getByRole('link', { name })).toBeInTheDocument();
    }
  });
});
