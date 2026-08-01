# Connect Local LLM — Ollama Node v1 Roadmap

**Project:** Free LLM Router  
**Feature:** Connect Local LLM  
**Initial runtime:** Ollama only  
**Access model:** A local node is private and usable only by the Free LLM Router account that paired it  
**Status:** Implementation plan  
**Target release:** Future minor release; version to be assigned before merge

---

## 1. Product goal

Allow a Free LLM Router user to connect Ollama running on their own computer and use its installed models through the same Free LLM Router API.

The local model should behave like another provider in the router:

```text
User application
      |
      v
Free LLM Router
      |
      +--> User's Ollama node
      |
      +--> Cloud providers as fallback
```

The first version is **not** a public compute marketplace. A node belongs to one account and cannot be shared with other users.

---

## 2. User experience

### Dashboard flow

1. User opens **Providers → Connect Local LLM**.
2. User chooses **Ollama**.
3. Dashboard creates a short-lived pairing code.
4. Dashboard shows the CLI command:

```bash
npx @free-llm-router/cli connect ollama --code FLR-XXXX-XXXX
```

5. The CLI:
   - Detects Ollama on `http://127.0.0.1:11434`.
   - Confirms the user's pairing code.
   - Discovers installed Ollama models.
   - Lets the user select allowed models.
   - Starts a protected local node agent.
   - Starts or connects an ngrok tunnel.
   - Registers the tunnel with Free LLM Router.
6. The dashboard shows the node as **Online**.
7. The user can:
   - Enable or disable individual models.
   - Test one model.
   - Test all local models.
   - Prefer local models before cloud providers.
   - Use local models only.
   - Remove or revoke the node.

### Expected CLI output

```text
Free LLM Router — Connect Local LLM

✓ Ollama detected at http://127.0.0.1:11434
✓ Pairing code accepted
✓ Node registered as "Soham-PC"
✓ 3 installed models found

Select models:
[x] qwen3:8b
[x] llama3.2:3b
[ ] nomic-embed-text

Maximum concurrent requests: 1
Maximum output tokens: 2048

✓ Secure tunnel started
✓ Node is online
```

---

## 3. V1 scope

### Included

- Ollama only.
- One Free LLM Router account owns each local node.
- CLI-assisted setup.
- Protected node agent in front of Ollama.
- ngrok tunnel managed by the CLI.
- Installed-model discovery.
- User-selected model allowlist.
- Node heartbeat and online/offline status.
- Direct provider-model testing.
- Router integration.
- Local-first, normal-order, and local-only routing modes.
- Streaming chat completions.
- Cloud fallback when the local node fails before the first token.
- Node revocation.
- Basic concurrency and output limits.
- Request authentication and replay protection.

### Not included in v1

- Public or community-shared models.
- Sharing a node with another account.
- Payments or host compensation.
- Automatic model installation, deletion, or pulling.
- Remote Ollama administration.
- Arbitrary user-provided inference URLs.
- Multiple local runtimes such as LM Studio, llama.cpp, or vLLM.
- Embeddings.
- Fine-tuning.
- Distributed execution of one model across multiple computers.
- Fallback after response tokens have already been sent.
- Full peer-to-peer networking.
- Native relay infrastructure replacing ngrok.

---

## 4. Security rules

These are mandatory for v1.

### 4.1 Never expose raw Ollama

Do not create this architecture:

```text
Internet -> ngrok -> localhost:11434
```

Use:

```text
Free LLM Router
      |
      v
ngrok HTTPS tunnel
      |
      v
Free LLM Router Node Agent on 127.0.0.1:11500
      |
      v
Ollama on 127.0.0.1:11434
```

The node agent exposes only approved inference and health operations. It must block Ollama administration operations such as pulling, creating, copying, pushing, or deleting models.

### 4.2 Account ownership

Every node record must contain an immutable `ownerAccountId`.

A request can use the node only when:

```text
router account ID == node owner account ID
```

The inference request must never accept an arbitrary node URL.

