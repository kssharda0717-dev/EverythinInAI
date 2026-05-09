/*
 * POLAR LUMINANCE — Hero Section
 * "Zero-Gravity" centered search with Glacier Glow effect.
 * The background shifts with a subtle generative gradient on search focus.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, ArrowRight, Sparkles } from "lucide-react";

interface HeroSectionProps {
  onSearch: (query: string) => void;
  toolCount: number;
}

export default function HeroSection({ onSearch, toolCount }: HeroSectionProps) {
  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0.5, y: 0.5 });
  const heroRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!heroRef.current) return;
    const rect = heroRef.current.getBoundingClientRect();
    setMousePos({
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    });
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(query);
  };

  // Live search as user types
  useEffect(() => {
    const timer = setTimeout(() => {
      onSearch(query);
    }, 200);
    return () => clearTimeout(timer);
  }, [query, onSearch]);

  // Reset local query state when logo is clicked
  useEffect(() => {
    const handler = () => {
      setQuery('');
      setIsFocused(false);
    };
    window.addEventListener('reset-home-filters', handler);
    return () => window.removeEventListener('reset-home-filters', handler);
  }, []);

  return (
    <section
      ref={heroRef}
      onMouseMove={handleMouseMove}
      className="relative min-h-[70vh] flex flex-col items-center justify-center px-4 pt-28 pb-16 overflow-hidden"
    >
      {/* Glacier Glow Background */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Base gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-[oklch(0.97_0.01_230)] via-white to-white" />

        {/* Mouse-following glow */}
        <motion.div
          className="absolute w-[800px] h-[800px] rounded-full"
          animate={{
            x: `calc(${mousePos.x * 100}% - 400px)`,
            y: `calc(${mousePos.y * 100}% - 400px)`,
            opacity: isFocused ? 0.35 : 0.12,
            scale: isFocused ? 1.3 : 1,
          }}
          transition={{ type: "spring", stiffness: 50, damping: 30 }}
          style={{
            background:
              "radial-gradient(circle, oklch(0.78 0.14 230 / 40%) 0%, oklch(0.82 0.12 185 / 20%) 40%, transparent 70%)",
          }}
        />

        {/* Hero image overlay — very subtle */}
        <div
          className="absolute inset-0 opacity-[0.04] bg-cover bg-center mix-blend-multiply"
          style={{
            backgroundImage: `url(https://d2xsxph8kpxj0f.cloudfront.net/310519663529896497/QBqeAVQQED5JYrhp7rE5AR/hero-glacier-glow-Dxzx6RqjUzukTBLDHwxssb.webp)`,
          }}
        />
      </div>

      {/* Content */}
      <div className="relative z-10 w-full max-w-3xl mx-auto text-center">
        {/* Badge */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1, type: "spring", stiffness: 100, damping: 20 }}
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass mb-8"
        >
          <div className="w-1.5 h-1.5 rounded-full bg-[oklch(0.72_0.18_150)] animate-pulse" />
          <span className="text-functional text-muted-foreground">
            {toolCount} AI tools discovered
          </span>
        </motion.div>

        {/* Title */}
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, type: "spring", stiffness: 100, damping: 20 }}
          className="text-display text-foreground mb-4"
        >
          Discover the{" "}
          <span className="bg-gradient-to-r from-[oklch(0.55_0.18_230)] to-[oklch(0.65_0.15_185)] bg-clip-text text-transparent">
            future
          </span>{" "}
          of AI
        </motion.h1>

        {/* Subtitle */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, type: "spring", stiffness: 100, damping: 20 }}
          className="text-subheading text-muted-foreground mb-10 max-w-xl mx-auto"
        >
          The world's most comprehensive real-time directory of AI tools.
          Refreshed every 6 hours, with daily backfill.
        </motion.p>

        {/* Search Bar */}
        <motion.form
          onSubmit={handleSubmit}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, type: "spring", stiffness: 100, damping: 20 }}
          className="relative w-full max-w-2xl mx-auto"
        >
          <motion.div
            animate={{
              boxShadow: isFocused
                ? "0 8px 40px oklch(0.75 0.12 230 / 18%), 0 2px 8px oklch(0.75 0.12 230 / 10%)"
                : "0 2px 12px oklch(0.70 0.03 230 / 8%), 0 1px 4px oklch(0.70 0.03 230 / 4%)",
            }}
            transition={{ type: "spring", stiffness: 200, damping: 25 }}
            className="relative rounded-2xl overflow-hidden bg-white"
          >
            <div className="flex items-center">
              <Search className="absolute left-5 w-5 h-5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                placeholder="Search AI tools, categories, or capabilities..."
                className="w-full py-4.5 pl-14 pr-14 text-base bg-transparent outline-none placeholder:text-muted-foreground/60 text-foreground"
              />
              <AnimatePresence>
                {query.length > 0 && (
                  <motion.button
                    type="submit"
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ type: "spring", stiffness: 300, damping: 25 }}
                    className="absolute right-3 w-9 h-9 rounded-xl bg-gradient-to-br from-[oklch(0.55_0.18_230)] to-[oklch(0.65_0.15_185)] flex items-center justify-center text-white"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.form>

        {/* Quick filters */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="flex flex-wrap items-center justify-center gap-2 mt-6"
        >
          {["Code Assistant", "Image Generation", "LLM & Chat", "Agent & Automation", "Video Generation"].map(
            (cat) => (
              <button
                key={cat}
                onClick={() => {
                  setQuery(cat);
                  onSearch(cat);
                }}
                className="px-3.5 py-1.5 rounded-xl text-xs font-medium text-muted-foreground bg-[oklch(0.97_0.005_230)] hover:bg-[oklch(0.94_0.01_230)] hover:text-foreground transition-colors"
              >
                {cat}
              </button>
            )
          )}
        </motion.div>
      </div>
    </section>
  );
}
