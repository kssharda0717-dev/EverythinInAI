/*
 * POLAR LUMINANCE — Navbar
 * Frosted glass navigation bar that floats above content.
 * Minimal: logo + nav links + magnetic Launchpad CTA.
 */

import { useState } from "react";
import { motion, useScroll, useTransform, AnimatePresence } from "framer-motion";
import { Sparkles, Rocket, Mail, X } from "lucide-react";
import { Link, useLocation } from "wouter";
import MagneticButton from "./MagneticButton";
import NewsletterSignup from "./NewsletterSignup";

export default function Navbar() {
  const [location, setLocation] = useLocation();
  const [newsletterOpen, setNewsletterOpen] = useState(false);

  // Logo click — if already on home, force a full reset (scroll top + reload state).
  // This ensures any in-page search filter clears even when wouter doesn't unmount the page.
  const handleLogoClick = (e: React.MouseEvent) => {
    if (location === '/') {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      // Soft reset: dispatch a custom event Home listens for
      window.dispatchEvent(new CustomEvent('reset-home-filters'));
    } else {
      setLocation('/');
    }
  };
  const { scrollY } = useScroll();
  const bgOpacity = useTransform(scrollY, [0, 100], [0.65, 0.9]);
  const shadowOpacity = useTransform(scrollY, [0, 100], [0, 0.08]);

  return (
    <motion.header
      initial={{ y: -20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 100, damping: 20 }}
      className="fixed top-0 left-0 right-0 z-50"
    >
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 pt-4">
        <motion.nav
          style={{
            backgroundColor: `oklch(1 0 0 / ${bgOpacity})`,
            boxShadow: `0 4px 24px oklch(0.70 0.03 230 / ${shadowOpacity})`,
          }}
          className="backdrop-blur-xl backdrop-saturate-150 rounded-2xl px-6 py-3 flex items-center justify-between"
        >
          {/* Logo */}
          <a href="/" onClick={handleLogoClick} className="cursor-pointer">
            <div className="flex items-center gap-2.5 group">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[oklch(0.75_0.12_230)] to-[oklch(0.82_0.12_185)] flex items-center justify-center shadow-sm">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <span className="text-lg font-semibold tracking-tight text-foreground">
                Everythin<span className="text-[oklch(0.55_0.18_230)]">InAI</span>
              </span>
            </div>
          </a>

          {/* Nav Links — mobile-responsive: text labels hidden on smallest screens */}
          <div className="flex items-center gap-1">
            <Link href="/">
              <div
                className={`hidden sm:block px-3 sm:px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
                  location === "/"
                    ? "bg-[oklch(0.94_0.01_230)] text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-[oklch(0.97_0.005_230)]"
                }`}
              >
                Discover
              </div>
            </Link>
            <Link href="/launchpad">
              <div
                className={`px-3 sm:px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 flex items-center gap-1.5 ${
                  location === "/launchpad"
                    ? "bg-[oklch(0.94_0.01_230)] text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-[oklch(0.97_0.005_230)]"
                }`}
              >
                <Rocket className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Launchpad</span>
              </div>
            </Link>
            {/* Newsletter pill */}
            <MagneticButton strength={0.2}>
              <button
                onClick={() => setNewsletterOpen(true)}
                className="ml-1 px-3 sm:px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 flex items-center gap-1.5 bg-gradient-to-r from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white shadow-sm hover:opacity-90"
              >
                <Mail className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Get the brief</span>
              </button>
            </MagneticButton>
          </div>
        </motion.nav>
      </div>

      {/* Newsletter modal */}
      <AnimatePresence>
        {newsletterOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setNewsletterOpen(false)}
              className="fixed inset-0 z-50 bg-[oklch(0.15_0.01_260_/_30%)] backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              className="fixed left-1/2 top-1/2 z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 bg-white rounded-3xl elevation-3 p-8"
            >
              <div className="flex items-start justify-between mb-5">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] flex items-center justify-center">
                    <Mail className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-xl font-semibold text-foreground">The 8 AM AI brief</h3>
                    <p className="text-sm text-muted-foreground">3 tools, 2 stories, 1 take. Daily, in your inbox.</p>
                  </div>
                </div>
                <button
                  onClick={() => setNewsletterOpen(false)}
                  className="w-8 h-8 rounded-xl bg-[oklch(0.95_0.005_230)] hover:bg-[oklch(0.92_0.01_230)] flex items-center justify-center transition-colors"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
              <NewsletterSignup compact />
              <p className="text-xs text-muted-foreground/70 mt-4">
                Sent every weekday at 8 AM IST. Unsubscribe anytime in 1 click.
              </p>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </motion.header>
  );
}
