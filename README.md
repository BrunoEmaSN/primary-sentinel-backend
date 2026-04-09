<div align="center">
  <img width="1888" height="544" alt="background_back" src="https://github.com/user-attachments/assets/95d1b69d-77b9-40ae-a988-71de10960986" />
  <br />
  <div>
    <img src="https://img.shields.io/badge/-Google%20Cloud-black?style=for-the-badge&logo=googlecloud&color=000000" alt="google cloud" />
    <img src="https://img.shields.io/badge/-Supabase-black?style=for-the-badge&logo=supabase&logoColor=3CC88B&color=000000" alt="supabase" />
    <img src="https://img.shields.io/badge/-Cloudflare-black?style=for-the-badge&logo=cloudflare&logoColor=EB7D20&color=000000" alt="cloudflare" />
    <img src="https://img.shields.io/badge/-Mysql-black?style=for-the-badge&logo=mysql&color=000000" alt="mysql" />
    <img src="https://img.shields.io/badge/-Claude-black?style=for-the-badge&logo=claude&color=000000" alt="claude" />
  </div>
  
  <h3 align="center">
    <img width="15" height="15" alt="logo" src="https://github.com/user-attachments/assets/84318606-0d4d-4461-8bd3-1c11b746946a" />
    PRIMARY SENTINEL BACKEND
  </h3>
</div>

> **Autonomous Reliability & Security Intelligence** — zero-downtime webhooks that auto-detect, fix, and learn from schema mutations.  
> **v2 adds multi-destination fanout**: send validated payloads to Supabase + any webhook/API simultaneously.

---

## What's new in v2

| Feature | v1 | v2 |
|---|---|---|
| Destinations per endpoint | 1 | Up to 5 (fanout) |
| Webhook relay | ❌ | ✅ POST to any URL |
| HTTP API with auth | ❌ | ✅ Bearer / Basic / API Key |
| Per-destination observability | ❌ | ✅ `dispatchResults` in every event |
| Partial failure handling | ❌ | ✅ `Promise.allSettled` — one fail ≠ DLQ |
| Backwards compat (`destination`) | — | ✅ auto-migrated to `destinations[]` |
| External Supabase project | ❌ | ✅ `projectUrl` + `serviceKey` (or `apiKey` alias) |
| PostgreSQL / MySQL | ❌ | ✅ `INSERT` JSON column via `postgres` / `mysql2` |
| BigQuery streaming | ❌ | ✅ REST `insertAll` + service account JSON |
| Encrypted destination secrets | ❌ | ✅ AES-GCM with `SENTINEL_DESTINATION_SECRET_KEY` |

---

## Architecture

```
Incoming Webhook
       │
       ▼
┌─────────────────┐
│  API Gateway    │  ← Cloudflare Workers (Edge)
│  Rate Limit     │
│  Signature ✓    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ✅ Valid
│  DataValidator  │─────────────────────────────────────────┐
│  (Zod Schema)   │                                         │
└────────┬────────┘                                         │
         │ ❌ Invalid                                        │
         ▼                                                   │
┌─────────────────┐                                         │
│  HealingAgent   │                                         │
│  A: Cache? ──►Yes──► Apply Rule ──► Re-validate ──────────┤
│  B: No ──► LLM ──► Sandbox ──► Re-validate ───────────────┤
│            │ fail                                         │
└────────────┼──────────────────────────────────────────────┘
             │                                              │
             ▼                                              ▼
     ┌───────────────┐               ┌────────────────────────────────┐
     │  Dead Letter  │               │  OutputDispatcher (NEW v2)     │
     │  Queue (R2)   │               │                                │
     └───────────────┘               │  destinations[0] → Supabase   │
             │                       │  destinations[1] → Webhook     │
             └── 🚨 Alert Email      │  destinations[2] → HTTP API    │
                                     │                                │
                                     │  Promise.allSettled(all)       │
                                     │  partial fail → still loaded   │
                                     └────────────────────────────────┘
```

---

## Quick Start

### 1. Setup

```bash
git clone <your-repo>
cd sentinel-saas-backend
npm install
cp .dev.vars.example .dev.vars
# Fill in .dev.vars with your credentials
```

### 2. Cloudflare resources

```bash
wrangler login
wrangler kv:namespace create "RULE_CACHE"
wrangler kv:namespace create "RULE_CACHE" --preview
wrangler r2 bucket create sentinel-dlq
```

Copy the KV IDs into `wrangler.toml`.

### 3. Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. SQL Editor → paste `migrations/001_schema.sql` → Run
3. Copy your Project URL and `service_role` key

