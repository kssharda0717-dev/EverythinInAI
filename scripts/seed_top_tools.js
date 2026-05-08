#!/usr/bin/env node
/**
 * EverythinInAI — Seed Top Essential AI Tools
 *
 * Hand-curated list of must-have AI tools that should ALWAYS be in the
 * directory. Idempotent: uses INSERT … ON CONFLICT (slug) DO UPDATE so
 * re-running merges cleanly without creating duplicates.
 *
 * Run on VM:
 *   node scripts/seed_top_tools.js
 */

const dbModule = require('../engine/core/database');
const { createLogger } = require('../engine/utils/logger');

const log = createLogger('seed_top_tools');

// ─────────────────────────────────────────────────────────────────────────────
// Top 100 essential AI tools (curated 2026 snapshot).
// Categories must match `CATEGORIES` in client/src/lib/data.ts.
// Pricing must be one of: free | freemium | paid | open_source | unknown
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  // ─── LLM & Chat ───
  { slug: 'chatgpt',        name: 'ChatGPT',        url: 'https://chatgpt.com',                homepage: 'https://chatgpt.com',                category: 'LLM & Chat',         tagline: "OpenAI's conversational AI assistant powered by GPT-5", pricing: 'freemium', tags: ['gpt','openai','assistant','llm'] },
  { slug: 'claude',         name: 'Claude',         url: 'https://claude.ai',                  homepage: 'https://claude.ai',                  category: 'LLM & Chat',         tagline: "Anthropic's safety-first AI assistant with 200K context", pricing: 'freemium', tags: ['anthropic','reasoning','safety'] },
  { slug: 'gemini',         name: 'Gemini',         url: 'https://gemini.google.com',          homepage: 'https://gemini.google.com',          category: 'LLM & Chat',         tagline: 'Google\'s multimodal AI integrated with Workspace', pricing: 'freemium', tags: ['google','multimodal','search'] },
  { slug: 'grok',           name: 'Grok',           url: 'https://grok.com',                   homepage: 'https://grok.com',                   category: 'LLM & Chat',         tagline: "xAI's snarky, real-time-aware chatbot", pricing: 'freemium', tags: ['xai','elon','x'] },
  { slug: 'deepseek',       name: 'DeepSeek',       url: 'https://chat.deepseek.com',          homepage: 'https://chat.deepseek.com',          category: 'LLM & Chat',         tagline: 'Open-weight Chinese reasoning model rivaling GPT-4', pricing: 'free',     tags: ['china','reasoning','open-weight'] },
  { slug: 'mistral-le-chat',name: 'Le Chat',        url: 'https://chat.mistral.ai',            homepage: 'https://chat.mistral.ai',            category: 'LLM & Chat',         tagline: 'Mistral AI\'s European AI assistant, fast and private', pricing: 'freemium', tags: ['mistral','europe','privacy'] },
  { slug: 'meta-ai',        name: 'Meta AI',        url: 'https://www.meta.ai',                homepage: 'https://www.meta.ai',                category: 'LLM & Chat',         tagline: 'Meta\'s AI built on Llama, integrated across WhatsApp/IG', pricing: 'free',     tags: ['meta','llama','social'] },
  { slug: 'poe',            name: 'Poe',            url: 'https://poe.com',                    homepage: 'https://poe.com',                    category: 'LLM & Chat',         tagline: 'Quora\'s aggregator: chat with multiple AI models from one app', pricing: 'freemium', tags: ['multi-model','aggregator','quora'] },
  { slug: 'character-ai',   name: 'Character.AI',   url: 'https://character.ai',               homepage: 'https://character.ai',               category: 'LLM & Chat',         tagline: 'Roleplay and conversation with custom AI characters', pricing: 'freemium', tags: ['roleplay','characters','community'] },

  // ─── Image Generation ───
  { slug: 'midjourney',     name: 'Midjourney',     url: 'https://midjourney.com',             homepage: 'https://midjourney.com',             category: 'Image Generation',   tagline: 'The artist-favorite AI image generator with cinematic style', pricing: 'paid',     tags: ['art','image','aesthetic'] },
  { slug: 'dall-e-3',       name: 'DALL-E 3',       url: 'https://openai.com/dall-e-3',        homepage: 'https://openai.com/dall-e-3',        category: 'Image Generation',   tagline: 'OpenAI\'s text-to-image model integrated into ChatGPT', pricing: 'freemium', tags: ['openai','image','dalle'] },
  { slug: 'flux',           name: 'FLUX.1',         url: 'https://blackforestlabs.ai',         homepage: 'https://blackforestlabs.ai',         category: 'Image Generation',   tagline: 'Black Forest Labs\' state-of-the-art open-weight image model', pricing: 'freemium', tags: ['flux','open-weight','photoreal'] },
  { slug: 'leonardo-ai',    name: 'Leonardo.Ai',    url: 'https://leonardo.ai',                homepage: 'https://leonardo.ai',                category: 'Image Generation',   tagline: 'Production-grade AI image platform for creators and studios', pricing: 'freemium', tags: ['game-art','creators','platform'] },
  { slug: 'stability-ai',   name: 'Stable Diffusion', url: 'https://stability.ai',             homepage: 'https://stability.ai',               category: 'Image Generation',   tagline: 'Open-source diffusion model that started the local-AI movement', pricing: 'open_source', tags: ['stable-diffusion','open-source','sd'] },
  { slug: 'ideogram',       name: 'Ideogram',       url: 'https://ideogram.ai',                homepage: 'https://ideogram.ai',                category: 'Image Generation',   tagline: 'AI image generation that actually nails text in images', pricing: 'freemium', tags: ['typography','design','image'] },
  { slug: 'recraft',        name: 'Recraft',        url: 'https://recraft.ai',                 homepage: 'https://recraft.ai',                 category: 'Image Generation',   tagline: 'Vector + raster AI image tool built for designers', pricing: 'freemium', tags: ['design','vector','brand'] },
  { slug: 'krea',           name: 'Krea',           url: 'https://krea.ai',                    homepage: 'https://krea.ai',                    category: 'Image Generation',   tagline: 'Real-time AI generation canvas for designers', pricing: 'freemium', tags: ['real-time','design','canvas'] },

  // ─── Video Generation ───
  { slug: 'sora',           name: 'Sora',           url: 'https://openai.com/sora',            homepage: 'https://openai.com/sora',            category: 'Video Generation',   tagline: "OpenAI's photoreal text-to-video model", pricing: 'paid',     tags: ['openai','video','text-to-video'] },
  { slug: 'runway',         name: 'Runway',         url: 'https://runwayml.com',               homepage: 'https://runwayml.com',               category: 'Video Generation',   tagline: 'AI video editing + Gen-3 model for filmmakers', pricing: 'freemium', tags: ['video','editing','filmmaker'] },
  { slug: 'pika',           name: 'Pika',           url: 'https://pika.art',                   homepage: 'https://pika.art',                   category: 'Video Generation',   tagline: 'Idea-to-video AI for creators with viral effects', pricing: 'freemium', tags: ['video','effects','social'] },
  { slug: 'kling',          name: 'Kling',          url: 'https://kling.kuaishou.com',         homepage: 'https://kling.kuaishou.com',         category: 'Video Generation',   tagline: 'Kuaishou\'s viral text-to-video model with strong physics', pricing: 'freemium', tags: ['kuaishou','china','video'] },
  { slug: 'luma-dream',     name: 'Luma Dream Machine', url: 'https://lumalabs.ai',           homepage: 'https://lumalabs.ai',                category: 'Video Generation',   tagline: 'Luma\'s text/image-to-video model with smooth camera control', pricing: 'freemium', tags: ['luma','3d','video'] },
  { slug: 'heygen',         name: 'HeyGen',         url: 'https://heygen.com',                 homepage: 'https://heygen.com',                 category: 'Video Generation',   tagline: 'Custom AI avatars and lip-sync for marketing video', pricing: 'freemium', tags: ['avatar','lip-sync','b2b'] },
  { slug: 'synthesia',      name: 'Synthesia',      url: 'https://synthesia.io',               homepage: 'https://synthesia.io',               category: 'Video Generation',   tagline: 'Enterprise AI video creation with 200+ avatars', pricing: 'paid',     tags: ['avatar','enterprise','training'] },
  { slug: 'invideo',        name: 'InVideo AI',     url: 'https://invideo.io/ai',              homepage: 'https://invideo.io/ai',              category: 'Video Generation',   tagline: 'Text-prompt to short-form social video', pricing: 'freemium', tags: ['short-form','social','reels'] },
  { slug: 'captions',       name: 'Captions',       url: 'https://captions.ai',                homepage: 'https://captions.ai',                category: 'Video Generation',   tagline: 'AI creator studio for talking-head videos and reels', pricing: 'freemium', tags: ['talking-head','social','creator'] },

  // ─── Audio & Music ───
  { slug: 'elevenlabs',     name: 'ElevenLabs',     url: 'https://elevenlabs.io',              homepage: 'https://elevenlabs.io',              category: 'Audio & Music',      tagline: 'The most natural-sounding AI voice generation and cloning', pricing: 'freemium', tags: ['voice','tts','cloning'] },
  { slug: 'suno',           name: 'Suno',           url: 'https://suno.com',                   homepage: 'https://suno.com',                   category: 'Audio & Music',      tagline: 'Generate full songs with vocals from a text prompt', pricing: 'freemium', tags: ['music','songs','vocals'] },
  { slug: 'udio',           name: 'Udio',           url: 'https://udio.com',                   homepage: 'https://udio.com',                   category: 'Audio & Music',      tagline: 'Suno\'s rival — high-fidelity AI music generation', pricing: 'freemium', tags: ['music','songs','high-fi'] },
  { slug: 'descript',       name: 'Descript',       url: 'https://descript.com',               homepage: 'https://descript.com',               category: 'Audio & Music',      tagline: 'Edit audio/video by editing the transcript like a doc', pricing: 'freemium', tags: ['podcast','editing','transcript'] },
  { slug: 'play-ht',        name: 'Play.ht',        url: 'https://play.ht',                    homepage: 'https://play.ht',                    category: 'Audio & Music',      tagline: 'Studio-grade AI voice generation for production', pricing: 'freemium', tags: ['voice','tts','studio'] },

  // ─── Code Assistant ───
  { slug: 'cursor',         name: 'Cursor',         url: 'https://cursor.com',                 homepage: 'https://cursor.com',                 category: 'Code Assistant',     tagline: 'The AI-first code editor that understands your codebase', pricing: 'freemium', tags: ['ide','editor','copilot'] },
  { slug: 'github-copilot', name: 'GitHub Copilot', url: 'https://github.com/features/copilot', homepage: 'https://github.com/features/copilot', category: 'Code Assistant',     tagline: 'AI pair programmer from GitHub, integrated into every IDE', pricing: 'paid',     tags: ['github','copilot','autocomplete'] },
  { slug: 'claude-code',    name: 'Claude Code',    url: 'https://claude.ai/code',             homepage: 'https://claude.ai/code',             category: 'Code Assistant',     tagline: "Anthropic's terminal-native coding agent", pricing: 'paid',     tags: ['anthropic','terminal','agent'] },
  { slug: 'codex-cli',      name: 'Codex CLI',      url: 'https://github.com/openai/codex',    homepage: 'https://github.com/openai/codex',    category: 'Code Assistant',     tagline: 'OpenAI\'s open-source coding agent for the terminal', pricing: 'open_source', tags: ['openai','cli','agent'] },
  { slug: 'windsurf',       name: 'Windsurf',       url: 'https://codeium.com/windsurf',       homepage: 'https://codeium.com/windsurf',       category: 'Code Assistant',     tagline: 'Codeium\'s agentic AI IDE with deep codebase awareness', pricing: 'freemium', tags: ['ide','agent','codeium'] },
  { slug: 'tabnine',        name: 'Tabnine',        url: 'https://tabnine.com',                homepage: 'https://tabnine.com',                category: 'Code Assistant',     tagline: 'Privacy-first AI code completion for enterprises', pricing: 'freemium', tags: ['privacy','enterprise','autocomplete'] },
  { slug: 'aider',          name: 'Aider',          url: 'https://aider.chat',                 homepage: 'https://aider.chat',                 category: 'Code Assistant',     tagline: 'Open-source command-line AI coding companion', pricing: 'open_source', tags: ['cli','open-source','agent'] },
  { slug: 'continue-dev',   name: 'Continue',       url: 'https://continue.dev',               homepage: 'https://continue.dev',               category: 'Code Assistant',     tagline: 'Open-source AI code assistant for VS Code and JetBrains', pricing: 'open_source', tags: ['open-source','vscode','jetbrains'] },

  // ─── Writing & Content ───
  { slug: 'jasper',         name: 'Jasper',         url: 'https://jasper.ai',                  homepage: 'https://jasper.ai',                  category: 'Writing & Content',  tagline: 'AI marketing copy and content platform for brands', pricing: 'paid',     tags: ['marketing','copy','b2b'] },
  { slug: 'copy-ai',        name: 'Copy.ai',        url: 'https://copy.ai',                    homepage: 'https://copy.ai',                    category: 'Writing & Content',  tagline: 'AI sales/marketing workflow automation', pricing: 'freemium', tags: ['sales','marketing','copy'] },
  { slug: 'writesonic',     name: 'Writesonic',     url: 'https://writesonic.com',             homepage: 'https://writesonic.com',             category: 'Writing & Content',  tagline: 'AI writing tool for SEO blog posts and ads', pricing: 'freemium', tags: ['seo','blog','marketing'] },
  { slug: 'notion-ai',      name: 'Notion AI',      url: 'https://notion.so/product/ai',       homepage: 'https://notion.so/product/ai',       category: 'Writing & Content',  tagline: 'AI workspace assistant inside Notion docs and databases', pricing: 'paid',     tags: ['notion','workspace','docs'] },
  { slug: 'grammarly',      name: 'Grammarly',      url: 'https://grammarly.com',              homepage: 'https://grammarly.com',              category: 'Writing & Content',  tagline: 'AI writing assistant for grammar, tone, and clarity', pricing: 'freemium', tags: ['grammar','writing','editing'] },

  // ─── Search & Research ───
  { slug: 'perplexity',     name: 'Perplexity',     url: 'https://perplexity.ai',              homepage: 'https://perplexity.ai',              category: 'Search & Research',  tagline: 'AI answer engine with real-time citations', pricing: 'freemium', tags: ['search','answers','citations'] },
  { slug: 'phind',          name: 'Phind',          url: 'https://phind.com',                  homepage: 'https://phind.com',                  category: 'Search & Research',  tagline: 'AI search built for developers, prioritizing technical sources', pricing: 'freemium', tags: ['developer','search','technical'] },
  { slug: 'you-com',        name: 'You.com',        url: 'https://you.com',                    homepage: 'https://you.com',                    category: 'Search & Research',  tagline: 'Multi-modal AI search engine with personal agents', pricing: 'freemium', tags: ['search','agents','personal'] },
  { slug: 'consensus',      name: 'Consensus',      url: 'https://consensus.app',              homepage: 'https://consensus.app',              category: 'Search & Research',  tagline: 'AI search engine over 200M+ peer-reviewed papers', pricing: 'freemium', tags: ['research','academic','papers'] },
  { slug: 'elicit',         name: 'Elicit',         url: 'https://elicit.com',                 homepage: 'https://elicit.com',                 category: 'Search & Research',  tagline: 'AI research assistant for systematic literature reviews', pricing: 'freemium', tags: ['research','literature','academic'] },
  { slug: 'scite',          name: 'Scite.ai',       url: 'https://scite.ai',                   homepage: 'https://scite.ai',                   category: 'Search & Research',  tagline: 'Smart citations: see how a paper has been cited', pricing: 'freemium', tags: ['citations','research','academic'] },

  // ─── Productivity ───
  { slug: 'reclaim-ai',     name: 'Reclaim.ai',     url: 'https://reclaim.ai',                 homepage: 'https://reclaim.ai',                 category: 'Productivity',       tagline: 'AI calendar that auto-schedules your tasks and habits', pricing: 'freemium', tags: ['calendar','scheduling','time'] },
  { slug: 'motion',         name: 'Motion',         url: 'https://usemotion.com',              homepage: 'https://usemotion.com',              category: 'Productivity',       tagline: 'AI project manager + calendar in one', pricing: 'paid',     tags: ['calendar','tasks','project'] },
  { slug: 'fellow-ai',      name: 'Fellow.app',     url: 'https://fellow.app',                 homepage: 'https://fellow.app',                 category: 'Productivity',       tagline: 'AI meeting platform: notes, transcripts, action items', pricing: 'freemium', tags: ['meetings','notes','transcript'] },
  { slug: 'otter',          name: 'Otter.ai',       url: 'https://otter.ai',                   homepage: 'https://otter.ai',                   category: 'Productivity',       tagline: 'AI meeting transcription with summary and action items', pricing: 'freemium', tags: ['meetings','transcript','summary'] },
  { slug: 'fireflies',      name: 'Fireflies.ai',   url: 'https://fireflies.ai',               homepage: 'https://fireflies.ai',               category: 'Productivity',       tagline: 'AI notetaker for meetings on Zoom/Meet/Teams', pricing: 'freemium', tags: ['meetings','notes','zoom'] },
  { slug: 'mem-ai',         name: 'Mem',            url: 'https://mem.ai',                     homepage: 'https://mem.ai',                     category: 'Productivity',       tagline: 'AI-native notes app that organizes itself', pricing: 'freemium', tags: ['notes','knowledge','organize'] },

  // ─── Data Analysis ───
  { slug: 'julius-ai',      name: 'Julius.ai',      url: 'https://julius.ai',                  homepage: 'https://julius.ai',                  category: 'Data Analysis',      tagline: 'Chat with your data — Python + visualizations from prompts', pricing: 'freemium', tags: ['data','python','visualization'] },
  { slug: 'rows',           name: 'Rows',           url: 'https://rows.com',                   homepage: 'https://rows.com',                   category: 'Data Analysis',      tagline: 'AI-powered spreadsheet that connects to APIs and databases', pricing: 'freemium', tags: ['spreadsheet','data','api'] },
  { slug: 'tableau-ai',     name: 'Tableau AI',     url: 'https://tableau.com/products/tableau-ai', homepage: 'https://tableau.com/products/tableau-ai', category: 'Data Analysis', tagline: 'Salesforce\'s AI layer for Tableau analytics', pricing: 'paid',     tags: ['salesforce','bi','enterprise'] },
  { slug: 'hex-tech',       name: 'Hex',            url: 'https://hex.tech',                   homepage: 'https://hex.tech',                   category: 'Data Analysis',      tagline: 'AI-powered notebook for data teams', pricing: 'freemium', tags: ['notebook','sql','analytics'] },

  // ─── Agent & Automation ───
  { slug: 'manus',          name: 'Manus',          url: 'https://manus.im',                   homepage: 'https://manus.im',                   category: 'Agent & Automation', tagline: 'General autonomous AI agent that can build and ship anything', pricing: 'freemium', tags: ['agent','autonomous','general'] },
  { slug: 'devin',          name: 'Devin',          url: 'https://cognition.ai/devin',         homepage: 'https://cognition.ai/devin',         category: 'Agent & Automation', tagline: "Cognition's autonomous AI software engineer", pricing: 'paid',     tags: ['agent','engineer','autonomous'] },
  { slug: 'lindy',          name: 'Lindy',          url: 'https://lindy.ai',                   homepage: 'https://lindy.ai',                   category: 'Agent & Automation', tagline: 'AI employees for sales, support, and operations', pricing: 'freemium', tags: ['agent','employee','b2b'] },
  { slug: 'crewai',         name: 'CrewAI',         url: 'https://crewai.com',                 homepage: 'https://crewai.com',                 category: 'Agent & Automation', tagline: 'Open-source framework for orchestrating role-playing AI agents', pricing: 'open_source', tags: ['framework','agents','open-source'] },
  { slug: 'autogpt',        name: 'AutoGPT',        url: 'https://agpt.co',                    homepage: 'https://agpt.co',                    category: 'Agent & Automation', tagline: 'Autonomous GPT-4 agent that breaks tasks into subtasks', pricing: 'open_source', tags: ['gpt','agent','open-source'] },
  { slug: 'n8n',            name: 'n8n',            url: 'https://n8n.io',                     homepage: 'https://n8n.io',                     category: 'Agent & Automation', tagline: 'Open-source workflow automation with native AI nodes', pricing: 'freemium', tags: ['workflow','automation','open-source'] },
  { slug: 'zapier-ai',      name: 'Zapier AI',      url: 'https://zapier.com/ai',              homepage: 'https://zapier.com/ai',              category: 'Agent & Automation', tagline: 'AI-powered workflow automation across 7000+ apps', pricing: 'freemium', tags: ['workflow','automation','no-code'] },

  // ─── Developer Tools ───
  { slug: 'replicate',      name: 'Replicate',      url: 'https://replicate.com',              homepage: 'https://replicate.com',              category: 'Developer Tools',    tagline: 'Run any open-source AI model with one API call', pricing: 'paid',     tags: ['api','open-source','ml'] },
  { slug: 'huggingface',    name: 'Hugging Face',   url: 'https://huggingface.co',             homepage: 'https://huggingface.co',             category: 'Developer Tools',    tagline: 'The hub for open-source AI models, datasets, and apps', pricing: 'freemium', tags: ['hub','models','datasets'] },
  { slug: 'langchain',      name: 'LangChain',      url: 'https://langchain.com',              homepage: 'https://langchain.com',              category: 'Developer Tools',    tagline: 'Framework for building applications with LLMs', pricing: 'open_source', tags: ['framework','llm','python'] },
  { slug: 'llamaindex',     name: 'LlamaIndex',     url: 'https://llamaindex.ai',              homepage: 'https://llamaindex.ai',              category: 'Developer Tools',    tagline: 'Data framework for connecting LLMs to private data', pricing: 'open_source', tags: ['framework','rag','data'] },
  { slug: 'modal',          name: 'Modal',          url: 'https://modal.com',                  homepage: 'https://modal.com',                  category: 'Developer Tools',    tagline: 'Serverless GPU cloud for ML/AI workloads', pricing: 'paid',     tags: ['gpu','serverless','ml'] },
  { slug: 'fal-ai',         name: 'fal.ai',         url: 'https://fal.ai',                     homepage: 'https://fal.ai',                     category: 'Developer Tools',    tagline: 'Fast inference API for generative AI models', pricing: 'paid',     tags: ['api','inference','gen-ai'] },
  { slug: 'anthropic-api',  name: 'Anthropic API',  url: 'https://anthropic.com/api',          homepage: 'https://anthropic.com/api',          category: 'Developer Tools',    tagline: 'Claude API for building safe, capable AI products', pricing: 'paid',     tags: ['api','claude','anthropic'] },
  { slug: 'openai-api',     name: 'OpenAI API',     url: 'https://platform.openai.com',        homepage: 'https://platform.openai.com',        category: 'Developer Tools',    tagline: 'GPT, DALL-E, Whisper, and more via one API', pricing: 'paid',     tags: ['api','gpt','openai'] },
  { slug: 'cohere',         name: 'Cohere',         url: 'https://cohere.com',                 homepage: 'https://cohere.com',                 category: 'Developer Tools',    tagline: 'Enterprise LLM platform with embeddings and Rerank', pricing: 'paid',     tags: ['enterprise','rag','embeddings'] },
  { slug: 'pinecone',       name: 'Pinecone',       url: 'https://pinecone.io',                homepage: 'https://pinecone.io',                category: 'Developer Tools',    tagline: 'The vector database for AI applications at scale', pricing: 'freemium', tags: ['vector-db','rag','embeddings'] },
  { slug: 'weaviate',       name: 'Weaviate',       url: 'https://weaviate.io',                homepage: 'https://weaviate.io',                category: 'Developer Tools',    tagline: 'Open-source vector database with hybrid search', pricing: 'open_source', tags: ['vector-db','open-source','rag'] },
  { slug: 'lovable',        name: 'Lovable',        url: 'https://lovable.dev',                homepage: 'https://lovable.dev',                category: 'Developer Tools',    tagline: 'AI app builder: prompt → full-stack web app', pricing: 'freemium', tags: ['no-code','app-builder','prompt'] },
  { slug: 'v0-dev',         name: 'v0 by Vercel',   url: 'https://v0.dev',                     homepage: 'https://v0.dev',                     category: 'Developer Tools',    tagline: 'Vercel\'s AI UI generator for React + shadcn/Tailwind', pricing: 'freemium', tags: ['vercel','ui','react'] },
  { slug: 'bolt-new',       name: 'Bolt.new',       url: 'https://bolt.new',                   homepage: 'https://bolt.new',                   category: 'Developer Tools',    tagline: 'StackBlitz\'s in-browser AI full-stack app generator', pricing: 'freemium', tags: ['no-code','app-builder','stackblitz'] },

  // ─── Voice & Speech ───
  { slug: 'whisper',        name: 'Whisper',        url: 'https://openai.com/research/whisper', homepage: 'https://openai.com/research/whisper', category: 'Voice & Speech',     tagline: 'OpenAI\'s open-source speech recognition for 99 languages', pricing: 'open_source', tags: ['speech','transcription','open-source'] },
  { slug: 'deepgram',       name: 'Deepgram',       url: 'https://deepgram.com',               homepage: 'https://deepgram.com',               category: 'Voice & Speech',     tagline: 'Real-time speech-to-text API with 90% lower latency', pricing: 'paid',     tags: ['stt','real-time','api'] },
  { slug: 'assemblyai',     name: 'AssemblyAI',     url: 'https://assemblyai.com',             homepage: 'https://assemblyai.com',             category: 'Voice & Speech',     tagline: 'Speech AI platform: transcription, summarization, sentiment', pricing: 'paid',     tags: ['stt','summarization','api'] },

  // ─── 3D & Design ───
  { slug: 'figma-ai',       name: 'Figma AI',       url: 'https://figma.com/ai',               homepage: 'https://figma.com/ai',               category: '3D & Design',        tagline: 'AI features built into Figma: First Draft, Make Designs, more', pricing: 'paid',     tags: ['figma','design','ui'] },
  { slug: 'galileo-ai',     name: 'Galileo AI',     url: 'https://usegalileo.ai',              homepage: 'https://usegalileo.ai',              category: '3D & Design',        tagline: 'AI UI designer: text → editable Figma designs', pricing: 'freemium', tags: ['design','ui','figma'] },
  { slug: 'spline-ai',      name: 'Spline AI',      url: 'https://spline.design/ai',           homepage: 'https://spline.design/ai',           category: '3D & Design',        tagline: 'AI-powered 3D design and animation in the browser', pricing: 'freemium', tags: ['3d','design','animation'] },
  { slug: 'meshy',          name: 'Meshy',          url: 'https://meshy.ai',                   homepage: 'https://meshy.ai',                   category: '3D & Design',        tagline: 'Generate 3D models from text or images for games', pricing: 'freemium', tags: ['3d','game-art','models'] },
];

