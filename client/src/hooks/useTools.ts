/**
 * EverythinInAI — useTools Hook
 *
 * Fetches AI tools DIRECTLY from Supabase (no Express middleman).
 * - Pagination via .range()
 * - Category filtering via .eq()
 * - Search via .or() with ilike patterns
 * - Falls back to mock data if Supabase env vars are missing or query fails
 *
 * This makes the frontend deployable as a pure static site (Vercel/Netlify)
 * with no backend required.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getSupabase, apiFetch, isSupabaseConfigured } from '@/lib/supabase';
import type { AITool } from '@/lib/data';
import {
  MOCK_TOOLS,
  searchTools as mockSearch,
  getToolsByCategory as mockFilter,
  getFeaturedTools,
} from '@/lib/data';

const PAGE_SIZE = 24;

// Map a Supabase row to the frontend AITool shape.
// IMPORTANT: prefer the actual product homepage over the GitHub URL whenever
// possible — the GitHub link is kept as a secondary `sourceUrl`.
function mapBackendTool(tool: any): AITool {
  // If `homepage` is set and not the same as `url`, treat homepage as the
  // "Visit" target and `url` as the source link. Otherwise fall back to `url`.
  const homepageRaw = (tool.homepage || '').trim();
  const urlRaw = (tool.url || '').trim();
  const visitUrl = homepageRaw || urlRaw;

  return {
    id: tool.slug || tool.id,
    name: tool.name,
    displayName: tool.display_name || tool.name,
    tagline: tool.tagline || '',
    description: tool.description || '',
    url: visitUrl,                                       // primary CTA target
    sourceUrl: homepageRaw && homepageRaw !== urlRaw ? urlRaw : null,  // secondary (GitHub etc.)
    category: tool.category || 'Other',
    tags: tool.tags || [],
    pricing: tool.pricing || 'unknown',
    source: tool.source || 'auto_discovery',
    upvotes: tool.upvotes || 0,
    publishedAt: tool.published_at || tool.added_at || new Date().toISOString(),
    featured: (tool.upvotes || 0) > 100 || (tool.confidence || 0) > 0.9,
    useCases: tool.use_cases || [],
    keyFeatures: tool.key_features || [],
    pros: tool.pros || [],
    cons: tool.cons || [],
    bestFor: tool.best_for || '',
    searchAliases: tool.search_aliases || [],
    homepage: homepageRaw || undefined,
    addedAt: tool.added_at || tool.published_at || undefined,
  };
}

/**
 * Main tools hook — paginated list with category + search.
 */
