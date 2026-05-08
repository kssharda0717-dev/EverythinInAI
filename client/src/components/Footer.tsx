/*
 * POLAR LUMINANCE — Footer
 * Minimal, clean footer with ice-fracture divider.
 */

import { Sparkles, Github } from "lucide-react";
import { Link } from "wouter";

export default function Footer() {
  return (
    <footer className="relative mt-12">
      {/* Ice fracture divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-[oklch(0.88_0.03_230)] to-transparent" />

      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[oklch(0.75_0.12_230)] to-[oklch(0.82_0.12_185)] flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-sm font-semibold tracking-tight text-foreground">
              Everythin<span className="text-[oklch(0.55_0.18_230)]">InAI</span>
            </span>
          </div>

          {/* Links */}
          <div className="flex items-center gap-6">
            <Link href="/">
              <span className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                Discover
              </span>
            </Link>
            <Link href="/launchpad">
              <span className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                Launchpad
              </span>
            </Link>
            <a
              href="https://github.com/kssharda0717-dev/EverythinInAI"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <Github className="w-4 h-4" />
            </a>
          </div>

          {/* Copyright */}
          <p className="text-xs text-muted-foreground/50">
            © EverythinInAI · Built with intelligence.
          </p>
        </div>
      </div>
    </footer>
  );
}
