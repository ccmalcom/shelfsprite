/**
 * Chrome-free layout for the public marketing page. Deliberately omits NavBar, BottomNav,
 * LibraryGate, ReprofileBanner, UsageWarningBanner, FeedbackLauncher and the Providers wrapper:
 * every one of them assumes a session, and the entire audience for this route group is signed
 * out. The root layout still supplies <html>, the fonts and ToastProvider.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-base text-text">{children}</div>;
}
