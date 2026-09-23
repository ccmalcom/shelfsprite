'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Shield, User, X } from 'lucide-react';
import useSWR from 'swr';
import { authEnabled, getSupabaseClient } from '@/utils/supabase/client';
import { adminMe, ADMIN_ME_KEY } from '@/lib/api';
import { navRoutesFor, sectionFor } from '@/lib/nav';
import { useScreenSettings } from '@/lib/useScreenSettings';
import SectionSwitch from '@/components/SectionSwitch';
import Wordmark from '@/components/Wordmark';
import FeedbackLauncher from '@/components/FeedbackLauncher';
import FeedbackModal from '@/components/FeedbackModal';
import { Modal } from '@/components/ui';

export default function NavBar() {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  const { enabled: screenEnabled } = useScreenSettings();
  const showSwitch = screenEnabled;
  const { data: me } = useSWR(ADMIN_ME_KEY, adminMe);
  const [accountOpen, setAccountOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const accountButton = useRef<HTMLButtonElement>(null);
  const feedbackFromAccount = useRef(false);
  function closeFeedback() {
    setFeedbackOpen(false);
    if (feedbackFromAccount.current) requestAnimationFrame(() => accountButton.current?.focus());
  }
  async function handleSignOut() {
    const supabase = getSupabaseClient();
    if (supabase) await supabase.auth.signOut();
    window.location.assign('/login');
  }
  function utilityLinks() {
    return (
      <>
        <Link
          href="/settings"
          className="shell-link"
          aria-current={pathname === '/settings' ? 'page' : undefined}
          onClick={() => setAccountOpen(false)}
        >
          Settings
        </Link>
        {me?.is_admin && (
          <Link
            href="/admin"
            className="shell-link"
            aria-current={pathname === '/admin' ? 'page' : undefined}
            onClick={() => setAccountOpen(false)}
          >
            <Shield size={18} aria-hidden="true" /> Admin
          </Link>
        )}
        <FeedbackLauncher
          onOpen={() => {
            feedbackFromAccount.current = accountOpen;
            setAccountOpen(false);
            setFeedbackOpen(true);
          }}
        />
        {authEnabled && (
          <button type="button" className="shell-link w-full" onClick={handleSignOut}>
            <LogOut size={18} aria-hidden="true" /> Sign out
          </button>
        )}
      </>
    );
  }
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:rounded focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <header className="shell-nav">
        <Link
          href={section === 'screen' ? '/screen' : '/'}
          aria-label={section === 'screen' ? 'ScreenSprite home' : 'ShelfSprite home'}
          // One box for both wordmarks, so the section switch holds still between sections: at lg
          // the book logo is ~41.6 px tall and the ScreenSprite mark 28 px; on a phone the switch
          // sits beside a 112 px logo or a 140 px mark.
          className={[
            'shrink-0 rounded lg:flex lg:h-[42px] lg:items-center',
            showSwitch ? 'min-w-[141px] lg:min-w-0' : '',
          ].join(' ')}
        >
          <Wordmark section={section} compact={showSwitch} />
        </Link>
        {showSwitch && <SectionSwitch active={section} className="lg:mt-6 lg:self-start" />}
        <nav
          aria-label="Desktop navigation"
          className="hidden lg:flex lg:flex-1 lg:flex-col lg:gap-1 lg:mt-12"
        >
          {/* No right padding and no wrap: "Your screening room" is 4.5 px wider than the rail's
              text box and would otherwise take two lines. */}
          <p className="mb-3 whitespace-nowrap pl-3 text-[11px] uppercase tracking-[0.18em] text-faint">
            {section === 'screen' ? 'Your screening room' : 'Your reading room'}
          </p>
          {navRoutesFor(section)
            .filter((r) => r.primary)
            .map(({ href, label, Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={pathname === href ? 'page' : undefined}
                className="shell-link"
              >
                <Icon size={19} aria-hidden="true" />
                {label}
              </Link>
            ))}
          <div className="mt-auto border-t border-border pt-4">{utilityLinks()}</div>
        </nav>
        <button
          type="button"
          className="shell-link lg:hidden"
          ref={accountButton}
          onClick={() => setAccountOpen(true)}
          aria-haspopup="dialog"
        >
          <User size={18} aria-hidden="true" />
          <span className={showSwitch ? 'sr-only sm:not-sr-only' : undefined}>Account</span>
        </button>
      </header>
      {feedbackOpen && (
        <FeedbackModal
          heading={'What\u2019s working? What isn\u2019t?'}
          onClose={closeFeedback}
          onResolved={closeFeedback}
        />
      )}
      {accountOpen && (
        <Modal
          labelId="account-title"
          onClose={() => setAccountOpen(false)}
          className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 id="account-title" className="text-xl">
              Your account
            </h2>
            <button
              type="button"
              aria-label="Close account"
              className="p-3"
              onClick={() => setAccountOpen(false)}
            >
              <X size={20} />
            </button>
          </div>
          {utilityLinks()}
        </Modal>
      )}
    </>
  );
}
