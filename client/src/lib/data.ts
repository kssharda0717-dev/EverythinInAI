/*
 * ═══════════════════════════════════════════════════════════════
 * POLAR LUMINANCE — Data Layer
 * Mock data for the discovery stream. In production, this will
 * be replaced by Supabase queries to the discovery_queue table.
 * ═══════════════════════════════════════════════════════════════
 */

export interface AITool {
  id: string;
  name: string;                           // technical name from DB (kept for breadcrumbs)
  displayName?: string;                   // friendly name with parenthetical, falls back to `name`
  tagline: string;
  description: string;
  url: string;                            // primary CTA target (homepage if available)
  sourceUrl?: string | null;              // secondary source URL (GitHub, etc.) for power-users
  category: string;
  source: string;
  upvotes: number;
  pricing: "free" | "freemium" | "paid" | "open_source" | "unknown";
  tags: string[];
  publishedAt: string;
  featured?: boolean;
  // Structured enrichment (optional)
  useCases?: string[];
  keyFeatures?: string[];
  pros?: string[];
  cons?: string[];
  bestFor?: string;
  searchAliases?: string[];
}

export const CATEGORIES = [
  "LLM & Chat",
  "Image Generation",
  "Video Generation",
  "Audio & Music",
  "Code Assistant",
  "Writing & Content",
  "Search & Research",
  "Productivity",
  "Data Analysis",
  "Agent & Automation",
  "Developer Tools",
  "Voice & Speech",
  "3D & Design",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_BADGE_MAP: Record<string, string> = {
  "LLM & Chat": "badge-llm",
  "Image Generation": "badge-image",
  "Video Generation": "badge-video",
  "Audio & Music": "badge-audio",
  "Code Assistant": "badge-code",
  "Writing & Content": "badge-writing",
  "Search & Research": "badge-search",
  "Productivity": "badge-productivity",
  "Data Analysis": "badge-data",
  "Agent & Automation": "badge-agent",
  "Developer Tools": "badge-dev",
  "Voice & Speech": "badge-audio",
  "3D & Design": "badge-image",
  "Other": "badge-other",
};

export const MOCK_TOOLS: AITool[] = [
  {
    id: "1",
    name: "Cursor",
    tagline: "The AI-first code editor built for pair programming with AI",
    description: "Cursor is an AI-powered code editor that understands your entire codebase. It offers intelligent code completion, natural language editing, and can refactor complex code patterns. Built on VS Code, it integrates seamlessly with your existing workflow while adding powerful AI capabilities that make you significantly more productive.",
    url: "https://cursor.com",
    category: "Code Assistant",
    source: "product_hunt",
    upvotes: 2847,
    pricing: "freemium",
    tags: ["coding", "ai-editor", "productivity"],
    publishedAt: "2026-04-18T10:00:00Z",
    featured: true,
  },
  {
    id: "2",
    name: "Midjourney v7",
    tagline: "Photorealistic AI image generation with unprecedented control",
    description: "The latest version of Midjourney pushes the boundaries of AI image generation with near-photorealistic output, fine-grained style control, and a new inpainting engine. Artists and designers can now iterate on compositions with surgical precision while maintaining the creative spontaneity that made Midjourney famous.",
    url: "https://midjourney.com",
    category: "Image Generation",
    source: "hacker_news",
    upvotes: 1923,
    pricing: "paid",
    tags: ["image-gen", "art", "creative"],
    publishedAt: "2026-04-17T14:30:00Z",
    featured: true,
  },
  {
    id: "3",
    name: "Bolt.new",
    tagline: "Prompt, run, edit, and deploy full-stack web apps instantly",
    description: "Bolt.new lets you build and deploy full-stack web applications entirely from your browser. Describe what you want in natural language, and Bolt generates the complete codebase, sets up the development environment, and deploys it — all in seconds. Supports React, Next.js, Vue, and more.",
    url: "https://bolt.new",
    category: "Developer Tools",
    source: "product_hunt",
    upvotes: 3102,
    pricing: "freemium",
    tags: ["web-dev", "no-code", "deployment"],
    publishedAt: "2026-04-19T08:15:00Z",
    featured: true,
  },
  {
    id: "4",
    name: "Perplexity",
    tagline: "AI-powered answer engine with real-time web search",
    description: "Perplexity combines the power of large language models with real-time web search to deliver accurate, cited answers to any question. It goes beyond traditional search by synthesizing information from multiple sources and presenting it in a clear, conversational format.",
    url: "https://perplexity.ai",
    category: "Search & Research",
    source: "hacker_news",
    upvotes: 1456,
    pricing: "freemium",
    tags: ["search", "research", "answers"],
    publishedAt: "2026-04-16T12:00:00Z",
  },
  {
    id: "5",
    name: "ElevenLabs",
    tagline: "The most realistic AI voice generation and cloning platform",
    description: "ElevenLabs offers state-of-the-art voice synthesis with emotional range, multilingual support, and voice cloning from just minutes of audio. Used by content creators, game studios, and enterprises for narration, dubbing, and accessibility.",
    url: "https://elevenlabs.io",
    category: "Voice & Speech",
    source: "github",
    upvotes: 987,
    pricing: "freemium",
    tags: ["voice", "tts", "cloning"],
    publishedAt: "2026-04-15T09:00:00Z",
  },
  {
    id: "6",
    name: "Runway Gen-4",
    tagline: "Professional-grade AI video generation and editing suite",
    description: "Runway Gen-4 brings cinematic AI video generation to creators. Generate, extend, and edit video clips with natural language prompts. Features include motion brush, camera controls, and style transfer — all running in real-time in your browser.",
    url: "https://runwayml.com",
    category: "Video Generation",
    source: "product_hunt",
    upvotes: 2134,
    pricing: "paid",
    tags: ["video", "creative", "editing"],
    publishedAt: "2026-04-14T16:45:00Z",
  },
  {
    id: "7",
    name: "Lovable",
    tagline: "Build production-ready apps with natural language",
    description: "Lovable transforms natural language descriptions into fully functional web applications. It handles frontend, backend, database, and deployment automatically. Perfect for entrepreneurs and product teams who want to ship fast without compromising on quality.",
    url: "https://lovable.dev",
    category: "Developer Tools",
    source: "product_hunt",
    upvotes: 1876,
    pricing: "freemium",
    tags: ["app-builder", "no-code", "startup"],
    publishedAt: "2026-04-13T11:30:00Z",
  },
  {
    id: "8",
    name: "Suno AI",
    tagline: "Create professional-quality music with AI in seconds",
    description: "Suno lets anyone create full songs — lyrics, melody, vocals, and instrumentals — from a simple text prompt. Whether you need background music for a video, a jingle for your brand, or just want to explore musical creativity, Suno makes it effortless.",
    url: "https://suno.com",
    category: "Audio & Music",
    source: "hacker_news",
    upvotes: 1543,
    pricing: "freemium",
    tags: ["music", "audio", "creative"],
    publishedAt: "2026-04-12T14:00:00Z",
  },
  {
    id: "9",
    name: "Devin",
    tagline: "The world's first fully autonomous AI software engineer",
    description: "Devin is an AI agent that can independently plan, write, debug, and deploy software. It handles entire engineering tasks end-to-end: from reading documentation to implementing features to running tests. Works alongside human engineers as a tireless teammate.",
    url: "https://devin.ai",
    category: "Agent & Automation",
    source: "hacker_news",
    upvotes: 3456,
    pricing: "paid",
    tags: ["agent", "coding", "automation"],
    publishedAt: "2026-04-11T10:00:00Z",
  },
  {
    id: "10",
    name: "NotebookLM",
    tagline: "Google's AI research assistant that understands your documents",
    description: "NotebookLM by Google lets you upload documents, papers, and notes, then ask questions and get AI-powered insights grounded in your specific sources. It generates audio overviews, creates study guides, and helps you synthesize complex information.",
    url: "https://notebooklm.google.com",
    category: "Search & Research",
    source: "product_hunt",
    upvotes: 1234,
    pricing: "free",
    tags: ["research", "documents", "google"],
    publishedAt: "2026-04-10T08:00:00Z",
  },
  {
    id: "11",
    name: "v0 by Vercel",
    tagline: "Generate UI components from text descriptions and screenshots",
    description: "v0 generates production-ready React components from natural language or image inputs. It produces clean, accessible code using shadcn/ui and Tailwind CSS. Ideal for rapid prototyping and building design systems.",
    url: "https://v0.dev",
    category: "Developer Tools",
    source: "github",
    upvotes: 2567,
    pricing: "freemium",
    tags: ["ui", "react", "components"],
    publishedAt: "2026-04-09T15:30:00Z",
  },
  {
    id: "12",
    name: "Gamma",
    tagline: "AI-powered presentations, documents, and websites in minutes",
    description: "Gamma reimagines how we create and share ideas. Generate beautiful presentations, documents, and microsites from a simple prompt. It handles design, layout, and content structure so you can focus on your message.",
    url: "https://gamma.app",
    category: "Productivity",
    source: "product_hunt",
    upvotes: 876,
    pricing: "freemium",
    tags: ["presentations", "documents", "design"],
    publishedAt: "2026-04-08T12:00:00Z",
  },
  {
    id: "13",
    name: "Windsurf",
    tagline: "Agentic IDE that flows with your development process",
    description: "Windsurf is an agentic IDE by Codeium that combines copilot and agent capabilities. It understands your codebase deeply, suggests multi-file changes, and can execute complex refactoring tasks autonomously while keeping you in control.",
    url: "https://codeium.com/windsurf",
    category: "Code Assistant",
    source: "hacker_news",
    upvotes: 1678,
    pricing: "freemium",
    tags: ["ide", "coding", "agent"],
    publishedAt: "2026-04-07T09:45:00Z",
  },
  {
    id: "14",
    name: "Kling AI",
    tagline: "Next-gen video generation with cinematic quality and control",
    description: "Kling AI produces high-fidelity video from text and image prompts with remarkable temporal consistency. Features include lip-sync, camera path control, and multi-subject scene composition. Rapidly becoming the go-to for professional video content.",
    url: "https://klingai.com",
    category: "Video Generation",
    source: "product_hunt",
    upvotes: 1345,
    pricing: "freemium",
    tags: ["video", "cinematic", "generation"],
    publishedAt: "2026-04-06T14:20:00Z",
  },
  {
    id: "15",
    name: "Replit Agent",
    tagline: "Build complete apps from a conversation with AI",
    description: "Replit Agent turns your ideas into working software through conversation. Describe what you want, and it builds the full application — frontend, backend, database, and deployment — iterating with you until it's exactly right.",
    url: "https://replit.com",
    category: "Agent & Automation",
    source: "github",
    upvotes: 2234,
    pricing: "freemium",
    tags: ["agent", "app-builder", "cloud"],
    publishedAt: "2026-04-05T11:00:00Z",
  },
  {
    id: "16",
    name: "Claude Artifacts",
    tagline: "Create interactive apps, visualizations, and documents in chat",
    description: "Claude Artifacts lets you generate interactive React components, data visualizations, SVG graphics, and rich documents directly within the Claude conversation. Each artifact is a self-contained, shareable creation.",
    url: "https://claude.ai",
    category: "LLM & Chat",
    source: "hacker_news",
    upvotes: 1890,
    pricing: "freemium",
    tags: ["llm", "interactive", "artifacts"],
    publishedAt: "2026-04-04T16:00:00Z",
  },
  {
    id: "17",
    name: "Ideogram 3.0",
    tagline: "AI image generation with perfect text rendering",
    description: "Ideogram 3.0 solves the text-in-image problem that plagued other generators. It produces stunning images with pixel-perfect typography, making it ideal for logos, posters, social media graphics, and any visual that needs readable text.",
    url: "https://ideogram.ai",
    category: "Image Generation",
    source: "product_hunt",
    upvotes: 1567,
    pricing: "freemium",
    tags: ["image-gen", "typography", "design"],
    publishedAt: "2026-04-03T10:30:00Z",
  },
  {
    id: "18",
    name: "Pieces for Developers",
    tagline: "AI-powered code snippet manager and workflow copilot",
    description: "Pieces captures, enriches, and reuses code snippets across your entire development workflow. Its on-device AI understands context, suggests relevant snippets, and helps you maintain a personal knowledge base of code patterns.",
    url: "https://pieces.app",
    category: "Developer Tools",
    source: "github",
    upvotes: 654,
    pricing: "free",
    tags: ["snippets", "productivity", "developer"],
    publishedAt: "2026-04-02T08:15:00Z",
  },
];

export function getToolsByCategory(category: string): AITool[] {
  return MOCK_TOOLS.filter((t) => t.category === category);
}

export function searchTools(query: string): AITool[] {
  const q = query.toLowerCase().trim();
  if (!q) return MOCK_TOOLS;
  return MOCK_TOOLS.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.tagline.toLowerCase().includes(q) ||
      t.category.toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.includes(q))
  );
}

export function getFeaturedTools(): AITool[] {
  return MOCK_TOOLS.filter((t) => t.featured);
}

export function formatTimeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffHours < 1) return "just now";
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}
