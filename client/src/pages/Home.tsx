/*
 * POLAR LUMINANCE — Home Page
 * Composes: Navbar → Hero → StatsBar → Featured → Discovery Grid → Footer
 * Now wired to the backend API via useTools/useStats hooks.
 * Falls back to mock data if the API is unavailable.
 */

import { useState, useCallback } from "react";
import Navbar from "@/components/Navbar";
import HeroSection from "@/components/HeroSection";
import StatsBar from "@/components/StatsBar";
import FeaturedCarousel from "@/components/FeaturedCarousel";
import DiscoveryGrid from "@/components/DiscoveryGrid";
import SidePeekDrawer from "@/components/SidePeekDrawer";
import Footer from "@/components/Footer";
import { useTools, useStats } from "@/hooks/useTools";
import type { AITool } from "@/lib/data";

export default function Home() {
  const {
    filteredTools,
    featuredTools,
    isLoading,
    isApiConnected,
    totalTools,
    search,
    searchQuery,
  } = useTools();

  const stats = useStats();

  const [drawerTool, setDrawerTool] = useState<AITool | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleSearch = useCallback(
    (query: string) => {
      search(query);
    },
    [search]
  );

  const handleFeaturedClick = useCallback((tool: AITool) => {
    setDrawerTool(tool);
    setDrawerOpen(true);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <HeroSection onSearch={handleSearch} toolCount={stats.totalTools || totalTools} />
      <StatsBar
        toolCount={stats.totalTools || totalTools}
        sourceCount={stats.totalSources}
        updateFrequency={stats.updateFrequency}
        categoryCount={stats.totalCategories}
      />
      {!searchQuery && (
        <FeaturedCarousel tools={featuredTools} onToolClick={handleFeaturedClick} />
      )}
      <DiscoveryGrid tools={filteredTools} isLoading={isLoading} />
      <Footer />

      {/* Connection status indicator */}
      {!isApiConnected && (
        <div className="fixed bottom-4 left-4 z-40 px-3 py-1.5 rounded-lg glass text-xs text-muted-foreground">
          Using demo data — connect Supabase for live tools
        </div>
      )}

      {/* Drawer for featured carousel clicks */}
      <SidePeekDrawer
        tool={drawerTool}
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
