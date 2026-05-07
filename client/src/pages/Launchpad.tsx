/*
 * POLAR LUMINANCE — Launchpad Page
 * Chat-style natural language submission flow.
 * UI asks questions → user replies → live card preview builds in real-time.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Send, Sparkles, ArrowUpRight, ExternalLink, CheckCircle2, RotateCcw } from "lucide-react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { CATEGORY_BADGE_MAP, CATEGORIES } from "@/lib/data";
import type { AITool } from "@/lib/data";
import { submitTool } from "@/hooks/useTools";

type ChatStep = "name" | "link" | "tagline" | "category" | "done";

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  text: string;
  step: ChatStep;
}

const STEP_QUESTIONS: Record<ChatStep, string> = {
  name: "Hey! What did you build? Tell me the name of your AI tool.",
  link: "Nice! What's the link where people can try it?",
  tagline: "In one sentence, what does it do?",
  category: "Last one — what category fits best?",
  done: "",
};

const STEP_ORDER: ChatStep[] = ["name", "link", "tagline", "category", "done"];

export default function Launchpad() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "1", role: "assistant", text: STEP_QUESTIONS.name, step: "name" },
  ]);
  const [currentStep, setCurrentStep] = useState<ChatStep>("name");
  const [input, setInput] = useState("");
  const [toolData, setToolData] = useState<Partial<AITool>>({
    pricing: "unknown",
    upvotes: 0,
    tags: [],
    source: "launchpad",
    publishedAt: new Date().toISOString(),
  });
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [currentStep]);

  const advanceStep = useCallback(
    (userAnswer: string) => {
      const stepIndex = STEP_ORDER.indexOf(currentStep);
      const nextStep = STEP_ORDER[stepIndex + 1] || "done";

      // Update tool data based on current step
      const updatedTool = { ...toolData };
      switch (currentStep) {
        case "name":
          updatedTool.name = userAnswer;
          break;
        case "link":
          updatedTool.url = userAnswer.startsWith("http") ? userAnswer : `https://${userAnswer}`;
          break;
        case "tagline":
          updatedTool.tagline = userAnswer;
          updatedTool.description = userAnswer;
          break;
        case "category":
          updatedTool.category = userAnswer;
          break;
      }
      setToolData(updatedTool);

      // Add user message
      const userMsg: ChatMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        text: userAnswer,
        step: currentStep,
      };

      if (nextStep === "done") {
        // Submit to API
        submitTool({
          name: updatedTool.name || '',
          url: updatedTool.url || '',
          tagline: updatedTool.tagline || '',
          category: updatedTool.category || 'Other',
        }).then((result) => {
          const statusText = result.success
            ? `Your tool "${updatedTool.name}" has been submitted for review! We'll add it to the discovery stream shortly.`
            : `Your tool "${updatedTool.name}" is ready for review! ${result.message}`;
          const doneMsg: ChatMessage = {
            id: `done-${Date.now()}`,
            role: "assistant",
            text: statusText,
            step: "done",
          };
          setMessages((prev) => [...prev, doneMsg]);
        });

        const pendingMsg: ChatMessage = {
          id: `done-${Date.now()}`,
          role: "assistant",
          text: `Submitting "${updatedTool.name}" to the directory...`,
          step: "done",
        };
        setMessages((prev) => [...prev, userMsg, pendingMsg]);
      } else {
        const nextMsg: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: STEP_QUESTIONS[nextStep],
          step: nextStep,
        };
        setMessages((prev) => [...prev, userMsg, nextMsg]);
      }

      setCurrentStep(nextStep);
      setInput("");
    },
    [currentStep, toolData]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || currentStep === "done") return;
    advanceStep(input.trim());
  };

  const handleCategorySelect = (cat: string) => {
    advanceStep(cat);
  };

  const handleReset = () => {
    setMessages([{ id: "1", role: "assistant", text: STEP_QUESTIONS.name, step: "name" }]);
    setCurrentStep("name");
    setInput("");
    setToolData({
      pricing: "unknown",
      upvotes: 0,
      tags: [],
      source: "launchpad",
      publishedAt: new Date().toISOString(),
    });
  };

  const badgeClass = CATEGORY_BADGE_MAP[toolData.category || ""] || "badge-other";

  return (
    <div className="min-h-screen bg-background">
      <Navbar />

      {/* Hero */}
      <section className="relative pt-28 pb-8 px-4">
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-b from-[oklch(0.96_0.01_230)] via-white to-white" />
          <div
            className="absolute inset-0 opacity-[0.06] bg-cover bg-center mix-blend-multiply"
            style={{
              backgroundImage: `url(https://d2xsxph8kpxj0f.cloudfront.net/310519663529896497/QBqeAVQQED5JYrhp7rE5AR/launchpad-bg-ZTYPZXdnLTpeFWxq4g5Dun.webp)`,
            }}
          />
        </div>
        <div className="relative z-10 max-w-3xl mx-auto text-center">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-display text-foreground mb-3"
          >
            Launch your{" "}
            <span className="bg-gradient-to-r from-[oklch(0.55_0.18_230)] to-[oklch(0.65_0.15_185)] bg-clip-text text-transparent">
              AI
            </span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-subheading text-muted-foreground"
          >
            Submit your tool to the world's largest AI directory. No forms — just a conversation.
          </motion.p>
        </div>
      </section>

      {/* Chat + Preview Layout */}
      <section className="px-4 sm:px-6 lg:px-8 pb-20">
        <div className="max-w-[1200px] mx-auto grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8">
          {/* Chat Column */}
          <div className="lg:col-span-3">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="glass-strong rounded-3xl overflow-hidden"
            >
              {/* Chat messages */}
              <div className="p-6 space-y-4 min-h-[400px] max-h-[500px] overflow-y-auto">
                <AnimatePresence mode="popLayout">
                  {messages.map((msg) => (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ type: "spring", stiffness: 200, damping: 25 }}
                      className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                          msg.role === "user"
                            ? "bg-foreground text-white rounded-br-md"
                            : "bg-[oklch(0.96_0.005_230)] text-foreground rounded-bl-md"
                        }`}
                      >
                        {msg.role === "assistant" && (
                          <Sparkles className="w-3.5 h-3.5 text-[oklch(0.55_0.18_230)] inline mr-1.5 -mt-0.5" />
                        )}
                        {msg.text}
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                <div ref={chatEndRef} />
              </div>

              {/* Category selector (special step) */}
              {currentStep === "category" && (
                <div className="px-6 pb-4">
                  <div className="flex flex-wrap gap-2">
                    {CATEGORIES.map((cat) => (
                      <button
                        key={cat}
                        onClick={() => handleCategorySelect(cat)}
                        className="px-3 py-1.5 rounded-xl text-xs font-medium bg-[oklch(0.97_0.005_230)] text-muted-foreground hover:bg-foreground hover:text-white transition-all"
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Input */}
              {currentStep !== "done" && currentStep !== "category" ? (
                <form onSubmit={handleSubmit} className="p-4 border-t border-[oklch(0.94_0.005_230)]">
                  <div className="flex items-center gap-3">
                    <input
                      ref={inputRef}
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder={
                        currentStep === "name"
                          ? "e.g., SuperAI Assistant"
                          : currentStep === "link"
                          ? "e.g., https://superai.com"
                          : "Type your answer..."
                      }
                      className="flex-1 py-3 px-4 rounded-xl bg-[oklch(0.97_0.005_230)] text-sm outline-none placeholder:text-muted-foreground/50 text-foreground focus:ring-2 focus:ring-[oklch(0.75_0.12_230_/_30%)] transition-shadow"
                    />
                    <button
                      type="submit"
                      disabled={!input.trim()}
                      className="w-10 h-10 rounded-xl bg-foreground text-white flex items-center justify-center disabled:opacity-30 transition-opacity"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </form>
              ) : currentStep === "done" ? (
                <div className="p-4 border-t border-[oklch(0.94_0.005_230)] flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm text-[oklch(0.50_0.15_150)]">
                    <CheckCircle2 className="w-4 h-4" />
                    Submission received
                  </div>
                  <button
                    onClick={handleReset}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-[oklch(0.96_0.005_230)] transition-colors"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Submit another
                  </button>
                </div>
              ) : null}
            </motion.div>
          </div>

          {/* Live Preview Column */}
          <div className="lg:col-span-2">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <p className="text-functional text-muted-foreground mb-3">Live Preview</p>

              {/* Preview card */}
              <div className="glass-strong rounded-3xl p-6">
                {toolData.name ? (
                  <motion.div
                    key={`${toolData.name}-${toolData.category}`}
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ type: "spring", stiffness: 200, damping: 25 }}
                  >
                    {/* Category badge */}
                    {toolData.category && (
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-[0.65rem] font-semibold tracking-wide uppercase ${badgeClass} mb-4`}>
                        {toolData.category}
                      </span>
                    )}

                    {/* Name */}
                    <h3 className="text-lg font-semibold text-foreground mb-1.5">
                      {toolData.name || "Your Tool Name"}
                    </h3>

                    {/* Tagline */}
                    <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                      {toolData.tagline || "Your one-line description will appear here..."}
                    </p>

                    {/* URL */}
                    {toolData.url && (
                      <a
                        href={toolData.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-[oklch(0.55_0.18_230)] hover:underline"
                      >
                        <ExternalLink className="w-3 h-3" />
                        {toolData.url}
                      </a>
                    )}

                    {/* Footer */}
                    <div className="flex items-center justify-between pt-4 mt-4 border-t border-[oklch(0.95_0.005_230)]">
                      <span className="text-functional text-muted-foreground flex items-center gap-1">
                        <ArrowUpRight className="w-3 h-3" />0
                      </span>
                      <span className="text-[0.65rem] font-medium px-2 py-0.5 rounded-md bg-[oklch(0.97_0.005_230)] text-muted-foreground">
                        just now
                      </span>
                    </div>
                  </motion.div>
                ) : (
                  <div className="text-center py-8">
                    <div className="w-12 h-12 rounded-2xl bg-[oklch(0.96_0.01_230)] flex items-center justify-center mx-auto mb-3">
                      <Sparkles className="w-5 h-5 text-muted-foreground/30" />
                    </div>
                    <p className="text-sm text-muted-foreground/50">
                      Your tool card will appear here as you chat
                    </p>
                  </div>
                )}
              </div>

              {/* Neural abstract decoration */}
              <div className="mt-6 rounded-2xl overflow-hidden opacity-60">
                <img
                  src="https://d2xsxph8kpxj0f.cloudfront.net/310519663529896497/QBqeAVQQED5JYrhp7rE5AR/ai-neural-abstract-fdonf4wTURy2oXug8AgXDU.webp"
                  alt=""
                  className="w-full h-32 object-cover"
                  loading="lazy"
                />
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