### 4. Secrets

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
wrangler secret put RESEND_API_KEY
wrangler secret put SENTINEL_WEBHOOK_SECRET
# Strongly recommended in production: 32-byte key as base64 (openssl rand -base64 32)
wrangler secret put SENTINEL_DESTINATION_SECRET_KEY
```

If `SENTINEL_DESTINATION_SECRET_KEY` is omitted, destination secrets (connection strings, API keys, service account JSON) are stored **in plaintext** in Supabase JSONB.

Raise `[limits] cpu_ms` in `wrangler.toml` if dispatching to BigQuery or SQL hits CPU timeouts.

### 5. Dev & Deploy

```bash
npm run dev           # http://localhost:8787
npm run deploy        # staging
npm run deploy:prod   # production
npm test              # unit tests
```

---

## API Reference

### POST `/webhook/:tenantId/:endpointSlug`

Public. Receives raw payload, validates, heals, dispatches to all destinations.

**Response:**
```json
{
  "eventId": "...",
  "status": "loaded | healed | dead",
  "message": "Event loaded and dispatched to all 2 destination(s)",
  "dispatchResults": [
    { "destinationType": "supabase", "destinationIndex": 0, "success": true, "durationMs": 45 },
    { "destinationType": "webhook",  "destinationIndex": 1, "success": true, "durationMs": 120 }
  ]
}
```

### POST `/api/endpoints` — Create endpoint

```json
{
  "name": "Stripe Webhooks",
  "schema": {
    "type": "object",
    "required": ["id", "type", "data"],
    "properties": {
      "id":   { "type": "string" },
      "type": { "type": "string" },
      "data": { "type": "object" }
    }
  },
  "destinations": [
    {
      "type": "supabase",
      "tableName": "stripe_events"
    },
    {
      "type": "webhook",
      "url": "https://your-crm.example.com/ingest",
      "method": "POST",
      "headers": { "X-Source": "sentinel" },
      "timeoutMs": 5000
    },
    {
      "type": "http_api",
      "url": "https://api.datawarehouse.io/events",
      "method": "POST",
      "authType": "bearer",
      "authValue": "your-dwh-token",
      "timeoutMs": 8000
    }
  ],
  "healingConfig": {
    "enabled": true,
    "maxAttempts": 3,
    "notifyOnHealing": true,
    "notifyOnDead": true
  }
}
```

**Destination types:**

| Type | Required fields | Auth |
|---|---|---|
| `supabase` | `tableName` | Uses Sentinel's Supabase key (or override with `projectUrl`+`serviceKey`) |
| `webhook` | `url` | Optional `headers` map |
| `http_api` | `url` | `authType`: `bearer`, `basic`, `api_key`, `none` |

### Other protected endpoints (require `Authorization: Bearer <jwt>`)

```
GET    /api/endpoints              # List endpoints
GET    /api/endpoints/:id          # Get endpoint
DELETE /api/endpoints/:id          # Delete endpoint
GET    /api/endpoints/:id/events   # Events (?status=&limit=&offset=)
GET    /api/endpoints/:id/rules    # Transformation rules
GET    /api/dlq                    # Dead letter queue
```

---

## Destination config reference

### `supabase`
```json
{
  "type": "supabase",
  "tableName": "my_table",
  "projectUrl": "https://other-project.supabase.co",  // optional override
  "serviceKey": "eyJ..."                               // optional override
}
```

### `webhook`
```json
{
  "type": "webhook",
  "url": "https://example.com/hook",
  "method": "POST",
  "wrapKey": "payload",       // optional: wraps body as { payload: <data> }
  "headers": { "X-Foo": "bar" },
  "retryOnFailure": true,
  "timeoutMs": 5000
}
```

### `http_api`
```json
{
  "type": "http_api",
  "url": "https://api.example.com/ingest",
  "method": "POST",
  "authType": "bearer",       // bearer | basic | api_key | none
  "authValue": "token-here",
  "authHeader": "X-Api-Key",  // only for authType=api_key (default: X-Api-Key)
  "headers": {},
  "timeoutMs": 5000
}
```

---

## Fanout behavior

- All destinations are dispatched **concurrently** via `Promise.allSettled`
- **Partial failure** → event is still marked `loaded`, response includes `dispatchResults` with per-destination status
- **All fail** → event goes to DLQ (same as before)
- Each `dispatchResults` entry contains: `destinationType`, `destinationIndex`, `success`, `durationMs`, `error?`

---

## Tech Stack

| Layer | Service | Purpose |
|---|---|---|
| Worker | Cloudflare Workers | API Gateway, routing |
| Database | Supabase (PostgreSQL) | Events, Endpoints, Rules, Auth |
| Cache | Upstash Redis | Transformation rule cache (24h TTL) |
| Storage | Cloudflare R2 | Dead Letter Queue payloads |
| LLM | Anthropic Claude Sonnet | Generating transformation scripts |
| Email | Resend | Healing & DLQ notifications |
