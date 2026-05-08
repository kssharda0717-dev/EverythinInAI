/*
 * EverythinInAI — AI Chatbot Widget
 *
 * Floating button bottom-right that expands into a chat panel.
 * Powered by /api/chat (Vercel Serverless Function).
 *
 * Features:
 *   - Find tools by description ("I need a tool that does X")
 *   - Returns 3 best matches with reasoning
 *   - Clicking a tool result opens the SidePeekDrawer (signal via custom event)
 */

import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageCircle, X, Send, Sparkles, ExternalLink, Loader2 } from 'lucide-react';

interface ToolMatch {
  slug: string;
  name: string;
  tagline: string;
  category: string;
  pricing: string;
  url: string;
  sourceUrl?: string | null;
}

interface Message {
  role: 'user' | 'assistant';
  text: string;
  tools?: ToolMatch[];
}

const STARTER_PROMPTS = [
  'Best AI tool to write SQL from natural language',
  'Free image generator for logos',
  'AI agent that can read my emails',
  'Open-source alternative to Cursor',
];

export default function ChatBot() {
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      text: "Hey, I'm Avi 👋 Tell me what you need to build and I'll find the right AI tool for it.",
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  async function send(query: string) {
    const trimmed = query.trim();
    if (!trimmed || isLoading) return;

    setMessages(prev => [...prev, { role: 'user', text: trimmed }]);
    setInput('');
    setIsLoading(true);

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      setMessages(prev => [...prev, {
        role: 'assistant',
        text: data.reply || 'Here are some tools that might help.',
        tools: data.tools || [],
      }]);
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: `Sorry, I hit an error (${err.message}). Try again in a moment, or browse the directory.`,
      }]);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      {/* Floating trigger button */}
      <motion.button
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 1, type: 'spring' }}
        onClick={() => setIsOpen(v => !v)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-gradient-to-br from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white shadow-lg flex items-center justify-center hover:scale-110 transition-transform"
        aria-label="Open AI assistant"
      >
        <AnimatePresence mode="wait">
          {isOpen ? (
            <motion.div key="x" initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: 90, opacity: 0 }}>
              <X className="w-6 h-6" />
            </motion.div>
          ) : (
            <motion.div key="msg" initial={{ rotate: 90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }} exit={{ rotate: -90, opacity: 0 }}>
              <Sparkles className="w-6 h-6" />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.button>

      {/* Chat panel */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="fixed bottom-24 right-6 z-50 w-[min(420px,calc(100vw-2rem))] h-[min(560px,calc(100vh-8rem))] bg-white rounded-3xl elevation-3 flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="px-5 py-4 bg-gradient-to-r from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                <Sparkles className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold">Avi · AI Tool Finder</div>
                <div className="text-[0.65rem] text-white/70">Ask me to find any tool</div>
              </div>
            </div>

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                    m.role === 'user'
                      ? 'bg-[oklch(0.55_0.18_230)] text-white'
                      : 'bg-[oklch(0.97_0.005_230)] text-foreground'
                  }`}>
                    <div>{m.text}</div>
                    {m.tools && m.tools.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {m.tools.map(t => (
                          <a
                            key={t.slug}
                            href={t.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block bg-white rounded-xl px-3 py-2.5 hover:shadow-md transition-shadow group"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-semibold text-foreground group-hover:text-[oklch(0.45_0.15_230)] transition-colors">
                                  {t.name}
                                </div>
                                <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                                  {t.tagline}
                                </div>
                                <div className="flex items-center gap-2 mt-1.5 text-[0.65rem] text-muted-foreground">
                                  <span>{t.category}</span>
                                  <span>·</span>
                                  <span className="capitalize">{t.pricing === 'open_source' ? 'open source' : t.pricing}</span>
                                </div>
                              </div>
                              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
                            </div>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="rounded-2xl px-4 py-2.5 bg-[oklch(0.97_0.005_230)]">
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                  </div>
                </div>
              )}

              {/* Starter prompts (only show on first state) */}
              {messages.length === 1 && !isLoading && (
                <div className="pt-2 space-y-1.5">
                  {STARTER_PROMPTS.map((p) => (
                    <button
                      key={p}
                      onClick={() => send(p)}
                      className="block w-full text-left px-3 py-2 rounded-xl text-xs bg-[oklch(0.97_0.005_230)] hover:bg-[oklch(0.94_0.01_230)] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Input */}
            <div className="border-t border-[oklch(0.94_0.005_230)] px-3 py-3">
              <form
                onSubmit={(e) => { e.preventDefault(); send(input); }}
                className="flex items-center gap-2"
              >
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="What tool do you need?"
                  disabled={isLoading}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-[oklch(0.97_0.005_230)] text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-[oklch(0.55_0.18_230)/_0.3]"
                />
                <button
                  type="submit"
                  disabled={isLoading || !input.trim()}
                  className="w-10 h-10 rounded-xl bg-gradient-to-br from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white flex items-center justify-center hover:scale-105 transition-transform disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="Send"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
