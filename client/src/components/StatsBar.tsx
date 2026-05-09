/*
 * POLAR LUMINANCE — Stats Bar
 * Floating frosted glass stats strip between hero and grid.
 * Shows key metrics with animated counters.
 * Now accepts dynamic props from the API.
 */

import { motion, useInView } from "framer-motion";
import { useRef, useState, useEffect } from "react";
import { Zap, Globe, Clock, TrendingUp, Sparkles } from "lucide-react";

interface StatItemProps {
  icon: React.ReactNode;
  value: number;
  suffix?: string;
  label: string;
  delay: number;
}

function AnimatedCounter({ target, delay }: { target: number; delay: number }) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true });

  useEffect(() => {
    if (!isInView) return;
    const timer = setTimeout(() => {
      const duration = 1200;
      const steps = 40;
      const increment = target / steps;
      let current = 0;
      const interval = setInterval(() => {
        current += increment;
        if (current >= target) {
          setCount(target);
          clearInterval(interval);
        } else {
          setCount(Math.floor(current));
        }
      }, duration / steps);
      return () => clearInterval(interval);
    }, delay);
    return () => clearTimeout(timer);
  }, [isInView, target, delay]);

  return <span ref={ref}>{count.toLocaleString()}</span>;
}

function StatItem({ icon, value, suffix = "", label, delay, animate = true }: StatItemProps & { animate?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay, type: "spring", stiffness: 100, damping: 20 }}
      className="flex items-center gap-3"
    >
      <div className="w-10 h-10 rounded-xl bg-[oklch(0.94_0.01_230)] flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div>
        <p className="text-lg font-semibold text-foreground leading-tight">
          {animate ? (
            <><AnimatedCounter target={value} delay={delay * 1000} />{suffix}</>
          ) : (
            <>{value}{suffix}</>
          )}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </motion.div>
  );
}

interface StatsBarProps {
  toolCount?: number;
  sourceCount?: number;
  updateFrequency?: string;
  categoryCount?: number;
  addedLast24h?: number;
}

export default function StatsBar({
  toolCount = 18,
  sourceCount = 5,
  updateFrequency = "6h",
  categoryCount = 14,
  addedLast24h = 0,
}: StatsBarProps) {
  // Parse the numeric part. "6h" → 6, "60min" → 60.
  const freqMatch = (updateFrequency || '').match(/(\d+)\s*(h|min)?/i);
  const freqNum = freqMatch ? parseInt(freqMatch[1], 10) : 6;
  const freqUnit = (freqMatch && freqMatch[2]) ? freqMatch[2].toLowerCase() : 'h';

  return (
    <section className="px-4 sm:px-6 lg:px-8 -mt-4 mb-12 relative z-10">
      <div className="max-w-[1000px] mx-auto">
        <div className="glass-strong rounded-2xl px-8 py-5 flex flex-wrap items-center justify-between gap-6">
          <StatItem
            icon={<Zap className="w-4.5 h-4.5 text-[oklch(0.55_0.18_230)]" />}
            value={toolCount}
            label="AI tools indexed"
            delay={0.1}
          />
          <div className="w-px h-8 bg-[oklch(0.92_0.005_230)]" />
          <StatItem
            icon={<Globe className="w-4.5 h-4.5 text-[oklch(0.65_0.15_185)]" />}
            value={sourceCount}
            label="Sources monitored"
            delay={0.2}
          />
          <div className="w-px h-8 bg-[oklch(0.92_0.005_230)]" />
          <StatItem
            icon={<Clock className="w-4.5 h-4.5 text-[oklch(0.55_0.18_230)]" />}
            value={freqNum}
            suffix={freqUnit}
            label="Refresh frequency"
            delay={0.3}
            animate={false}
          />
          <div className="w-px h-8 bg-[oklch(0.92_0.005_230)]" />
          <StatItem
            icon={<Sparkles className="w-4.5 h-4.5 text-[oklch(0.65_0.15_185)]" />}
            value={addedLast24h}
            suffix=" new"
            label="Added in last 24h"
            delay={0.4}
          />
          <div className="w-px h-8 bg-[oklch(0.92_0.005_230)] hidden md:block" />
          <div className="hidden md:flex items-center gap-3">
            <StatItem
              icon={<TrendingUp className="w-4.5 h-4.5 text-[oklch(0.65_0.15_185)]" />}
              value={categoryCount}
              label="Categories"
              delay={0.5}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
