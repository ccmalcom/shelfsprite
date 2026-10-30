import { truncateAtWord } from '@/lib/truncate';

describe('truncateAtWord', () => {
  it('leaves text that fits alone', () => {
    expect(truncateAtWord('Loves found family', 40)).toBe('Loves found family');
  });

  it('cuts at the last word boundary, never mid-word', () => {
    const out = truncateAtWord('Drawn to sweeping, thesis-driven popular history', 30);
    expect(out).toBe('Drawn to sweeping…');
    expect(out.length).toBeLessThanOrEqual(30);
  });

  it('drops dangling punctuation before the ellipsis', () => {
    expect(truncateAtWord('Quiet, interior, character-led stories', 18)).toBe('Quiet, interior…');
  });

  it('falls back to a hard cut for one long word', () => {
    expect(truncateAtWord('Supercalifragilistic', 8)).toBe('Superca…');
  });
});
