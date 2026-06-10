# Deploying FlowMine

This guide takes a fresh clone of FlowMine to a fully working deployment:
the Next.js app on Vercel, the event store on DynamoDB, the relational store
on Aurora PostgreSQL, realtime on Pusher, and the Chrome extension loaded
locally. Every step is a one-time setup.

Total time: ~45–60 minutes, most of it waiting for the Aurora cluster to
provision.

> **Region note.** Everything below uses **`eu-north-1` (Stockholm)** to match
> the AWS account this project was built against. If you provision in a
> different region, change `AWS_REGION` in `web/.env.local` and create the
> DynamoDB table and Aurora cluster in that same region — they must match.

---

## 0. Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node | 22.x (see `.nvmrc`) | `node --version` |
| pnpm | 11.x | `pnpm --version` |
| AWS account | with billing/credits | console access |
| `psql` client | 14+ | `psql --version` |
| Vercel account | free tier | vercel.com |
| Pusher account | free tier | pusher.com |

If `psql` is missing on Windows, install the PostgreSQL client tools (the
"Command Line Tools" component of the EDB installer is enough).

---

## 1. Pusher Channels (≈5 min)

Realtime dashboard updates ride on Pusher Channels.

1. Sign in at **https://dashboard.pusher.com**.
2. **Create app** → name it `flowmine`.
3. Cluster: choose **`eu`** (Ireland) to sit close to `eu-north-1`.
4. Front-end: **React**, back-end: **Node.js** (these only change the sample
   snippets, not the keys).
5. Open the app's **App Keys** tab. You'll copy four values into
   `web/.env.local` later:

   | Pusher field | Env var |
   |--------------|---------|
   | `app_id`  | `PUSHER_APP_ID` |
   | `key`     | `NEXT_PUBLIC_PUSHER_KEY` |
   | `secret`  | `PUSHER_SECRET` |
   | `cluster` | `NEXT_PUBLIC_PUSHER_CLUSTER` (= `eu`) |

That's the entire Pusher setup — no channels to pre-create. FlowMine creates
the `team-{team_id}` channel on first publish.

---

## 2. DynamoDB table (≈5 min)

The high-write browser event stream.

### Via the AWS Console

1. Console → **DynamoDB** → confirm the region selector reads
   **Europe (Stockholm) eu-north-1**.
2. **Create table**.
   - **Table name**: `flowmine-events`
   - **Partition key**: `team_id` — type **String**
   - **Sort key**: `event_key` — type **String**
3. **Table settings**: choose **Customize settings**.
   - **Capacity mode**: **On-demand** (this is `PAY_PER_REQUEST`).
4. **Create table** and wait until status is **Active**.

### Add the Global Secondary Index

1. Open the table → **Indexes** tab → **Create index**.
   - **Partition key**: `user_id` — **String**
   - **Sort key**: `event_key` — **String**
   - **Index name**: `user_id-event_key-index`
   - **Attribute projections**: **All**
2. **Create index**. (Building is near-instant on an empty table.)

### Enable TTL

1. Table → **Additional settings** → **Time to Live (TTL)** → **Enable**.
   - **TTL attribute name**: `created_at`
2. Save. Rows expire 90 days after capture; the writer in
   `web/lib/dynamodb.ts` sets `created_at` to capture-time + 90 days in
   epoch **seconds**.

### CLI alternative

If you'd rather script it:

```bash
aws dynamodb create-table \
  --region eu-north-1 \
  --table-name flowmine-events \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
      AttributeName=team_id,AttributeType=S \
      AttributeName=event_key,AttributeType=S \
      AttributeName=user_id,AttributeType=S \
  --key-schema \
      AttributeName=team_id,KeyType=HASH \
      AttributeName=event_key,KeyType=RANGE \
  --global-secondary-indexes \
    '[{"IndexName":"user_id-event_key-index",
       "KeySchema":[{"AttributeName":"user_id","KeyType":"HASH"},
                    {"AttributeName":"event_key","KeyType":"RANGE"}],
       "Projection":{"ProjectionType":"ALL"}}]'

aws dynamodb update-time-to-live \
  --region eu-north-1 \
  --table-name flowmine-events \
  --time-to-live-specification "Enabled=true,AttributeName=created_at"
```

---

## 3. IAM credentials for the app (≈5 min)

The Next.js app needs an access key that can read/write the table.

1. Console → **IAM** → **Users** → **Create user** → name `flowmine-app`.
2. **Attach policies directly** → for a quick start attach
   `AmazonDynamoDBFullAccess`. (For least privilege, scope a custom policy to
   the `flowmine-events` table and its index instead.)