async function main() {
  const db = dbModule.getClient();
  log.info(`Seeding ${TOOLS.length} top essential tools...`);

  let inserted = 0;
  let updated = 0;
  let failed = 0;

  for (const t of TOOLS) {
    const row = {
      slug: t.slug,
      name: t.name,
      tagline: t.tagline,
      description: t.tagline,        // backfilled later by enrich script
      url: t.url,
      homepage: t.homepage,
      category: t.category,
      tags: t.tags || [],
      pricing: t.pricing || 'unknown',
      source: 'curated_seed',
      upvotes: 1000,                  // give them a high boost so they appear featured
      confidence: 0.95,
      classifier_version: 'curated_v1',
      is_active: true,
      published_at: new Date().toISOString(),
    };

    const { data: existing } = await db.from('tools').select('id').eq('slug', t.slug).maybeSingle();
    try {
      if (existing) {
        const { error } = await db.from('tools').update({
          ...row,
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
        if (error) throw error;
        updated++;
      } else {
        const { error } = await db.from('tools').insert(row);
        if (error) throw error;
        inserted++;
      }
    } catch (err) {
      log.warn(`Failed for ${t.slug}: ${err.message}`);
      failed++;
    }
  }

  log.info(`══════════════════════════════════════════════`);
  log.info(`✓ Seed complete.`);
  log.info(`   Inserted: ${inserted}`);
  log.info(`   Updated:  ${updated}`);
  log.info(`   Failed:   ${failed}`);
  log.info(`══════════════════════════════════════════════`);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
