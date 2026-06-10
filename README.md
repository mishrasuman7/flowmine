# FlowMine

> An AI workforce that learns by watching how a team works.

FlowMine is a B2B SaaS platform that observes browser activity across a team, detects repetitive multi-step workflows, converts each pattern into an executable AI skill, and lets the agent take over the work.

## How it works

1. **Observe** — A Chrome extension captures lightweight browser metadata (domain, navigation, tab activity). No keystrokes. No page content. No passwords.
2. **Detect** — A streaming pattern-detection pipeline identifies multi-step sequences that recur across multiple employees.
3. **Generate** — Claude turns each pattern into a structured, executable skill specification.
4. **Execute** — The extension runs the skill in the user's browser, with adaptive selector recovery when the DOM shifts.

## Quickstart

See **[DEPLOY.md](./DEPLOY.md)** for the full setup walkthrough — Pusher, DynamoDB, Aurora, environment variables, Vercel, and loading the extension.

```bash
# Web app
cd web && pnpm install && pnpm dev          # http://localhost:3000

# Seed demo data + run detection
cd scripts && pnpm install && pnpm seed:apply
curl -X POST http://localhost:3000/api/detect \
  -H "Content-Type: application/json" \
  -d '{"team_id":"demo_team_001","window_days":21}'

# Chrome extension
cd extension && pnpm install && pnpm build   # load extension/dist unpacked
```

## Repository layout

```
flowmine/
├── web/         Next.js app — dashboard, API routes (Vercel deployment root)
├── extension/   Chrome Manifest V3 extension — capture + execution
└── scripts/     Seed data, Aurora schema, one-off tooling
```

## Tech stack

| Layer              | Technology                                  |
|--------------------|---------------------------------------------|
| Web app            | Next.js 16 (App Router), TypeScript strict  |
| Hosting            | Vercel                                      |
| UI                 | shadcn/ui, Tailwind CSS, Framer Motion      |
| Event store        | AWS DynamoDB (on-demand)                    |
| Relational store   | AWS Aurora PostgreSQL 16 + pgvector         |
| Detection          | Pure algorithm (shared by API route + Lambda) |
| Realtime           | Pusher Channels                             |
| AI generation      | Anthropic Claude (Sonnet + Haiku)           |
| Embeddings         | OpenAI `text-embedding-3-small`             |
| Browser client     | Chrome Manifest V3 + TypeScript             |

## Status

Feature-complete: full observe → detect → generate → execute loop is
implemented across the web app, API, detection algorithm, dashboard, and
extension. Remaining work is operational provisioning — see
[DEPLOY.md](./DEPLOY.md).

## License

Proprietary — all rights reserved.