3. After creating the user, open it → **Security credentials** →
   **Create access key** → use case **Application running outside AWS**.
4. Copy the **Access key ID** and **Secret access key** into `web/.env.local`
   as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. The secret is shown
   once — store it now.

---

## 4. Aurora PostgreSQL (≈20 min, mostly waiting)

The relational store for teams, patterns, skills, and pgvector embeddings.

### Create the cluster

1. Console → **RDS** → **Create database**.
2. **Standard create**.
3. **Engine**: **Amazon Aurora** → **Aurora PostgreSQL-Compatible**.
4. **Engine version**: any **PostgreSQL 16.x** build.
5. **Templates**: **Dev/Test** (cheaper) is fine for the hackathon.
6. **Cluster identifier**: `flowmine-db`.
7. **Master username**: `flowmine_admin`.
8. **Master password**: set one and remember it → this is `AURORA_PASSWORD`.
9. **Instance configuration**: **Serverless v2**. Set min capacity to
   **0.5 ACU**, max to **1–2 ACU** for a demo.
10. **Connectivity**:
    - **Public access**: **Yes** (so you can run `schema.sql` from your
      laptop and so Vercel can connect without a VPC peering setup).
    - **VPC security group**: create new, or pick one you'll edit in the
      next step.
11. **Create database** and wait for status **Available** (~10–15 min).

### Open the security group

The default RDS security group blocks inbound Postgres. To connect from your
laptop and from Vercel:

1. Open the cluster → **Connectivity & security** → click the **VPC security
   group**.
2. **Inbound rules** → **Edit inbound rules** → **Add rule**:
   - **Type**: PostgreSQL (port **5432**)
   - **Source**: your IP for laptop access. For Vercel (whose egress IPs are
     dynamic) you'll either open `0.0.0.0/0` for the demo **or** use the
     Vercel/RDS Proxy path. For a hackathon, `0.0.0.0/0` on a throwaway
     cluster is the pragmatic choice — **do not** ship that to production.
3. Save.

### Grab the endpoint

Cluster → **Connectivity & security** → copy the **Writer endpoint**
(`flowmine-db.cluster-xxxx.eu-north-1.rds.amazonaws.com`). This is
`AURORA_HOST`.

### Run the schema

`scripts/schema.sql` creates the `flowmine` database, the `vector` extension,
every table, the IVFFlat index, and the demo seed rows. Run it against the
default `postgres` database (the script issues `CREATE DATABASE flowmine`
then `\c flowmine`):

```bash
psql "host=<AURORA_HOST> port=5432 dbname=postgres \
      user=flowmine_admin password=<AURORA_PASSWORD> sslmode=require" \
  -f scripts/schema.sql
```

Expected: a `CREATE DATABASE` (or a benign "already exists" on re-runs),
then a run of `CREATE EXTENSION`, `CREATE TABLE`, `CREATE INDEX`, and two
`INSERT` lines for the demo team and users.

> **pgvector note.** Aurora PostgreSQL 16 ships the `vector` extension; the
> `CREATE EXTENSION IF NOT EXISTS vector;` line in the schema enables it. No
> separate install needed.

---

## 5. API keys for the AI layer (≈5 min)

1. **Anthropic** — https://console.anthropic.com → **API keys** → create one
   → `ANTHROPIC_API_KEY`. Used for skill generation (Sonnet) and pattern
   interpretation (Haiku).
2. **OpenAI** — https://platform.openai.com → **API keys** → create one →
   `OPENAI_API_KEY`. Used only for `text-embedding-3-small`.

---

## 6. Fill `web/.env.local` (≈3 min)

Copy the template and fill every value gathered above:

```bash
cp web/.env.example web/.env.local
```

```bash
# AWS
AWS_REGION=eu-north-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
DYNAMODB_EVENTS_TABLE=flowmine-events

# Aurora PostgreSQL
AURORA_HOST=flowmine-db.cluster-xxxx.eu-north-1.rds.amazonaws.com
AURORA_PORT=5432
AURORA_DATABASE=flowmine
AURORA_USERNAME=flowmine_admin
AURORA_PASSWORD=...

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# OpenAI (embeddings only)
OPENAI_API_KEY=sk-...

# Pusher
PUSHER_APP_ID=...
NEXT_PUBLIC_PUSHER_KEY=...
PUSHER_SECRET=...
NEXT_PUBLIC_PUSHER_CLUSTER=eu

# App
NEXT_PUBLIC_API_URL=http://localhost:3000
TEAM_ID=demo_team_001
```

