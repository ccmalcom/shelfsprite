/**
 * @jest-environment jsdom
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('reject-reason modal copy', () => {
  it('does not offer two buttons that do the same thing', () => {
    // Guard at the source level: the picker must not render a "Skip" button that shares its
    // handler with the submit button. The modal moved out of the swipe page in wave 8.
    const picker = readFileSync(join(__dirname, '../../components/RejectReasonPicker.tsx'), 'utf8');
    expect(picker.match(/onClick=\{submit\}/g) ?? []).toHaveLength(1);
  });

  it('keeps the swipe page on the shared picker', () => {
    const swipe = readFileSync(join(__dirname, '../(main)/swipe/page.tsx'), 'utf8');
    expect(swipe.match(/<RejectReasonPicker/g) ?? []).toHaveLength(1);
  });
});
