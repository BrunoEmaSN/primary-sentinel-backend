# 🛡️ Sentinel SaaS — Self-Healing AI Data Pipeline

> Zero-downtime API integration that automatically detects, fixes, and learns from schema mutations using AI.

---

## Architecture Overview

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
│  DataValidator  │─────────────────────► DataLoader ──► DWH
│  (Zod Schema)   │
└────────┬────────┘
         │ ❌ Invalid
         ▼
┌─────────────────┐
│  HealingAgent   │
│                 │
│  A: Cache?──►Yes─────────────────────► Apply Rule ──► DataLoader
│  B: No ──► LLM ──► Sandbox ──► Valid?─► Save Rule ──► DataLoader
│            │                   Invalid?─────────────────────────┐
│            │ LLM Error                                          │
└────────────┼───────────────────────────────────────────────────┼─┘
             │                                                    │
             ▼                                                    ▼
     ┌───────────────┐                                  ┌────────────────┐
     │  Dead Letter  │                                  │  Dead Letter   │
     │  Queue (R2)   │                                  │  Queue (R2)    │
     └───────────────┘                                  └────────────────┘
             │                                                    │
             └──────────────── 🚨 Alert Email ───────────────────┘
```

## Tech Stack (100% Free Tier)

| Layer | Service | Purpose |
|---|---|---|
| Worker | Cloudflare Workers | API Gateway, DataValidator, DataLoader |
| Database | Supabase (PostgreSQL) | Events, Endpoints, Rules, Auth |
| Cache | Upstash Redis | Transformation rule cache (Cache-Aside) |
| Queue | Upstash Kafka | Async event bus |
| Storage | Cloudflare R2 | Dead Letter Queue raw payloads |
| LLM | Anthropic Claude | Generating transformation scripts |
| Email | Resend | Healing & DLQ notifications |

## Project Structure

```
sentinel-saas/
├── workers/
│   └── main.ts                          # CF Worker entry point
├── src/
│   ├── domain/                          # Pure business logic
│   │   ├── events/
│   │   │   ├── entities/
│   │   │   │   ├── RawEvent.ts          # Core aggregate
│   │   │   │   └── Endpoint.ts          # Tenant webhook config
│   │   │   └── repositories/            # Interface contracts
│   │   └── healing/
│   │       ├── entities/
│   │       │   └── TransformationRule.ts # AI-learned fix
│   │       └── repositories/
│   ├── application/
│   │   ├── use-cases/
│   │   │   ├── ProcessWebhookEvent.ts   # Main orchestrator
│   │   │   └── ManageEndpoint.ts        # CRUD use cases
│   │   └── ports/                       # External service interfaces
│   └── infrastructure/
│       ├── adapters/
│       │   ├── database/                # Supabase implementations
│       │   ├── external/                # Redis, Kafka, R2, Resend
│       │   ├── llm/                     # Anthropic adapter
│       │   └── sandbox/                 # JS execution sandbox
│       ├── http/
│       │   ├── middleware/              # Auth, rate limit, CORS
│       │   └── routes/                  # API Gateway router
│       ├── utils/                       # Logger, crypto helpers
│       └── container.ts                 # Dependency injection
├── migrations/
│   └── 001_schema.sql                   # Complete DB schema
├── tests/
│   ├── unit/                            # Domain & use case tests
│   └── integration/                     # Full pipeline tests
└── wrangler.toml                        # CF Workers config
```

## Quick Start

### 1. Prerequisites

```bash
npm install -g wrangler
node --version  # >= 18
```

### 2. Clone & Install

```bash
git clone <your-repo>
cd sentinel-saas
npm install
```

### 3. Configure External Services

**Supabase**
1. Create a project at [supabase.com](https://supabase.com)
2. Go to SQL Editor → paste `migrations/001_schema.sql` → Run
3. Copy your Project URL and `service_role` key

**Upstash**
1. Create a Redis database at [upstash.com](https://upstash.com)
2. Create a Kafka cluster (or use Redis Pub/Sub for simpler setup)
3. Copy credentials

**Cloudflare**
```bash
wrangler login
wrangler kv:namespace create "RULE_CACHE"         # copy ID to wrangler.toml
wrangler kv:namespace create "RULE_CACHE" --preview
wrangler r2 bucket create sentinel-dlq
wrangler queues create sentinel-events
```

**Resend**
1. Sign up at [resend.com](https://resend.com) (free: 3,000 emails/month)
2. Add and verify your sending domain

### 4. Set Secrets

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
wrangler secret put UPSTASH_KAFKA_URL
wrangler secret put UPSTASH_KAFKA_USERNAME
wrangler secret put UPSTASH_KAFKA_PASSWORD
wrangler secret put RESEND_API_KEY
```

