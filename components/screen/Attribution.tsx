const CC_BY_SA = 'https://creativecommons.org/licenses/by-sa/4.0/';
const LINK = 'underline underline-offset-2 hover:text-muted';

function wikipediaUrl(page: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, '_'))}`;
}

/**
 * The source line under a description (spec §7.9): Wikipedia names and links the article with
 * CC BY-SA; TVmaze is credited with a link back, which its API terms require.
 */
export function DescriptionSource({
  source,
  url,
  page,
}: {
  source: 'wikipedia' | 'tvmaze' | null;
  url: string | null;
  page: string | null;
}) {
  if (source === 'wikipedia') {
    const href = url ?? (page ? wikipediaUrl(page) : 'https://en.wikipedia.org/');
    return (
      <p className="text-xs text-faint">
        From Wikipedia:{' '}
        <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
          {page ?? 'the article'}
        </a>{' '}
        (
        <a href={CC_BY_SA} target="_blank" rel="noopener noreferrer" className={LINK}>
          CC BY-SA 4.0
        </a>
        )
      </p>
    );
  }
  if (source === 'tvmaze') {
    return (
      <p className="text-xs text-faint">
        Summary from{' '}
        <a
          href={url ?? 'https://www.tvmaze.com/'}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK}
        >
          TVmaze
        </a>{' '}
        (
        <a href={CC_BY_SA} target="_blank" rel="noopener noreferrer" className={LINK}>
          CC BY-SA 4.0
        </a>
        )
      </p>
    );
  }
  return null;
}

/** The footer on every /screen page (spec §7.9). No hooks: the server layout renders it. */
export function ScreenCredits() {
  return (
    <footer className="mx-auto mt-12 max-w-[960px] border-t border-border pt-4 text-xs leading-relaxed text-faint">
      Film and TV data from{' '}
      <a
        href="https://www.wikidata.org/"
        target="_blank"
        rel="noopener noreferrer"
        className={LINK}
      >
        Wikidata
      </a>{' '}
      (CC0). Descriptions from{' '}
      <a
        href="https://en.wikipedia.org/"
        target="_blank"
        rel="noopener noreferrer"
        className={LINK}
      >
        Wikipedia
      </a>{' '}
      and{' '}
      <a href="https://www.tvmaze.com/" target="_blank" rel="noopener noreferrer" className={LINK}>
        TVmaze
      </a>{' '}
      (CC BY-SA 4.0). Posters load directly from those sites.
    </footer>
  );
}
