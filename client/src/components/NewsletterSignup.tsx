/*
 * EverythinInAI — Newsletter Signup
 * Compact email signup that posts to /api/newsletter
 */

import { useState } from 'react';
import { Mail, Check, Loader2 } from 'lucide-react';

export default function NewsletterSignup() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'err'>('idle');
  const [message, setMessage] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || status === 'loading') return;
    setStatus('loading');
    setMessage('');

    try {
      const r = await fetch('/api/newsletter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await r.json();
      if (r.ok) {
        setStatus('ok');
        setMessage(data.message || "You're in.");
        setEmail('');
      } else {
        setStatus('err');
        setMessage(data.error || 'Something went wrong.');
      }
    } catch (err: any) {
      setStatus('err');
      setMessage(err.message || 'Network error.');
    }
  }

  return (
    <div className="bg-gradient-to-br from-[oklch(0.97_0.01_230)] to-[oklch(0.95_0.02_210)] rounded-3xl p-6 sm:p-8 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] flex items-center justify-center">
          <Mail className="w-5 h-5 text-white" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">The 8 AM AI brief</h3>
          <p className="text-xs text-muted-foreground">3 tools, 2 stories, 1 take. Daily, in your inbox.</p>
        </div>
      </div>
      <form onSubmit={submit} className="flex gap-2 mt-4">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          disabled={status === 'loading'}
          className="flex-1 px-4 py-2.5 rounded-xl bg-white text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-[oklch(0.55_0.18_230)/_0.3]"
        />
        <button
          type="submit"
          disabled={status === 'loading' || status === 'ok'}
          className="px-5 py-2.5 rounded-xl bg-gradient-to-br from-[oklch(0.55_0.18_230)] to-[oklch(0.60_0.16_210)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
        >
          {status === 'loading' && <Loader2 className="w-4 h-4 animate-spin" />}
          {status === 'ok' && <Check className="w-4 h-4" />}
          {status === 'idle' && 'Subscribe'}
          {status === 'err' && 'Try again'}
          {status === 'ok' && 'Subscribed'}
          {status === 'loading' && 'Joining…'}
        </button>
      </form>
      {message && (
        <p className={`text-xs mt-3 ${status === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
          {message}
        </p>
      )}
    </div>
  );
}
