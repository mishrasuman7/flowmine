# FlowMine — Devpost submission

> An AI workforce that learns by watching how a team actually works.

**Tagline:** FlowMine watches how your team really works, finds the repetitive
browser workflows nobody documents, and turns them into AI skills that run
themselves.

**Live demo:** https://flowmine-theta.vercel.app
**Repo:** https://github.com/mishrasuman7/flowmine
**Track:** B2B · H0: Hack the Zero Stack (Vercel + AWS)

---

## Inspiration

Every team has invisible work — the 6-tab routine to onboard a customer, the
copy-paste dance between a CRM and a billing tool, the weekly report nobody
wrote down how to make. It never shows up in a process doc because it lives in
people's muscle memory. Automation tools exist, but they all start with the same
impossible ask: *"first, map out your workflow."* Nobody does, so nothing gets
automated.

I wanted to flip it. What if the tool figured out the workflow on its own — by
just watching the browser — and then offered to do it for you?

## What it does

FlowMine closes a full **observe → detect → generate → execute** loop:

1. **Observe** — A Chrome extension captures lightweight browser metadata
   (domain, navigation, tab switches). No keystrokes, no page content, no
   passwords. Events stream to the backend in batches.
2. **Detect** — A streaming pattern-detection algorithm finds multi-step domain
   sequences that recur across multiple employees, and scores each by how
   frequent, how widely shared, and how time-consistent it is.
3. **Generate** — Google Gemini turns each high-scoring pattern into a
   structured, executable skill specification, and estimates the hours/month the
   team would save by automating it.
4. **Execute** — The extension runs the skill back in the user's browser —
   navigate, click, fill, submit — with adaptive selector recovery when the DOM
   shifts.

On the demo team's three weeks of activity: **1,003 events → 8 detected
patterns → 6 generated AI skills → ~94 hours/month saved → a 1,128-hour
12-month ROI projection.**

## How I built it

**The architecture is the product.** FlowMine deliberately uses two AWS
databases because the two halves of the problem have opposite shapes:

- **AWS DynamoDB** absorbs the high-write event firehose from every browser —
  on-demand capacity, a GSI for team-scoped queries, and TTL so raw events
  expire automatically.
- **AWS Aurora PostgreSQL + pgvector** stores the structured output (patterns,
  skills, attribution, executions) *and* powers semantic dedup: every generated
  skill is embedded with `gemini-embedding-001` (1536-dim) and checked against
  existing skills by cosine distance, so the same workflow is never generated
  twice.

The rest of the stack:

- **Vercel** hosts a **Next.js 16 (App Router)** app. Server components read
  Aurora directly; API routes (`/api/events`, `/api/detect`,
  `/api/generate-skill`, `/api/execute`) handle ingestion, detection, and
  generation.
- **Google Gemini 2.5 Flash** does both skill generation and pattern
  interpretation (ROI estimation), with strict JSON output.
- **Pusher Channels** pushes realtime updates to the dashboard as patterns and
  skills appear.
- **Chrome Manifest V3 extension** (TypeScript, esbuild) handles both capture
  and execution.

**Detection algorithm:** a sliding window over each user's event stream at
window sizes k = 2, 3, 4 produces candidate sequences. Each candidate is scored
`log(1 + frequency) × (users / teamSize) × (1 − timeInconsistency)` — rewarding
workflows that are frequent, shared across the team, and habitual (done at
consistent times of day) rather than one-off.

## Challenges I ran into

- **Gemini's "thinking" tokens silently ate my output budget.** Skill
  generation kept returning truncated JSON. The cause wasn't a bad prompt — 2.5
  Flash spends part of `maxOutputTokens` on internal reasoning, so the visible
  JSON got cut off. Fixed by setting `thinkingBudget: 0` and raising the output
  ceilings.
- **Designing two databases that don't overlap.** It was tempting to force
  everything into Postgres. Keeping DynamoDB strictly for the append-only event
  stream and Aurora for everything queryable/relational/semantic kept both fast
  and made the cost story clean.
- **Vercel Hobby function timeouts.** Detection over thousands of events
  exceeded the default limit; raising `maxDuration` and trimming the read path
  fixed the 503s.
- **Migrating off paid APIs mid-build.** I started on a paid LLM + embedding
  stack and migrated the entire generation and embedding layer to free Google
  Gemini without changing the product surface — proof the LLM layer was cleanly
  abstracted.

## Accomplishments I'm proud of

- A genuinely end-to-end loop — not a mockup. Events really flow from a browser
  through two AWS databases and come back out as a skill the extension runs.
- A privacy-respecting capture model: metadata only, never content.
- Semantic dedup with pgvector that keeps the skill library clean.
- A clean, deployed product with a live dashboard and real ROI numbers.

## What I learned

- How to split a workload across the right storage primitives instead of forcing
  one database to do everything.
- The operational realities of LLM output budgets, JSON-mode reliability, and
  grounding model output so it never invents data.
- pgvector as a practical dedup engine, not just a RAG buzzword.

## What's next for FlowMine

- Cross-application capture beyond the browser.
- Human-in-the-loop approval and step-by-step "explain this skill" views.
- Confidence scoring and automatic selector self-healing using Gemini.
- Team analytics: which automations actually saved time, measured against the
  projection.

## Built with

`next.js` · `typescript` · `vercel` · `aws-dynamodb` · `aws-aurora` ·
`postgresql` · `pgvector` · `google-gemini` · `pusher` · `chrome-extension` ·
`tailwindcss` · `framer-motion`
