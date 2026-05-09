/*
 * EverythinInAI — Privacy Policy
 * Plain-language policy page; B15 backstop for legal links.
 */

import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

export default function Privacy() {
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 sm:px-6 pt-32 pb-16">
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-foreground mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: May 9, 2026</p>

        <section className="prose prose-sm max-w-none text-foreground space-y-6">
          <div>
            <h2 className="text-xl font-semibold mb-2">What we collect</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              EverythinInAI is a public AI tools directory. We collect minimal information:
              (a) anonymous page-view analytics to improve the site, (b) email addresses
              you voluntarily provide via the newsletter signup, and (c) freeform text
              you type into the AI Tool Finder chat. We do not require accounts, do not
              place persistent identifying cookies, and do not sell data to third parties.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-2">Newsletter</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              If you subscribe to "The 8 AM AI brief," your email is stored solely to
              send you the digest. You can unsubscribe in one click via any newsletter
              footer link, which permanently flags your row as inactive in our database.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-2">AI Tool Finder</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Queries you type into the chat widget are sent to our backend, which
              forwards them to Google's Gemini API for matching against our public
              tool database. We do not store individual chat queries linked to your
              identity. Aggregated query patterns may inform site improvements.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-2">Tool listings</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              All listed tools are sourced from publicly available metadata (GitHub
              repos, Product Hunt, Hacker News, and similar sources). If you are an
              owner and want your tool removed or its metadata corrected, email{" "}
              <a className="underline" href="mailto:hello@everythininai.com">hello@everythininai.com</a>.
              We respond within 7 days.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-2">Children</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              EverythinInAI is not directed at children under 13. We do not knowingly
              collect personal information from anyone under that age.
            </p>
          </div>

          <div>
            <h2 className="text-xl font-semibold mb-2">Contact</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Questions? <a className="underline" href="mailto:hello@everythininai.com">hello@everythininai.com</a>
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