### 4.3 Pairing codes

Pairing codes must be:

- Random.
- One-time use.
- Bound to the signed-in account.
- Valid for no more than 10 minutes.
- Stored as a hash.
- Invalidated immediately after successful pairing.

### 4.4 Device credentials

After pairing, the CLI receives:

- `nodeId`
- Long-lived device credential
- Router verification public key or trusted key identifier

The device credential must be stored using the operating-system credential store when possible. A fallback file must have restrictive filesystem permissions.

The device credential is used for node-to-router operations such as:

- Heartbeats.
- Tunnel registration.
- Model inventory updates.
- Node status updates.

### 4.5 Router-to-node authorization

Every inference request sent to the node must include a short-lived signed token.

Suggested claims:

```json
{
  "iss": "free-llm-router",
  "aud": "node_123",
  "sub": "account_123",
  "requestId": "req_123",
  "model": "qwen3:8b",
  "iat": 1760000000,
  "exp": 1760000060
}
```

The node agent verifies:

- Signature.
- Issuer.
- Intended node ID.
- Owner account.
- Expiration.
- Requested model.
- Model allowlist.
- Request ID has not already been used.

Keep accepted request IDs temporarily to prevent replay.

### 4.6 Tunnel restrictions

For v1:

- Require HTTPS.
- Allow only registered ngrok HTTPS endpoints.
- Reject redirects to a different host.
- Never use an endpoint supplied inside an inference request.
- Register endpoint changes only through an authenticated node operation.
- Validate that the node ID returned by `/health` matches the registered node.
- Apply request-size and rate limits before forwarding to Ollama.

### 4.7 Local limits

Node-owner limits always override request settings:

- Maximum concurrent requests.
- Maximum queue size.
- Maximum input size.
- Maximum output tokens.
- First-token timeout.
- Idle-stream timeout.
- Total generation timeout.
- Allowed models.
- Allowed capabilities.

Recommended defaults:

```text
Concurrency:               1
Queue size:                2
Maximum output tokens:     2048
Maximum request body:      2 MB
First-token timeout:       60 seconds
Idle-stream timeout:       60 seconds
Total generation timeout:  10 minutes
```

---

## 5. Proposed components

### 5.1 Dashboard

Add a **Connect Local LLM** area under Providers.

Responsibilities:

- Create pairing codes.
- Display setup instructions.
- List nodes.
- Display online/offline state.
- Display discovered models.
- Enable and disable models.
- Configure routing preference.
- Test one model.
- Test all models.
- Revoke a node.
- Display last heartbeat, latency, errors, and CLI version.

### 5.2 Node management backend

Responsibilities:

- Pairing-code lifecycle.
- Node ownership.
- Device authentication.
- Heartbeat processing.
- Tunnel registration.
- Model inventory.
- Node/model configuration.
- Node revocation.
- Request-token signing.
- Health and availability state.

### 5.3 CLI and node agent

Suggested package name:

```text
@free-llm-router/cli
```

Responsibilities:

- Detect Ollama.
- Pair with the user's account.
- Discover installed models.
- Run the protected local HTTP agent.
- Start/manage ngrok.
- Register the current tunnel.
- Send heartbeats.
- Enforce local limits.
- Verify signed inference requests.
- Forward allowed requests to Ollama.
- Stream responses back.
- Cancel Ollama when the upstream request is cancelled.
- Reconnect after network changes.
- Display status and logs.

### 5.4 Routing adapter

Introduce a local provider type:

```ts
type ProviderType =
  | ExistingProviderType
  | "local-ollama";
```

A local candidate is identified by:

```text
nodeId + modelId
```

Do not store circuit, latency, or model health only at the generic provider level.

---

## 6. Suggested repository structure

Adapt this to the existing repository layout.

