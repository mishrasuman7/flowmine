import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen bg-white font-sans">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-slate-100">
        <span className="text-lg font-semibold tracking-tight text-slate-900">
          FLOWMINE
        </span>
        <Link
          href="/dashboard"
          className="rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
        >
          Open dashboard →
        </Link>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-4xl px-8 pt-24 pb-16 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-4 py-1.5 text-xs font-medium text-slate-600 mb-8">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Built for H0: Hack the Zero Stack · Vercel + AWS
        </div>

        <h1 className="text-5xl font-bold tracking-tight text-slate-900 leading-tight mb-6">
          Your team&apos;s workflows,<br />
          <span className="text-slate-400">automated while you sleep.</span>
        </h1>

        <p className="text-xl text-slate-500 max-w-2xl mx-auto leading-relaxed mb-10">
          FlowMine watches how your team actually works — not how you think they work.
          It detects repeated browser workflows, generates executable AI skills,
          and runs them automatically.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/dashboard"
            className="rounded-full bg-slate-900 px-8 py-3.5 text-sm font-semibold text-white hover:bg-slate-700 transition-colors"
          >
            See live dashboard →
          </Link>
          <a
            href="https://github.com/mishrasuman7/flowmine"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-slate-200 px-8 py-3.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
          >
            View source
          </a>
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-5xl px-8 py-16">
        <h2 className="text-center text-sm font-semibold uppercase tracking-widest text-slate-400 mb-12">
          How it works
        </h2>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-8">
            <div className="text-3xl mb-4">👁</div>
            <h3 className="font-semibold text-slate-900 mb-2">Observe</h3>
            <p className="text-sm text-slate-500 leading-relaxed">
              A Chrome extension silently records which sites your team visits
              and in what sequence — no manual logging, no surveys.
              Events stream into AWS DynamoDB in real time.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-8">
            <div className="text-3xl mb-4">🔍</div>
            <h3 className="font-semibold text-slate-900 mb-2">Detect</h3>
            <p className="text-sm text-slate-500 leading-relaxed">
              A sliding-window algorithm scores every repeated domain sequence
              by frequency, team participation, and time-of-day consistency.
              Patterns are ranked and stored in Aurora PostgreSQL + pgvector.
            </p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-8">
            <div className="text-3xl mb-4">⚡</div>
            <h3 className="font-semibold text-slate-900 mb-2">Automate</h3>
            <p className="text-sm text-slate-500 leading-relaxed">
              Gemini generates a step-by-step executable skill for each pattern.
              Activate it and the extension runs the workflow for anyone on the team —
              navigate, click, fill, submit.
            </p>
          </div>
        </div>
      </section>

      {/* Stats strip */}
      <section className="border-y border-slate-100 bg-slate-50 py-12">
        <div className="mx-auto max-w-4xl px-8 grid grid-cols-2 gap-8 sm:grid-cols-4 text-center">
          <div>
            <div className="text-3xl font-bold text-slate-900">1,003</div>
            <div className="text-sm text-slate-500 mt-1">Events captured</div>
          </div>
          <div>
            <div className="text-3xl font-bold text-slate-900">8</div>
            <div className="text-sm text-slate-500 mt-1">Patterns detected</div>
          </div>
          <div>
            <div className="text-3xl font-bold text-slate-900">94 hr</div>
            <div className="text-sm text-slate-500 mt-1">Saved per month</div>
          </div>
          <div>
            <div className="text-3xl font-bold text-slate-900">1,128 hr</div>
            <div className="text-sm text-slate-500 mt-1">12-month projection</div>
          </div>
        </div>
      </section>

      {/* Tech stack */}
      <section className="mx-auto max-w-4xl px-8 py-16 text-center">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-400 mb-8">
          Built on
        </h2>
        <div className="flex flex-wrap gap-3 justify-center">
          {[
            'AWS DynamoDB',
            'AWS Aurora PostgreSQL',
            'pgvector',
            'Vercel',
            'Next.js 16',
            'Google Gemini 2.5 Flash',
            'Chrome MV3 Extension',
            'Pusher Channels',
            'TypeScript strict',
          ].map((tech) => (
            <span
              key={tech}
              className="rounded-full border border-slate-200 px-4 py-1.5 text-sm text-slate-600"
            >
              {tech}
            </span>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-4xl px-8 pb-24 text-center">
        <div className="rounded-3xl bg-slate-900 px-8 py-16">
          <h2 className="text-3xl font-bold text-white mb-4">
            See it running live
          </h2>
          <p className="text-slate-400 mb-8 max-w-md mx-auto">
            The demo team has 3 weeks of browsing data. 8 patterns detected,
            6 AI skills generated, ROI projected to 1,128 hours saved.
          </p>
          <Link
            href="/dashboard"
            className="inline-block rounded-full bg-white px-8 py-3.5 text-sm font-semibold text-slate-900 hover:bg-slate-100 transition-colors"
          >
            Open the dashboard →
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 px-8 py-6 text-center text-xs text-slate-400">
        FlowMine · Built for H0: Hack the Zero Stack ·{' '}
        <a
          href="https://github.com/mishrasuman7/flowmine"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-slate-600"
        >
          github.com/mishrasuman7/flowmine
        </a>
      </footer>
    </div>
  );
}
