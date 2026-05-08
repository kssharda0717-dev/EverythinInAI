/*
 * POLAR LUMINANCE — Navbar
 * Frosted glass navigation bar that floats above content.
 * Minimal: logo + nav links + magnetic Launchpad CTA.
 */

import { motion, useScroll, useTransform } from "framer-motion";
import { Sparkles, Rocket } from "lucide-react";
import { Link, useLocation } from "wouter";
import MagneticButton from "./MagneticButton";

export default function Navbar() {
  const [location, setLocation] = useLocation();

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

          {/* Nav Links */}
          <div className="flex items-center gap-1">
            <Link href="/">
              <div
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
                  location === "/"
                    ? "bg-[oklch(0.94_0.01_230)] text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-[oklch(0.97_0.005_230)]"
                }`}
              >
                Discover
              </div>
            </Link>
            <MagneticButton strength={0.2}>
              <Link href="/launchpad">
                <div
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 flex items-center gap-1.5 ${
                    location === "/launchpad"
                      ? "bg-gradient-to-r from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white shadow-sm"
                      : "text-muted-foreground hover:text-foreground hover:bg-[oklch(0.97_0.005_230)]"
                  }`}
                >
                  <Rocket className="w-3.5 h-3.5" />
                  Launchpad
                </div>
              </Link>
            </MagneticButton>
          </div>
        </motion.nav>
      </div>
    </motion.header>
  );
}
