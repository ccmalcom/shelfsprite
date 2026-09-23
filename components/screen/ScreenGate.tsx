'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Spinner } from '@/components/ui';
import { useScreenSettings } from '@/lib/useScreenSettings';

/**
 * Every /screen page sits behind the opt-in (spec §7.1): a reader without ScreenSprite goes to
 * the settings card that turns it on. A 403 from any screen read re-reads the settings
 * (lib/screenCache.ts#handleScreenError), so turning ScreenSprite off in another tab lands here
 * too, without a reload.
 */
export default function ScreenGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { settings, error, mutate } = useScreenSettings();
  const disabled = settings !== undefined && !settings.enabled;

  useEffect(() => {
    if (disabled) router.replace('/settings#screen');
  }, [disabled, router]);

  if (settings === undefined && error) {
    return (
      <div role="alert" className="py-24 text-center text-sm text-muted">
        <p>ScreenSprite did not load.</p>
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => void mutate()}>
          Retry
        </Button>
      </div>
    );
  }
  if (settings === undefined || disabled) {
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" label="Loading ScreenSprite" />
      </div>
    );
  }
  return <>{children}</>;
}