export function useTools() {
  const [tools, setTools] = useState<AITool[]>([]);
  const [filteredTools, setFilteredTools] = useState<AITool[]>([]);
  const [featuredTools, setFeaturedTools] = useState<AITool[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isApiConnected, setIsApiConnected] = useState(false);
  const [totalTools, setTotalTools] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [activeCategory, setActiveCategory] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');

  const abortRef = useRef<AbortController | null>(null);

  const fetchTools = useCallback(async (page = 1, category = 'All') => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    const localSignal = abortRef.current.signal;

    setIsLoading(true);

    const supabase = getSupabase();
    if (!supabase) {
      console.warn('[useTools] Supabase not configured, using mock data');
      setIsApiConnected(false);
      const mockFiltered = category !== 'All' ? mockFilter(category) : MOCK_TOOLS;
      setTools(MOCK_TOOLS);
      setFilteredTools(mockFiltered);
      setTotalTools(MOCK_TOOLS.length);
      setTotalPages(1);
      setCurrentPage(1);
      setFeaturedTools(getFeaturedTools());
      setIsLoading(false);
      return;
    }

    try {
      const offset = (page - 1) * PAGE_SIZE;
      let query = supabase
        .from('tools')
        .select('*', { count: 'exact' })
        .eq('is_active', true);

      if (category && category !== 'All') {
        query = query.eq('category', category);
      }

      query = query
        .order('added_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      const { data, count, error } = await query;
      if (localSignal.aborted) return;
      if (error) throw error;

      const mapped = (data || []).map(mapBackendTool);
      setTools(mapped);
      setFilteredTools(mapped);
      setTotalTools(count || 0);
      setTotalPages(Math.max(1, Math.ceil((count || 0) / PAGE_SIZE)));
      setCurrentPage(page);
      setIsApiConnected(true);

      const featured = [...mapped].sort((a, b) => b.upvotes - a.upvotes).slice(0, 6);
      setFeaturedTools(featured.length > 0 ? featured : mapped.slice(0, 6));
    } catch (err: any) {
      if (localSignal.aborted) return;
      console.warn('[useTools] Supabase query failed, falling back to mock:', err.message);
      setIsApiConnected(false);
      const mockFiltered = category !== 'All' ? mockFilter(category) : MOCK_TOOLS;
      setTools(MOCK_TOOLS);
      setFilteredTools(mockFiltered);
      setTotalTools(MOCK_TOOLS.length);
      setTotalPages(1);
      setCurrentPage(1);
      setFeaturedTools(getFeaturedTools());
    } finally {
      setIsLoading(false);
    }
  }, []);

  const search = useCallback(async (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      fetchTools(1, activeCategory);
      return;
    }

    setIsLoading(true);
    const supabase = getSupabase();
    if (!supabase) {
      const results = mockSearch(query);
      setFilteredTools(results);
      setTotalTools(results.length);
      setIsLoading(false);
      return;
    }

    try {
      const term = `%${query.replace(/[%_]/g, '\\$&')}%`;
      // Search across name, display_name, tagline, description, category, AND search_aliases
      // search_aliases is text[] so we use `contains` (cs) for an exact tag match plus ilike for partial
      const { data, error } = await supabase
        .from('tools')
        .select('*')
        .eq('is_active', true)
        .or(
          `name.ilike.${term},display_name.ilike.${term},tagline.ilike.${term},category.ilike.${term},description.ilike.${term}`
        )
        .limit(100);

      if (error) throw error;
      const mapped = (data || []).map(mapBackendTool);

      // Score-based ranking: exact name > prefix > contains > tagline > description
      const q = query.trim().toLowerCase();
      const scored = mapped.map((t) => {
        const name = (t.name || '').toLowerCase();
        const dn = (t.displayName || '').toLowerCase();
        const tag = (t.tagline || '').toLowerCase();
        const desc = (t.description || '').toLowerCase();
        const cat = (t.category || '').toLowerCase();
        let score = 0;
        if (name === q) score += 1000;
        if (dn === q) score += 800;
        if (name.startsWith(q)) score += 500;
        if (dn.startsWith(q)) score += 400;
        if (name.includes(q)) score += 200;
        if (dn.includes(q)) score += 150;
        if (cat === q) score += 200;
        if (tag.includes(q)) score += 50;
        if (desc.includes(q)) score += 10;
        score += Math.log10(Math.max(1, (t.upvotes || 0)));
        return { tool: t, score };
      });
      scored.sort((a, b) => b.score - a.score);
      const ranked = scored.slice(0, 50).map((s) => s.tool);

      setFilteredTools(ranked);
      setTotalTools(ranked.length);
      setIsApiConnected(true);
    } catch (err: any) {
      console.warn('[useTools] Search fell back to mock:', err.message);
      const results = mockSearch(query);
      setFilteredTools(results);
      setTotalTools(results.length);
    } finally {
      setIsLoading(false);
    }
  }, [activeCategory, fetchTools]);

  const filterByCategory = useCallback((category: string) => {
    setActiveCategory(category);
    setSearchQuery('');
    fetchTools(1, category);
  }, [fetchTools]);

  const goToPage = useCallback((page: number) => {
    fetchTools(page, activeCategory);
  }, [activeCategory, fetchTools]);

  useEffect(() => {
    fetchTools(1, 'All');
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchTools]);

  return {
    tools,
    filteredTools,
    featuredTools,
    isLoading,
    isApiConnected,
    totalTools,
    currentPage,
    totalPages,
    activeCategory,
    searchQuery,
    search,
    filterByCategory,
    goToPage,
    fetchTools,
  };
}

