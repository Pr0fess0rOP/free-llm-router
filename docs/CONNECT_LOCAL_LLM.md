# Connect a private local node

Free LLM Router can use models installed in Ollama or LM Studio on your own computer. The node belongs to the router account that paired it.

## Requirements

- Ollama running on `http://127.0.0.1:11434` or LM Studio 0.4+ running on `http://127.0.0.1:1234`
- At least one installed chat model
- Node.js 20 or newer
- ngrok installed, authenticated with `ngrok config add-authtoken ...`, and available on `PATH`
- A signed-in Free LLM Router account

## Connect

1. Open **Dashboard → Providers → Local LLMs**.
2. Choose **Ollama** or **LM Studio**, select **Connect**, and copy the one-time command.
3. Run it on the computer hosting the model:

   ```bash
   npx --yes @free-llm-router/cli@latest connect ollama --code FLR-XXXX-XXXX --router-url https://your-router.example
   ```

   For LM Studio, start the server from its **Developer** tab and use `connect lmstudio`. If LM Studio requires authentication, set `LMSTUDIO_API_TOKEN` in the terminal before connecting or starting the agent. [LM Studio server setup](https://lmstudio.ai/docs/developer/core/server)

   ```bash
   npx --yes @free-llm-router/cli@latest connect lmstudio --code FLR-XXXX-XXXX --router-url https://your-router.example
   ```

4. Select the installed models that the router may use.
5. Leave the foreground process running, or restart it later with:

   ```bash
   npx --yes @free-llm-router/cli@latest start
   ```

When testing an unpublished checkout, run the source CLI from the repository
instead of asking npm to download a package:

```bash
npm run cli -- connect ollama --code FLR-XXXX-XXXX --router-url http://localhost:8787
```

The CLI stores each runtime's pairing under the current user's `~/.freellm/` directory, starts a protected loopback agent, registers its ngrok HTTPS tunnel, and sends an authenticated heartbeat every 20 seconds. Existing pairings keep their saved port. When both runtimes are paired, `free-llm status` shows both and commands such as `start` or `models sync` take `--runtime ollama` or `--runtime lmstudio`. Each online agent needs its own HTTPS endpoint pointing to its agent port. [Using both runtimes on one computer](../packages/cli/README.md#use-ollama-and-lm-studio-on-one-computer)

`npx` runs the package without installing a permanent `free-llm` command. You
can either keep using the full `npx --yes @free-llm-router/cli@latest ...`
form for every command, or install the command once:

```bash
npm install --global @free-llm-router/cli@latest
free-llm --version
```

The shorter commands below assume the global installation. Installing it does
not pair again or replace the credential already stored in `~/.freellm/`.

## Routing modes

Configure the node under **Router & Policies → Local LLM Properties**. The per-node routing gate can exclude the node from normal API routing without disconnecting it; direct Local LLM Playground tests remain available while the gate is closed.

- **Normal order:** local models participate with cloud providers.
- **Prefer local:** compatible, healthy local models are placed before cloud providers.
- **Local only:** cloud providers are excluded. If no local model is online and eligible, the request fails clearly.

Cloud fallback is possible only before output begins. Once a local stream sends its first token, a later failure ends that stream; output from a second model is never mixed into it.

## Test in the Playground

Open **Playground → Local LLM**, then select an online node and a ready, enabled model. For LM Studio, a downloaded model must be loaded or available on demand. This mode calls that exact local model through the protected node and bypasses cloud ranking and fallback. You can change:

- API compatibility: OpenAI, Responses/Codex, or Claude Messages
- Request type: basic text, JSON, structured output, tools, or reasoning
- Temperature and output token cap
- The prompt sent to the local runtime

The result shows the node, exact model, latency, required capabilities, and response. This is distinct from **Router request**, which exercises the complete routing policy, and **Provider + model**, which directly diagnoses a hosted provider model.

## Integration snippet

After pairing and choosing a routing mode, applications keep using the same router endpoint and private `flm_...` key:

```bash
curl https://your-router.example/v1/chat/completions \
  -H "Authorization: Bearer flm_your_router_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "free-router",
    "messages": [{"role":"user","content":"Reply from my local model"}],
    "max_tokens": 256
  }'
```

## Data leaving the computer

Requests selected for a local model travel through the ngrok HTTPS connection to the protected agent. The agent and local runtime process the prompt in plaintext. Heartbeats carry operational information such as model inventory, versions, runtime status, and active-request counts. LM Studio API tokens stay on the host computer.

## Management commands

```bash
free-llm status
free-llm models
free-llm models sync
free-llm logs
free-llm credential rotate
free-llm disconnect
free-llm revoke
```

`disconnect` stops the connection while preserving pairing. `revoke` invalidates the device credential and removes the local configuration. Neither command installs, deletes, or changes Ollama models.

The Local LLM dashboard tab offers two separate removal actions. **Revoke access** immediately invalidates the device credential but keeps the node record for inspection. **Delete node** permanently removes the node, its model settings, and its routing entry. A CLI whose node was deleted remotely can run `free-llm revoke` to remove its now-invalid local pairing; Ollama models remain untouched.

Each Local LLM uses the same summary-first visual flow as a cloud provider card. Uppercase letter icons identify local nodes and models. Providers is the connection and status surface; choose **Manage in Settings** to open **Local LLM Properties**, where you can gate routing, select normal/prefer-local/local-only participation, rename the node, change concurrency, queue, token and timeout limits, enable models, update capabilities, test, revoke, or permanently delete it. Heartbeats deliver the updated allowlist and limits to the running agent.

See [Local-node security](LOCAL_NODE_SECURITY.md), [troubleshooting](LOCAL_NODE_TROUBLESHOOTING.md), and the [release checklist](LOCAL_NODE_RELEASE_CHECKLIST.md).
