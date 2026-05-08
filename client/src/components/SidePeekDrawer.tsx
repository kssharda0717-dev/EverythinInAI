/*
 * EverythinInAI — Side-Peek Drawer (v3: lazy-fill + structured sections)
 *
 * Tool detail drawer with:
 *   - Friendly display name
 *   - 200-word About
 *   - Best for (one-line)
 *   - Use cases (3-5 bullets)
 *   - Key features (3-5 bullets)
 *   - Pros / Cons (side by side)
 *   - Pricing + secondary GitHub link
 *
 * Lazy-fill: if tool is missing structured fields, fetches /api/enrich-on-demand
 * to populate them in real time before showing.
 */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink, Globe, DollarSign, Github, CheckCircle2, XCircle, Sparkles, Target, Zap, Loader2 } from "lucide-react";
import type { AITool } from "@/lib/data";
import { CATEGORY_BADGE_MAP } from "@/lib/data";

interface SidePeekDrawerProps {
  tool: AITool | null;
  isOpen: boolean;
  onClose: () => void;
}

function Section({ icon: Icon, title, children }: { icon: any; title: string; children: React.ReactNode }) {
  return (
    <div className="mb-7">
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-[oklch(0.55_0.18_230)]" />
        <h3 className="text-xs font-semibold text-foreground uppercase tracking-wider">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function BulletList({ items, accent = "default" }: { items: string[]; accent?: "default" | "green" | "red" }) {
  if (!items || items.length === 0) return null;
  const dotColor =
    accent === "green"
      ? "bg-green-500"
      : accent === "red"
        ? "bg-red-400"
        : "bg-[oklch(0.55_0.18_230)]";
  return (
    <ul className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2.5 text-sm text-foreground/85 leading-relaxed">
          <span className={`mt-2 w-1.5 h-1.5 rounded-full ${dotColor} flex-shrink-0`} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function SidePeekDrawer({ tool, isOpen, onClose }: SidePeekDrawerProps) {
  const [enrichedTool, setEnrichedTool] = useState<AITool | null>(tool);
  const [isEnriching, setIsEnriching] = useState(false);

  useEffect(() => {
    setEnrichedTool(tool);
    if (!tool || !isOpen) return;
    const isStructured =
      (tool.useCases && tool.useCases.length > 0) ||
      (tool.keyFeatures && tool.keyFeatures.length > 0);
    if (isStructured) return;

    setIsEnriching(true);
    fetch("/api/enrich-on-demand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: tool.id }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.tool) {
          setEnrichedTool({
            ...tool,
            displayName: data.tool.display_name || tool.displayName || tool.name,
            description: data.tool.description || tool.description,
            useCases: data.tool.use_cases || [],
            keyFeatures: data.tool.key_features || [],
            pros: data.tool.pros || [],
            cons: data.tool.cons || [],
            bestFor: data.tool.best_for || "",
          });
        }
      })
      .catch(() => {
        /* silent fail; user still sees tagline */
      })
      .finally(() => setIsEnriching(false));
  }, [tool, isOpen]);

  if (!tool) return null;
  const t = enrichedTool || tool;

  const badgeClass = CATEGORY_BADGE_MAP[t.category] || "badge-other";
  const displayName = t.displayName || t.name;

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
                {isEnriching && (
                  <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Enriching with AI...
                  </div>
                )}
                <span className={`inline-flex items-center px-3 py-1 rounded-lg text-[0.65rem] font-semibold tracking-wide uppercase ${badgeClass}`}>
                  {t.category}
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
                <h2 className="text-2xl font-bold text-foreground mb-1.5 leading-tight">{displayName}</h2>

                {/* Tagline */}
                <p className="text-base text-muted-foreground mb-6 leading-relaxed">
                  {t.tagline}
                </p>

                {/* Visit button */}
                <a
                  href={t.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white text-sm font-medium hover:opacity-90 transition-opacity mb-2"
                >
                  <Globe className="w-4 h-4" />
                  Visit {t.name}
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>

                {t.sourceUrl && (
                  <div className="mb-7">
                    <a
                      href={t.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Github className="w-3.5 h-3.5" />
                      View source on {t.sourceUrl.includes("github") ? "GitHub" : "source"}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                )}

                {/* Best for one-liner */}
                {t.bestFor && (
                  <div className="mb-7 p-4 rounded-2xl bg-gradient-to-br from-[oklch(0.97_0.01_230)] to-[oklch(0.95_0.02_210)]">
                    <div className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                      Best for
                    </div>
                    <p className="text-sm text-foreground/90 leading-relaxed">{t.bestFor}</p>
                  </div>
                )}

                {/* Divider */}
                <div className="h-px bg-gradient-to-r from-transparent via-[oklch(0.90_0.01_230)] to-transparent mb-6" />

                {/* About */}
                <Section icon={Sparkles} title={`About ${displayName}`}>
                  <div className="text-[15px] text-foreground/85 leading-[1.7] space-y-3">
                    {(t.description || t.tagline || "")
                      .split(/\n+/)
                      .filter((p) => p.trim().length > 0)
                      .map((para, i) => (
                        <p key={i}>{para}</p>
                      ))}
                    {(!t.description || t.description.length < 50) && !isEnriching && (
                      <p className="italic text-muted-foreground text-xs">
                        Detailed description coming soon — our AI is enriching this tool's profile.
                      </p>
                    )}
                  </div>
                </Section>

                {/* Use Cases */}
                {t.useCases && t.useCases.length > 0 && (
                  <Section icon={Target} title="Use Cases">
                    <BulletList items={t.useCases} accent="default" />
                  </Section>
                )}

                {/* Key Features */}
                {t.keyFeatures && t.keyFeatures.length > 0 && (
                  <Section icon={Zap} title="Key Features">
                    <BulletList items={t.keyFeatures} accent="default" />
                  </Section>
                )}

                {/* Pros / Cons side by side */}
                {((t.pros && t.pros.length > 0) || (t.cons && t.cons.length > 0)) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-7">
                    {t.pros && t.pros.length > 0 && (
                      <div className="p-4 rounded-2xl bg-green-50/50">
                        <div className="flex items-center gap-2 mb-3">
                          <CheckCircle2 className="w-4 h-4 text-green-600" />
                          <h3 className="text-xs font-semibold text-green-900 uppercase tracking-wider">Pros</h3>
                        </div>
                        <BulletList items={t.pros} accent="green" />
                      </div>
                    )}
                    {t.cons && t.cons.length > 0 && (
                      <div className="p-4 rounded-2xl bg-red-50/40">
                        <div className="flex items-center gap-2 mb-3">
                          <XCircle className="w-4 h-4 text-red-500" />
                          <h3 className="text-xs font-semibold text-red-900 uppercase tracking-wider">Cons</h3>
                        </div>
                        <BulletList items={t.cons} accent="red" />
                      </div>
                    )}
                  </div>
                )}

                {/* Pricing tile */}
                <div className="p-4 rounded-2xl bg-[oklch(0.97_0.005_230)] mb-6">
                  <div className="flex items-center gap-2 mb-1">
                    <DollarSign className="w-4 h-4 text-[oklch(0.55_0.18_230)]" />
                    <span className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-semibold">Pricing</span>
                  </div>
                  <p className="text-base font-semibold text-foreground capitalize">
                    {t.pricing === "open_source" ? "Open Source" : t.pricing}
                  </p>
                </div>

                {/* Tags */}
                {t.tags.length > 0 && (
                  <div className="mb-6">
                    <div className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-semibold mb-3">
                      Categories &amp; Tags
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {t.tags.slice(0, 8).map((tag) => (
                        <span
                          key={tag}
                          className="px-3 py-1.5 rounded-full text-xs font-medium bg-white text-foreground border border-[oklch(0.92_0.01_230)]"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Discovery source attribution */}
                <div className="flex items-center gap-3 pt-6 mt-2 border-t border-[oklch(0.92_0.01_230)/_0.5]">
                  <span className="text-[0.65rem] text-muted-foreground/60 uppercase tracking-wider">
                    Discovered via {t.source.replace(/_/g, " ")}
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
