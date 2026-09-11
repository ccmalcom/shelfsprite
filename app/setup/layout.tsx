/**
 * Isolated layout for the setup wizard — no nav, no repro-profile banner.
 * The user hasn't imported their library yet, so there's nothing to navigate to.
 */
export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-base text-text antialiased">
      <main className="mx-auto max-w-3xl px-4 pb-16 pt-8">{children}</main>
    </div>
  );
}
