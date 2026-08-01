# Local Ollama node release checklist

## Build and automated verification

- [ ] `npm run typecheck` succeeds.
- [ ] `npm run build` succeeds from a clean checkout.
- [ ] `npm test` passes pairing, ownership, authentication, agent-limit, routing, streaming, cancellation, dashboard, and security tests.
- [ ] `npm pack --dry-run` includes the built CLI, agent, dashboard, provider catalog, README, and license.

## Hosted router configuration

- [ ] Upstash Redis is configured for accounts, node records, pairing codes, routing state, and analytics.
- [ ] `LOCAL_NODE_SIGNING_PRIVATE_KEY` and `LOCAL_NODE_SIGNING_PUBLIC_KEY` contain a stable Ed25519 key pair.
- [ ] Dashboard authentication and the public router URL are configured.
- [ ] `LOCAL_NODE_ALLOW_HTTP_LOOPBACK` is unset in production.
- [ ] Pairing rate limits and request body limits have been exercised against the deployed endpoint.

## CLI and tunnel smoke test

- [ ] The release version shown by the CLI matches the package version.
- [ ] Windows DPAPI, macOS Keychain, and Linux Secret Service storage have been smoke-tested; the restrictive file fallback has been verified.
- [ ] `connect ollama` detects Ollama, discovers models, pairs once, starts the loopback agent, starts ngrok, and registers the HTTPS endpoint.
- [ ] Restarting `free-llm-router start` reconnects without a new pairing code.
- [ ] An ngrok URL change is detected and re-registered.
- [ ] `disconnect`, credential rotation, and revoke behave as documented without changing Ollama models.

## End-to-end behavior

- [ ] Prefer-local succeeds against a real Ollama model.
- [ ] A failure before the first token falls back to a configured cloud provider.
- [ ] A failure after the first token terminates with a stream error and never mixes provider output.
- [ ] Local-only never calls a cloud provider.
- [ ] Another account cannot list, test, configure, authenticate as, or route to the node.
- [ ] Disabled, removed, offline, capability-incompatible, over-limit, and circuit-open models are skipped or rejected correctly.
- [ ] Client cancellation reaches Ollama.

## Security and documentation

- [ ] ngrok targets the loopback agent, never raw Ollama.
- [ ] `/api/pull`, `/api/create`, and `/api/delete` return `404` through the agent.
- [ ] Endpoint registration rejects non-ngrok hosts, HTTP, redirects, credentials, queries, fragments, paths, and the wrong node identity.
- [ ] Logs contain no device credential, signed token, full prompt, full response, or ngrok credential.
- [ ] Setup, security, troubleshooting, CLI, and rollback instructions are published.
