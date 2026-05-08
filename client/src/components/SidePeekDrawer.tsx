/*
 * POLAR LUMINANCE — Side-Peek Drawer
 * Frosted glass drawer that slides from the right.
 * Shows full tool description, URL, tags, and metadata.
 */

import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink, ArrowUpRight, Globe, Tag, DollarSign, Github } from "lucide-react";
import type { AITool } from "@/lib/data";
import { CATEGORY_BADGE_MAP } from "@/lib/data";

interface SidePeekDrawerProps {
  tool: AITool | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function SidePeekDrawer({ tool, isOpen, onClose }: SidePeekDrawerProps) {
  if (!tool) return null;

  const badgeClass = CATEGORY_BADGE_MAP[tool.category] || "badge-other";

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={onClose}
            className="fixed inset-0 z-50 bg-[oklch(0.15_0.01_260_/_20%)] backdrop-blur-sm"
          />

          {/* Drawer */}
          <motion.aside
            initial={{ x: "100%", opacity: 0.5 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "100%", opacity: 0.5 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-lg"
          >
            <div className="h-full glass-strong rounded-l-3xl overflow-y-auto">
              {/* Header */}
              <div className="sticky top-0 z-10 glass-strong px-6 py-4 flex items-center justify-between rounded-tl-3xl">
                <span className={`inline-flex items-center px-3 py-1 rounded-lg text-[0.65rem] font-semibold tracking-wide uppercase ${badgeClass}`}>
                  {tool.category}
                </span>
                <button
                  onClick={onClose}
                  className="w-8 h-8 rounded-xl bg-[oklch(0.95_0.005_230)] hover:bg-[oklch(0.92_0.01_230)] flex items-center justify-center transition-colors"
                >
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>

              {/* Content */}
              <div className="px-6 py-6">
                {/* Tool name */}
                <h2 className="text-heading text-foreground mb-2">{tool.name}</h2>

                {/* Tagline */}
                <p className="text-base text-muted-foreground mb-6 leading-relaxed">
                  {tool.tagline}
                </p>

                {/* Visit button */}
                <a
                  href={tool.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white text-sm font-medium hover:opacity-90 transition-opacity mb-8"
                >
                  <Globe className="w-4 h-4" />
                  Visit {tool.name}
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>

                {/* Divider */}
                <div className="h-px bg-gradient-to-r from-transparent via-[oklch(0.90_0.01_230)] to-transparent mb-6" />

                {/* About — long-form 200-word description */}
                <div className="mb-8">
                  <h3 className="text-sm font-semibold text-foreground mb-3 uppercase tracking-wide">About {tool.name}</h3>
                  <div className="text-[15px] text-foreground/85 leading-[1.7] space-y-3">
                    {(tool.description || tool.tagline || '')
                      .split(/\n+/)
                      .filter(p => p.trim().length > 0)
                      .map((para, i) => <p key={i}>{para}</p>)}
                    {(!tool.description || tool.description.length < 50) && (
                      <p className="italic text-muted-foreground text-xs">
                        Detailed description coming soon — our AI is enriching this tool's profile.
                      </p>
                    )}
                  </div>
                </div>

                {/* Who it's for / Best for */}
                {tool.tags.length > 0 && (
                  <div className="mb-8">
                    <h3 className="text-sm font-semibold text-foreground mb-3 uppercase tracking-wide">Best For</h3>
                    <div className="flex flex-wrap gap-2">
                      {tool.tags.slice(0, 6).map((tag) => (
                        <span
                          key={tag}
                          className="px-3 py-1.5 rounded-full text-xs font-medium bg-gradient-to-br from-[oklch(0.97_0.01_230)] to-[oklch(0.95_0.02_210)] text-foreground border border-[oklch(0.92_0.01_230)]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Metadata grid */}
                <div className="grid grid-cols-2 gap-4 mb-8">
                  <div className="glass rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <ArrowUpRight className="w-3.5 h-3.5 text-[oklch(0.55_0.18_230)]" />
                      <span className="text-functional text-muted-foreground">Upvotes</span>
                    </div>
                    <p className="text-lg font-semibold text-foreground">{tool.upvotes.toLocaleString()}</p>
                  </div>
                  <div className="glass rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <DollarSign className="w-3.5 h-3.5 text-[oklch(0.55_0.18_230)]" />
                      <span className="text-functional text-muted-foreground">Pricing</span>
                    </div>
                    <p className="text-lg font-semibold text-foreground capitalize">
                      {tool.pricing === "open_source" ? "Open Source" : tool.pricing}
                    </p>
                  </div>
                </div>

                {/* Secondary source link (GitHub etc.) shown only if different from primary */}
                {tool.sourceUrl && (
                  <a
                    href={tool.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors mb-6"
                  >
                    <Github className="w-3.5 h-3.5" />
                    View source on {tool.sourceUrl.includes('github') ? 'GitHub' : 'source'}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}

                {/* Discovery source attribution (small footnote) */}
                <div className="flex items-center gap-3 pt-6 mt-6 border-t border-[oklch(0.92_0.01_230)/_0.5]">
                  <span className="text-[0.65rem] text-muted-foreground/60 uppercase tracking-wider">
                    Discovered via {tool.source.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