```text
free-llm-router/
├── src/
│   ├── local-nodes/
│   │   ├── local-node-types.ts
│   │   ├── local-node-store.ts
│   │   ├── local-node-auth.ts
│   │   ├── local-node-service.ts
│   │   ├── pairing-service.ts
│   │   ├── heartbeat-service.ts
│   │   └── local-ollama-provider.ts
│   └── ...
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── packages/
│   └── cli/
│       ├── src/
│       │   ├── commands/
│       │   │   ├── connect.ts
│       │   │   ├── start.ts
│       │   │   ├── status.ts
│       │   │   ├── models.ts
│       │   │   └── disconnect.ts
│       │   ├── agent/
│       │   │   ├── server.ts
│       │   │   ├── auth.ts
│       │   │   ├── ollama-client.ts
│       │   │   ├── tunnel.ts
│       │   │   ├── heartbeat.ts
│       │   │   └── limits.ts
│       │   └── index.ts
│       └── package.json
├── docs/
│   └── CONNECT_LOCAL_LLM_V1.md
└── ...
```

If the repository is not currently a workspace/monorepo, the CLI can initially live under `cli/` and move into `packages/cli/` later.

---

## 7. Data model

### 7.1 Pairing code

```ts
interface LocalNodePairingCode {
  id: string;
  codeHash: string;
  ownerAccountId: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}
```

### 7.2 Local node

```ts
interface LocalNode {
  id: string;
  ownerAccountId: string;
  name: string;
  runtime: "ollama";
  status: "online" | "unstable" | "offline" | "revoked";
  endpoint?: string;
  endpointUpdatedAt?: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  revokedAt?: string;
  cliVersion?: string;

  limits: {
    maxConcurrentRequests: number;
    maxQueueSize: number;
    maxInputBytes: number;
    maxOutputTokens: number;
    firstTokenTimeoutMs: number;
    idleTimeoutMs: number;
    totalTimeoutMs: number;
  };

  routingMode: "normal" | "prefer-local" | "local-only";
}
```

### 7.3 Local node model

```ts
interface LocalNodeModel {
  nodeId: string;
  modelId: string;
  displayName?: string;
  enabled: boolean;
  installed: boolean;
  loaded?: boolean;

  capabilities: {
    streaming: "supported" | "unsupported" | "unknown";
    tools: "supported" | "unsupported" | "unknown";
    vision: "supported" | "unsupported" | "unknown";
    reasoning: "supported" | "unsupported" | "unknown";
    structuredOutputs: "supported" | "unsupported" | "unknown";
  };

  contextWindow?: number;
  maxOutputTokens?: number;
  lastTestedAt?: string;
  lastLatencyMs?: number;
  health: "unknown" | "healthy" | "unavailable" | "error";
  lastError?: string;
}
```

### 7.4 Device credential

Store only a secure hash or encrypted credential representation server-side.

```ts
interface LocalNodeCredential {
  nodeId: string;
  credentialHash: string;
  createdAt: string;
  rotatedAt?: string;
  revokedAt?: string;
}
```

---

## 8. Backend API proposal

Names can be adjusted to match existing conventions.

### Dashboard-authenticated APIs

```text
POST   /api/local-nodes/pairing-code
GET    /api/local-nodes
GET    /api/local-nodes/:nodeId
PATCH  /api/local-nodes/:nodeId
DELETE /api/local-nodes/:nodeId

PATCH  /api/local-nodes/:nodeId/models/:modelId
POST   /api/local-nodes/:nodeId/test
POST   /api/local-nodes/:nodeId/models/:modelId/test
POST   /api/local-nodes/:nodeId/test-all
```

### CLI/device APIs

```text
POST /api/local-nodes/pair
POST /api/local-nodes/:nodeId/heartbeat
POST /api/local-nodes/:nodeId/endpoint
POST /api/local-nodes/:nodeId/models/sync
POST /api/local-nodes/:nodeId/rotate-credential
```

### Node-agent endpoints exposed through ngrok

```text
GET  /health
GET  /models
POST /v1/chat/completions
```

Only the router should be able to invoke the inference endpoint successfully.

### Health response

```json
{
  "nodeId": "node_123",
  "runtime": "ollama",
  "status": "online",
  "agentVersion": "0.1.0",
  "activeRequests": 0,
  "maxConcurrentRequests": 1
}
```

