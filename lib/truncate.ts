// Dependency-free: card components import this.

/**
 * `text` cut to at most `max` characters, ellipsis included, at the last word boundary
 * that fits. A single word longer than the budget is cut mid-word, since there is no
 * boundary to use. Trailing punctuation before the cut is dropped so the ellipsis
 * does not land after a comma.
 */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  const cut = space > 0 ? room.slice(0, space) : room;
  return cut.replace(/[\s,;:.–—-]+$/, '') + '…';
}
