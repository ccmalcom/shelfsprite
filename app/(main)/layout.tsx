import NavBar from '@/components/NavBar';
import ReprofileBanner from '@/components/ReprofileBanner';
import UsageWarningBanner from '@/components/UsageWarningBanner';
import LibraryGate from '@/components/LibraryGate';
import BottomNav from '@/components/BottomNav';
import Providers from '@/app/providers';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <div className="app-shell min-h-screen bg-base">
        <NavBar />
        <div className="lg:ml-[220px]">
          <ReprofileBanner />
          <UsageWarningBanner />
          <main
            id="main-content"
            className="mx-auto max-w-[1200px] px-5 pb-28 pt-6 sm:px-8 lg:px-12 lg:pb-16 lg:pt-10"
          >
            {/* On /, /swipe, /library a user with no library sees the setup wizard inline
            (see LibraryGate); other routes pass through untouched. */}
            <LibraryGate>{children}</LibraryGate>
          </main>
        </div>
        <BottomNav />
      </div>
    </Providers>
  );
}
