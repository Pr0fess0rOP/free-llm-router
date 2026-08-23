# Free LLM Router v0.7.0

Free LLM Router can now securely connect private Ollama models alongside hosted cloud providers.

This release introduces the complete Local LLM workflow: device pairing, private model discovery, authenticated routing, lifecycle management, an npm-distributed CLI, Local LLM routing policies, and direct Playground testing.

## Highlights

### Private Ollama node integration

Connect Ollama running on a computer you control and make its models available through the same Free LLM Router API used by cloud providers.

The Local LLM integration includes:

* Short-lived, single-use pairing codes
* Automatic Ollama detection and version checks
* Installed-model discovery and selection
* Protected loopback agent on the Ollama computer
* Authenticated ngrok tunnel registration
* Regular node heartbeats
* Online, unstable, offline, error, and revoked states
* Account-isolated node ownership
* Redis-backed production persistence
* Node renaming, revocation, and permanent deletion
* Model synchronization and per-model controls

Raw Ollama is never exposed directly to the internet.

### Local LLM routing policies

Local models can now participate in normal router requests using configurable routing behavior.

Available modes include:

* **Normal order:** local and cloud models participate according to routing policy
* **Prefer local:** eligible local models are attempted before cloud providers
* **Local only:** cloud providers are excluded
* **Routing gate:** temporarily exclude an individual node from normal routing without disconnecting it

Local routing respects:

* Model capability requirements
* Installed and enabled model state
* Node health and heartbeat status
* Concurrent-request limits
* Queue limits
* Input-size limits
* Maximum output tokens
* Request timeouts
* Account ownership
* Model allowlists

Cloud fallback can occur only before a local stream emits its first token. Responses from different models are never mixed within one stream.

### Public Local LLM CLI

The Local LLM connector is now published separately on npm:

```bash
npx --yes @free-llm-router/cli@latest connect ollama \
  --code FLR-XXXX-XXXX \
  --router-url https://your-router.example
```

The package provides the `free-llm` executable when installed globally:

```bash
npm install --global @free-llm-router/cli@latest
```

Available commands include:

```text
free-llm connect ollama
free-llm start
free-llm status
free-llm models
free-llm models sync
free-llm logs
free-llm disconnect
free-llm revoke
free-llm credential rotate
free-llm help
```

Pairing is reusable. `disconnect` stops the node while preserving its stored credential, while `start` reconnects it later without requiring another pairing code.

`revoke` invalidates the device credential and removes the local pairing. Neither command installs, changes, or deletes Ollama models.

### Protected device credentials

Local device credentials are stored under the current user rather than inside the project checkout.

The CLI supports:

* Windows DPAPI
* macOS Keychain
* Linux Secret Service
* Restrictive file-storage fallback
* Safe migration from older checkout-local configuration
* Device credential rotation
* Redacted diagnostic logs

Configuration is stored under the current user's `~/.freellm/` directory.

### Local LLM Properties

Local-node configuration now has a dedicated workspace under:

**Settings → Router & Policies → Local LLM Properties**

Each node can be configured independently, including:

* Routing gate
* Routing participation mode
* Node name
* Concurrent-request limit
* Queue limit
* Maximum input size
* Maximum output tokens
* Request timeout
* Enabled models
* Model capabilities
* Model health tests
* Credential rotation
* Revocation
* Permanent deletion

Providers remains the connection and status workspace, while wider routing controls live under Settings.

### Updated Providers interface

Cloud providers and Local LLMs now use matching workspace tabs and card flows.

The Providers page includes:

* **Cloud providers**
* **Local LLMs**

Local nodes use the same summary-first visual language as cloud provider cards while retaining clear uppercase letter icons for private nodes and models.

### Expanded Playground

The Playground now provides three testing modes:

* **Router request:** test the complete routing and fallback policy
* **Provider + model:** call one exact hosted provider model
* **Local LLM:** call one exact enabled Ollama model

Local LLM tests support:

* OpenAI Chat Completions compatibility
* OpenAI Responses/Codex compatibility
* Anthropic Messages compatibility
* Basic text prompts
* JSON and structured-output scenarios
* Tool-use scenarios
* Reasoning scenarios
* Temperature controls
* Maximum output-token controls
* Exact node and model selection
* Latency and capability reporting

### Production routing fixes

This release includes fixes discovered during real hosted deployment testing:

* Fixed Local LLM dashboard listing on Vercel
* Fixed trailing-slash handling for `/api/local-nodes`
* Added the missing Vercel rewrite for `/api/playground/direct`
* Added the missing Vercel rewrite for `/api/playground/local`
* Improved frontend handling of non-JSON server and platform errors
* Preserved useful error messages instead of showing JSON parsing failures

### Documentation

Documentation now covers the complete Local LLM lifecycle:

* Connecting Ollama
* Installing and using the npm CLI
* Local routing modes
* Node and model configuration
* Playground testing
* Network and credential security
* Production signing-key configuration
* Redis-backed persistence
* Troubleshooting
* Revocation and deletion
* Release verification

Integration snippets and the project feature overview have also been updated.

## Security

Local-node requests use signed, short-lived authorization and account-bound device credentials.

The Local LLM security model includes:

* Ed25519 request signing
* Request expiration and replay protection
* Account and node identity binding
* Model allowlist enforcement
* Loopback-only local agent
* Protected device credential storage
* HTTPS tunnel validation
* Concurrency and request-size limits
* Credential rotation and revocation
* Redacted CLI diagnostics

For production deployments using hosted Redis, configure:

```text
LOCAL_NODE_SIGNING_PRIVATE_KEY
LOCAL_NODE_SIGNING_PUBLIC_KEY
```

Include the complete PEM contents, including the `BEGIN` and `END` lines. Newlines may be stored as escaped `\n` characters in hosting environment variables.

Never commit signing keys, Redis credentials, Clerk secrets, router keys, device credentials, provider API keys, prompts, or generated responses.

See `docs/LOCAL_NODE_SECURITY.md` for the complete security model.

## Requirements

### Router deployment

* Node.js 20 or newer
* Clerk authentication
* `ACCOUNT_ENCRYPTION_KEY`
* Hosted Redis for persistent production storage
* Local-node Ed25519 signing keys when enabling hosted Local LLM nodes

### Ollama computer

* Node.js 20 or newer
* Ollama running on `127.0.0.1:11434`
* At least one installed Ollama model
* ngrok installed and authenticated
* Network access to the deployed router

## Upgrade notes

No intentional breaking changes have been introduced to the existing OpenAI-compatible, Responses/Codex, or Anthropic-compatible APIs.

Before upgrading:

1. Back up local or Redis-backed router data.
2. Install the latest dependencies.
3. Add the Local LLM signing environment variables when using hosted Redis.
4. Confirm the complete PEM headers and footers are included.
5. Redeploy the router.
6. Hard-refresh the dashboard.
7. Test Router request, Provider + model, and Local LLM Playground modes.
8. Verify that connected Ollama nodes appear under Providers → Local LLMs.

```bash
npm install
npm run typecheck
npm test
npm run build
```

Existing cloud-provider configurations remain supported.

## Thank you

Thank you to everyone testing, reviewing, documenting, and contributing to Free LLM Router.

Bug reports, provider requests, Local LLM runtime requests, documentation improvements, and focused pull requests are welcome.
