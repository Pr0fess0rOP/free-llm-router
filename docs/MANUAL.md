# Free LLM Router

A self-hosted LLM router and dashboard that lets a signed-in user bring their own provider API keys, call OpenAI-compatible applications, Codex, or Claude Code through one gateway, fail over across providers, and analyze which provider handled each request.

This project is an adaptation of [`harivilasp/freellm`](https://github.com/harivilasp/freellm). The upstream project provides the core idea of a self-hosted free-tier LLM router with Clerk auth, provider key management, Redis/local storage options, and OpenAI-compatible failover. This adaptation builds on that foundation with a product-style dashboard, provider logos, analytics, request inspection, integration snippets, settings/account details, persistent rate-limit and quota protection, provider usage tracking, one-active-model provider catalogs, model-aware capability detection and runtime learning, request deduplication, end-to-end request correlation, rich routing headers, detailed router/provider/first-token/stream timing, aggregated token/fallback/tool/client analytics, and a simplified routing-first UX.

> Current direction: this adaptation focuses on the router, provider key management, analytics, dashboard UX, and developer integration. The upstream hosted prompt-link flow is intentionally not part of this current UI direction.

---

## Table of Contents

- [Overview](#overview)
- [Major Features](#major-features)
- [Feature Guide with Examples](#feature-guide-with-examples)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Provider Configuration](#provider-configuration)
- [Provider Model Catalog](#provider-model-catalog)
- [Model-Aware Capability Registry](#model-aware-capability-registry)
- [Model Aliases](#model-aliases)
- [Environment Variables](#environment-variables)
- [How to Run as a Developer](#how-to-run-as-a-developer)
- [CLI Usage](#cli-usage)
- [Dashboard Pages](#dashboard-pages)
- [API Routes](#api-routes)
- [Request IDs and Routing Headers](#request-ids-and-routing-headers)
- [Performance Timing Breakdown](#performance-timing-breakdown)
- [Advanced Analytics](#advanced-analytics)
- [OpenAI-Compatible API](#openai-compatible-api)
- [OpenAI Responses API and Codex](#openai-responses-api-and-codex)
- [Claude Code Compatibility](#claude-code-compatibility)
- [Storage and JSON Databases](#storage-and-json-databases)
- [Redis/KV Storage](#rediskv-storage)
- [Security Model](#security-model)
- [Analytics and Rate-Limit Protection](#analytics-and-rate-limit-protection)
- [Development Commands](#development-commands)
- [Roadmap](#roadmap)
- [Potential Future Updates](#potential-future-updates)
- [Credits](#credits)

---

## Overview

Free LLM Router gives applications three compatible API surfaces:

```txt
OpenAI Chat Completions: http://localhost:8787/v1/chat/completions
OpenAI Responses/Codex:  http://localhost:8787/v1/responses
Claude Code:             http://localhost:8787/v1/messages
```

Your app sends requests to this router using a private `flm_...` router key. The router loads only the provider keys attached to that router account and selects providers using the routing policy saved for that router.

If one provider is rate-limited, down, invalid, or temporarily unavailable, the router can move to the next configured provider.

Typical flow:

1. User signs in through Clerk.
2. User creates a router/project.
3. Server generates a private router key beginning with `flm_`.
4. User adds provider API keys from the built-in 26-provider catalog, including Groq, OpenRouter, Together AI, Fireworks AI, Gemini, Anthropic, OpenAI, DeepSeek, and more.
5. User calls `/v1/chat/completions`, `/v1/responses`, or `/v1/messages` with the router key.
6. Router forwards the request to an available configured provider.
7. Dashboard records request analytics and shows which provider was used.

---

## Major Features

### OpenAI-Compatible Gateway

- `GET /v1/models`
- `POST /v1/chat/completions`
- Works with cURL, JavaScript `fetch`, Python `requests`, and OpenAI SDK style clients.
- Returns upstream provider responses in OpenAI-compatible shape when providers follow that standard.

### OpenAI Responses API and Codex Gateway

- `POST /v1/responses` with OpenAI Responses request, response, and SSE event shapes.
- Supports string or item-array `input`, `instructions`, streaming, usage, structured text formats, function tools, custom tools, tool outputs, and parallel tool calls.
- Translates Responses requests to the selected provider's Chat Completions API and converts provider output back to Responses items.
- Exposes `codex-free-router` through `GET /v1/models`.
- Works as a custom Codex CLI model provider through `wire_api = "responses"`.
- Preserves Codex function-call loops, including `response.output_item.done` and the required terminal `response.completed` event.

### Claude Code-Compatible Gateway

- `POST /v1/messages` with Anthropic Messages request and response shapes.
- Real-time Anthropic SSE events for text and tool-use responses.
- `POST /v1/messages/count_tokens` with a local token estimate.
- Accepts `Authorization: Bearer` and `x-api-key` router credentials.
- Converts Claude Code system prompts, content blocks, tools, tool results, and stop reasons to and from OpenAI chat completions.
- Exposes `claude-free-router` through `GET /v1/models` for optional Claude Code gateway model discovery.

### Routing Policy Engine

- Provider definitions live in `providers.json`.
- Each router stores its own routing strategy and preferred provider order.
- Supported strategies: Priority, Fastest, Round robin, Least used, Reliability, and Smart.
- Routing performance is learned from real provider attempts, including latency, success score, usage, and consecutive failures.
- Retryable failures move the request to the next ordered provider.
- Provider `429` responses create persistent, per-router cooldown windows and honor `Retry-After` seconds or HTTP-date values.
- Providers in an active cooldown are skipped before an upstream request is made.
- Repeated retryable failures are protected by a persistent closed/open/half-open circuit breaker.
- Open circuits are skipped until a single recovery probe is allowed.
- The selected strategy is returned through `x-free-llm-routing-policy` and stored with analytics logs.
- If every configured provider fails, the router returns a sanitized `providers_exhausted` error.

### Persistent Rate-Limit Cooldowns

- Stores cooldown state separately for every router and provider in local JSON or Redis/KV.
- Honors upstream `Retry-After` headers and falls back to exponential cooldowns when the header is absent.
- Default fallback sequence is 30 seconds, 1 minute, 2 minutes, 5 minutes, 10 minutes, then 15 minutes.
- Returns `429 providers_cooling_down` with `Retry-After` when every compatible provider is cooling down.
- Displays live countdowns in Provider Health, provider cards, and **Settings → Router & Policies**.
- Includes a manual **Clear cooldown** action for administrators.
- Analytics provider evaluations identify providers skipped because of a rate-limit cooldown.

### Persistent Circuit Breakers

- Tracks retryable `5xx` responses, timeouts, connection failures, and malformed successful responses.
- Opens a provider circuit after three consecutive circuit-eligible failures.
- Uses escalating open windows of 2 minutes, 5 minutes, 10 minutes, then 15 minutes.
- Automatically moves an expired circuit into half-open state and allows one request-triggered recovery probe.
- A successful probe closes and resets the circuit; a failed probe immediately reopens it with a longer delay.
- Circuit state persists per router/provider in local JSON or Redis/KV, including failure type, failure count, open count, recovery time, and probe state.
- Provider Health, provider cards, Router & Policies, and Analytics show circuit-open and recovery-test states.
- Administrators can run **Test recovery** or **Reset circuit** without removing the provider key.

### One-Active-Model Provider Catalogs

- Each provider can store multiple user-supplied model IDs while exposing exactly one active model to the routing engine.
- Existing single-model provider configuration is migrated automatically into a catalog containing that model as the active option.
- Provider cards include a **Models** manager with **Add**, **Add & activate**, **Set active**, **Test**, **Edit**, and **Delete** actions.
- Inactive saved models are never tried automatically; changing the active model is an explicit production configuration change.
- Model health is tracked separately from provider circuit health with `healthy`, `unavailable`, `unauthorized`, `rate-limited`, `error`, and `not tested` states.
- A provider-specific `401`, `403`, or `404` updates the active model state and immediately fails over to the next ranked provider without opening the provider circuit.
- Analysis records the provider and exact active provider model for every attempt.

Example:

```txt
OpenRouter saved models
○ qwen/qwen3-coder:free      unavailable
● qwen/qwen3-coder-next      active · healthy
○ deepseek/deepseek-r1:free  not tested

Only qwen/qwen3-coder-next is used for new OpenRouter requests.
```

### Provider Quota and Usage Tracking

- Configure optional daily and monthly request limits for each provider.
- Configure optional daily and monthly token limits for each provider.
- Every upstream attempt increments persistent request, success, and failure counters.
- Successful responses store input, output, and total token usage across OpenAI Chat Completions, OpenAI Responses/Codex, and Anthropic Messages/Claude Code.
- Provider-reported usage is preferred; when usage is unavailable, the router estimates input tokens and labels the source as estimated.
- Providers crossing the configurable warning threshold are moved behind providers with healthier remaining capacity.
- Providers at a configured limit are skipped before an upstream call and automatically become eligible after the relevant UTC day or month resets.
- If every compatible provider is exhausted, the API returns `429 providers_quota_exhausted` with `Retry-After` and `x-free-llm-quota-reset-at`.
- Provider cards show live usage bars, limit status, and reset time. Administrators can edit limits or reset counters without removing the provider key.
- Analysis request details show input, output, total tokens, and whether the usage was reported or estimated.

### Configurable Retry and Timeout Controls

- Configure the normal per-provider timeout and a hard total request deadline across every attempt and delay.
- Limit the maximum number of provider attempts so one client request cannot fan out indefinitely.
- Configure retryable HTTP status codes, network-error retries, and malformed-response retries.
- Use exponential backoff with an adjustable initial delay, maximum delay, multiplier, and optional jitter.
- Set separate timeouts for establishing streaming responses and running half-open circuit recovery probes.
- Override the provider timeout for individual providers that need a shorter or longer response window.
- Add alias-level overrides for provider timeout, total deadline, and maximum attempts without changing the router defaults.
- Analysis stores the full attempt timeline, applied timeout, retryability decision, retry delay, and the reason retrying stopped.

Example:

```txt
Router policy: maximum 3 attempts, 8s provider timeout, 30s total deadline

Attempt 1 — Groq
503 after 420ms → retryable → wait 250ms

Attempt 2 — Mistral
connection timeout after 8s → retryable → wait 500ms

Attempt 3 — OpenRouter
200 after 1.2s → return response
```

### Full Provider-Attempt Timeline

Every Analysis record now contains a standardized chronological event stream instead of only a final provider and a flat attempt list. The timeline is generated for OpenAI Chat Completions, OpenAI Responses/Codex, and Anthropic Messages/Claude Code requests.

The timeline can include:

- Request receipt and router-key authentication.
- Model-alias resolution, routing strategy, and required capabilities.
- Candidate ranking and quota-warning deprioritization.
- Providers skipped for capability mismatch, exhausted quota, active cooldown, open circuit, or unavailable recovery probe.
- Exact provider-attempt start and completion timestamps.
- Applied provider timeout, HTTP status, latency, retryability, and upstream failure details.
- Retry backoff and the reason retrying stopped.
- Cooldown creation, circuit open/reopen/close transitions, and half-open recovery.
- Deduplication source, original request ID, and provider call avoided.
- Final response delivery or final routed failure.

Each event stores an ISO timestamp, elapsed milliseconds from request receipt, a stable event type, optional provider ID, a readable explanation, and expandable raw metadata. The Analysis drawer presents these events as a vertical timeline and provides **Copy timeline** for issue reports.

Example:

```txt
0 ms      Request received
1 ms      Router key accepted
2 ms      Alias “free-router” resolved
4 ms      vision-only-provider skipped — vision unsupported
5 ms      groq ranked #1
6 ms      Attempt 1 started — groq
1,204 ms  groq failed — HTTP 429
1,205 ms  Cooldown started for groq
1,205 ms  Retry scheduled after 500 ms
1,708 ms  Attempt 2 started — mistral
2,942 ms  mistral succeeded — HTTP 200
2,945 ms  Response returned to client
```

The existing provider-attempt cards and routing-decision list remain available for quick summaries; the full timeline is the authoritative chronological debugging view.

### Request IDs and Rich Routing Headers

- Accepts an optional client `x-request-id` and preserves it when it contains only safe characters and is no longer than 128 characters.
- Generates a collision-resistant `req_...` identifier before authentication when no valid client ID is supplied.
- Uses the same request ID for alias resolution, capability filtering, every provider retry, streaming headers, error responses, timelines, and Analysis.
- Forwards only the safe `x-request-id` upstream; router keys, account IDs, analytics IDs, and storage identifiers are never forwarded.
- Returns the provider, provider model, requested alias, strategy, attempt count, fallback usage, total latency, deduplication state, and applicable cooldown/circuit/quota/retry details as `x-free-llm-*` headers.
- Adds `request_id` to structured OpenAI, Responses, and Anthropic error bodies.
- Keeps a duplicate caller's own request ID while linking it to the original provider operation with `x-free-llm-original-request-id`.
- Makes request IDs searchable and copyable in Analysis and exposes an expandable list of the exact routing headers returned to the client.

Example:

```txt
Client header:
  x-request-id: invoice-summary-2026-8472

Provider attempt 1:
  x-request-id: invoice-summary-2026-8472

Provider attempt 2:
  x-request-id: invoice-summary-2026-8472

Gateway response:
  x-free-llm-request-id: invoice-summary-2026-8472
  x-free-llm-provider: mistral
  x-free-llm-provider-attempts: 2
  x-free-llm-fallback-used: true
```

### Detailed Performance Timing

- Measures total request latency from gateway receipt through final response completion.
- Separates router preparation, provider work, retry/backoff delay, response-body processing, and final router overhead.
- Stores independent timing data for every provider attempt instead of combining failover into one opaque latency number.
- For streaming requests, records response-header time, time to first token, stream duration, and tokens per second when output-token usage is available.
- Failed requests retain partial timing data so slow timeouts and exhausted retry budgets remain diagnosable.
- Deduplicated responses report fast reuse latency without pretending that a new provider call occurred.
- Analysis presents summary metrics, proportional timing bars, per-attempt timings, the slowest stage, and a **Copy timings** action.
- Returns normalized `x-free-llm-*` performance headers; final streaming-only values are also exposed through HTTP trailers and the Analysis record.

Example:

```txt
Total request                 4,280 ms
Router preparation              18 ms
Provider attempt 1 — Groq    1,205 ms
Retry backoff                  500 ms
Provider attempt 2 — Mistral 2,430 ms
Time to first token            620 ms
Streaming duration           1,810 ms
Final router overhead           12 ms
```

### Request Deduplication and Idempotency

- Coalesces identical non-streaming requests that are already in flight, so concurrent callers share one provider operation.
- Reuses successful completed responses during a configurable one-to-300-second window.
- Supports an optional `Idempotency-Key` request header for explicit client-controlled operation identity.
- Automatic fingerprints include the router, endpoint, model alias, input/messages, generation settings, tool definitions, and response-format settings.
- Deduplication entries are isolated by router account; separate users never share results.
- Streaming requests are always bypassed. Tool, multimodal, and explicitly non-deterministic requests are bypassed by default unless the client supplies an explicit idempotency key.
- Completed failures are not cached. Only callers already waiting for the same in-flight operation may receive that shared failure.
- Provider request and token counters increase only for the real upstream operation.
- Duplicate Analysis records show the original request ID, in-flight/completed source, provider call avoided, and estimated request/token savings.
- Responses include `x-free-llm-deduplicated`, `x-free-llm-original-request-id`, `x-free-llm-deduplication-source`, and `x-free-llm-duplicate-count`.
- The current in-flight coordinator and response cache are process-local and intentionally ephemeral. Use sticky routing for horizontally scaled deployments until a shared coordinator is introduced.

Example:

```txt
Client A → identical request → provider call starts
Client B → identical request → joins Client A in flight
Provider → 200              → both clients receive the same result
Client C → 5 seconds later  → completed response is reused

Provider calls: 1
Client responses: 3
```

### Provider Model Catalog

The static `model` value in `providers.json` remains the migration fallback for new or legacy accounts. After a user saves provider model choices, the account-specific catalog controls the active upstream model.

Example stored account shape:

```json
{
  "providerModels": {
    "openrouter": {
      "activeModelId": "qwen/qwen3-coder-next",
      "models": [
        {
          "id": "qwen/qwen3-coder:free",
          "status": "unavailable",
          "lastStatus": 404,
          "lastError": "This model is unavailable for free",
          "lastCheckedAt": "2026-07-21T19:30:00.000Z"
        },
        {
          "id": "qwen/qwen3-coder-next",
          "status": "healthy",
          "lastStatus": 200,
          "lastCheckedAt": "2026-07-21T19:34:00.000Z"
        }
      ]
    }
  }
}
```

Rules:

- A provider must always retain at least one saved model.
- The active model must be one of the saved model IDs.
- The active model cannot be deleted until another model is activated.
- Adding a model does not change production traffic unless **Add & activate** is chosen.
- Testing a model sends a tiny direct chat-completions request and updates only model health; it does not modify routing order or circuit state.
- Runtime requests use only `activeModelId`. Inactive models are configuration options, not internal fallback attempts.
- Provider-specific model failures update model health and then continue to the next ranked provider.

Dashboard API routes:

```txt
PUT  /api/providers/:providerId/models
POST /api/providers/:providerId/models/test
POST /api/providers/:providerId/models/detect
```

`PUT /models` accepts the complete catalog:

```json
{
  "activeModelId": "qwen/qwen3-coder-next",
  "models": [
    { "id": "qwen/qwen3-coder:free", "status": "unavailable" },
    { "id": "qwen/qwen3-coder-next", "status": "healthy" }
  ]
}
```

## Model Aliases

- Every new router starts with only the three required compatibility aliases: `free-router`, `codex-free-router`, and `claude-free-router`. Intent-specific aliases are created only when you add them. Legacy auto-seeded aliases from earlier releases are removed when account data is normalized; customized aliases are preserved.
- Aliases can override the router-wide strategy, require capabilities, restrict eligible providers, and define their own provider priority.
- Custom aliases are created and managed under **Settings → Router & Policies**.
- The same alias can be used through Chat Completions, Responses/Codex, or Messages/Claude endpoints.
- `GET /v1/models` returns enabled aliases; authenticated requests also include account-specific custom aliases.
- Successful responses include `x-free-llm-model-alias`, `x-free-llm-requested-model`, and `x-free-llm-provider-model`.
- Analytics records both the requested virtual model and the actual upstream provider model.

### Model-Aware Capability Registry

The capability registry is layered because a provider API and a model hosted by that provider answer different questions:

1. **Provider layer** — whether the provider transport supports Chat Completions, streaming, tools, image payloads, embeddings, and related request shapes.
2. **Model layer** — whether a specific saved model actually supports streaming, tools, JSON mode, structured outputs, vision, reasoning, or embeddings.
3. **Runtime evidence** — what capability probes and real routed requests have verified for that exact provider/model pair.

Each saved model can store `supported`, `unsupported`, or `unknown` for every tracked capability. A state also records its source, last verification time, and safe evidence:

```json
{
  "id": "qwen/qwen3-coder-next",
  "capabilities": {
    "tools": {
      "value": "supported",
      "source": "user",
      "lastVerifiedAt": "2026-07-21T20:30:00.000Z"
    },
    "vision": {
      "value": "unsupported",
      "source": "probe",
      "evidence": {
        "status": 400,
        "message": "Image input is not supported by this model",
        "observedAt": "2026-07-21T20:32:00.000Z"
      }
    }
  }
}
```

Capability precedence protects intentional configuration:

```txt
User override → capability probe → runtime observation → built-in model catalog → provider default
```

A lower-priority runtime observation cannot overwrite a user override or a newer probe result. Generic `429`, timeout, network, or `5xx` failures never prove that a capability is unsupported and therefore do not modify the registry. Only a successful capability request or a clear capability-specific rejection can teach the registry.

#### Capability detection and manual control

Under **Settings → Router & Policies → Capability Registry**, every saved model has its own matrix. Users can:

- Select **Inherited**, **Supported**, **Unsupported**, or **Unknown** for each capability.
- Enter model-specific context-window and maximum-output-token limits when they differ from the provider default.
- Save explicit user overrides.
- Reset overrides back to inherited provider/model information.
- Run **Detect capabilities**, which sends small controlled probes for streaming, tools, JSON mode, structured outputs, vision, reasoning, and embeddings.
- See whether the effective value came from a user override, probe, runtime request, built-in model catalog, or provider default.

The detection endpoint is:

```txt
POST /api/providers/:providerId/models/detect
```

Request body:

```json
{ "modelId": "qwen/qwen3-coder-next" }
```

#### Flexible and strict unknown handling

The router-wide capability mode controls how unverified models are treated:

- **Flexible** — verified support ranks first; `unknown` remains eligible as a lower-confidence fallback. This is the default.
- **Strict** — a model with `unknown` support for any required capability is excluded before an upstream call.

Example for an alias that requires tools:

```txt
OpenRouter / qwen3-coder-next  tools=supported (probe)  → eligible
Groq / custom-llama           tools=unsupported (user) → skipped
Mistral / new-model           tools=unknown (provider) → fallback in flexible mode; skipped in strict mode
```

Capability-aware routing always evaluates the **active model**. Inactive saved models remain configuration choices and are never silently attempted. Analysis records the active provider model, required capabilities, effective values, sources, and why each provider/model pair was eligible or skipped. A clear model capability rejection triggers immediate provider failover, updates that model's runtime evidence, and does not damage the provider circuit.

### Bring Your Own API Keys

- Users add provider API keys through the dashboard or CLI.
- Provider keys are never displayed again after saving.
- Local storage uses `.freellm/accounts.json`.
- Hosted storage can use Redis/KV.
- `ACCOUNT_ENCRYPTION_KEY` enables AES-256-GCM credential encryption.

### Clerk Authentication

- Dashboard uses Clerk sign-in.
- Backend verifies Clerk session tokens using `@clerk/backend`.
- Signed-in user is linked to a router account.
- Settings page can show account name, email, login method, and sign-in metadata.

### Dashboard UX

The adapted UI includes:

- Sidebar navigation.
- Overview page.
- Providers page.
- Playground/test page.
- Analysis page.
- Docs/integration snippets page, including Claude Code PowerShell setup.
- Settings page.
- Provider company logos with fallback initials.
- App favicon/logo assets.
- Terminal-style code snippet windows.
- Empty states.
- Toasts and small UI animations.

### Provider Management

- Provider cards show logo, name, model, description, free-tier note, connection state, rate-limit awareness, and daily/monthly usage bars.
- Each connected provider has a quota editor for request limits, token limits, warning threshold, and usage reset.
- Clicking a specific provider's **Add key** button opens a dedicated modal for that provider only.
- The dropdown provider picker was removed because it made the flow confusing.

### Analytics

- Tracks request count, success rate, most used provider, average latency, request frequency, and recent logs.
- Searches provider, alias, request/response content, current request ID, client request ID, original deduplicated request ID, and routing headers.
- Request drawer shows a copyable correlation ID, exact returned routing headers, full timeline, provider decisions, attempts, usage, deduplication linkage, and request/response snapshots.
- Logs are stored in `.freellm/analytics.json` or Redis/KV.

### Rate-Limit Awareness

The Providers and Overview pages can show provider states like:

- `Available`
- `Connected`
- `Healthy`
- `Rate limited`
- `Circuit open`
- `Testing recovery`
- `Ready to test`
- `Quota warning`
- `Quota reached`
- `Failing`

These states combine persistent routing health with recent analytics, including rate limits, retryable upstream failures, and recovery probes.


---

## Feature Guide with Examples

This index mirrors the dashboard's **Docs → Project Features** guide. It explains how each major feature changes a real request rather than only listing the feature name.

| # | Feature | What it does | Example |
|---:|---|---|---|
| 01 | Request lifecycle | Authenticates the router key, resolves the alias, filters and ranks providers, attempts recovery, then records the outcome. | `free-router` tries Groq, receives `429`, cools Groq down, succeeds through Mistral, and stores both attempts in Analysis. |
| 02 | API compatibility | Exposes OpenAI Chat Completions, OpenAI Responses/Codex, and Anthropic Messages/Claude Code through the same provider pool. | An OpenAI app uses `free-router`, Codex uses `codex-free-router`, and Claude Code uses `claude-free-router`. |
| 03 | Provider keys | Keeps upstream provider credentials behind one private `flm_...` router key. | Your application never receives the Groq or Mistral key; it sends only the router key. |
| 03A | Provider model catalog | Saves multiple model IDs for one provider while allowing exactly one active model. | When an OpenRouter free slug disappears, save a replacement, test it, and activate it without editing `providers.json`. |
| 04 | Routing policies | Chooses how compatible and healthy providers are ranked. | **Fastest** prefers the lowest measured latency, while **Reliability** prefers the strongest success history. |
| 05 | Provider priority | Lets the user define a deterministic fallback order. | Groq → Mistral → OpenRouter means Mistral is attempted only when Groq is unavailable or skipped. |
| 06 | Retry and failover | Moves to the next provider after transient retryable failures and provider-specific `401`, `403`, or `404` failures. | A provider returns `404` because its model slug is unavailable; the router immediately tries the next candidate without backoff or a circuit penalty. |
| 07 | Rate-limit cooldowns | Temporarily skips providers after `429` responses and honors `Retry-After`. | `Retry-After: 60` prevents that provider from receiving new requests for 60 seconds. |
| 08 | Circuit breaker | Stops repeatedly failing providers from slowing every request. | Three eligible failures open the circuit; later, one half-open recovery probe decides whether to close or reopen it. |
| 09 | Model aliases | Creates stable virtual model names with their own routing rules. | `vision-router` can require vision, use Reliability, and allow only providers verified to support images. |
| 10 | Model-aware capability registry | Resolves provider transport support together with the active saved model's manual, probed, runtime, catalog, and inherited capability evidence. | A tools alias prefers a model verified by probe, skips a user-marked unsupported model, and treats unknown support according to flexible or strict mode. |
| 11 | Full request timeline and Analysis | Stores a chronological event stream for authentication, alias resolution, filtering, ranking, skips, attempts, retries, protection-state changes, deduplication, and final delivery. | Groq returns `429`, a cooldown event is created, a 500 ms retry is scheduled, Mistral succeeds, and every step remains copyable with elapsed milliseconds. |
| 12 | Request IDs and routing headers | Correlates one request across the client, every provider attempt, errors, streaming, deduplication, and Analysis while returning the routing outcome as headers. | `x-request-id: checkout-8472` reaches both provider attempts; the response returns the same ID plus provider, model, strategy, attempt count, fallback, and latency headers. |
| 13 | Performance timing | Separates router preparation, provider work, retry delay, response processing, first-token latency, stream duration, throughput, and total time. | Groq spends 1.2 seconds before failing, the router waits 500 ms, Mistral returns its first token after 620 ms, and Analysis shows each stage independently. |
| 14 | Advanced analytics | Aggregates tokens, fallback paths, tool activity, structured-output validation, provider reliability, and safely detected client applications. | Filter the last seven days to see that Codex CLI generated 86 tool-enabled requests, Groq → Mistral was the most common fallback, and Mistral succeeded on 98% of attempts. |
| 15 | Expanded dashboards | Provides dedicated Overview, Providers, APIs & Models, and Applications workspaces with shared filters and drill-down links to Request Logs. | Compare Groq's P95 attempt latency and fallback starts, then click **View logs** to inspect only Groq requests. |
| 16 | Playground | Tests the configured router without writing a separate client. | Send a prompt with a selected API format and immediately inspect the chosen provider and response. |
| 17 | Recovery controls | Gives administrators compact actions for protected providers. | **Clear cooldown**, **Test recovery**, or **Reset circuit** restores service without deleting the provider key. |
| 18 | Provider quotas | Tracks provider request/token usage and prevents configured free-tier limits from being exceeded. | At 80% usage a provider is deprioritized; at 100% it is skipped until the daily or monthly window resets. |
| 19 | Retry and timeout controls | Separates transient retry/backoff rules from immediate provider failover while enforcing timeouts, deadlines, and attempt limits. | OpenRouter returns provider-specific `404` and fails over immediately; a later `503` uses the configured backoff before the next attempt. |
| 20 | Request deduplication | Coalesces identical in-flight work and briefly reuses successful safe responses without double-counting provider quota. | Two identical requests create one upstream call; a later request inside the 30-second window receives the stored result with `x-free-llm-deduplicated: true`. |
| 21 | Security and storage | Separates dashboard identity, router authentication, and encrypted provider credentials. | Clerk authenticates the user, `flm_...` authenticates inference, and `ACCOUNT_ENCRYPTION_KEY` protects stored provider secrets. |

### Example: one request moving through failover

```txt
Client request
  model: free-router
        |
        v
Alias and capability resolution
        |
        v
1. Groq       -> 429, cooldown starts
2. Mistral    -> 503, retryable failure recorded
3. OpenRouter -> 200, response returned
        |
        v
Analysis stores all three attempts, the selected policy, latency, and final provider
```

### Example: custom capability-aware alias

```json
{
  "id": "vision-router",
  "routingStrategy": "reliability",
  "requiredCapabilities": ["vision"],
  "eligibleProviderIds": ["openrouter", "nvidia"]
}
```

The client then uses the alias like a normal model name:

```json
{
  "model": "vision-router",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Describe this image." },
        { "type": "image_url", "image_url": { "url": "https://example.com/image.png" } }
      ]
    }
  ]
}
```

### Example: quota-aware free-tier protection

```txt
Groq daily request limit: 1,000
Warning threshold:         80%
Current usage:             812

Routing order before warning:
1. Groq
2. Mistral

Routing order after warning:
1. Mistral   healthy capacity
2. Groq      quota warning

At 1,000 requests:
Groq         quota-exhausted → skipped without an upstream call
Mistral      selected
```

Usage is stored in both daily and monthly UTC windows. A provider response such as:

```json
{ "usage": { "prompt_tokens": 6, "completion_tokens": 4, "total_tokens": 10 } }
```

adds ten tokens to that provider's daily and monthly counters and records the same usage in Analysis.

### Example: duplicate requests without duplicate provider usage

```http
POST /v1/chat/completions
Authorization: Bearer flm_your_router_key
Idempotency-Key: summarize-document-8472
Content-Type: application/json
```

When two clients send that operation together, only the first request calls the provider. The second response includes:

```txt
x-free-llm-deduplicated: true
x-free-llm-original-request-id: req_...
x-free-llm-deduplication-source: in-flight
x-free-llm-duplicate-count: 1
```

A successful response may also be reused during the configured window with `x-free-llm-deduplication-source: completed`. Analysis records the duplicate separately, but provider requests and token usage increase only once. The cache is process-local and is cleared by a restart or deployment.

---

## Architecture

```txt
Browser Dashboard
  |
  | Clerk session token via x-clerk-session-token
  v
Node.js TypeScript HTTP Server
  |
  | /api/* dashboard APIs
  | /v1/chat/completions OpenAI Chat Completions format
  | /v1/responses OpenAI Responses / Codex format
  | /v1/messages Anthropic Messages / Claude Code format
  v
Account + Provider Key Store
  |-- Local JSON: .freellm/accounts.json
  |-- Optional Redis/KV
  |
  v
Request Deduplication Guard
  |-- Router-scoped fingerprint or Idempotency-Key
  |-- In-flight coalescing
  |-- Short successful-response reuse
  |-- Unsafe/streaming bypass
  |
  v
ProviderRouter
  |
  | Detect request requirements
  | Filter explicit capability mismatches
  | Prefer verified matches over unverified matches
  | Resolve requested model alias
  | Merge alias capability requirements
  | Apply alias or router-wide routing policy
  | Resolve each provider's one active saved model
  v
OpenAI-Compatible Providers
  |-- OpenRouter
  |-- Groq
  |-- NVIDIA
  |-- Cerebras
  |-- Mistral
  |-- GitHub
  |-- Hugging Face
  |-- SambaNova
  |-- ModelScope
  |-- SiliconFlow
  |-- etc.
```

---

## Tech Stack

### Runtime and Language

- Node.js 20+
- TypeScript
- ES modules
- Native `node:http` server
- `tsx` for local TypeScript execution

### Backend Files

- `src/server.ts` — HTTP server, API routes, static file serving.
- `src/router.ts` — provider routing, failover, upstream calls.
- `src/responses.ts` — OpenAI Responses/Codex translation and SSE conversion.
- `src/anthropic.ts` — Anthropic Messages/Claude Code translation and SSE conversion.
- `src/accounts.ts` — account/router/provider-key and persisted router-setting storage.
- `src/deduplication.ts` — router-scoped fingerprints, safety bypasses, in-flight coalescing, and short response reuse.
- `src/auth.ts` — Clerk config and session verification.
- `src/config.ts` — provider config loading.
- `src/provider-catalog.ts` — provider display metadata.
- `src/provider-identities.ts` — canonical provider-only IDs and backward-compatible migration from former model-coupled IDs.
- `src/provider-capabilities.ts` — layered provider/model capability resolution, request requirement detection, strict/flexible unknown handling, and compatibility matching.
- `src/provider-models.ts` — provider model catalog migration, validation, active-model selection, model health, and per-model capability-profile normalization.
- `src/model-aliases.ts` — default/custom virtual models, alias validation, policy overrides, and capability merging.
- `src/provider-quotas.ts` — quota normalization, token extraction, usage windows, and exhaustion checks.
- `src/reliability-settings.ts` — retry, timeout, backoff, provider override, and alias override normalization.
- `src/routing-state.ts` — persistent provider performance, cooldown, circuit, quota usage, and round-robin state.
- `src/request-ids.ts` — request ID validation, secure generation, correlation metadata, response headers, and error-payload enrichment.
- `src/analytics.ts` — request logging, request correlation, routing headers, deduplication metadata, normalized analytics dimensions, aggregation, and request frequency storage.
- `src/request-analytics.ts` — safe client detection, tool-call and structured-output analytics, fallback metadata, and P4.4 summary aggregation.
- `public/dashboard-analytics.js` — privacy-safe P4.6 provider, API/model, and application dashboard aggregation used by the browser and unit tests.
- `src/dashboard.ts` — static public-file helper.
- `src/cli.ts` — local CLI.
- `src/types.ts` — shared types.

### Frontend Files

- `public/index.html` — public product landing page.
- `public/landing.css` — landing page and public documentation styling.
- `public/landing.js` — responsive navigation, code tabs, copy actions, scroll reveals, animated counters, route-trace playback, active section tracking, and pointer interactions.
- `public/docs.html` — public deployment and integration quick start.
- `public/dashboard.html` — authenticated router dashboard layout.
- `public/app.js` — dashboard behavior.
- `public/styles.css` — dashboard styling.
- `public/assets/providers/` — provider logos.
- `public/assets/brand/` — app logo and favicon assets.

### Runtime Dependencies

```txt
@clerk/backend
@upstash/redis
dotenv
```

### Dev Dependencies

```txt
@types/node
tsx
typescript
```

---

## Project Structure

```txt
.
├── api/
│   └── handler.ts
├── public/
│   ├── index.html
│   ├── docs.html
│   ├── dashboard.html
│   ├── landing.js
│   ├── landing.css
│   ├── app.js
│   ├── styles.css
│   ├── favicon.ico
│   └── assets/
│       ├── brand/
│       └── providers/
├── src/
│   ├── accounts.ts
│   ├── analytics.ts
│   ├── auth.ts
│   ├── cli.ts
│   ├── config.ts
│   ├── dashboard.ts
│   ├── deduplication.ts
│   ├── model-aliases.ts
│   ├── performance-timing.ts
│   ├── request-analytics.ts
│   ├── provider-catalog.ts
│   ├── provider-identities.ts
│   ├── provider-capabilities.ts
│   ├── provider-models.ts
│   ├── provider-quotas.ts
│   ├── reliability-settings.ts
│   ├── request-ids.ts
│   ├── request-timeline.ts
│   ├── router.ts
│   ├── routing-state.ts
│   ├── responses.ts
│   ├── anthropic.ts
│   ├── server.ts
│   └── types.ts
├── test/
│   ├── accounts.test.ts
│   ├── anthropic.test.ts
│   ├── circuit-api.test.ts
│   ├── cooldown-api.test.ts
│   ├── deduplication-api.test.ts
│   ├── deduplication.test.ts
│   ├── performance-timing-api.test.ts
│   ├── performance-timing.test.ts
│   ├── provider-capabilities.test.ts
│   ├── router.test.ts
│   ├── routing-state.test.ts
│   └── responses.test.ts
├── providers.json
├── providers.example.json
├── package.json
├── tsconfig.json
├── vercel.json
└── README.md
```

---

## Provider Configuration

Providers are defined in `providers.json`.

Current provider IDs in this adaptation include:

| ID | Provider | Env var | Model |
|---|---|---|---|
| `openrouter` | OpenRouter | `OPENROUTER_API_KEY` | `qwen/qwen3-coder:free` |
| `groq` | Groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `nvidia` | NVIDIA | `NVIDIA_API_KEY` | `nvidia/nemotron-3-super-120b-a12b` |
| `cerebras` | Cerebras | `CEREBRAS_API_KEY` | `gpt-oss-120b` |
| `mistral` | Mistral | `MISTRAL_API_KEY` | `mistral-small-2603` |
| `aion` | Aion Labs | `AION_API_KEY` | `aion-2.5` |
| `zai` | Z.ai / BigModel | `ZAI_API_KEY` | `glm-4.7-flash` |
| `github` | GitHub | `GITHUB_MODELS_TOKEN` | `openai/gpt-4.1-mini` |
| `hugging-face` | Hugging Face | `HUGGINGFACE_API_KEY` | `meta-llama/Meta-Llama-3.1-8B-Instruct` |
| `kilo-code` | Kilo Code | `KILO_API_KEY` | `kilo-auto/free` |
| `modelscope` | ModelScope | `MODELSCOPE_API_KEY` | `Qwen/Qwen3.5-35B-A3B` |
| `sambanova` | SambaNova | `SAMBANOVA_API_KEY` | `Meta-Llama-3.3-70B-Instruct` |
| `siliconflow` | SiliconFlow | `SILICONFLOW_API_KEY` | `Qwen/Qwen3-8B` |
| `together` | Together AI | `TOGETHER_API_KEY` | `openai/gpt-oss-20b` |
| `fireworks` | Fireworks AI | `FIREWORKS_API_KEY` | `accounts/fireworks/models/deepseek-v3p1` |
| `deepinfra` | DeepInfra | `DEEPINFRA_API_KEY` | `deepseek-ai/DeepSeek-V3` |
| `gemini` | Google Gemini | `GEMINI_API_KEY` | `gemini-3.5-flash` |
| `xai` | xAI | `XAI_API_KEY` | `grok-4.5` |
| `novita` | Novita AI | `NOVITA_API_KEY` | `deepseek/deepseek-v3.1` |
| `baseten` | Baseten | `BASETEN_API_KEY` | `deepseek-ai/DeepSeek-V4-Pro` |
| `cohere` | Cohere | `COHERE_API_KEY` | `command-a-03-2025` |
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| `openai` | OpenAI | `OPENAI_API_KEY` | `gpt-5.4` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-v4-flash` |
| `perplexity` | Perplexity | `PERPLEXITY_API_KEY` | `sonar-pro` |
| `friendli` | FriendliAI | `FRIENDLI_API_KEY` | `zai-org/GLM-5.2` |


### Expanded Provider Catalog

The built-in provider list now includes 26 canonical provider identities. The 13 newly added providers use their official OpenAI-compatible endpoints:

| Provider | Base URL |
|---|---|
| Together AI | `https://api.together.ai/v1` |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| xAI | `https://api.x.ai/v1` |
| Novita AI | `https://api.novita.ai/openai/v1` |
| Baseten | `https://inference.baseten.co/v1` |
| Cohere | `https://api.cohere.ai/compatibility/v1` |
| Anthropic | `https://api.anthropic.com/v1` |
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Perplexity | `https://api.perplexity.ai` |
| FriendliAI | `https://api.friendli.ai/serverless/v1` |

The model shown in `providers.json` is only the initial catalog entry. Users can add provider-specific model IDs, test them, and select exactly one active model without changing source code. Provider-level capability defaults remain conservative, while model probes and manual overrides refine the active model's capabilities.

### Provider Identity and Model Separation

Provider IDs now identify only the upstream provider. Model names are stored exclusively in the provider model catalog.

```txt
Provider ID: openrouter
Active model: qwen/qwen3-coder-next

Provider ID: groq
Active model: llama-3.3-70b-versatile
```

This keeps provider keys, quotas, cooldowns, circuits, analytics, and routing history stable when a provider changes or retires a model. Older stored IDs are migrated automatically:

| Former ID | Canonical provider ID |
|---|---|
| `openrouter-qwen` | `openrouter` |
| `groq-llama` | `groq` |
| `nvidia-nemotron` | `nvidia` |
| `cerebras-gpt-oss` | `cerebras` |
| `github-models` | `github` |

Legacy IDs remain accepted by the CLI and provider-management API for compatibility, but all responses and newly persisted data use the canonical provider-only ID. Analysis also normalizes historical timeline titles, descriptions, raw event metadata, attempts, rankings, fallback paths, and final routing details when logs are read. The dashboard renders the provider display name, such as **OpenRouter**, **Groq**, or **NVIDIA**, while keeping the model name in its separate model field.

> **Hugging Face endpoint:** the OpenAI-compatible Inference Providers base URL is `https://router.huggingface.co/v1`. The previous loopback value (`http://127.0.0.1:9999/v1`) was incorrect for the hosted Hugging Face service. Use a Hugging Face token with permission to call Inference Providers. The endpoint is designed for chat completions; the router's Codex and Claude adapters translate their requests to chat completions before selecting an upstream provider. See the [official Hugging Face Inference Providers documentation](https://huggingface.co/docs/inference-providers/index#alternative-openai-compatible-chat-completions-endpoint-chat-only).

Provider object shape:

```json
{
  "id": "groq",
  "baseUrl": "https://api.groq.com/openai/v1",
  "apiKeyEnv": "GROQ_API_KEY",
  "model": "llama-3.3-70b-versatile",
  "priority": 20,
  "cooldownMs": 30000,
  "timeoutMs": 30000,
  "headers": {},
  "capabilities": {
    "streaming": "supported",
    "tools": "supported",
    "jsonMode": "supported",
    "structuredOutputs": "unknown",
    "vision": "unsupported",
    "reasoning": "unknown",
    "embeddings": "unsupported",
    "contextWindow": 131072,
    "maxOutputTokens": 32768
  },
  "enabled": true
}
```

Field notes:

- `id`: stable internal ID used by dashboard, API routes, storage, and analytics.
- `baseUrl`: OpenAI-compatible provider base URL.
- `apiKeyEnv`: optional env-var fallback for the provider key.
- `model`: default/fallback upstream model used to migrate accounts that do not yet have a saved provider model catalog. After a user selects an active model in the dashboard, that account-specific model is sent upstream instead.
- `priority`: lower number means earlier attempt.
- `cooldownMs`: initial fallback cooldown after a `429` when `Retry-After` is absent. Repeated rate limits increase this value up to 15 minutes.
- `timeoutMs`: optional per-provider timeout.
- `headers`: optional provider-specific headers.
- `capabilities`: optional model-specific overrides for the built-in registry. Use `supported`, `unsupported`, or `unknown` for each feature.
- `contextWindow` and `maxOutputTokens`: optional positive token limits inside `capabilities`.
- `enabled`: set `false` to hide and disable provider.

Capability support has three states:

- `supported`: verified and preferred for requests requiring that feature.
- `unsupported`: a hard incompatibility; the provider is skipped before an upstream call.
- `unknown`: still eligible, but ranked behind verified matches. This prevents incomplete documentation from incorrectly disabling a provider.

---

## Environment Variables

Create `.env` in the project root.

### Required for Dashboard Auth

```env
CLERK_SECRET_KEY=sk_test_xxx
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_xxx
```

### Production Clerk domain and CSP

The production Clerk instance for this deployment uses the Frontend API origin:

```txt
https://clerk.llmrouter.dpdns.org
```

Both `vercel.json` and the static-file response headers in `src/server.ts` must allow this origin in `script-src` and `connect-src`. The project keeps the development `https://*.clerk.accounts.dev` origin as well, so local/test Clerk keys continue to work. After changing Clerk keys or CSP headers in Vercel, create a new deployment; an existing response header cannot be fixed by refreshing the browser.

The automated CSP regression test verifies that the production Frontend API origin remains present in both deployment paths.

### Strongly Recommended

```env
ACCOUNT_ENCRYPTION_KEY=your_32_byte_base64url_secret
```

Generate it:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Optional Local Storage Paths

```env
ACCOUNTS_PATH=.freellm/accounts.json
ANALYTICS_PATH=.freellm/analytics.json
```

### Optional Redis/KV Storage

Use either Upstash style:

```env
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

or Vercel KV style:

```env
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

### Optional Provider Key Env Vars

```env
OPENROUTER_API_KEY=...
GROQ_API_KEY=...
NVIDIA_API_KEY=...
CEREBRAS_API_KEY=...
MISTRAL_API_KEY=...
AION_API_KEY=...
ZAI_API_KEY=...
GITHUB_MODELS_TOKEN=...
HUGGINGFACE_API_KEY=...
KILO_API_KEY=...
MODELSCOPE_API_KEY=...
SAMBANOVA_API_KEY=...
SILICONFLOW_API_KEY=...
```

Provider key loading priority:

1. User-saved provider key from account storage.
2. Environment variable defined by `apiKeyEnv`.
3. Hardcoded `apiKey` in provider config, if present.

---

## How to Run as a Developer

### 1. Install Dependencies

```bash
npm install
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Add Clerk keys and an encryption key.

### 3. Start the Server

```bash
npm start
```

or watch mode:

```bash
npm run dev
```

Open:

```txt
http://localhost:8787
```

### 4. Sign In

Use the Clerk sign-in screen.

### 5. Create Router

Create a router/project from the dashboard. Save the generated `flm_...` router key.

### 6. Add Provider Keys

Use the Providers tab. Click **Add key** on the provider you want to configure.

### 7. Test

Use the Playground tab or make a direct cURL request to `/v1/chat/completions`.

---

## CLI Usage

Initialize a router:

```bash
npm run cli -- init "My Router"
```

List providers:

```bash
npm run cli -- providers
```

Add a provider key:

```bash
npm run cli -- add groq --no-open
```

The CLI is useful for local development when you want to avoid dashboard setup or quickly add provider keys.

---

## Public Product Surface

The root route is a public product landing page rather than an immediate authentication wall:

| Route | Purpose |
|---|---|
| `/` | Product overview, provider showcase, reliability features, API examples, and dashboard call to action |
| `/docs` | Public deployment and integration quick start |
| `/dashboard` | Clerk-protected router creation and management dashboard |
| `/sign-in` | Friendly alias for the dashboard sign-in surface |

The landing page uses only local CSS, JavaScript, brand assets, and provider logos, so the production Clerk Content Security Policy remains unchanged. Its interaction layer includes progressive scroll reveals, an animated failover trace with replay controls, counters, chart drawing, section-aware navigation, provider and feature-card interactions, and explicit `prefers-reduced-motion` support. Clerk redirects return to `/dashboard` after sign-in or sign-up.

---

## Dashboard Pages

### Overview

- Provider count.
- Base URL.
- Router key preview.
- Provider health, cooldown, circuit, and quota state.
- Quick-start terminal snippet.

### Providers

- Provider cards.
- Company logos.
- Add/replace/remove provider key.
- Rate-limit, circuit, failure, and quota awareness.
- Daily/monthly request and token usage bars.
- Quota editor and usage-reset action.
- Search providers.

### Playground

- API compatibility selector for OpenAI-compatible or Claude Code-compatible requests.
- Sends the matching request shape to `/v1/chat/completions` or `/v1/messages`.
- Prompt input.
- Temperature.
- Max tokens.
- Test request button.
- Endpoint and provider-used output.
- Protocol-aware response display.

### Analysis

The Analysis workspace is split into two focused tabs so aggregate reporting does not make individual request debugging cumbersome:

- **Analytics** — total requests, success rate, most used provider and API format, average latency, token totals, fallback rate and paths, average attempts, tool activity, client applications, provider reliability, trend charts, request frequency, and a dedicated aggregate filter set.
- **Request Logs** — a separate searchable and filterable list of individual gateway requests. Each row shows request ID, provider, alias, API format, client, status, fallback/tool indicators, latency, and timestamp.
- Clicking a request log opens the full details drawer with the copyable request ID, returned routing headers, chronological timeline, provider skip reasons, attempt outcomes, retries and backoff, cooldown and circuit changes, deduplication linkage, performance timings, token usage, request payload, and provider response.
- Analytics and Request Logs keep independent filters, so narrowing charts does not hide the request records being investigated.

### Docs

The Docs workspace is divided into two tabs:

- **Setup & Code** — cURL, JavaScript, Python, OpenAI SDK, Codex custom-provider, and Claude Code setup snippets.
- **Project Features** — an indexed, example-driven guide to the complete request lifecycle, API compatibility, provider keys, all six routing policies, provider priority, retry/failover behavior, persistent cooldowns, circuit breakers, model aliases, capability-aware routing, the full chronological request timeline, request IDs and routing headers, Analysis logs, Playground testing, recovery controls, provider quotas, configurable retry/timeout controls, security, and storage.

### Settings

The Settings workspace is divided into three tabs:

- **Account** — identity, login method, sign-in metadata, and session controls.
- **Router & Policies** — contains nested **Routing Policies**, **Model Aliases**, and **Capability Registry** tabs so each workspace remains compact. Routing Policies contains the router identity, strategy, provider fallback order, provider/total/stream/probe timeouts, retry status codes, maximum attempts, backoff, jitter, and per-provider timeout overrides. Model aliases may override the three primary reliability limits.
- **Logs & Data** — storage/security information and analytics-log deletion.

---

## API Routes

### `GET /health`

Health check.

```json
{ "status": "ok" }
```

### `GET /api/auth/config`

Returns Clerk publishable key for frontend auth.

```json
{ "publishableKey": "pk_test_xxx" }
```

### `GET /api/user/router`

Requires:

```txt
x-clerk-session-token: <Clerk session token>
```

Returns the signed-in user's router or `null`.

```json
{ "router": null }
```

or:

```json
{
  "router": {
    "id": "acct_xxx",
    "name": "My Router",
    "routerKey": "flm_xxx",
    "routerKeyPrefix": "flm_abcd",
    "createdAt": "2026-06-25T00:00:00.000Z",
    "configuredProviderIds": []
  }
}
```

### `POST /api/accounts`

Creates a router for the signed-in user or returns the existing router.

Requires:

```txt
x-clerk-session-token: <Clerk session token>
```

Body:

```json
{ "name": "My development router" }
```

### `GET /api/me`

Returns dashboard account and provider metadata.

Requires:

```txt
Authorization: Bearer <router key>
x-clerk-session-token: <Clerk session token>
```

Response shape:

```json
{
  "account": {
    "id": "acct_xxx",
    "name": "My Router",
    "routerKeyPrefix": "flm_abcd",
    "createdAt": "2026-06-25T00:00:00.000Z",
    "configuredProviderIds": ["groq"],
    "routingPolicy": {
      "strategy": "smart",
      "providerOrder": ["groq"]
    }
  },
  "providers": [
    {
      "id": "groq",
      "name": "Groq",
      "model": "llama-3.3-70b-versatile",
      "baseUrl": "https://api.groq.com/openai/v1",
      "configured": true,
      "routingStats": {
        "attempts": 12,
        "successes": 11,
        "failures": 1,
        "averageLatencyMs": 412,
        "successScore": 0.94,
        "rateLimitCount": 1,
        "cooldownUntil": 1784383200000,
        "cooldownReason": "rate_limit",
        "lastRetryAfterSeconds": 120,
        "circuitState": "open",
        "circuitFailureCount": 3,
        "circuitOpenCount": 1,
        "circuitOpenUntil": 1784383500000,
        "lastFailureType": "server_error",
        "halfOpenProbeActive": false,
        "quotaUsage": {
          "daily": { "requests": 812, "totalTokens": 486120, "resetAt": "2026-07-21T00:00:00.000Z" },
          "monthly": { "requests": 12040, "totalTokens": 7210040, "resetAt": "2026-08-01T00:00:00.000Z" },
          "lastTokenUsageSource": "reported"
        }
      },
      "quota": {
        "config": { "dailyRequestLimit": 1000, "warningThresholdPercent": 80 },
        "warning": true,
        "exhausted": false,
        "consumedPercent": 81,
        "nextResetAt": 1784592000000
      },
      "website": "https://console.groq.com/keys",
      "description": "Provider description",
      "freeTier": "Free-tier information"
    }
  ]
}
```

### `PATCH /api/router/settings`

Updates the router project name, routing policy, reliability controls, request-deduplication controls, and model aliases.

Requires signed-in router access.

```json
{
  "name": "Production router",
  "routingPolicy": {
    "strategy": "smart",
    "providerOrder": ["groq", "mistral"]
  },
  "reliabilitySettings": {
    "providerTimeoutMs": 30000,
    "totalRequestTimeoutMs": 90000,
    "maxProviderAttempts": 3,
    "initialBackoffMs": 250,
    "maxBackoffMs": 3000,
    "backoffMultiplier": 2,
    "useJitter": true,
    "retryStatusCodes": [408, 409, 425, 429, 500, 502, 503, 504],
    "retryNetworkErrors": true,
    "retryMalformedResponses": true,
    "streamingConnectionTimeoutMs": 30000,
    "halfOpenProbeTimeoutMs": 10000,
    "providerTimeoutOverrides": {
      "mistral": 45000
    }
  },
  "deduplicationSettings": {
    "enabled": true,
    "windowMs": 30000,
    "automaticFingerprinting": true,
    "requireIdempotencyKey": false,
    "bypassToolRequests": true,
    "bypassMultimodalRequests": true,
    "bypassNonDeterministicRequests": true
  },
  "modelAliases": [
    {
      "id": "fast-router",
      "name": "Fast Router",
      "enabled": true,
      "routingStrategy": "fastest",
      "requiredCapabilities": [],
      "eligibleProviderIds": [],
      "providerOrder": [],
      "reliabilityOverrides": {
        "providerTimeoutMs": 4000,
        "totalRequestTimeoutMs": 12000,
        "maxProviderAttempts": 2
      }
    }
  ]
}
```

Set `retryStatusCodes` to an empty array when HTTP status responses should never fail over. Network and malformed-response retry behavior are controlled separately.

Request deduplication defaults to a 30-second window. Set `requireIdempotencyKey` to `true` when automatic body fingerprinting should be disabled and every reusable operation must provide an explicit `Idempotency-Key` header.

Supported strategy values:

```txt
priority
fastest
round-robin
least-used
reliability
smart
```

### `PUT /api/providers/:providerId`

Adds or replaces a provider key.

Requires signed-in router access.

Body:

```json
{ "apiKey": "provider_api_key_here" }
```

Example:

```bash
curl -X PUT http://localhost:8787/api/providers/groq \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "x-clerk-session-token: $CLERK_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"your-groq-key"}'
```

### `DELETE /api/providers/:providerId`

Removes a saved provider key.

Requires signed-in router access.

Example:

```bash
curl -X DELETE http://localhost:8787/api/providers/groq \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "x-clerk-session-token: $CLERK_SESSION_TOKEN"
```

### `PUT /api/providers/:providerId/quota`

Creates or replaces the selected provider's quota limits. At least one request or token limit is required.

```json
{
  "dailyRequestLimit": 1000,
  "monthlyRequestLimit": 30000,
  "dailyTokenLimit": 500000,
  "monthlyTokenLimit": 15000000,
  "warningThresholdPercent": 80
}
```

All limit fields are optional positive integers. `warningThresholdPercent` accepts `1` through `99` and defaults to `80`.

### `DELETE /api/providers/:providerId/quota`

Removes the configured limits while preserving existing usage counters.

### `DELETE /api/providers/:providerId/usage`

Resets the provider's current daily and monthly request/token counters without changing its API key or quota configuration.

### `DELETE /api/providers/:providerId/cooldown`

Clears a provider's active rate-limit cooldown without removing its API key.

Requires signed-in router access.

```bash
curl -X DELETE http://localhost:8787/api/providers/groq/cooldown \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "x-clerk-session-token: $CLERK_SESSION_TOKEN"
```

### `DELETE /api/providers/:providerId/circuit`

Manually closes and resets a provider circuit. The provider API key is not changed.

### `POST /api/providers/:providerId/circuit/retry`

Immediately starts a real half-open recovery test against the selected provider. A successful test closes the circuit; a failed test reopens it using the next backoff window.

### `GET /api/analytics?limit=250`

Returns request logs and frequency buckets for the current router.

Requires signed-in router access.

```json
{
  "requests": [],
  "frequency": [
    { "label": "1 PM", "count": 0 }
  ]
}
```

### `DELETE /api/analytics`

Clears analytics logs for the current router.

Requires signed-in router access.

```json
{ "ok": true }
```

---

## Request IDs and Routing Headers

Every inference request receives one correlation ID before authentication or body validation begins.

- Send a valid `x-request-id` to preserve an existing application trace ID.
- Omit it and the gateway creates a collision-resistant `req_...` ID.
- IDs containing unsafe characters, whitespace, or more than 128 characters are replaced.
- Every provider retry receives the same safe `x-request-id` header.
- Router keys, account IDs, storage IDs, and provider credentials are never forwarded upstream.
- The ID appears in response headers, structured error bodies, streaming headers, the P4.1 timeline, and Analysis.

Example request:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer flm_your_router_key" \
  -H "Content-Type: application/json" \
  -H "x-request-id: checkout-summary-8472" \
  -d '{
    "model": "free-router",
    "messages": [{"role":"user","content":"Summarize this order."}]
  }'
```

Representative success headers:

```txt
x-free-llm-request-id: checkout-summary-8472
x-free-llm-request-id-source: client
x-free-llm-client-request-id: checkout-summary-8472
x-free-llm-provider: mistral
x-free-llm-provider-model: mistral-small-latest
x-free-llm-requested-model: free-router
x-free-llm-model-alias: free-router
x-free-llm-routing-strategy: reliability
x-free-llm-provider-attempts: 2
x-free-llm-fallback-used: true
x-free-llm-router-latency-ms: 21
x-free-llm-provider-latency-ms: 2310
x-free-llm-retry-delay-ms: 500
x-free-llm-total-latency-ms: 2841
x-free-llm-deduplicated: false
```

Additional conditional headers may include:

```txt
x-free-llm-cooldown-applied: groq
x-free-llm-circuit-state: closed
x-free-llm-quota-warning: true
x-free-llm-retry-stop-reason: maximum_attempts_reached
```

Every structured API error includes the same ID:

```json
{
  "error": {
    "message": "All configured providers failed",
    "type": "providers_exhausted",
    "request_id": "req_7d7f5b51d9ed4e339ce907ecde771f45"
  }
}
```

Deduplicated callers keep their own request ID. The response separately identifies the operation that performed the upstream work:

```txt
x-free-llm-request-id: client-duplicate-002
x-free-llm-deduplicated: true
x-free-llm-original-request-id: client-original-001
x-free-llm-deduplication-source: in-flight
```

Analysis stores `requestId`, optional `clientRequestId`, the ID source, and the exact returned routing headers. Search accepts the current ID or the original deduplicated request ID. The request drawer can copy the ID, inspect headers, and open the original request when it is still in loaded history.

---

## Performance Timing Breakdown

P4.3 normalizes performance data across OpenAI Chat Completions, OpenAI Responses/Codex, and Anthropic Messages/Claude Code. The same structure is stored for successful requests, partial failures, streams, retries, and deduplicated responses.

### Normalized timing model

| Metric | Meaning |
|---|---|
| `totalLatencyMs` | Wall-clock time from gateway receipt to completed response handling. |
| `routerPreparationMs` | Authentication, body parsing, account loading, alias resolution, compatibility checks, and ranking before the first provider attempt. |
| `providerLatencyMs` | Sum of all upstream provider-attempt durations, including failed attempts. |
| `providerHeadersMs` | Time until upstream response headers are available. |
| `responseBodyMs` | Time spent reading, validating, translating, or forwarding the selected provider response body. |
| `responseProcessingMs` | Gateway-side response conversion, usage extraction, serialization, and final accounting. |
| `retryDelayMs` | Backoff time intentionally spent between provider attempts. |
| `routerOverheadMs` | Remaining gateway work not already attributed to preparation, providers, retry delay, or response processing. |
| `firstTokenMs` | Time from gateway receipt until the first streaming payload is available. |
| `providerFirstTokenMs` | Time from the selected provider attempt start until its first streaming payload. |
| `streamDurationMs` | Time from the first upstream chunk until the stream finishes. |
| `tokensPerSecond` | Output-token throughput when the provider reports usable output-token counts. |

Each item in `attempts` keeps independent provider, timeout, headers, body, first-token, stream, status, and success/failure timings. Retry latency is therefore visible instead of being hidden inside one average.

Example Analysis record:

```json
{
  "performance": {
    "totalLatencyMs": 4280,
    "routerPreparationMs": 18,
    "providerLatencyMs": 3635,
    "retryDelayMs": 500,
    "responseProcessingMs": 12,
    "routerOverheadMs": 115,
    "firstTokenMs": 2470,
    "providerFirstTokenMs": 620,
    "streamDurationMs": 1810,
    "tokensPerSecond": 38.7,
    "slowestStage": "Provider processing",
    "attempts": [
      { "attempt": 1, "providerId": "groq", "latencyMs": 1205, "status": 503, "success": false },
      { "attempt": 2, "providerId": "mistral", "latencyMs": 2430, "status": 200, "success": true, "firstTokenMs": 620, "streamDurationMs": 1810 }
    ]
  }
}
```

### Performance headers

Non-streaming responses expose the final values immediately. Streaming responses expose values known before the first client chunk as normal headers; values known only after completion, such as final stream duration, are added as HTTP trailers and always remain available in Analysis.

```txt
x-free-llm-router-latency-ms: 18
x-free-llm-provider-latency-ms: 3635
x-free-llm-first-token-ms: 2470
x-free-llm-stream-duration-ms: 1810
x-free-llm-stream-tokens-per-second: 38.7
x-free-llm-retry-delay-ms: 500
x-free-llm-response-processing-ms: 12
x-free-llm-total-latency-ms: 4280
```

The Analysis drawer includes summary cards, proportional stage bars, per-provider attempt timing, a slowest-stage indicator, and **Copy timings**. Deduplicated responses are explicitly labeled and report reuse latency with zero provider work. Failed requests keep every timing value collected before the failure.

---


## Advanced Analytics

P4.4 turns the recent Analysis log into filterable trends. The workspace keeps those trends in the **Analytics** tab and places individual records in a separate **Request Logs** tab, so the dashboard can answer questions such as:

- How many provider-reported versus estimated tokens were used?
- How often did a request need fallback, and which provider path was most common?
- Which provider has the strongest observed attempt success rate?
- Which requests enabled tools, how many tool calls were generated, and which tool names appeared?
- Did requested structured output contain valid JSON?
- Which safe client category generated the traffic: Codex CLI, Claude Code, OpenAI Python/JavaScript, Anthropic SDKs, cURL, or an unknown client?

### Normalized request dimensions

Each new Analysis record can include:

```json
{
  "clientApplication": {
    "id": "openai-python",
    "name": "OpenAI Python SDK",
    "detectedBy": "stainless",
    "language": "python",
    "sdkVersion": "1.99.0"
  },
  "streaming": false,
  "fallbackUsed": true,
  "providerAttemptCount": 2,
  "fallbackPath": ["groq", "mistral"],
  "toolAnalytics": {
    "toolRequest": true,
    "requestedToolCount": 1,
    "requestedToolNames": ["search_docs"],
    "generatedToolCallCount": 1,
    "generatedToolNames": ["search_docs"],
    "outcome": "generated",
    "structuredOutputRequested": true,
    "structuredOutputValidation": "valid"
  }
}
```

Historical records that do not contain these fields still load. The dashboard derives conservative defaults from the saved request, response, provider, and attempt fields.

### Dashboard filters

The Analytics tab and Request Logs tab each keep their own filter state. Analytics can be filtered by:

- Time range: last hour, 12 hours, 24 hours, 7 days, 30 days, or all history
- Provider
- Model alias
- API format
- Client application
- Success or failure
- Streaming or non-streaming
- Tool usage
- Search text, request ID, original deduplicated request ID, provider, model, headers, client label, or tool metadata

Request Logs provides the same dimensions with a dedicated request-search field, allowing a user to inspect one request without changing the chart view.

### Summary and charts

The dashboard displays:

- Total tokens with provider-reported versus router-estimated totals
- Fallback rate and average attempts per upstream request
- Tool-enabled requests and generated tool-call count
- Most used client application
- Most reliable provider by observed attempt success rate
- Token usage over time
- Requests by client application
- Most common fallback paths
- Provider success rates
- Tool and structured-output activity
- Requests by API format

Deduplicated requests remain visible as client requests but are excluded from upstream token, provider-attempt, and fallback totals so the original provider operation is not counted twice.

### Client privacy

Client detection stores only a normalized application label and limited safe SDK metadata. The analytics record does **not** retain raw `Authorization`, `x-api-key`, cookie, IP-address, or user-agent values. Unknown clients remain grouped as `Unknown client` rather than persisting an identifying header string.

---

## Expanded Analytics Dashboards

P4.6 divides the aggregated **Analytics** workspace into four focused dashboards that share the same filters:

1. **Overview** — token trends, fallback paths, provider reliability, tool activity, API distribution, clients, and request frequency.
2. **Providers** — completed requests, every upstream attempt, success rate, average and P95 attempt latency, token usage, fallback starts, and fallback recoveries.
3. **APIs & Models** — request volume, success, end-to-end latency, tokens, streaming share, tool share, provider attempts, and fallback rate by API compatibility format and model alias.
4. **Applications** — Codex CLI, Claude Code, SDK, cURL, and unknown-client comparisons with API mix, top alias, reliability, latency, streaming, tools, tokens, and fallback behavior.

### Provider dashboard example

```txt
Provider      Served  Attempts  Success  Avg attempt  P95 attempt  Tokens   Recoveries
Groq             842       996    84.5%       620 ms       1,940 ms  1.84M            8
Mistral          516       544    97.8%       780 ms       1,420 ms  1.12M          132
OpenRouter       194       201    99.0%     1,180 ms       2,260 ms   492K           44
```

Attempt metrics include all upstream tries. Completed-request and token metrics are attributed to the provider that actually returned the response. Deduplicated responses remain visible as client demand but do not add fake attempts or token consumption.

### API and model dashboard example

```txt
OpenAI Chat          690 requests · 95.8% success · 18.2% fallback
Responses / Codex    488 requests · 97.1% success · 71.4% tools
Claude Messages      374 requests · 98.4% success · 63.9% streaming

free-router          912 requests · 1.24 attempts/request
codex-free-router    410 requests · 72% tool-enabled
claude-free-router   230 requests · 9.6% fallback
```

### Application dashboard example

```txt
Codex CLI            410 requests · 96% success · Responses API · 72% tools
Claude Code          288 requests · 98% success · Messages API · 61% streaming
OpenAI Python SDK    172 requests · 94% success · Chat Completions · 14% fallback
```

Every comparison-table row includes **View logs**. It switches to **Request Logs**, copies the current analytics time range, and applies the matching provider, API, alias, or application filter for immediate debugging.

OpenTelemetry export is intentionally **deferred and not required for the current product scope**. P4.6 uses the router's privacy-safe Analysis records directly and does not add an external telemetry dependency.

---

## OpenAI-Compatible API

### `GET /v1/models`

Returns the virtual router model.

```json
{
  "object": "list",
  "data": [
    { "id": "free-router", "object": "model", "owned_by": "local" },
    { "id": "codex-free-router", "object": "model", "owned_by": "local" },
    { "id": "claude-free-router", "object": "model", "owned_by": "local" }
  ]
}
```

### `POST /v1/chat/completions`

Requires router key:

```txt
Authorization: Bearer <router key>
Content-Type: application/json
```

Body:

```json
{
  "model": "free-router",
  "stream": false,
  "temperature": 0.2,
  "max_tokens": 256,
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

cURL:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "free-router",
    "messages": [{"role":"user","content":"Hello"}]
  }'
```

Successful responses are forwarded from the upstream provider. The router also returns provider, routing, alias, capability, deduplication, and performance headers when applicable:

```txt
x-free-llm-provider: groq
x-free-llm-routing-policy: smart
x-free-llm-model-alias: free-router
x-free-llm-deduplicated: false
x-free-llm-original-request-id: req_...
x-free-llm-deduplication-source: original
x-free-llm-router-latency-ms: 18
x-free-llm-provider-latency-ms: 920
x-free-llm-response-processing-ms: 7
x-free-llm-total-latency-ms: 945
```

For a reused request, `x-free-llm-deduplicated` becomes `true` and the source is `in-flight` or `completed`. Streaming requests return `x-free-llm-deduplication-bypass: streaming_request` instead of being buffered.

If all providers fail:

```json
{
  "error": {
    "message": "All configured providers failed",
    "type": "providers_exhausted",
    "attempts": [
      {
        "provider": "openrouter",
        "status": 429,
        "message": "Provider returned error"
      }
    ]
  }
}
```

---

## OpenAI Responses API and Codex

The Responses adapter is the modern OpenAI-compatible surface used by the Codex CLI custom-provider configuration. The router translates each Responses request to the selected provider's Chat Completions API, then reconstructs Responses output items and SSE events.

### `POST /v1/responses`

Authentication:

```txt
Authorization: Bearer <router key>
Content-Type: application/json
```

Basic request:

```json
{
  "model": "codex-free-router",
  "instructions": "You are a precise coding assistant.",
  "input": "Summarize this repository.",
  "stream": false,
  "max_output_tokens": 1024
}
```

Streaming request:

```bash
curl http://localhost:8787/v1/responses \
  -H "Authorization: Bearer $ROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "codex-free-router",
    "input": "Reply with exactly: Router is working.",
    "stream": true
  }'
```

The SSE stream includes Responses lifecycle events such as:

```txt
response.created
response.output_item.added
response.output_text.delta
response.output_item.done
response.completed
```

Function calls are returned as `function_call` items. Custom/freeform tools are returned as `custom_tool_call` items. Codex sends the corresponding `function_call_output` or `custom_tool_call_output` in the next stateless request, and the router converts that history back into provider chat messages.

### Supported compatibility scope

- String or item-array `input`.
- `instructions` mapped to the provider system message.
- Text and image input content.
- Streaming and non-streaming responses.
- Function tools and tool-choice controls.
- Custom/freeform tools represented to upstream providers through an `input` wrapper schema.
- Namespaced Codex/MCP tools flattened for generic providers and restored on the response path.
- Parallel function-call history.
- Structured JSON text formats where the selected provider supports them.
- Input/output token usage and analytics capture.

Hosted OpenAI-only tools such as native web search are not executed by the router itself. Unsupported hosted tools are omitted before forwarding to generic Chat Completions providers.

### Codex CLI setup

Set the router key in the environment:

```powershell
$env:FREE_LLM_ROUTER_KEY = "flm_your_router_key"
```

Add this to `~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`):

```toml
model = "codex-free-router"
model_provider = "free_llm_router"

[model_providers.free_llm_router]
name = "Free LLM Router"
base_url = "http://localhost:8787/v1"
env_key = "FREE_LLM_ROUTER_KEY"
wire_api = "responses"
supports_websockets = false
request_max_retries = 3
stream_max_retries = 5
stream_idle_timeout_ms = 300000
```

Launch Codex from a project directory:

```bash
codex
```

The router currently uses HTTP SSE for Codex. Responses WebSocket transport is intentionally disabled in the sample configuration.

---

## Claude Code Compatibility

Claude Code can point to this router as an Anthropic-format LLM gateway. The router accepts Claude Code's Messages API request, converts it to an OpenAI chat-completions request for the selected provider, and converts the result back to Anthropic content blocks and streaming events.

### Supported routes

```txt
POST /v1/messages
POST /v1/messages/count_tokens
GET  /v1/models
HEAD /
```

Claude Code inference requests can include `?beta=true`; route matching uses the pathname, so `/v1/messages?beta=true` is supported.

### Windows PowerShell setup

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:8787"
$env:ANTHROPIC_AUTH_TOKEN = "flm_your_router_key"
$env:ANTHROPIC_MODEL = "claude-free-router"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-free-router"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-free-router"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-free-router"
claude
```

The base URL must be the gateway origin without `/v1`. Claude Code adds `/v1/messages` itself. `ANTHROPIC_AUTH_TOKEN` sends the router key as a bearer token, so an existing Claude account login is not used for that session.

### macOS or Linux setup

```bash
export ANTHROPIC_BASE_URL="http://localhost:8787"
export ANTHROPIC_AUTH_TOKEN="flm_your_router_key"
export ANTHROPIC_MODEL="claude-free-router"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-free-router"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-free-router"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-free-router"
claude
```

### Verify inside Claude Code

Run `/status` and confirm that it shows the custom Anthropic base URL and `ANTHROPIC_AUTH_TOKEN`. Then send a small test request.

### Compatibility scope

The adapter currently supports the parts Claude Code needs for normal coding workflows:

- Text and image inputs.
- System prompts and prompt-cache metadata tolerance.
- Client tools and tool results.
- Parallel tool-call request control.
- Streaming text and tool-use blocks.
- Basic structured-output translation.
- Stop reason and usage conversion.

Some Anthropic-only features cannot be reproduced exactly when the selected upstream is an OpenAI-compatible non-Claude model. The router safely ignores unsupported fields such as Anthropic thinking and context-management controls. Token counting is an estimate because generic OpenAI-compatible providers do not expose Anthropic's tokenizer. Provider and model tool-calling quality also varies, so coding-focused models with reliable function calling should receive higher routing priority.

Anthropic documents custom LLM gateways, but it does not officially support routing Claude Code to non-Claude models. Treat this adapter as best-effort interoperability and test it against new Claude Code releases.

---

## Storage and JSON Databases

The project uses local JSON files by default, not SQL.

### `.freellm/accounts.json`

Default account store.

Controlled by:

```env
ACCOUNTS_PATH=.freellm/accounts.json
```

Stores:

- Account/router records.
- Clerk owner user ID.
- Router key hash.
- Router key prefix.
- Encrypted recoverable router key if enabled.
- Provider API keys.
- Configured provider IDs.

Approximate shape:

```json
{
  "accounts": [
    {
      "id": "acct_xxx",
      "ownerUserId": "user_xxx",
      "name": "My Router",
      "routerKeyHash": "sha256_hash_here",
      "routerKeyPrefix": "flm_abcd",
      "encryptedRouterKey": "v1.encrypted_value",
      "createdAt": "2026-06-25T00:00:00.000Z",
      "providerKeys": {
        "groq": "v1.encrypted_provider_key"
      },
      "routingPolicy": {
        "strategy": "priority",
        "providerOrder": ["groq"]
      }
    }
  ]
}
```

Important:

- `.freellm/` should not be committed.
- Router keys should be treated like API keys.
- Provider keys should be encrypted with `ACCOUNT_ENCRYPTION_KEY`.

### `.freellm/routing-state.json`

Stores provider-routing performance and the round-robin cursor when Redis/KV is not configured.

Controlled by:

```env
ROUTING_STATE_PATH=.freellm/routing-state.json
```

Tracks per-provider attempt count, success/failure count, moving average latency, success score, consecutive failures, rate-limit cooldowns, circuit state, circuit failure/open counts, failure classification, half-open probes, and recovery timestamps.

### `.freellm/analytics.json`

Default analytics store.

Controlled by:

```env
ANALYTICS_PATH=.freellm/analytics.json
```

Stores:

- Request ID.
- Router key hash.
- Timestamp.
- Provider ID.
- Provider model.
- Status.
- Latency.
- Sanitized request body.
- Sanitized response body.

Approximate shape:

```json
{
  "requests": [
    {
      "id": "uuid",
      "routerKeyHash": "sha256_hash_here",
      "createdAt": "2026-06-25T00:00:00.000Z",
      "providerId": "groq",
      "providerModel": "llama-3.3-70b-versatile",
      "status": 200,
      "latencyMs": 318,
      "request": {
        "model": "free-router",
        "stream": false,
        "messages": [
          { "role": "user", "content": "Hello" }
        ]
      },
      "response": {
        "id": "chatcmpl_xxx",
        "choices": []
      }
    }
  ]
}
```

Analytics sanitization:

- Redacts keys named like `authorization`, `apiKey`, `api_key`, `key`, `token`, `password`.
- Truncates very long strings.
- Limits arrays and object depth.
- Reconstructs and stores completed OpenAI Responses and Anthropic Messages streams; OpenAI Chat Completions streams retain the existing lightweight logging behavior.

---

## Redis/KV Storage

When Redis/KV env vars are configured, the app uses Redis/KV instead of local JSON.

Supported env names:

```env
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

or:

```env
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
```

Common Redis keys:

```txt
freellm:account:<routerKeyHash>
freellm:accounts
freellm:user-account:<clerkUserId>
freellm:create-limit:<fingerprint>
freellm:analytics:<routerKeyHash>
```

Purpose:

- `freellm:account:<routerKeyHash>` stores an account/router.
- `freellm:user-account:<clerkUserId>` maps a Clerk user to their router.
- `freellm:analytics:<routerKeyHash>` stores recent request logs.

---

## Security Model

### Router Key

- Starts with `flm_`.
- Authorizes `/v1/*` calls.
- Should be treated like a secret API key.
- Should only be shown once or masked in normal UI.

### Clerk Session

- Protects dashboard APIs.
- Sent as `x-clerk-session-token`.
- Backend verifies it and extracts the Clerk user ID.
- User ID is used for account ownership checks, not as a password.

### Provider API Keys

- Never returned after save.
- Should be encrypted at rest.
- Should never be logged.
- Are redacted from analytics snapshots when key-like fields are detected.

### Settings Page Safety

Safe to show:

- Name.
- Email.
- Login method.
- Last sign-in.
- Router name.
- Storage mode.
- Masked IDs.

Avoid showing:

- Full provider API keys.
- Full router key by default.
- Clerk session token.
- Redis/KV token.
- `ACCOUNT_ENCRYPTION_KEY`.

---

## Analytics and Rate-Limit Protection

For each request, analytics can capture:

- Provider ID and provider model.
- Requested model alias and routing strategy.
- API compatibility format and endpoint.
- HTTP status and latency.
- Required capabilities and capability match.
- Provider candidate evaluations, including cooldown, circuit, capability, and quota skips.
- Input, output, and total token usage with reported/estimated source.
- Deduplication source, original request ID, provider call avoided, and estimated request/token savings.
- Request and response snapshots.

Provider cooldown state is persisted per router/provider. When an upstream provider returns `429`, the router records:

```json
{
  "rateLimitCount": 2,
  "cooldownUntil": 1784383200000,
  "cooldownReason": "rate_limit",
  "lastRetryAfterSeconds": 120,
  "lastRateLimitAt": "2026-07-18T12:00:00.000Z"
}
```

The dashboard classifies providers as:

| State | Meaning |
|---|---|
| `Available` | Provider exists but no key is saved. |
| `Connected` | Key is saved but no successful traffic exists yet. |
| `Healthy` | Recent successful traffic exists. |
| `Cooldown` | Provider is temporarily skipped after a `429`. |
| `Quota warning` | A configured limit has crossed its warning threshold, so healthier providers are preferred. |
| `Quota reached` | A configured request or token limit is exhausted, so the provider is skipped until reset. |
| `Failing` | Multiple recent failed requests exist. |

If all compatible providers are cooling down, the gateway returns status `429`, a `Retry-After` header, and a safe `providers_cooling_down` error.

For circuit-eligible failures, the router records `server_error`, `timeout`, `connection_error`, or `malformed_response`. After three consecutive failures, the circuit opens and the provider is skipped. When every compatible provider is protected by a cooldown or circuit, the gateway returns `503 providers_unavailable` with the earliest recovery time.

Provider quota usage is also persisted per router/provider. Request counters increment for every actual upstream attempt, including failed attempts. Token counters increment after successful responses. Daily counters reset at the next UTC midnight and monthly counters reset at the first day of the next UTC month. When all compatible providers have exhausted configured limits, the gateway returns `429 providers_quota_exhausted`, a `Retry-After` value, and `x-free-llm-quota-reset-at`.

Reliability controls are persisted with each router. They define provider and total-request timeouts, maximum attempts, transient retry status codes, network and malformed-response behavior, exponential backoff, jitter, streaming connection timeout, half-open probe timeout, and provider-specific timeout overrides. Model aliases may override provider timeout, total deadline, and maximum attempts. Analysis stores the resulting attempt metrics and builds the complete P4.1 chronological event timeline, including attempt starts, outcomes, immediate failover, retry decisions, backoff, circuit/cooldown changes, and final delivery.

Provider recovery distinguishes **retry with backoff** from **immediate provider failover**:

| Upstream result | Router action | Backoff | Circuit penalty |
|---|---|---:|---:|
| `401` provider credential rejected | Try the next ranked provider immediately | No | No |
| `403` provider access denied | Try the next ranked provider immediately | No | No |
| `404` provider model or endpoint unavailable | Try the next ranked provider immediately | No | No |
| Configured transient status such as `429`, `500`, `502`, `503`, or `504` | Try the next provider using configured retry pacing | Yes | When applicable |
| Unconfigured client error such as `400` | Stop because the same invalid request would fail elsewhere | No | No |

The attempt limit and total request deadline still apply to both recovery paths. Analysis labels provider-specific recovery as `immediate_failover`, records the reason, and creates a separate **Immediate failover to next provider** timeline event.

Deduplication controls are also persisted with each router. Safe non-streaming requests can be matched automatically or through `Idempotency-Key`. In-flight requests are coalesced, successful responses are reusable only during the configured short window, and failures are never retained for later callers. Deduplicated Analysis records include the original request ID and estimated quota savings, while routing and provider-usage counters remain attached only to the actual upstream request.

Request correlation is created before API authentication and remains stable through alias resolution, provider filtering, retries, streaming, and final delivery. A safe client `x-request-id` is preserved; otherwise the router creates a `req_...` value. All provider attempts receive the same upstream correlation header. Analysis records the request ID, source, optional client ID, deduplication relationship, and returned routing headers so a production error can be found directly from the ID shown to the client.

---

## Development Commands

```bash
npm install
npm start
npm run dev
npm run cli -- providers
npm run typecheck
npm test
npm run build
```

Recommended pre-commit validation:

```bash
npm run typecheck
npm test
npm run build
```

---


## Roadmap

The project is being implemented incrementally. Completed items remain listed here so progress can be tracked from the README.

### Phase 1 — API Compatibility

- [x] **P1.1** OpenAI Responses API
- [x] **P1.2** Codex CLI compatibility
- [ ] **P1.3** Embeddings API
- [x] **P1.4** Model discovery for router aliases
- [x] **P1.5** Expanded multimodal support and validation

### Phase 2 — Intelligent Routing

- [x] **P2.1** Provider capability registry
- [x] **P2.2** Routing-policy engine
- [x] **P2.3** Model aliases
- [x] **P2.4** Request-aware capability routing core
- [x] **P2.5** Configurable and draggable provider order
- [x] **P2.6** Provider model catalogs with one active model per provider
- [x] **P2.7** Model-aware capability registry, probes, runtime learning, and strict/flexible unknown handling
- [x] **P2.8** Canonical provider-only identities with automatic legacy-ID migration
- [x] **P2.9** Expanded built-in provider catalog with 13 additional OpenAI-compatible providers

### Phase 3 — Reliability and Free-Tier Protection

- [x] **P3.1** Persistent provider cooldowns and `Retry-After`
- [x] **P3.2** Circuit breakers for repeated timeout, connection, malformed-response, and `5xx` failures
- [x] **P3.3** Half-open recovery and automatic provider restoration
- [x] **P3.4** Provider quota and usage tracking
- [x] **P3.5** Configurable retry and timeout controls
- [x] **P3.6** Request deduplication where appropriate

### Phase 4 — Observability

- [x] **P4.1** Full provider-attempt timeline
- [x] **P4.2** Request IDs and richer routing headers
- [x] **P4.3** Router/provider/first-token/stream timing breakdown
- [x] **P4.4** Token, fallback, tool-call, and client-application analytics
- [ ] **P4.5** OpenTelemetry export — **Deferred / not required for now**
- [x] **P4.6** Expanded provider/API/application dashboards

### Phase 5 — Application Keys and Security

- [ ] Multiple named keys per router
- [ ] Endpoint, model, provider, and permission restrictions
- [ ] Per-key rate limits and token budgets
- [ ] Expiration, rotation, revocation, and last-used metadata
- [ ] Per-application analytics

### Phase 6 — Privacy and Data Controls

- [ ] Full, metadata-only, errors-only, and disabled logging modes
- [ ] Automatic log retention
- [ ] Sensitive-data redaction rules
- [ ] Payload storage limits
- [ ] Log export and permanent deletion
- [ ] Per-key privacy settings

### Phase 7 — Playground and Evaluation Lab

- [ ] Multi-provider comparison mode
- [ ] Side-by-side output, latency, usage, and status
- [ ] Tool-call and structured-output validation
- [ ] Manual response ratings
- [ ] Saved evaluations and regression runs

### Phase 8 — Developer Experience

- [x] **P8.1** Public landing page, friendly `/dashboard` and `/docs` routes, and public integration quick start.
- [x] **P8.2** Interactive landing motion with route-trace playback, scroll reveals, counters, chart animation, pointer depth, and reduced-motion support.

- [ ] OpenAPI specification
- [ ] Postman collection
- [ ] Python SDK
- [ ] JavaScript/TypeScript SDK
- [ ] Expanded CLI
- [ ] Docker Compose self-hosting
- [ ] Integration guides and environment generator

### Phase 9 — Platform Features

- [ ] Prompt templates and versioning
- [ ] Outage, quota, and failure-rate alerts
- [ ] Team workspaces, roles, and shared routers
- [ ] Audit logs
- [ ] Public status page
- [ ] Packaged self-hosted edition

---

## Potential Future Updates

The Responses API, Codex/Claude compatibility, intelligent routing, model aliases, persistent cooldowns, and circuit breakers are implemented. The next roadmap items focus on automatic recovery monitoring, application keys, privacy, and evaluation tooling.

### 1. Test All Providers

Add a button that checks every configured provider and reports status/latency.

```txt
Groq        Healthy      420 ms
Mistral     Healthy      817 ms
OpenRouter  Rate limited 429
```

### 2. Dynamic Capability Discovery

Periodically refresh model capabilities from provider model catalogs and allow users to verify or override registry entries from the dashboard.

### 3. Advanced Alias Templates

Allow user-defined routers:

```txt
fast-router       -> Groq first, then Cerebras
coding-router     -> Qwen/Coder providers
cheap-router      -> free providers only
quality-router    -> Mistral/OpenRouter first
```

### 4. Multiple Router Keys

Support named keys:

- Local dev.
- Production.
- Demo.
- Last used timestamp.
- Revoke/regenerate.

### 5. Usage Limits

Add per-key limits:

- Requests per day.
- Tokens per day.
- Allowed origins.
- Allowed IPs.
- Allowed models.

### 6. Cost and Token Tracking

Track:

- Input tokens.
- Output tokens.
- Estimated cost.
- Cost by provider.
- Cost by date range.

### 7. Request Replay

From request drawer:

- Replay request.
- Copy as cURL.
- Copy as Python.
- Copy as JavaScript.

### 8. Streaming Playground

Add a stream toggle and render tokens progressively.

### 9. Multiple Projects

Support more than one router per user:

```txt
Development Router
Production Router
Client Demo Router
```

### 10. Validate Provider Key Before Save

When user adds a key:

1. Run a lightweight test request.
2. Save only if valid.
3. Show helpful failure message.

### 11. Export Logs

Add:

- Export JSON.
- Export CSV.
- Download last 100 requests.

### 12. Observability Integrations

Deferred for the current product scope. A future release may optionally support:

- OpenTelemetry.
- Datadog.
- Grafana Loki.
- CloudWatch.

### 13. Provider Adapters

Expand the existing Anthropic-to-OpenAI adapter and add more provider protocol adapters:

- Gemini.
- Cohere.
- Anthropic.
- Cloudflare Workers AI.
- Ollama.

---

## Credits

This project is an adaptation of [`harivilasp/freellm`](https://github.com/harivilasp/freellm), a self-hosted OpenAI-compatible router for free-tier LLM APIs.

Original upstream concepts include:

- Self-hosted router.
- Bring-your-own provider keys.
- Clerk-backed dashboard auth.
- OpenAI-compatible `/v1` endpoint.
- Provider failover.
- Local JSON or Redis/KV-style storage.

This adaptation adds dashboard/product UX work, analytics, provider logos, request inspection, rate-limit awareness, updated settings/account details, integration snippets, and brand assets.

---

## License

Preserve the upstream license terms from the original project. Check the included `LICENSE` file before publishing or distributing this adaptation.
