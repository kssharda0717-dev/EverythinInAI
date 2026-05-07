/*
 * POLAR LUMINANCE — Side-Peek Drawer
 * Frosted glass drawer that slides from the right.
 * Shows full tool description, URL, tags, and metadata.
 */

import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink, ArrowUpRight, Globe, Tag, Clock } from "lucide-react";
import type { AITool } from "@/lib/data";
import { CATEGORY_BADGE_MAP, formatTimeAgo } from "@/lib/data";

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

                {/* Description */}
                <div className="mb-8">
                  <h3 className="text-functional text-muted-foreground mb-3">About</h3>
                  <p className="text-sm text-foreground/80 leading-relaxed">
                    {tool.description}
                  </p>
                </div>

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
                      <Clock className="w-3.5 h-3.5 text-[oklch(0.55_0.18_230)]" />
                      <span className="text-functional text-muted-foreground">Discovered</span>
                    </div>
                    <p className="text-lg font-semibold text-foreground">{formatTimeAgo(tool.publishedAt)}</p>
                  </div>
                </div>

                {/* Tags */}
                {tool.tags.length > 0 && (
                  <div className="mb-8">
                    <div className="flex items-center gap-2 mb-3">
                      <Tag className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-functional text-muted-foreground">Tags</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {tool.tags.map((tag) => (
                        <span
                          key={tag}
                          className="px-3 py-1 rounded-lg text-xs font-medium bg-[oklch(0.96_0.005_230)] text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Source + Pricing */}
                <div className="flex items-center gap-3">
                  <span className="text-functional text-muted-foreground/60">
                    Source: {tool.source.replace("_", " ")}
                  </span>
                  <span className="text-muted-foreground/30">|</span>
                  <span className="text-functional text-muted-foreground/60 capitalize">
                    {tool.pricing === "open_source" ? "open source" : tool.pricing}
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
