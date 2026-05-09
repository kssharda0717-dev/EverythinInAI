/*
 * POLAR LUMINANCE — Footer (B15: full footer with sections + legal + social + contact)
 * Three-column responsive layout on desktop, single stacked column on mobile.
 */

import { Sparkles, Github, Twitter, Mail, Activity } from "lucide-react";
import { Link } from "wouter";

export default function Footer() {
  return (
    <footer className="relative mt-12">
      {/* Ice fracture divider */}
      <div className="h-px bg-gradient-to-r from-transparent via-[oklch(0.88_0.03_230)] to-transparent" />

      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 mb-10">
          {/* Brand column */}
          <div className="lg:col-span-1 sm:col-span-2">
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-[oklch(0.75_0.12_230)] to-[oklch(0.82_0.12_185)] flex items-center justify-center">
                <Sparkles className="w-3.5 h-3.5 text-white" />
              </div>
              <span className="text-sm font-semibold tracking-tight text-foreground">
                Everythin<span className="text-[oklch(0.55_0.18_230)]">InAI</span>
              </span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-[280px]">
              The most comprehensive real-time directory of AI tools. Refreshed every 6 hours, with daily backfill.
            </p>
            <div className="flex items-center gap-2 mt-4">
              <a
                href="https://github.com/kssharda0717-dev/EverythinInAI"
                target="_blank"
                rel="noopener noreferrer"
                className="w-8 h-8 rounded-lg bg-[oklch(0.97_0.005_230)] hover:bg-[oklch(0.94_0.01_230)] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                aria-label="GitHub"
              >
                <Github className="w-3.5 h-3.5" />
              </a>
              <a
                href="https://twitter.com/intent/follow?screen_name=everythininai"
                target="_blank"
                rel="noopener noreferrer"
                className="w-8 h-8 rounded-lg bg-[oklch(0.97_0.005_230)] hover:bg-[oklch(0.94_0.01_230)] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Twitter"
              >
                <Twitter className="w-3.5 h-3.5" />
              </a>
              <a
                href="mailto:hello@everythininai.com"
                className="w-8 h-8 rounded-lg bg-[oklch(0.97_0.005_230)] hover:bg-[oklch(0.94_0.01_230)] flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Contact"
              >
                <Mail className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>

          {/* Explore column */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground mb-3">Explore</h3>
            <ul className="space-y-2">
              <li>
                <Link href="/">
                  <span className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    Discover
                  </span>
                </Link>
              </li>
              <li>
                <Link href="/launchpad">
                  <span className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    Launchpad
                  </span>
                </Link>
              </li>
              <li>
                <Link href="/?q=trending">
                  <span className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    Trending tools
                  </span>
                </Link>
              </li>
              <li>
                <Link href="/?q=new">
                  <span className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    Just added
                  </span>
                </Link>
              </li>
            </ul>
          </div>

          {/* Resources column */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground mb-3">Resources</h3>
            <ul className="space-y-2">
              <li>
                <a
                  href="https://github.com/kssharda0717-dev/EverythinInAI"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="mailto:hello@everythininai.com"
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Contact
                </a>
              </li>
              <li>
                <a
                  href="mailto:hello@everythininai.com?subject=Submit%20a%20tool"
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Submit a tool
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/kssharda0717-dev/EverythinInAI/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Report issue
                </a>
              </li>
            </ul>
          </div>

          {/* Legal column */}
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground mb-3">Legal</h3>
            <ul className="space-y-2">
              <li>
                <Link href="/privacy">
                  <span className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    Privacy Policy
                  </span>
                </Link>
              </li>
              <li>
                <Link href="/terms">
                  <span className="text-sm text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    Terms of Service
                  </span>
                </Link>
              </li>
              <li>
                <a
                  href="mailto:hello@everythininai.com?subject=DMCA%20Takedown"
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  DMCA / Removal
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom strip */}
        <div className="pt-8 border-t border-[oklch(0.94_0.01_230)] flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground/70">
            © {new Date().getFullYear()} EverythinInAI · Built with intelligence.
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[oklch(0.72_0.18_150)] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[oklch(0.72_0.18_150)]"></span>
            </span>
            <Activity className="w-3 h-3" />
            <span>Engine: live · refreshing every 6 hours</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
