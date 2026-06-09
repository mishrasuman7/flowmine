-- =============================================================================
-- FlowMine - Aurora PostgreSQL 16 schema
--
-- Run once against a fresh Aurora cluster, connected as a superuser. This
-- script creates the relational store for teams, users, detected patterns,
-- generated skills (with pgvector embeddings), pattern-user attribution, and
-- skill execution telemetry. DynamoDB owns the high-write browser event
-- stream; everything in this file is the durable, queryable side of FlowMine.
--
-- Idempotency: every CREATE uses IF NOT EXISTS where supported. The demo seed
-- block at the bottom uses ON CONFLICT DO NOTHING so re-running this file
-- against a populated database is safe.
--
-- Connection: psql "host=$AURORA_HOST port=5432 dbname=postgres \
--                   user=$AURORA_USERNAME password=$AURORA_PASSWORD" \
--             -f scripts/schema.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Database
-- -----------------------------------------------------------------------------
-- CREATE DATABASE cannot run inside a transaction block and cannot use
-- IF NOT EXISTS in older Postgres releases, so it lives in its own statement
-- and is expected to be a no-op on subsequent runs (the error is benign).
CREATE DATABASE flowmine;

\c flowmine

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------
-- pgvector powers cosine-similarity search across skill embeddings so we can
-- deduplicate semantically equivalent skills before generating a new one.
CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- Tenancy
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS teams (
  team_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT DEFAULT 'free',
  seat_count  INTEGER DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  user_id    TEXT PRIMARY KEY,
  team_id    TEXT REFERENCES teams(team_id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  role       TEXT DEFAULT 'member',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- Detected workflow patterns
-- -----------------------------------------------------------------------------
-- `sequence` is a JSONB array of domains (["salesforce.com","docs.google.com"])
-- and `score` is the ranking output of the detection algorithm: combines log
-- frequency, fraction of team participating, and time-of-day consistency.
CREATE TABLE IF NOT EXISTS patterns (
  pattern_id           TEXT PRIMARY KEY,
  team_id              TEXT REFERENCES teams(team_id) ON DELETE CASCADE,
  sequence             JSONB NOT NULL,
  frequency            INTEGER NOT NULL,
  score                NUMERIC NOT NULL,
  est_hours_monthly    NUMERIC,
  status               TEXT DEFAULT 'detected',
  detected_at          TIMESTAMPTZ DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- Generated AI skills
-- -----------------------------------------------------------------------------
-- `action_sequence` is the structured SkillSpec JSON produced by Claude Sonnet;
-- `embedding` is the OpenAI text-embedding-3-small vector used to detect
-- semantically duplicate skills across patterns.
CREATE TABLE IF NOT EXISTS skills (
  skill_id         TEXT PRIMARY KEY,
  team_id          TEXT REFERENCES teams(team_id) ON DELETE CASCADE,
  pattern_id       TEXT REFERENCES patterns(pattern_id),
  name             TEXT NOT NULL,
  description      TEXT,
  action_sequence  JSONB NOT NULL,
  embedding        vector(1536),
  status           TEXT DEFAULT 'draft',
  success_count    INTEGER DEFAULT 0,
  failure_count    INTEGER DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- IVFFlat index for cosine-distance nearest-neighbour queries over the 1536-dim
-- embedding column. Lists=100 is a reasonable default for the tens-of-thousands
-- skill scale we expect; revisit when row counts grow past ~1M.
CREATE INDEX IF NOT EXISTS skills_emb_idx
ON skills
USING ivfflat (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- Attribution: which users contributed to which pattern
-- -----------------------------------------------------------------------------
-- Used by the dashboard to show "5 of 12 team members do this workflow daily"
-- and to weight detection scores by fraction of the team participating.
CREATE TABLE IF NOT EXISTS pattern_users (
  pattern_id       TEXT REFERENCES patterns(pattern_id) ON DELETE CASCADE,
  user_id          TEXT REFERENCES users(user_id) ON DELETE CASCADE,
  occurrence_count INTEGER DEFAULT 0,
  PRIMARY KEY (pattern_id, user_id)
);

-- -----------------------------------------------------------------------------
-- Skill execution telemetry
-- -----------------------------------------------------------------------------
-- Every time the extension runs an active skill it logs the outcome here so
-- we can compute success rate, average runtime, and hours-saved ROI on the
-- dashboard.
CREATE TABLE IF NOT EXISTS skill_executions (
  execution_id TEXT PRIMARY KEY,
  skill_id     TEXT REFERENCES skills(skill_id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(user_id) ON DELETE CASCADE,
  success      BOOLEAN NOT NULL,
  duration_ms  INTEGER,
  executed_at  TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- Demo seed data
--
-- Inserts the synthetic team and five demo users referenced by the seed event
-- generator in scripts/seed-events.ts. ON CONFLICT DO NOTHING keeps the script
-- idempotent for repeated runs during development.
-- =============================================================================

INSERT INTO teams (team_id, name)
VALUES ('demo_team_001', 'Demo Team')
ON CONFLICT (team_id) DO NOTHING;

INSERT INTO users (user_id, team_id, email, role) VALUES
  ('demo_user_001', 'demo_team_001', 'alice@demo.com', 'admin'),
  ('demo_user_002', 'demo_team_001', 'bob@demo.com',   'member'),
  ('demo_user_003', 'demo_team_001', 'carol@demo.com', 'member'),
  ('demo_user_004', 'demo_team_001', 'david@demo.com', 'member'),
  ('demo_user_005', 'demo_team_001', 'eve@demo.com',   'member')
ON CONFLICT (user_id) DO NOTHING;
