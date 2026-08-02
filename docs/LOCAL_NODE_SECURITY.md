# Local-node security

## Network boundary

The supported topology is:

```text
Router → ngrok HTTPS → agent on 127.0.0.1:11500 → Ollama on 127.0.0.1:11434
```

Do not point ngrok directly at port `11434`. The agent intentionally exposes only `GET /health`, `GET /models`, and `POST /v1/chat/completions`. Ollama administration routes such as pull, push, create, copy, and delete are not proxied.

The router accepts only HTTPS ngrok hostnames for registered endpoints, rejects URL credentials/query strings/fragments/paths, validates `/health` node identity, and does not follow endpoint-registration redirects. HTTP loopback endpoints are available only when `LOCAL_NODE_ALLOW_HTTP_LOOPBACK=true`, for local development and automated tests.

## Ownership and credentials

- Pairing codes have 40 bits of random entropy, are hashed at rest, bound to one account, valid for ten minutes, and atomically consumed once.
- Online pairing attempts are rate-limited.
- Device credentials contain 256 random bits and are stored only as SHA-256 hashes by the router.
- On Windows, the CLI protects its device credential with user-scoped DPAPI. On macOS it uses Keychain. On Linux it uses Secret Service through `secret-tool` when available. Other environments use a mode-`0600` configuration-file fallback.
- Revocation invalidates the device credential immediately and removes the registered endpoint while retaining the dashboard record. Permanent deletion additionally removes the owner-scoped node and model records.

## Router authorization

Every inference attempt receives a short-lived Ed25519-signed token containing issuer, node audience, owning account, request ID, model, issue time, and expiry. Tokens live no longer than two minutes; the normal lifetime is 60 seconds. The agent checks every claim, matches the request model, and rejects reused request IDs until their token expires.

For hosted deployments set stable Ed25519 keys with:

```env
LOCAL_NODE_SIGNING_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
LOCAL_NODE_SIGNING_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n..."
```

Local installations generate a mode-`0600` key file under `.freellm/` by default. Back up or explicitly configure this key before moving a router deployment; connected agents trust its public key.

Hosted/serverless production deployments refuse to generate an ephemeral signing key. They require the stable environment keys above so a serverless instance change cannot invalidate every connected node. A local development server still generates and reuses the mode-`0600` key file when its data store happens to be remote.

## Local enforcement

The agent enforces its owner-controlled model allowlist, capability restrictions, input size, maximum output tokens, concurrency, queue length, first-token timeout, idle timeout, and total generation timeout. Dashboard settings are synchronized on every heartbeat. A client disconnect aborts the agent’s Ollama fetch.

Logs record timestamps, request IDs, model IDs, status, and timing. Full prompts, responses, authorization tokens, device credentials, and ngrok credentials are not logged.