---

## 9. CLI commands

### Connect

```bash
free-llm-router connect ollama
free-llm-router connect ollama --code FLR-XXXX-XXXX
```

Actions:

1. Check Ollama availability.
2. Validate pairing code.
3. Register device.
4. Discover models.
5. Ask user which models to enable.
6. Configure limits.
7. Start agent.
8. Start tunnel.
9. Register tunnel.
10. Start heartbeats.

### Start

```bash
free-llm-router start
```

Starts the agent and reconnects the registered node.

### Status

```bash
free-llm-router status
```

Displays:

- Pairing/account status.
- Ollama status.
- Tunnel status.
- Registered endpoint.
- Last heartbeat.
- Enabled models.
- Active requests.
- CLI version.

### Models

```bash
free-llm-router models
free-llm-router models sync
```

Lists or synchronizes installed Ollama models.

### Logs

```bash
free-llm-router logs
```

Shows local agent events without printing full prompts or secrets by default.

### Disconnect

```bash
free-llm-router disconnect
```

Stops the local connection. It should not delete local Ollama models.

### Revoke

```bash
free-llm-router revoke
```

Revokes the node credential and removes the node from router eligibility.

---

## 10. Heartbeat and availability behavior

The CLI sends a heartbeat approximately every 20 seconds.

Heartbeat payload:

```json
{
  "nodeId": "node_123",
  "agentVersion": "0.1.0",
  "ollamaVersion": "x.y.z",
  "activeRequests": 0,
  "maxConcurrentRequests": 1,
  "models": [
    {
      "id": "qwen3:8b",
      "installed": true,
      "loaded": true
    }
  ]
}
```

Suggested state calculation:

```text
Heartbeat age <= 45 seconds   -> Online
Heartbeat age 46-90 seconds   -> Unstable
Heartbeat age > 90 seconds    -> Offline
```

Offline nodes must be skipped before an inference request is attempted.

The router should still use a circuit breaker for cases where a node is marked online but inference repeatedly fails.

---

## 11. Routing behavior

### Candidate filtering

A local model is eligible only when:

- Node belongs to the requesting account.
- Node is online.
- Node is not revoked.
- Model is installed.
- Model is enabled.
- Required capabilities match.
- Node has available concurrency.
- Circuit for `nodeId:modelId` is not open.
- The request is within configured local limits.

### Routing modes

#### Normal

Local models participate in the configured provider order.

```text
Gemini -> Local Ollama -> Mistral
```

#### Prefer local

Eligible local models are placed before cloud providers.

```text
Local Ollama -> Gemini -> Mistral
```

#### Local only

Only eligible local models are considered.

If no local model is available, return a clear local-node-unavailable error.

### Failure and fallback rules

Before first token:

```text
Connection failure
Node offline
Model unavailable
First-token timeout
Authentication failure
Valid retryable upstream error
        |
        v
Try the next eligible provider
```

After first token:

```text
Stream failure
        |
        v
End the stream with an error
Do not merge output from another provider
```

### State key

Use:

```text
local-node:{nodeId}:model:{modelId}
```

for:

- Circuit state.
- Latency.
- Success rate.
- Last error.
- Consecutive failures.
- Health observations.

Node credential failures should be tracked at node level.

---

## 12. Request flow

```text
1. Client sends request to Free LLM Router.
2. Router resolves alias and required capabilities.
3. Router loads cloud providers and private local-node models.
4. Router filters local nodes by ownership and heartbeat.
5. Router ranks eligible providers.
6. Router chooses a local Ollama candidate.
7. Router signs a short-lived node request token.
8. Router sends the request to the registered ngrok endpoint.
9. Node agent verifies signature, expiration, ownership, nonce, and model.
10. Node agent validates local limits.
11. Node agent forwards the request to Ollama.
12. Ollama streams tokens to the node agent.
13. Node agent streams tokens to Free LLM Router.
14. Router streams tokens to the original client.
15. Health, latency, and usage state are updated.
```