`web/.env.local` is gitignored — it never gets committed.

### Verify locally

```bash
cd web
pnpm install
pnpm dev
```

Open **http://localhost:3000/dashboard**. With Aurora reachable you should
see the "Detected patterns" and "Skill library" sections render their empty
states instead of the "Aurora is unreachable" card.

---

## 7. Seed demo data (≈3 min)

Generate three weeks of synthetic events containing the three planted
workflow patterns, then write them to DynamoDB:

```bash
cd scripts
pnpm install
pnpm seed:dry     # inspect scripts/out/seed-events.json first (optional)
pnpm seed:apply   # writes ~1000 events to DynamoDB
```

`seed:apply` reads AWS credentials and the table name from `web/.env.local`,
so make sure step 6 is done first.

### Run detection

Trigger the detection pipeline once so patterns land in Aurora and the
dashboard populates:

```bash
curl -X POST http://localhost:3000/api/detect \
  -H "Content-Type: application/json" \
  -d '{"team_id":"demo_team_001","window_days":21}'
```

The response reports `detected`, `persisted`, and `skipped` counts. Reload
`/dashboard` — the three planted patterns (Salesforce→Sheets→Gmail,
GitHub→Linear→Slack, HubSpot→Docs→Gmail) should appear as cards, top-scored
first, and the ROI chart should populate.

---

## 8. Deploy the web app to Vercel (≈5 min)

1. Push your repo to GitHub (already done if you've been committing).
2. **vercel.com** → **Add New… → Project** → import the `flowmine` repo.
3. **Root directory**: set to **`web`** (the Next.js app is not at the repo
   root).
4. **Environment Variables**: add every variable from `web/.env.local`.
   Change `NEXT_PUBLIC_API_URL` to your Vercel URL (e.g.
   `https://flowmine.vercel.app`).
5. **Deploy**.

Once live, re-run detection against the deployed URL if you want the
production dashboard populated:

```bash
curl -X POST https://flowmine.vercel.app/api/detect \
  -H "Content-Type: application/json" \
  -d '{"team_id":"demo_team_001","window_days":21}'
```

---

## 9. Load the Chrome extension (≈3 min)

```bash
cd extension
pnpm install
pnpm build        # writes ./dist
```

1. Open **chrome://extensions**.
2. Toggle **Developer mode** (top-right).
3. **Load unpacked** → select **`extension/dist`**.
4. Click the FlowMine toolbar icon. In the popup:
   - **API URL**: `http://localhost:3000` for local, or your Vercel URL.
   - **Team ID** / **User ID**: leave as `demo_team_001` / `demo_user_001`
     or set your own.
   - **Save**.
5. Browse normally. Every 60 s a batch flushes to `/api/events`; click
   **Flush now** to push immediately. The **Active skills** section lists any
   skill you've activated on the dashboard — click **Run** to execute it on
   the current tab.

---

## 10. End-to-end smoke test

1. Browse `salesforce.com`, then `docs.google.com`, then `mail.google.com`
   — repeat a few times.
2. Extension popup → **Flush now**.
3. `POST /api/detect` (step 7).
4. Dashboard → the workflow appears as a pattern card (live, via Pusher).
5. Click **Generate skill** → Sonnet writes a SkillSpec → a SkillCard
   appears in the library.
6. Click **Activate** on the skill.
7. Extension popup → **Active skills** → **Run** → watch the agent drive the
   tab, then a toast confirms the result on the dashboard.

That's the full loop: observe → detect → generate → execute.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Dashboard shows "Aurora is unreachable" | Security group, wrong host, or wrong password | Re-check inbound 5432 rule, `AURORA_HOST` (writer endpoint), `AURORA_PASSWORD` |
| `seed:apply` hangs or 403s | AWS credentials or region mismatch | Confirm `AWS_REGION=eu-north-1` and the key has DynamoDB access |
| `/api/detect` returns 404 "no registered users" | `schema.sql` seed block didn't run | Re-run `schema.sql`; confirm the `users` table has the five demo rows |
| `/api/generate-skill` returns 502 | Anthropic or OpenAI key missing/invalid | Check `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` |
| No realtime cards / toasts | Pusher keys missing | Set all four `PUSHER_*` vars; cluster must match (`eu`) |
| `CREATE EXTENSION vector` fails | Engine isn't Aurora PG 16 | Recreate the cluster on PostgreSQL 16.x |
| Extension Run does nothing | No active skill, or content script not injected | Activate a skill on the dashboard; reload the target tab so `content.js` is present |
