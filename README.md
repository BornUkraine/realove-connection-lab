# Realove Connection Lab

Realove's mission is to help single adults communicate respectfully, make meaningful connections and build healthy relationships. Connection Lab explores cultural conversation ideas and careful communication rehearsal. Venus V2, Realove's planned AI superconnector and matchmaker, remains in development.

This standalone experimental demo contains original contest code. It connects no production database, profiles, messages or accounts.

## Two product flows

1. **Qloo cultural planner:** enter one to three public film, book or artist names. The server uses the official Qloo harness to search actual entities. Confirm the exact matches, then request cultural recommendations. The UI shows their source and product-written conversation prompts. Aggregate affinities describe cultural entities, not a person's identity or romantic compatibility.
2. **Nebius communication rehearsal:** choose introduction, boundary or deescalation and use a short fictional scenario. A configured NVIDIA model on Nebius generates a suggested draft. The human decides whether to use it; the app sends no messages.

When provider access is absent or fails, the app returns a clear configuration or provider error. Runtime responses have no fabricated provider fallback. Tests use explicitly injected fixtures and do not call paid services.

## Run locally

Requires Node.js 22.19 or newer; Node 24 is recommended.

```sh
npm ci --ignore-scripts
npm test
npm start
```

Open `http://127.0.0.1:4378`. The interface and configuration status work without API keys. Live features require the relevant provider configuration.

Copy `.env.example` to a private `.env` and supply only separately issued contest credentials. Keep that file out of Git and screenshots. Do not reuse a production credential.

| Variable | Purpose |
| --- | --- |
| `QLOO_API_KEY` | Individually issued event credential |
| `QLOO_BASE_URL` | `https://hackathon.api.qloo.com` for the event, or official `https://api.qloo.com` |
| `NEBIUS_API_KEY` | Credential for the intended Nebius project |
| `NEBIUS_MODEL` | Explicitly selected and verified eligible NVIDIA open-model identifier |
| `NEBIUS_BASE_URL` | Defaults to `https://api.tokenfactory.nebius.com/v1` |
| `HOST`, `PORT` | Defaults to `127.0.0.1`, `4378` |
| `RATE_LIMIT_PER_HOUR` | Per-client API-operation allowance, default 30 |
| `QLOO_DAILY_LIMIT`, `COACH_DAILY_LIMIT` | Process-local daily operation allowances, defaults 120 and 60 |
| `TRUST_PROXY` | Set to `1` only behind a proxy that overwrites untrusted forwarded-client headers |

The Qloo adapter verifies its endpoint against the two official hosts, passes the event credential only in the child process environment and sets the harness's supported `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL`. Its isolated `.qloo` state directory prevents fallback to a user's global harness configuration. The frontend receives no provider credentials.

`/api/status` means configuration presence, not successful authentication. `lastSuccessAt` is set only after a successful provider response. Model availability and open-source eligibility require verification against the provider catalog and contest rules; the code does not claim this check was performed.

## API contract

`GET /healthz` returns process health. `GET /api/status` returns configuration, attribution and limitations without secret values.

`POST /api/qloo/resolve`:

```json
{"concepts":["Spirited Away","The Little Prince"]}
```

Returns `resolutionId`, `groups[{query,candidates[{id,name,type,description}]}]`, `needsConfirmation`, `source` and `limits`. No candidate is silently selected. Search candidates are filtered to public cultural entity types.

`POST /api/qloo/plan`:

```json
{"resolutionId":"returned-by-resolve","entities":[{"id":"confirmed-candidate-id"}],"confirmed":true,"goal":"conversation"}
```

`goal` can be `conversation` or `activity`. The server accepts only distinct IDs from that temporary resolution, ignores client-supplied names, and expires the selection after 15 minutes. It returns recommendations, conversation starters, selected entities, provenance, limitations and `humanApprovalRequired: true`.

`POST /api/coach`:

```json
{"message":"A fictional adult wants to decline an invitation kindly.","goal":"boundary"}
```

Returns `draft`, `inference{provider,model,at}`, `humanApprovalRequired` and limitations. The interface supports fictional rehearsal only. Do not paste real private conversations, contact details or credentials. Basic input checks reject obvious contact information; these checks are not a comprehensive personal-data detector.

