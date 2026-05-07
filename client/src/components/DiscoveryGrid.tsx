/*
 * POLAR LUMINANCE — Discovery Grid
 * "Floating Ice Sheet" organic bento layout.
 * CSS grid with staggered column spans and varying heights.
 */

import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Filter, LayoutGrid, List } from "lucide-react";
import ToolCard, { ToolCardSkeleton } from "./ToolCard";
import SidePeekDrawer from "./SidePeekDrawer";
import type { AITool } from "@/lib/data";
import { CATEGORIES } from "@/lib/data";

interface DiscoveryGridProps {
  tools: AITool[];
  isLoading?: boolean;
}

export default function DiscoveryGrid({ tools, isLoading = false }: DiscoveryGridProps) {
  const [selectedTool, setSelectedTool] = useState<AITool | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string>("All");

  const filteredTools = useMemo(() => {
    if (activeCategory === "All") return tools;
    return tools.filter((t) => t.category === activeCategory);
  }, [tools, activeCategory]);

  // Get categories that actually have tools
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
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h2 className="text-heading text-foreground">Discovery Stream</h2>
            <span className="text-functional text-muted-foreground/60 mt-1">
              {filteredTools.length} tools
            </span>
          </div>
        </div>

        {/* Category filter pills */}
        <div className="flex items-center gap-2 mb-8 overflow-x-auto pb-2 scrollbar-hide">
          {availableCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={`whitespace-nowrap px-4 py-2 rounded-xl text-sm font-medium transition-all ${
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
            <p className="text-sm text-muted-foreground/60">Try a different search or category</p>
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
                  // Staggered heights: every 4th and 5th card spans 2 rows on large screens
                  className={
                    index % 7 === 0
                      ? "lg:row-span-1"
                      : ""
                  }
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
