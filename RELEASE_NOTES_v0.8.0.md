# Free LLM Router v0.8.0

Free LLM Router now connects private **LM Studio** models alongside **Ollama** and hosted cloud providers. You can pair both local runtimes from the same computer, manage each connection independently, and test either one from the Playground.

This release also adds live provider model browsing, detects capabilities when you save a model, and gives you more control over the routing stages that run for your account.

## Highlights

### Private LM Studio integration

Open **Providers → Local LLMs**, choose **LM Studio**, and generate a one-time pairing code. The CLI discovers downloaded chat models and lets you choose which ones the router may use.

- See which models are loaded or available to serve. If a downloaded model is unavailable, load it in LM Studio or enable on-demand loading.
- Use LM Studio’s reported vision, tool-use, and reasoning metadata when it establishes support.
- Test an exact LM Studio node and model in **Playground → Local LLM**.
- Include enabled models in normal router requests through the existing local routing policies.
- Use `LMSTUDIO_API_TOKEN` in the agent terminal if the local LM Studio server requires authentication.

Start LM Studio’s local API server before pairing. Its default address is `http://127.0.0.1:1234`. If you changed the port, pass the server origin with `--lmstudio-url`. For example, use `--lmstudio-url http://127.0.0.1:1235` for a server on port 1235.

### Ollama and LM Studio on one computer

Generate a separate pairing code for each runtime in the same router account. The CLI saves each pairing separately and assigns different protected agent ports. Existing pairings are recognized with their saved ports and credentials.

Run `free-llm status` to see both connections. Use `--runtime ollama` or `--runtime lmstudio` when a command needs to act on one connection.

```bash
free-llm status
free-llm start --runtime ollama
free-llm models sync --runtime lmstudio
```

Each agent needs a distinct HTTPS endpoint to be online at the same time. Point each ngrok tunnel at its agent port, which you can find in `free-llm status`. Revoking a runtime with `free-llm revoke --runtime lmstudio` or `free-llm revoke --runtime ollama` removes that pairing and its router access while preserving the installed models. [Connecting local runtimes](https://github.com/Pr0fess0rOP/free-llm-router/blob/v0.8.0/docs/CONNECT_LOCAL_LLM.md)

### Browse a provider’s current models

Open a cloud provider’s model manager and select **Browse provider models**. The panel fetches the provider’s model catalog and shows model IDs, display names, and context lengths when supplied. Search the list and select **Use ID** to fill in the model ID, then save it. You can also enter a model ID manually.

### Capability detection for saved models

Cloud provider capabilities start as **Unknown**. When you save a new cloud model, the router sends small probes to that model on the chosen provider. Saving the first provider key also checks its initial model.

- Successful probes can establish support for streaming, tools, JSON mode, structured output, vision, reasoning, and embeddings.
- Capability-specific rejections can establish that a model does not support a feature. Timeouts, rate limits, and ambiguous results stay **Unknown**.
- Use **Router & Policies → Capability Registry → Detect capabilities** to recheck an existing model. Existing model-level evidence and manual overrides are retained.
- Ollama capabilities are inspected using its local model-details endpoint. LM Studio contributes capability information from its own model catalog.

### Routing controls and dashboard cleanup

- **Router & Policies → Flow Features** exposes switches for alias policy overrides, capability matching and learning, quota protection, cooldowns, circuit breaking, automatic failover, and local routing. The page shows mandatory request stages separately.
- The router can move to another eligible provider after a provider rejects a request, subject to the configured failover policy and request limits. The attempt timeline records the reason.
- Direct and Local LLM Playground targets accommodate long provider, node, and model names. Provider cards put connection status in the header and remove redundant status and summary fields.

## Install or upgrade the CLI

For regular use, install the `free-llm` command globally:

```bash
npm install --global @free-llm-router/cli@0.8.0
free-llm --version
free-llm --help
```

To run the CLI on demand, copy the pairing command from the dashboard. An LM Studio command looks like this:

```bash
npx --yes @free-llm-router/cli@0.8.0 connect lmstudio --code FLR-XXXX-XXXX --router-url https://your-router.example
```

Replace the example code and URL with the values from your dashboard. Keep the agent terminal open while you want the model available to the router. The updated CLI README covers both install methods, model sync, status, logs, disconnect, revocation, credential rotation, and troubleshooting. [CLI README](https://github.com/Pr0fess0rOP/free-llm-router/blob/v0.8.0/packages/cli/README.md)

## Security

LM Studio uses the same protected local-node request path as Ollama. The HTTPS tunnel forwards to the loopback agent, which verifies short-lived signed requests and enforces the node’s model allowlist and request limits. Keep the local model server bound to loopback.

Set `LMSTUDIO_API_TOKEN` in each terminal that connects or starts an authenticated LM Studio agent. The CLI uses the token for local model discovery and inference and keeps it out of the saved pairing file. Hosted deployments using Redis for local-node state need the configured Ed25519 signing key pair. [Local-node security](https://github.com/Pr0fess0rOP/free-llm-router/blob/v0.8.0/docs/LOCAL_NODE_SECURITY.md)

## Requirements

- **Router** — Free LLM Router v0.8.0 for LM Studio pairing.
- **Local computer** — Node.js 20 or newer, an authenticated ngrok installation, and access to the router.
- **LM Studio** — Version 0.4 or newer, the local API server running, and at least one downloaded chat model.
- **Ollama** — Ollama running, typically on `127.0.0.1:11434`, with at least one installed chat model.

## Upgrade notes

1. Deploy the v0.8.0 router before upgrading the connector on your local computer.
2. Upgrade the npm CLI and check `free-llm --version`.
3. Restart an existing Ollama connection with `free-llm start --runtime ollama` using its saved pairing.
4. If you’re adding LM Studio, start its local API server and use a new LM Studio pairing code from the updated dashboard.
5. Send a test prompt under **Playground → Local LLM**. If the node should also serve normal API traffic, review its routing gate and routing policy under **Router & Policies → Local LLM Properties**.
6. If a routing policy requires a specific capability, review the model’s evidence in the Capability Registry. Cloud provider defaults now start as **Unknown**.

## Thank you

Thanks to everyone who tested provider setup, local pairing, and the dashboard. Please include the runtime, CLI version, and a redacted error message when reporting a local connection issue. [Report an issue](https://github.com/Pr0fess0rOP/free-llm-router/issues)