---

## 13. Implementation milestones

### Milestone 0 — Technical spike

**Goal:** Prove end-to-end inference before building the full UI.

Deliverables:

- Minimal local agent.
- Agent calls Ollama.
- Manual ngrok tunnel.
- Router sends one signed request.
- Streaming response reaches the router.

Exit criteria:

- A test prompt sent through Free LLM Router returns a response from local Ollama.
- Raw Ollama is not exposed.

### Milestone 1 — Node data model and pairing

Deliverables:

- Pairing-code storage.
- Pairing-code API.
- Node records.
- Credential generation and verification.
- Ownership checks.
- Node revocation.
- Unit tests.

Exit criteria:

- Signed-in user can generate a one-time code.
- CLI can exchange it for a node identity.
- Another account cannot access the node.
- Reusing or using an expired code fails.

### Milestone 2 — CLI foundation

Deliverables:

- CLI package.
- `connect ollama`.
- Ollama detection.
- Installed-model discovery.
- Secure local configuration storage.
- `status`, `models`, and `disconnect`.
- Clear setup and error messages.

Exit criteria:

- User can pair a computer in one guided command.
- CLI identifies when Ollama is not installed or not running.
- CLI lists installed models.

### Milestone 3 — Protected local agent and tunnel

Deliverables:

- Local agent on `127.0.0.1`.
- `/health`, `/models`, and `/v1/chat/completions`.
- Request-token verification.
- Replay protection.
- Model allowlist.
- Request and output limits.
- ngrok lifecycle management.
- Endpoint registration.
- Tunnel reconnection.

Exit criteria:

- Requests without valid router authorization are rejected.
- Ollama administration routes are not exposed.
- Endpoint changes are automatically registered.
- Only selected models can be used.

### Milestone 4 — Heartbeats and dashboard

Deliverables:

- Heartbeat API.
- Online, unstable, and offline states.
- Node cards in Providers.
- Model list.
- Enable/disable model controls.
- Node configuration.
- Remove/revoke controls.
- Test model and test all models.

Exit criteria:

- Dashboard reflects node status within the expected heartbeat window.
- Offline nodes are visibly marked.
- User can manage allowed models without editing CLI files.

### Milestone 5 — Routing integration

Deliverables:

- `local-ollama` provider adapter.
- Ownership filtering.
- Online/offline filtering.
- Capability matching.
- `normal`, `prefer-local`, and `local-only` modes.
- Local model included in request timeline.
- Cloud fallback before first token.
- Per-node-model circuit state.

Exit criteria:

- Prefer-local routes to Ollama first.
- Cloud fallback occurs when Ollama is unavailable before first output.
- Another user's node is never selected.
- Local-only mode never silently calls a cloud provider.

### Milestone 6 — Streaming and cancellation

Deliverables:

- Streaming passthrough.
- First-token timeout.
- Idle timeout.
- Total timeout.
- Client-disconnect cancellation.
- Node-to-Ollama cancellation.
- Correct success/failure recording.

Exit criteria:

- Tokens stream incrementally.
- A disconnected client cancels the local generation.
- A pre-token failure can fall back.
- A post-token failure does not switch providers.

### Milestone 7 — Reliability and release hardening

Deliverables:

- Concurrency and queue enforcement.
- CLI reconnect behavior.
- Credential rotation.
- Structured logs with secret redaction.
- Integration tests.
- Security review.
- Documentation.
- Troubleshooting guide.
- Release checklist.

Exit criteria:

- Restarting the CLI reconnects without new pairing.
- Revoked credentials stop working immediately.
- Concurrent requests cannot exceed configured limits.
- Logs do not expose credentials or full prompts by default.
- Core end-to-end scenarios pass in CI.

---

## 14. Required test plan

### Pairing and ownership

- Pairing code expires.
- Pairing code is one-time use.
- Pairing code belongs to one account.
- Node belongs to one account.
- Cross-account node access fails.
- Revoked node cannot heartbeat or process requests.

