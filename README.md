# FlowMine

> An AI workforce that learns by watching how a team works.

FlowMine is a B2B SaaS platform that observes browser activity across a team, detects repetitive multi-step workflows, converts each pattern into an executable AI skill, and lets the agent take over the work.

## How it works

1. **Observe** — A Chrome extension captures lightweight browser metadata (domain, navigation, tab activity). No keystrokes. No page content. No passwords.
2. **Detect** — A streaming pattern-detection pipeline identifies multi-step sequences that recur across multiple employees.
3. **Generate** — Claude turns each pattern into a structured, executable skill specification.
4. **Execute** — The extension runs the skill in the user's browser, with adaptive selector recovery when the DOM shifts.

## Repository layout

```
flowmine/
├── web/         Next.js 15 app — dashboard, API routes (Vercel deployment root)
├── extension/   Chrome Manifest V3 extension — capture + execution
└── scripts/     Seed data, Aurora schema, one-off tooling
```

## Tech stack

| Layer              | Technology                                  |
|--------------------|---------------------------------------------|
| Web app            | Next.js 15 (App Router), TypeScript strict  |
| Hosting            | Vercel                                      |
| UI                 | shadcn/ui, Tailwind CSS, Framer Motion      |
| Event store        | AWS DynamoDB (on-demand)                    |
| Relational store   | AWS Aurora PostgreSQL 16 + pgvector         |
| Streaming          | DynamoDB Streams -> AWS Lambda              |
| Realtime           | Pusher Channels                             |
| AI generation      | Anthropic Claude (Sonnet + Haiku)           |
| Embeddings         | OpenAI `text-embedding-3-small`             |
| Browser client     | Chrome Manifest V3 + TypeScript             |

## Status

Early build. See the project tracker for current milestone.

## License

Proprietary — all rights reserved.
