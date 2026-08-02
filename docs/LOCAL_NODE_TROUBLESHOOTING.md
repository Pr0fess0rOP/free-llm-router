# Local-node troubleshooting

## Ollama is not detected

Run `ollama serve`, verify `curl http://127.0.0.1:11434/api/version`, then retry. For a non-default loopback port use `--ollama-url http://127.0.0.1:PORT` or `OLLAMA_BASE_URL`. Remote Ollama URLs are intentionally rejected; the protected agent must remain on the Ollama computer.

## No models are found

Run `ollama list`. Install a model yourself with Ollama, then run `free-llm models sync`. The router never pulls or deletes models.

## Pairing code is invalid or expired

Generate a new code under **Providers → Local LLMs**. Codes expire after ten minutes and cannot be reused, including after a successful exchange.

## ngrok does not start

Install ngrok, run `ngrok config add-authtoken YOUR_TOKEN`, and ensure `ngrok version` works. If the executable is elsewhere, pass `--ngrok-path /absolute/path/to/ngrok` during pairing or set `NGROK_PATH` before `free-llm start`.

## Node stays offline

Run `free-llm status` and `free-llm logs`. Confirm the CLI remains running, the router URL is reachable, and the registered tunnel reaches `GET /health`. A node becomes unstable after 45 seconds without a heartbeat and offline after 90 seconds.

## Requests fall back to cloud

Check that the node is online, the model is installed and enabled, capability settings match the request, local concurrency is available, and the per-model circuit is closed. Prefer-local may still exclude an incompatible model. Choose local-only to prohibit cloud fallback.

## A stream ends without cloud fallback

This is intentional after the first output token. Switching providers mid-stream would combine output from different models. Failures before the first token remain eligible for fallback.

## Stop, reconnect, or revoke

`free-llm disconnect` stops the current agent without revoking it. `free-llm start` reconnects with the stored credential. `free-llm revoke` invalidates the credential and removes local configuration. The owner can also revoke or permanently delete the node under **Settings → Router & Policies → Local LLM Properties**.

If the node was permanently deleted from the dashboard first, `free-llm revoke` recognizes the already-invalid credential and still removes the stale local pairing configuration.

## Rotate the credential

Run `free-llm credential rotate`. The old credential stops working immediately; the replacement is written to the OS-protected or restrictive fallback store.