All API operations use JSON. Errors contain `error{code,message,retryable}` and an appropriate HTTP status. Raw provider errors and process stderr are never returned. This app does not automatically retry or change credentials, providers or endpoints.

## Deploying and judging

Run on a container or VM with Node 22.19+ and the installed harness. Qloo's event starter does not support a browser-only or serverless harness process. The Dockerfile uses an unprivileged runtime account:

```sh
docker build -t realove-connection-lab .
docker run --rm --env-file .env -e HOST=0.0.0.0 -p 4378:4378 realove-connection-lab
```

Hosted Node deployments must set `HOST=0.0.0.0` so the hosting proxy can reach the process. Keep `127.0.0.1` for ordinary local development. Supply HTTPS at the hosting proxy. Keep the demo accessible to judges through the judging period. The code and local tests alone do not establish a hosted demo, verified provider access or a submitted contest entry. Capture actual provider results and verify the public deployment before claiming readiness.

The rate counters and cultural selections are in memory. They reset when the process restarts and are not a hard provider billing cap. For a shared deployment, retain the provider's own quota controls and use one bounded demonstration process. The Qloo harness may perform multiple provider requests within one recommendation operation.

## Verification

### Portable Worker API adapter

`worker/handler.mjs` exports a standard `fetch(request, env, ctx)` handler for API routes. Its dependency graph uses Web APIs only, with no Node imports or subprocesses. The existing Node/harness server remains available. A hosting wrapper must serve `public/*` for the other routes.

The portable adapter uses the official SDK's documented REST request shapes: `GET /search` with `query` and `take`, and `GET /v2/insights` with `filter.type`, `signal.interests.entities`, `take` and `feature.explainability`. Authentication uses the server-side `X-Api-Key` header. Only official Qloo hosts are accepted, redirects are rejected and response sizes are bounded.

Provide `QLOO_API_KEY`, `QLOO_BASE_URL` and a separate randomly generated runtime secret `SELECTION_SIGNING_KEY` containing at least 32 bytes. The confirmation token is HMAC-SHA256 signed, expires after 15 minutes, and contains only issued cultural entity IDs, version, audience and expiry metadata. It verifies across isolates without requiring shared session memory. Client-supplied names are ignored, so Worker `selectedEntities` contains IDs only; the UI retains the confirmed labels from its search response.

The Worker maintains conservative per-isolate request allowances and reports that limitation in `/api/status`. These counters reset with an isolate and do not enforce a global billing cap. An optional Cloudflare `RATE_LIMITER.limit({key})` binding can enforce an external rate rule. A deployment-specific `DEMO_BUDGET.consume({provider,cost,day})` hook can add a shared budget gate if provided. Neither binding is assumed to exist. Provider-side quota/billing controls remain necessary for a shared public deployment.

The Worker code and mocked contract tests do not establish live access, hosting or final contest submission. Its optional Nebius path needs the same separately verified access and eligible NVIDIA model as the Node application.

For a temporary server-side runtime investigation, `PROVIDER_DIAGNOSTICS=1` logs only sanitized error names and messages. It removes configured provider/signing secrets, URLs and credential-like fields. It is disabled by default and never adds diagnostics to public API responses. Disable it after investigating. The adapter preserves the global receiver required by native edge `fetch` and uses a disposable AbortController timer rather than depending on `AbortSignal.timeout` availability.

`npm test` exercises HTTP validation, explicit consent and selection binding, expired selections, missing credentials, private-file access, origin checks, request limits, safe provider errors, and both provider request contracts. Fixtures are labelled inside test code. They are never used as live results.

## Official references

- Qloo requirements: https://qloo.devpost.com/
- Qloo rules: https://qloo.devpost.com/rules
- Qloo event kit and data-handling guidance: https://github.com/qloo/qloo-hackathon-kit
- Nebius contest: https://nebiusglobalaihackathon.devpost.com/

## License and brand

The original code and documentation are MIT licensed. The Realove name and unchanged approved logo retain their owner's brand rights; see `BRAND-NOTICE.txt`. Third-party dependencies retain their licenses.
