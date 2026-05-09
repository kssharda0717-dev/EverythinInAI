/*
 * POLAR LUMINANCE — Discovery Grid (Phase 18)
 * View-mode tabs (All / Trending / Just Added) + category filter pills.
 * Mobile-first responsive: 1 col mobile, 2 col tablet, 3 col desktop.
 * Drawer is full-screen on mobile (handled by SidePeekDrawer max-w-lg w-full).
 */

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Filter, Flame, Sparkles, LayoutGrid } from "lucide-react";
import ToolCard, { ToolCardSkeleton } from "./ToolCard";
import SidePeekDrawer from "./SidePeekDrawer";
import type { AITool } from "@/lib/data";
import { CATEGORIES } from "@/lib/data";

interface DiscoveryGridProps {
  tools: AITool[];
  isLoading?: boolean;
}

type ViewMode = "all" | "trending" | "new";

const VIEW_MODES: { id: ViewMode; label: string; icon: any; description: string }[] = [
  { id: "all",      label: "All",         icon: LayoutGrid, description: "Everything by popularity" },
  { id: "trending", label: "Trending",    icon: Flame,      description: "Hottest in last 30 days" },
  { id: "new",      label: "Just Added",  icon: Sparkles,   description: "Newest discoveries" },
];

export default function DiscoveryGrid({ tools, isLoading = false }: DiscoveryGridProps) {
  const [selectedTool, setSelectedTool] = useState<AITool | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [viewMode, setViewMode] = useState<ViewMode>("all");

  // Apply view mode + category filter
  const filteredTools = useMemo(() => {
    let result = [...tools];

    // View mode sort/filter
    const now = Date.now();
    if (viewMode === "trending") {
      // Trending: tools added in last 30 days, sorted by upvotes desc
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      result = result.filter(t => {
        if (!t.addedAt) return false;
        try { return new Date(t.addedAt).getTime() >= thirtyDaysAgo; }
        catch { return false; }
      });
      result.sort((a, b) => b.upvotes - a.upvotes);
    } else if (viewMode === "new") {
      // Just Added: sort by addedAt desc, top 60
      result.sort((a, b) => {
        const ta = a.addedAt ? new Date(a.addedAt).getTime() : 0;
        const tb = b.addedAt ? new Date(b.addedAt).getTime() : 0;
        return tb - ta;
      });
      result = result.slice(0, 60);
    }
    // For "all", we keep the order from useTools (already sorted by upvotes)

    // Category filter
    if (activeCategory !== "All") {
      result = result.filter(t => t.category === activeCategory);
    }

    return result;
  }, [tools, viewMode, activeCategory]);

  // Get categories that actually have tools (within current view)
  const availableCategories = useMemo(() => {
    const cats = new Set(tools.map((t) => t.category));
    return ["All", ...CATEGORIES.filter((c) => cats.has(c))];
  }, [tools]);

  const handleToolClick = (tool: AITool) => {
    setSelectedTool(tool);
    setDrawerOpen(true);
  };

  return (
    <section className="relative px-4 sm:px-6 lg:px-8 pb-20">
      <div className="max-w-[1400px] mx-auto">
        {/* Section header */}
        <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            <h2 className="text-heading text-foreground">Discovery Stream</h2>
            <span className="text-functional text-muted-foreground/60 mt-1">
              {filteredTools.length} tools
            </span>
          </div>
        </div>

        {/* View mode tabs */}
        <div className="flex items-center gap-1.5 sm:gap-2 mb-5 overflow-x-auto pb-1 scrollbar-hide">
          {VIEW_MODES.map((mode) => {
            const Icon = mode.icon;
            const active = viewMode === mode.id;
            return (
              <button
                key={mode.id}
                onClick={() => setViewMode(mode.id)}
                title={mode.description}
                className={`whitespace-nowrap inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-xl text-xs sm:text-sm font-medium transition-all ${
                  active
                    ? "bg-gradient-to-r from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white shadow-sm"
                    : "bg-white text-muted-foreground hover:text-foreground hover:bg-[oklch(0.97_0.005_230)]"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {mode.label}
              </button>
            );
          })}
        </div>

        {/* Category filter pills */}
        <div className="flex items-center gap-2 mb-7 overflow-x-auto pb-2 scrollbar-hide">
          {availableCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`whitespace-nowrap px-3.5 sm:px-4 py-1.5 sm:py-2 rounded-xl text-xs sm:text-sm font-medium transition-all ${
                activeCategory === cat
                  ? "bg-foreground text-white shadow-sm"
                  : "bg-[oklch(0.97_0.005_230)] text-muted-foreground hover:bg-[oklch(0.94_0.01_230)] hover:text-foreground"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Organic Bento Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-5">
            {Array.from({ length: 9 }).map((_, i) => (
              <ToolCardSkeleton key={i} index={i} />
            ))}
          </div>
        ) : filteredTools.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-20"
          >
            <div className="w-16 h-16 rounded-2xl bg-[oklch(0.96_0.01_230)] flex items-center justify-center mx-auto mb-4">
              <Filter className="w-7 h-7 text-muted-foreground/40" />
            </div>
            <p className="text-lg font-medium text-muted-foreground mb-1">No tools found</p>
            <p className="text-sm text-muted-foreground/60">Try a different view or category</p>
          </motion.div>
        ) : (
          <motion.div
            layout
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-5 auto-rows-auto"
          >
            <AnimatePresence mode="popLayout">
              {filteredTools.map((tool, index) => (
                <motion.div
                  key={tool.id}
                  layout
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                >
                  <ToolCard tool={tool} index={index} onClick={handleToolClick} />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </div>

      {/* Side-Peek Drawer */}
      <SidePeekDrawer
        tool={selectedTool}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </section>
  );
}