interface StatsResponse {
  totalTools: number;
  totalSources: number;
  updateFrequency: string;
  totalCategories: number;
  lastUpdated: string | null;
  lastRunMerged: number;
}

/**
 * Dashboard stats — direct from Supabase.
 */
export function useStats() {
  const [stats, setStats] = useState<StatsResponse>({
    totalTools: 0,
    totalSources: 5,
    updateFrequency: '60min',
    totalCategories: 14,
    lastUpdated: null,
    lastRunMerged: 0,
  });

  useEffect(() => {
    let cancelled = false;
    const supabase = getSupabase();
    if (!supabase) {
      setStats({
        totalTools: MOCK_TOOLS.length,
        totalSources: 5,
        updateFrequency: '60min',
        totalCategories: 14,
        lastUpdated: null,
        lastRunMerged: 0,
      });
      return;
    }

    (async () => {
      try {
        const { count: toolCount } = await supabase
          .from('tools')
          .select('*', { count: 'exact', head: true })
          .eq('is_active', true);

        const { data: catData } = await supabase
          .from('tools')
          .select('category')
          .eq('is_active', true);
        const uniqueCategories = new Set((catData || []).map((r: any) => r.category));

        const { data: latestRun } = await supabase
          .from('runs')
          .select('completed_at, items_merged')
          .eq('state', 'done')
          .order('completed_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (cancelled) return;
        setStats({
          totalTools: toolCount || 0,
          totalSources: 5,
          updateFrequency: '60min',
          totalCategories: uniqueCategories.size || 14,
          lastUpdated: latestRun?.completed_at || null,
          lastRunMerged: latestRun?.items_merged || 0,
        });
      } catch (err: any) {
        if (cancelled) return;
        console.warn('[useStats] Falling back to mock stats:', err.message);
        setStats({
          totalTools: MOCK_TOOLS.length,
          totalSources: 5,
          updateFrequency: '60min',
          totalCategories: 14,
          lastUpdated: null,
          lastRunMerged: 0,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return stats;
}

/**
 * Categories with counts — direct from Supabase.
 */
export function useCategories() {
  const [categories, setCategories] = useState<Array<{ name: string; count: number }>>([]);

  useEffect(() => {
    let cancelled = false;
    const supabase = getSupabase();
    if (!supabase) {
      const counts: Record<string, number> = {};
      MOCK_TOOLS.forEach((t) => {
        counts[t.category] = (counts[t.category] || 0) + 1;
      });
      setCategories(
        Object.entries(counts)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
      );
      return;
    }

    (async () => {
      try {
        const { data, error } = await supabase
          .from('tools')
          .select('category')
          .eq('is_active', true);
        if (error) throw error;

        const counts: Record<string, number> = {};
        (data || []).forEach((r: any) => {
          counts[r.category] = (counts[r.category] || 0) + 1;
        });
        const list = Object.entries(counts)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);
        if (!cancelled) setCategories(list);
      } catch (err: any) {
        if (cancelled) return;
        console.warn('[useCategories] Falling back to mock:', err.message);
        const counts: Record<string, number> = {};
        MOCK_TOOLS.forEach((t) => {
          counts[t.category] = (counts[t.category] || 0) + 1;
        });
        setCategories(
          Object.entries(counts)
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count)
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return categories;
}

/**
 * Submit a tool from the Launchpad.
 *
 * Writes still go through the Express /api/submit endpoint (which uses the
 * service_role key on the server). On the Vercel-deployed static frontend,
 * this will fail gracefully until we wire submission directly via Supabase
 * with a dedicated INSERT RLS policy on `discovery_queue`.
 */
export async function submitTool(data: {
  name: string;
  url: string;
  tagline: string;
  category: string;
}): Promise<{ success: boolean; message: string; queueId?: string }> {
  try {
    const result = await apiFetch<{ success: boolean; message: string; queueId?: string }>(
      '/api/submit',
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    );
    return result;
  } catch (err: any) {
    return {
      success: false,
      message:
        err?.message ||
        'Submission endpoint unavailable in this deployment. Please try again later.',
    };
  }
}

export { isSupabaseConfigured };
