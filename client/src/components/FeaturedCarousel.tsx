/*
 * POLAR LUMINANCE — Featured Carousel
 * Horizontal scrolling strip of featured/trending tools.
 * Large cards with gradient overlays and the generated hero image.
 */

import { motion } from "framer-motion";
import { useRef } from "react";
import { ArrowRight, Star, ChevronLeft, ChevronRight } from "lucide-react";
import type { AITool } from "@/lib/data";
import { CATEGORY_BADGE_MAP } from "@/lib/data";

interface FeaturedCarouselProps {
  tools: AITool[];
  onToolClick: (tool: AITool) => void;
}

export default function FeaturedCarousel({ tools, onToolClick }: FeaturedCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollBy = (dir: 1 | -1) => {
    if (!scrollRef.current) return;
    const cardWidth = 360 + 16;
    scrollRef.current.scrollBy({ left: dir * cardWidth, behavior: 'smooth' });
  };
  // B12: graceful empty state when nothing trending
  if (tools.length === 0) {
    return (
      <section className="px-4 sm:px-6 lg:px-8 mb-14">
        <div className="max-w-[1400px] mx-auto">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[oklch(0.75_0.12_230)] to-[oklch(0.82_0.12_185)] flex items-center justify-center">
              <Star className="w-3 h-3 text-white fill-white" />
            </div>
            <h2 className="text-heading text-foreground">Trending Now</h2>
          </div>
          <div className="rounded-2xl bg-[oklch(0.97_0.005_230)] px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">No trending tools right now — check back in a few hours.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="px-4 sm:px-6 lg:px-8 mb-14">
      <div className="max-w-[1400px] mx-auto">
        {/* Section header (B8: scroll buttons) */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-[oklch(0.75_0.12_230)] to-[oklch(0.82_0.12_185)] flex items-center justify-center">
              <Star className="w-3 h-3 text-white fill-white" />
            </div>
            <h2 className="text-heading text-foreground">Trending Now</h2>
          </div>
          <div className="hidden sm:flex items-center gap-1.5">
            <button
              onClick={() => scrollBy(-1)}
              className="w-9 h-9 rounded-xl bg-white hover:bg-[oklch(0.97_0.005_230)] elevation-1 flex items-center justify-center transition-colors"
              aria-label="Scroll left"
            >
              <ChevronLeft className="w-4 h-4 text-foreground" />
            </button>
            <button
              onClick={() => scrollBy(1)}
              className="w-9 h-9 rounded-xl bg-white hover:bg-[oklch(0.97_0.005_230)] elevation-1 flex items-center justify-center transition-colors"
              aria-label="Scroll right"
            >
              <ChevronRight className="w-4 h-4 text-foreground" />
            </button>
          </div>
        </div>

        {/* Horizontal scroll */}
        <div ref={scrollRef} className="flex gap-4 overflow-x-auto pb-4 scrollbar-hide -mx-4 px-4 snap-x snap-mandatory scroll-smooth">
          {tools.map((tool, index) => {
            const badgeClass = CATEGORY_BADGE_MAP[tool.category] || "badge-other";
            return (
              <motion.div
                key={tool.id}
                initial={{ opacity: 0, x: 30 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  delay: index * 0.1,
                  type: "spring",
                  stiffness: 100,
                  damping: 20,
                }}
                whileHover={{
                  y: -4,
                  transition: { type: "spring", stiffness: 300, damping: 20 },
                }}
                onClick={() => onToolClick(tool)}
                className="shrink-0 w-[320px] sm:w-[360px] snap-start cursor-pointer"
              >
                <div className="relative rounded-3xl overflow-hidden bg-gradient-to-br from-[oklch(0.15_0.01_260)] to-[oklch(0.25_0.03_230)] h-[200px] p-6 flex flex-col justify-end group">
                  {/* Background mesh gradient */}
                  <div
                    className="absolute inset-0 opacity-30 bg-cover bg-center"
                    style={{
                      backgroundImage: `url(https://d2xsxph8kpxj0f.cloudfront.net/310519663529896497/QBqeAVQQED5JYrhp7rE5AR/abstract-mesh-gradient-4uLazc2jw95wUsgYWapbQQ.webp)`,
                    }}
                  />

                  {/* Gradient overlay */}
                  <div className="absolute inset-0 bg-gradient-to-t from-[oklch(0.10_0.01_260_/_90%)] via-[oklch(0.15_0.01_260_/_40%)] to-transparent" />

                  {/* Content */}
                  <div className="relative z-10">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-[0.6rem] font-semibold tracking-wide uppercase mb-2 ${badgeClass}`}>
                      {tool.category}
                    </span>
                    <h3 className="text-white text-lg font-semibold mb-1">{tool.name}</h3>
                    <p className="text-white/60 text-sm line-clamp-1">{tool.tagline}</p>
                  </div>

                  {/* Hover arrow */}
                  <div className="absolute top-4 right-4 w-8 h-8 rounded-xl bg-white/10 backdrop-blur-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <ArrowRight className="w-4 h-4 text-white" />
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
