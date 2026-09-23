import type { Metadata } from 'next';
import ScreenGate from '@/components/screen/ScreenGate';
import { ScreenCredits } from '@/components/screen/Attribution';

export const metadata: Metadata = { title: 'ScreenSprite' };

/**
 * Every /screen page: the ScreenSprite <title> (spec §7.11), the opt-in gate (§7.1), and the
 * source credits (§7.9). Not behind LibraryGate: ScreenSprite needs no books.
 */
export default function ScreenLayout({ children }: { children: React.ReactNode }) {
  return (
    <ScreenGate>
      {children}
      <ScreenCredits />
    </ScreenGate>
  );
}
