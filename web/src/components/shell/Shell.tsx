import { TopBar } from "./TopBar";
import { BottomBar } from "./BottomBar";
import { Footer } from "./Footer";
import { DeploymentBanner } from "./DeploymentBanner";

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <TopBar />
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[1280px] flex-1 px-6 pb-28 pt-6 md:pb-12">
        <DeploymentBanner />
        {children}
      </main>
      <Footer />
      <BottomBar />
    </div>
  );
}
