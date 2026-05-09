/*
 * POLAR LUMINANCE — Tool Card
 * Organic bento card with varying corner radii and staggered heights.
 * Elevation-based depth, no borders. Spring hover animation.
 */

import { motion } from "framer-motion";
import { ExternalLink, ArrowUpRight, Star, Github } from "lucide-react";
import type { AITool } from "@/lib/data";
import { CATEGORY_BADGE_MAP } from "@/lib/data";

// True if the tool's primary URL is a GitHub repo (and there's no separate hosted homepage)
function isGithubOnly(tool: AITool): boolean {
  const isGithubUrl = (u: string | undefined) => !!u && /(^|\/\/)(www\.)?github\.com\//i.test(u);
  return isGithubUrl(tool.url) && !tool.homepage;
}

interface ToolCardProps {
  tool: AITool;
  index: number;
  onClick: (tool: AITool) => void;
}

// Varying border radii for organic feel
const RADIUS_VARIANTS = [
  "rounded-2xl",
  "rounded-3xl",
  "rounded-[1.25rem]",
  "rounded-[1.75rem]",
];

export default function ToolCard({ tool, index, onClick }: ToolCardProps) {
  const radiusClass = RADIUS_VARIANTS[index % RADIUS_VARIANTS.length];
  const badgeClass = CATEGORY_BADGE_MAP[tool.category] || "badge-other";

  return (
    <motion.article
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: Math.min(index * 0.05, 0.5),
        type: "spring",
        stiffness: 100,
        damping: 18,
      }}
      whileHover={{
        y: -6,
        transition: { type: "spring", stiffness: 300, damping: 20 },
      }}
      onClick={() => onClick(tool)}
      className={`group relative bg-white ${radiusClass} p-6 cursor-pointer elevation-1 hover:elevation-3 transition-shadow duration-300`}
    >
      {/* Featured indicator */}
      {tool.featured && (
        <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-gradient-to-br from-[oklch(0.75_0.12_230)] to-[oklch(0.82_0.12_185)] flex items-center justify-center">
          <Star className="w-3 h-3 text-white fill-white" />
        </div>
      )}

      {/* Category badge */}
      <div className="mb-4">
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-lg text-[0.65rem] font-semibold tracking-wide uppercase ${badgeClass}`}
        >
          {tool.category}
        </span>
      </div>

      {/* Tool name (friendly display name with fallback) */}
      <h3 className="text-lg font-semibold text-foreground mb-1.5 group-hover:text-[oklch(0.45_0.15_230)] transition-colors">
        {tool.displayName || tool.name}
      </h3>

      {/* Tagline */}
      <p className="text-sm text-muted-foreground leading-relaxed mb-4 line-clamp-2">
        {tool.tagline}
      </p>

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t border-[oklch(0.95_0.005_230)]">
        <div className="flex items-center gap-3">
          {/* Upvotes */}
          <span className="text-functional text-muted-foreground flex items-center gap-1">
            <ArrowUpRight className="w-3 h-3" />
            {tool.upvotes.toLocaleString()}
          </span>
          {/* GitHub repo indicator (Phase 17) */}
          {isGithubOnly(tool) && (
            <span className="inline-flex items-center gap-1 text-[0.65rem] font-medium px-2 py-0.5 rounded-md bg-[oklch(0.97_0.01_280)] text-[oklch(0.45_0.12_280)]">
              <Github className="w-3 h-3" />
              GitHub Repo
            </span>
          )}
        </div>

        {/* Pricing badge */}
        <span className="text-[0.65rem] font-medium px-2 py-0.5 rounded-md bg-[oklch(0.97_0.005_230)] text-muted-foreground capitalize">
          {tool.pricing === "open_source" ? "open source" : tool.pricing}
        </span>
      </div>

      {/* Hover arrow */}
      <motion.div
        initial={{ opacity: 0, x: -4 }}
        whileHover={{ opacity: 1, x: 0 }}
        className="absolute top-5 right-5 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <ExternalLink className="w-4 h-4 text-muted-foreground" />
      </motion.div>
    </motion.article>
  );
}

/* Shimmer skeleton for loading state */
export function ToolCardSkeleton({ index }: { index: number }) {
  const radiusClass = RADIUS_VARIANTS[index % RADIUS_VARIANTS.length];

  return (
    <div className={`bg-white ${radiusClass} p-6 elevation-1`}>
      <div className="shimmer w-24 h-5 rounded-lg mb-4" />
      <div className="shimmer w-3/4 h-6 rounded-lg mb-2" />
      <div className="shimmer w-full h-4 rounded-lg mb-1" />
      <div className="shimmer w-2/3 h-4 rounded-lg mb-4" />
      <div className="flex items-center justify-between pt-3 border-t border-[oklch(0.95_0.005_230)]">
        <div className="shimmer w-16 h-3 rounded" />
        <div className="shimmer w-14 h-5 rounded-md" />
      </div>
    </div>
  );
}