### 5. Local Development

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your actual credentials
npm run dev
# Worker available at http://localhost:8787
```

### 6. Deploy

```bash
npm run deploy           # staging
npm run deploy:prod      # production
```

## API Reference

### Webhook Receiver (Public)

```
POST /webhook/:tenantId/:endpointSlug
```

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | `application/json` |
| `X-Event-ID` | No | Idempotency key (auto-generated if missing) |
| `X-Sentinel-Signature` | No | HMAC-SHA256 of body with your webhook secret |

**Response**
```json
{ "eventId": "...", "status": "loaded|healed|dead", "message": "..." }
```

### Endpoint Management (Authenticated)

All endpoints require `Authorization: Bearer <supabase-jwt>`.

```
POST   /api/endpoints              # Create endpoint
GET    /api/endpoints              # List endpoints
GET    /api/endpoints/:id          # Get endpoint
DELETE /api/endpoints/:id          # Delete endpoint
GET    /api/endpoints/:id/events   # List events (?status=&limit=&offset=)
GET    /api/endpoints/:id/rules    # List transformation rules
GET    /api/dlq                    # Dead letter queue
```

**Create Endpoint Body**
```json
{
  "name": "Stripe Webhooks",
  "schema": {
    "type": "object",
    "required": ["id", "type", "data"],
    "properties": {
      "id":      { "type": "string" },
      "type":    { "type": "string" },
      "data":    { "type": "object" },
      "created": { "type": "number" }
    }
  },
  "destination": {
    "type": "supabase",
    "tableName": "stripe_events"
  },
  "healingConfig": {
    "enabled": true,
    "maxAttempts": 3,
    "autoApplyRules": true,
    "notifyOnHealing": true,
    "notifyOnDead": true
  }
}
```

## Testing

```bash
npm test                          # Unit tests
npm run test:coverage             # With coverage report
WORKER_URL=http://localhost:8787 \
  TEST_TENANT_TOKEN=<jwt> \
  npx vitest run tests/integration  # Integration tests (requires running worker)
```

## How the HealingAgent Works

1. **Receive** broken payload → validation fails
2. **Fingerprint** the error pattern (schema + error types hash)
3. **Cache lookup** → if rule exists and is active, apply it instantly
4. **LLM generation** → Claude receives: expected schema + broken payload + validation errors
5. **Sandbox execution** → AI script runs in isolated context (no network, no fs)
6. **Re-validation** → healed output must pass the original Zod schema
7. **Cache + persist** → rule stored for future events (24h cache TTL)
8. **Auto-quarantine** → rules with < 30% success rate after 10 uses are quarantined

## Free Tier Limits

| Service | Free Limit | Notes |
|---|---|---|
| Cloudflare Workers | 100K req/day | More than enough for demo |
| Cloudflare R2 | 10GB storage | DLQ payloads |
| Supabase | 500MB DB, 2GB bandwidth | |
| Upstash Redis | 10,000 req/day | Rule cache |
| Upstash Kafka | 10,000 messages/day | Event queue |
| Resend | 3,000 emails/month | Notifications |
| Anthropic | Pay-per-use | ~$0.003/healing call with Sonnet |

## Roadmap

- [ ] Dashboard UI (React + Supabase Realtime)
- [ ] Multi-destination support (BigQuery, Webhook relay)
- [ ] Rule editor UI (manual override/approval flow)
- [ ] Tenant billing (Stripe integration)
- [ ] WASM sandbox for stronger isolation
- [ ] OpenTelemetry tracing
