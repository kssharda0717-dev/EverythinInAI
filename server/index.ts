/**
 * EverythinInAI — Unified Server
 *
 * Serves the Vite-built frontend AND provides API routes that proxy
 * to the engine's Supabase database for tool data.
 *
 * In development: Vite handles the frontend, this server provides /api routes
 * In production: This server serves static files + /api routes
 *
 * API Routes:
 *   GET  /api/tools              — List tools (paginated, filterable by category)
 *   GET  /api/tools/search       — Search tools by query
 *   GET  /api/tools/categories   — List categories with counts
 *   GET  /api/tools/:slug        — Single tool detail
 *   GET  /api/stats              — Dashboard stats
 *   POST /api/submit             — Developer tool submission
 *   GET  /api/engine/health      — Engine health check
 *   GET  /api/engine/status      — Engine run status
 *   GET  /api/engine/export      — Export tools as JSON
 */

import express from "express";
import cors from "cors";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamic import for the CJS engine modules
async function loadEngine() {
  try {
    const dbModule = await import("../engine/core/database.js");
    const configModule = await import("../engine/core/config.js");
    return { db: dbModule.default || dbModule, config: configModule.config || configModule.default?.config };
  } catch (e) {
    console.warn("[server] Engine modules not loaded (Supabase not configured):", (e as Error).message);
    return { db: null, config: null };
  }
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(cors());
  app.use(express.json());

  // ═══════════════════════════════════════════════════════════════════
  // API ROUTES
  // ═══════════════════════════════════════════════════════════════════

  let engine: any = null;

  // Lazy-load engine on first API call
  async function getEngine() {
    if (!engine) {
      engine = await loadEngine();
    }
    return engine;
  }

  // --- GET /api/tools ---
  // List tools with pagination and optional category filter
  app.get("/api/tools", async (req, res) => {
    try {
      const { db } = await getEngine();
      if (!db) {
        return res.json({ tools: [], total: 0, message: "Database not configured" });
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 24, 100);
      const category = req.query.category as string;
      const sort = (req.query.sort as string) || "added_at";
      const order = (req.query.order as string) || "desc";
      const offset = (page - 1) * limit;

      const client = db.getClient();
      let query = client
        .from("tools")
        .select("*", { count: "exact" })
        .eq("is_active", true);

      if (category && category !== "All") {
        query = query.eq("category", category);
      }

      query = query.order(sort, { ascending: order === "asc" }).range(offset, offset + limit - 1);

      const { data, count, error } = await query;
      if (error) throw error;

      res.json({
        tools: data || [],
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      });
    } catch (err: any) {
      console.error("[api] /api/tools error:", err.message);
      res.status(500).json({ error: "Failed to fetch tools" });
    }
  });

  // --- GET /api/tools/search ---
  app.get("/api/tools/search", async (req, res) => {
    try {
      const { db } = await getEngine();
      if (!db) {
        return res.json({ tools: [], total: 0 });
      }

      const q = (req.query.q as string || "").trim();
      const limit = Math.min(parseInt(req.query.limit as string) || 24, 100);

      if (!q) {
        return res.json({ tools: [], total: 0 });
      }

      const client = db.getClient();
      const searchTerm = `%${q}%`;

      const { data, error } = await client
        .from("tools")
        .select("*")
        .eq("is_active", true)
        .or(`name.ilike.${searchTerm},tagline.ilike.${searchTerm},category.ilike.${searchTerm},description.ilike.${searchTerm}`)
        .order("upvotes", { ascending: false })
        .limit(limit);

      if (error) throw error;

      res.json({ tools: data || [], total: data?.length || 0 });
    } catch (err: any) {
      console.error("[api] /api/tools/search error:", err.message);
      res.status(500).json({ error: "Search failed" });
    }
  });

  // --- GET /api/tools/categories ---
  app.get("/api/tools/categories", async (req, res) => {
    try {
      const { db } = await getEngine();
      if (!db) {
        return res.json({ categories: [] });
      }

      const client = db.getClient();
      const { data, error } = await client
        .from("tools")
        .select("category")
        .eq("is_active", true);

      if (error) throw error;

      // Count per category
      const counts: Record<string, number> = {};
      (data || []).forEach((row: any) => {
        counts[row.category] = (counts[row.category] || 0) + 1;
      });

      const categories = Object.entries(counts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      res.json({ categories });
    } catch (err: any) {
      console.error("[api] /api/tools/categories error:", err.message);
      res.status(500).json({ error: "Failed to fetch categories" });
    }
  });

  // --- GET /api/tools/:slug ---
  app.get("/api/tools/:slug", async (req, res) => {
    try {
      const { db } = await getEngine();
      if (!db) {
        return res.status(404).json({ error: "Not found" });
      }

      const client = db.getClient();
      const { data, error } = await client
        .from("tools")
        .select("*")
        .eq("slug", req.params.slug)
        .eq("is_active", true)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: "Tool not found" });
      }

      res.json({ tool: data });
    } catch (err: any) {
      console.error("[api] /api/tools/:slug error:", err.message);
      res.status(500).json({ error: "Failed to fetch tool" });
    }
  });

  // --- GET /api/stats ---
  app.get("/api/stats", async (req, res) => {
    try {
      const { db } = await getEngine();
      if (!db) {
        return res.json({
          totalTools: 0,
          totalSources: 5,
          updateFrequency: "60min",
          totalCategories: 0,
        });
      }

      const client = db.getClient();

      // Total tools
      const { count: toolCount } = await client
        .from("tools")
        .select("*", { count: "exact", head: true })
        .eq("is_active", true);

      // Unique categories
      const { data: catData } = await client
        .from("tools")
        .select("category")
        .eq("is_active", true);

      const uniqueCategories = new Set((catData || []).map((r: any) => r.category));

      // Latest run
      const { data: latestRun } = await client
        .from("runs")
        .select("completed_at, items_merged")
        .eq("state", "done")
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      res.json({
        totalTools: toolCount || 0,
        totalSources: 5,
        updateFrequency: "60min",
        totalCategories: uniqueCategories.size,
        lastUpdated: latestRun?.completed_at || null,
        lastRunMerged: latestRun?.items_merged || 0,
      });
    } catch (err: any) {
      console.error("[api] /api/stats error:", err.message);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // --- POST /api/submit ---
  // Developer tool submission from the Launchpad
  app.post("/api/submit", async (req, res) => {
    try {
      const { db } = await getEngine();
      if (!db) {
        return res.status(503).json({ error: "Database not configured" });
      }

      const { name, url, tagline, category } = req.body;

      if (!name || !url) {
        return res.status(400).json({ error: "Name and URL are required" });
      }

      const client = db.getClient();

      // Check for duplicate URL
      const normalizedUrl = url.toLowerCase().replace(/\/$/, "").replace(/^https?:\/\/(www\.)?/, "");
      const { data: existing } = await client
        .from("tools")
        .select("id, name")
        .eq("url_normalized", normalizedUrl)
        .limit(1)
        .maybeSingle();

      if (existing) {
        return res.status(409).json({
          error: "This tool already exists in our directory",
          existingTool: existing.name,
        });
      }

      // Also check discovery_queue
      const { data: queued } = await client
        .from("discovery_queue")
        .select("id")
        .eq("url", url)
        .in("status", ["pending", "processing", "classified"])
        .limit(1)
        .maybeSingle();

      if (queued) {
        return res.status(409).json({
          error: "This tool is already in our review queue",
        });
      }

      // Insert into discovery_queue for review
      const { data: inserted, error: insertError } = await client
        .from("discovery_queue")
        .insert({
          raw_title: name,
          raw_description: tagline || "",
          url,
          source: "developer_submission",
          source_url: "",
          upvotes: 0,
          comments: 0,
          heuristic_score: 80, // High score for manual submissions
          score_reasons: ["developer_submitted"],
          status: "pending",
          run_id: `submit_${Date.now()}`,
        })
        .select("id")
        .single();

      if (insertError) throw insertError;

      res.json({
        success: true,
        message: "Your tool has been submitted for review!",
        queueId: inserted.id,
      });
    } catch (err: any) {
      console.error("[api] /api/submit error:", err.message);
      res.status(500).json({ error: "Submission failed" });
    }
  });

  // --- GET /api/engine/health ---
  app.get("/api/engine/health", async (_req, res) => {
    const { db } = await getEngine();
    res.json({
      status: db ? "connected" : "not_configured",
      timestamp: new Date().toISOString(),
    });
  });

  // --- GET /api/engine/status ---
  app.get("/api/engine/status", async (_req, res) => {
    try {
      const { db } = await getEngine();
      if (!db) {
        return res.json({ status: "not_configured" });
      }

      const toolCount = await db.getToolCount();
      const latestInc = await db.getLatestRun("incremental");
      const latestBf = await db.getLatestRun("backfill");

      res.json({ toolCount, latestIncremental: latestInc, latestBackfill: latestBf });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- GET /api/engine/export ---
  app.get("/api/engine/export", async (_req, res) => {
    try {
      const { db } = await getEngine();
      if (!db) {
        return res.json({ metadata: {}, tools: [] });
      }

      const data = await db.exportToolsAsJson();
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // STATIC FILE SERVING (Production)
  // ═══════════════════════════════════════════════════════════════════

  const staticPath =
    process.env.NODE_ENV === "production"
      ? path.resolve(__dirname, "public")
      : path.resolve(__dirname, "..", "dist", "public");

  app.use(express.static(staticPath));

  // Handle client-side routing — serve index.html for all non-API routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"));
  });

  const port = process.env.PORT || 3000;

  server.listen(port, () => {
    console.log(`[EverythinInAI] Server running on http://localhost:${port}/`);
    console.log(`[EverythinInAI] API available at http://localhost:${port}/api/`);
  });
}

startServer().catch(console.error);
