/*
 * POLAR LUMINANCE — Navbar (B2 + B7 fixed)
 * - Mobile (<md): logo + hamburger that opens an overlay sheet with all links
 * - Desktop (>=md): logo + nav links + CTA pill
 * - No nested buttons (MagneticButton renders a single <button>, no inner one)
 */

import { useState } from "react";
import { motion, useScroll, useTransform, AnimatePresence } from "framer-motion";
import { Sparkles, Rocket, Mail, X, Menu } from "lucide-react";
import { Link, useLocation } from "wouter";
import NewsletterSignup from "./NewsletterSignup";

export default function Navbar() {
  const [location, setLocation] = useLocation();
  const [newsletterOpen, setNewsletterOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const handleLogoClick = (e: React.MouseEvent) => {
    if (location === '/') {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      window.dispatchEvent(new CustomEvent('reset-home-filters'));
    } else {
      setLocation('/');
    }
    setMenuOpen(false);
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
      <div className="mx-auto max-w-[1400px] px-3 sm:px-6 lg:px-8 pt-3 sm:pt-4">
        <motion.nav
          style={{
            backgroundColor: `oklch(1 0 0 / ${bgOpacity})`,
            boxShadow: `0 4px 24px oklch(0.70 0.03 230 / ${shadowOpacity})`,
          }}
          className="backdrop-blur-xl backdrop-saturate-150 rounded-2xl px-4 sm:px-6 py-2.5 sm:py-3 flex items-center justify-between"
        >
          {/* Logo */}
          <a
            href="/"
            onClick={handleLogoClick}
            className="cursor-pointer flex items-center gap-2.5 group flex-shrink-0"
            aria-label="EverythinInAI home"
          >
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-[oklch(0.75_0.12_230)] to-[oklch(0.82_0.12_185)] flex items-center justify-center shadow-sm">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="text-base sm:text-lg font-semibold tracking-tight text-foreground">
              Everythin<span className="text-[oklch(0.55_0.18_230)]">InAI</span>
            </span>
          </a>

          {/* DESKTOP NAV (md+) */}
          <div className="hidden md:flex items-center gap-1">
            <Link href="/">
              <div
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 cursor-pointer ${
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
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                  location === "/launchpad"
                    ? "bg-[oklch(0.94_0.01_230)] text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-[oklch(0.97_0.005_230)]"
                }`}
              >
                <Rocket className="w-3.5 h-3.5" />
                Launchpad
              </div>
            </Link>
            <button
              onClick={() => setNewsletterOpen(true)}
              className="ml-1 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 flex items-center gap-1.5 bg-gradient-to-r from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white shadow-sm hover:opacity-90"
            >
              <Mail className="w-3.5 h-3.5" />
              Get the brief
            </button>
          </div>

          {/* MOBILE HAMBURGER (<md) */}
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="md:hidden w-10 h-10 rounded-xl bg-[oklch(0.97_0.005_230)] hover:bg-[oklch(0.94_0.01_230)] flex items-center justify-center transition-colors"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="w-5 h-5 text-foreground" /> : <Menu className="w-5 h-5 text-foreground" />}
          </button>
        </motion.nav>
      </div>

      {/* MOBILE MENU SHEET */}
      <AnimatePresence>
        {menuOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setMenuOpen(false)}
              className="md:hidden fixed inset-0 z-40 bg-[oklch(0.15_0.01_260_/_30%)] backdrop-blur-md"
            />
            <motion.div
              initial={{ y: -20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -20, opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 25 }}
              className="md:hidden fixed top-[68px] left-3 right-3 z-50 bg-white rounded-2xl elevation-3 p-3 flex flex-col gap-1"
            >
              <Link href="/">
                <div
                  onClick={() => setMenuOpen(false)}
                  className={`px-4 py-3 rounded-xl text-base font-medium cursor-pointer flex items-center gap-3 ${
                    location === "/"
                      ? "bg-[oklch(0.94_0.01_230)] text-foreground"
                      : "text-muted-foreground hover:bg-[oklch(0.97_0.005_230)] hover:text-foreground"
                  }`}
                >
                  <Sparkles className="w-4 h-4" />
                  Discover
                </div>
              </Link>
              <Link href="/launchpad">
                <div
                  onClick={() => setMenuOpen(false)}
                  className={`px-4 py-3 rounded-xl text-base font-medium cursor-pointer flex items-center gap-3 ${
                    location === "/launchpad"
                      ? "bg-[oklch(0.94_0.01_230)] text-foreground"
                      : "text-muted-foreground hover:bg-[oklch(0.97_0.005_230)] hover:text-foreground"
                  }`}
                >
                  <Rocket className="w-4 h-4" />
                  Launchpad
                </div>
              </Link>
              <button
                onClick={() => { setNewsletterOpen(true); setMenuOpen(false); }}
                className="mt-1 px-4 py-3 rounded-xl text-base font-medium flex items-center justify-center gap-2 bg-gradient-to-r from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white shadow-sm hover:opacity-90"
              >
                <Mail className="w-4 h-4" />
                Get the brief
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* NEWSLETTER MODAL */}
      <AnimatePresence>
        {newsletterOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setNewsletterOpen(false)}
              className="fixed inset-0 z-[60] bg-[oklch(0.15_0.01_260_/_30%)] backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: 'spring', stiffness: 300, damping: 25 }}
              className="fixed left-1/2 top-1/2 z-[60] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 bg-white rounded-3xl elevation-3 p-6 sm:p-8"
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
                  aria-label="Close"
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
