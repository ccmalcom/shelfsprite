import { describe, it, expect } from 'vitest';
import { fictionKind, genreLabel, libraryShape } from '../libraryShape';
import { ARCHETYPES, ARCHETYPE_HOOKS, archetypeCopy } from '../archetype';

describe('genreLabel', () => {
  it('drops umbrella labels that are not genres', () => {
    for (const s of ['Fiction', 'Nonfiction', 'Non-Fiction', 'General', 'Fiction, general']) {
      expect(genreLabel(s)).toBeNull();
    }
  });

  it('drops LC headings, people headings and the book’s own title', () => {
    expect(genreLabel('New York (N.Y.), Fiction')).toBeNull();
    expect(genreLabel('Young men')).toBeNull();
    expect(genreLabel('Children of clergy')).toBeNull();
    expect(genreLabel('Goldfinch', 'The Goldfinch')).toBeNull();
  });

  it('keeps real genres and lifts the genre out of "Fiction, <genre>"', () => {
    expect(genreLabel('Science fiction')).toBe('Science fiction');
    expect(genreLabel('Biography & Autobiography')).toBe('Biography & Autobiography');
    expect(genreLabel("Children's stories")).toBe("Children's stories");
    expect(genreLabel('Fiction, fantasy, epic')).toBe('fantasy');
  });
});

describe('fictionKind', () => {
  it('classifies from the subjects, fiction winning a mix', () => {
    expect(fictionKind(['History', 'Ireland'])).toBe('nonfiction');
    expect(fictionKind(['Fiction, historical', 'History'])).toBe('fiction');
    expect(fictionKind(['Nonfiction'])).toBe('nonfiction');
    expect(fictionKind(['Ireland'])).toBeNull();
  });
});

describe('libraryShape', () => {
  const b = (author: string, subjects: string[] = ['Fiction'], inSeries = false) => ({
    author,
    subjects,
    inSeries,
  });

  it('sees no loyalty in six books by six authors', () => {
    const shape = libraryShape(['a', 'b', 'c', 'd', 'e', 'f'].map((a) => b(a)));
    expect(shape).toEqual({ repeatAuthors: false, readsSeries: false, mostlyNonfiction: false });
  });

  it('sees repeat authors, series and a nonfiction majority', () => {
    const shape = libraryShape([
      b('a', ['History'], true),
      b('a', ['Biography'], true),
      b('c', ['Fiction']),
    ]);
    expect(shape).toEqual({ repeatAuthors: true, readsSeries: true, mostlyNonfiction: true });
  });
});

describe('archetypeCopy', () => {
  const none = { repeatAuthors: false, readsSeries: false, mostlyNonfiction: false };
  const loyal = { repeatAuthors: true, readsSeries: true, mostlyNonfiction: false };

  it('keeps the default copy when the library backs it', () => {
    expect(archetypeCopy('ICDH', loyal)).toEqual({
      tagline: ARCHETYPES.ICDH.tagline,
      hook: ARCHETYPE_HOOKS.ICDH,
    });
  });

  it('drops author and series claims for a library with neither', () => {
    expect(archetypeCopy('ICDH', none).hook).not.toMatch(/series/);
    expect(archetypeCopy('RCDH', none).tagline).not.toMatch(/authors/);
  });

  it('uses nonfiction framing for a mostly nonfiction library', () => {
    expect(archetypeCopy('RCBM', { ...loyal, mostlyNonfiction: true }).tagline).not.toMatch(
      /characters/
    );
  });

  it('has no literal double hyphen in any tagline', () => {
    for (const { tagline } of Object.values(ARCHETYPES)) expect(tagline).not.toContain('--');
  });
});
