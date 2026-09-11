'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogOut, Shield, User, X } from 'lucide-react';
import useSWR from 'swr';
import { authEnabled, getSupabaseClient } from '@/utils/supabase/client';
import { adminMe, ADMIN_ME_KEY } from '@/lib/api';
import { NAV_ROUTES } from '@/lib/nav';
import BrandLogo from '@/components/BrandLogo';
import FeedbackLauncher from '@/components/FeedbackLauncher';
import FeedbackModal from '@/components/FeedbackModal';
import { Modal } from '@/components/ui';

export default function NavBar() {
  const pathname = usePathname();
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
        <Link href="/" aria-label="ShelfSprite home" className="shrink-0 rounded">
          <BrandLogo alt="" priority sizes="160px" className="h-auto w-[150px] lg:w-[170px]" />
        </Link>
        <nav
          aria-label="Desktop navigation"
          className="hidden lg:flex lg:flex-1 lg:flex-col lg:gap-1 lg:mt-12"
        >
          <p className="mb-3 px-3 text-[11px] uppercase tracking-[0.18em] text-faint">
            Your reading room
          </p>
          {NAV_ROUTES.filter((r) => r.primary).map(({ href, label, Icon }) => (
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
          <User size={18} aria-hidden="true" /> Account
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