### Authentication

- Missing token fails.
- Invalid signature fails.
- Expired token fails.
- Wrong node audience fails.
- Wrong owner account fails.
- Replayed request ID fails.
- Request for disabled model fails.

### Ollama and agent

- Ollama offline.
- Ollama restarts.
- Model exists.
- Model removed after registration.
- Model disabled.
- Request exceeds body limit.
- Request exceeds output limit.
- Concurrency full.
- Queue full.
- Agent version mismatch warning.

### Tunnel

- Tunnel starts.
- Tunnel URL changes.
- Tunnel disconnects.
- Invalid endpoint rejected.
- Redirect to another host rejected.
- Registered endpoint does not belong to expected node.

### Routing

- Prefer-local success.
- Prefer-local local failure and cloud fallback.
- Normal configured order.
- Local-only success.
- Local-only node offline.
- Capability mismatch.
- Circuit opens for repeated local failures.
- Healthy model on same node is not poisoned by another model.
- Another account's local models are never candidates.

### Streaming

- Successful stream.
- No first token.
- Idle stream.
- Failure before first token.
- Failure after first token.
- Client disconnect.
- Upstream cancellation reaches Ollama.

### Security

- Raw `/api/pull` blocked.
- Raw `/api/delete` blocked.
- Raw `/api/create` blocked.
- Arbitrary URL cannot be supplied in an inference request.
- Secrets are redacted from logs.
- Full prompts are not logged by default.

---

## 15. Definition of done

The first version is complete when all of the following are true:

- A user can connect Ollama using one guided CLI command.
- The connection is private to that user's account.
- Raw Ollama is never exposed publicly.
- Installed models appear in the dashboard.
- User can enable, disable, test, and remove models.
- User can choose normal, prefer-local, or local-only routing.
- Chat completions work in streaming and non-streaming mode.
- Local failures before the first token can fall back to cloud providers.
- Local failures after the first token terminate cleanly without mixed output.
- Node status is based on authenticated heartbeats.
- Requests use short-lived signed authorization and replay protection.
- Local concurrency, queue, request-size, and output limits are enforced.
- Circuit and health state are tracked per node-model.
- Cross-account access tests pass.
- Node revocation works immediately.
- Security and integration test suites pass.
- User-facing setup and troubleshooting documentation is published.

---

## 16. Release documentation

Create these documents before release:

```text
docs/CONNECT_LOCAL_LLM.md
docs/LOCAL_NODE_SECURITY.md
docs/LOCAL_NODE_TROUBLESHOOTING.md
packages/cli/README.md
```

Documentation must explain:

- What data leaves the user's computer.
- That prompts are processed by the user's own Ollama instance.
- That ngrok carries encrypted network traffic but the local node sees plaintext prompts.
- How to stop and revoke the node.
- How to rotate credentials.
- How to change model and token limits.
- How cloud fallback works.
- How to disable cloud fallback using local-only mode.

---

## 17. Future versions

### V2 — Native relay

Replace ngrok with an outbound agent connection:

```text
Node agent -> persistent outbound WebSocket/HTTP2 relay -> Router
```

Benefits:

- No public node endpoint.
- No ngrok account.
- Stable identity.
- Better reconnection.
- Easier cancellation and streaming.
- Lower SSRF exposure.

### V3 — Additional local runtimes

Possible adapters:

- LM Studio.
- llama.cpp server.
- vLLM.
- LocalAI.
- Text Generation Inference.

### V4 — Trusted organization nodes

Allow an organization administrator to share a node with selected organization members. This remains separate from a public marketplace.

---

## 18. Key implementation principle

The local node should look like a normal provider to the routing engine, but it must have stricter ownership and security checks:

```text
Normal provider behavior
+ account ownership
+ heartbeat availability
+ signed requests
+ local limits
+ node-model health
```

The MVP promise is:

> Connect Ollama running on your own computer and use your private local models through the same Free LLM Router API, with optional cloud fallback when your machine is unavailable.
