# Free LLM Router CLI

`@free-llm-router/cli` connects models running in Ollama or LM Studio on your computer to Free LLM Router. Install the `free-llm` command for regular use, or run the package on demand with `npx`.

- [Install or run the CLI](#1-install-or-run-the-cli)
- [Prepare your runtime and ngrok](#2-prepare-your-runtime-and-ngrok)
- [Pair your computer](#3-pair-your-computer)
- [Start and test](#4-start-and-test)
- [Command reference](#command-reference)
- [Manage your connection](#manage-your-connection)
- [Troubleshooting](#troubleshooting)

## 1. Install or run the CLI

Install Node.js 20 or newer and verify that npm is available. [Node.js downloads](https://nodejs.org/en/download)

```sh
node --version
npm --version
```

### Permanent installation with npm

Install once on the computer that runs your local models. Then use `free-llm` from any terminal on that computer.

```sh
npm install --global @free-llm-router/cli@latest
free-llm --version
free-llm --help
```

### Run on demand with npx

Use the package name before each command. These examples check that the CLI works before you pair a router.

```sh
npx --yes @free-llm-router/cli@latest --version
npx --yes @free-llm-router/cli@latest --help
```

Both forms use the same saved pairing under your user account. You can switch from `npx` to the global command and resume with `free-llm start`.

## 2. Prepare your runtime and ngrok

### Ollama

1. Install and open Ollama. If its server is stopped, run `ollama serve` in a separate terminal. The CLI looks for Ollama at `http://127.0.0.1:11434` by default. [Ollama CLI reference](https://docs.ollama.com/cli)
2. Run `ollama ls` to check for an installed chat model. You can download the example below if your list is empty. [Llama 3.2 model page](https://ollama.com/library/llama3.2)

```sh
ollama pull llama3.2:1b
ollama ls
```

### LM Studio

1. Open LM Studio 0.4 or newer and download a chat model.
2. In the **Developer** tab, start the local server. The CLI uses `http://127.0.0.1:1234` by default. Load a model manually or enable LM Studio's on-demand loading. [LM Studio server setup](https://lmstudio.ai/docs/developer/core/server)
3. If you enabled LM Studio API authentication, set `LMSTUDIO_API_TOKEN` in the terminal that runs the CLI. Set it again when starting the agent from a new terminal. The CLI uses this token locally for model discovery and inference. [LM Studio authentication](https://lmstudio.ai/docs/developer/core/authentication)

```powershell
$env:LMSTUDIO_API_TOKEN = "YOUR_LM_STUDIO_API_TOKEN"
```

```sh
export LMSTUDIO_API_TOKEN="YOUR_LM_STUDIO_API_TOKEN"
```

### ngrok

Install and sign in to ngrok. Add your ngrok authtoken once so the CLI can open the tunnel. [ngrok setup](https://ngrok.com/docs/start)

```sh
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
ngrok version
```

Replace `YOUR_NGROK_AUTHTOKEN` with the token from your ngrok dashboard. The CLI starts or reuses the tunnel for its protected agent.

## 3. Pair your computer

1. Sign in to your Free LLM Router dashboard and create a router if prompted.
2. Open **Providers → Local LLMs**, choose **Ollama** or **LM Studio**, and click **Connect**. The pairing code expires after 10 minutes and works once.
3. Run the generated command on the computer running your local runtime, or use the examples below. Replace the example code and URL with those from your dashboard.
4. Select the installed models to enable by number or model ID, then give the computer a name you’ll recognize in the dashboard.

**Global installation**

```sh
free-llm connect ollama --code FLR-XXXX-XXXX --router-url https://your-router.example --no-start
free-llm connect lmstudio --code FLR-XXXX-XXXX --router-url https://your-router.example --no-start
```

**On-demand run**

```sh
npx --yes @free-llm-router/cli@latest connect ollama --code FLR-XXXX-XXXX --router-url https://your-router.example --no-start
npx --yes @free-llm-router/cli@latest connect lmstudio --code FLR-XXXX-XXXX --router-url https://your-router.example --no-start
```

`--no-start` saves the pairing so you can start the agent in the next step. Omit it to start immediately after pairing, as the dashboard’s generated command does.

## 4. Start and test

Start the agent using the pairing you just saved.

```sh
free-llm start
```

Or, with the on-demand form:

```sh
npx --yes @free-llm-router/cli@latest start
```

Keep this terminal open while you want the models available. The agent runs in the foreground in either installation mode. Wait for a **Heartbeat accepted** message, then check that the node appears online under **Providers → Local LLMs**. To check from another terminal, run `free-llm status` or `npx --yes @free-llm-router/cli@latest status`.

Open **Playground → Local LLM**, select the node and an enabled model, and send a basic prompt such as `Reply with exactly: Hello from my local model.` If an enabled LM Studio model is downloaded but unavailable, load it in LM Studio and wait for the next heartbeat or run `free-llm models sync`.

For normal API requests, go to **Router & Policies → Local LLM Properties** to choose **Normal order**, **Prefer local**, or **Local only**. Use **Playground → Router request** to test that routing policy. Apps continue to use your Free LLM Router URL and private router key. [Local LLM routing and application setup](https://github.com/Pr0fess0rOP/free-llm-router/blob/main/docs/CONNECT_LOCAL_LLM.md)

## Command reference

Replace `free-llm` with `npx --yes @free-llm-router/cli@latest` in any command if you use the on-demand form.

| Command | What it does |
| --- | --- |
| `free-llm help` | Shows usage. `--help`, `-h`, and running `free-llm` by itself also show help. |
| `free-llm version` | Prints the CLI version. `--version` and `-v` do the same. |
| `free-llm connect ollama` | Pairs this computer with a router and starts the agent. Supply the router URL and pairing code or enter the code when prompted. |
| `free-llm connect lmstudio` | Pairs an LM Studio server running on the same computer. |
| `free-llm start` | Starts the saved connection in the foreground. |
| `free-llm status` | Shows whether the agent is running, whether the local runtime and tunnel are reachable, the last heartbeat, and the enabled models. |
| `free-llm models` | Lists installed chat models. `[x]` marks enabled models in the local configuration. |
| `free-llm models sync` | Sends the current model inventory to the router and refreshes the local model configuration. Enable newly discovered models in the dashboard. |
| `free-llm logs` | Prints up to 200 lines from the local agent log. |
| `free-llm disconnect` | Stops the local agent and keeps the pairing for a later restart. |
| `free-llm credential rotate` | Stops a running agent, replaces its device credential, and invalidates the old one. Run `start` afterward. |
| `free-llm revoke` | Revokes the device's router access and removes its local pairing. Reconnecting requires a new code. |

These are terminal commands. Use `free-llm --help` and `free-llm --version`.

### Pairing options

Pass options after `connect ollama` or `connect lmstudio`. Use `--models` and `--name` to skip the model and computer-name prompts.

| Option | Purpose |
| --- | --- |
| `--code CODE` | Supplies the one-time pairing code. If omitted, the CLI asks for it. |
| `--router-url URL` | Sets the router site URL. The CLI accepts HTTPS or loopback HTTP for a local development router. |
| `--ollama-url URL` | Sets the local Ollama origin. Defaults to `http://127.0.0.1:11434`. |
| `--lmstudio-url URL` | Sets the local LM Studio origin. Defaults to `http://127.0.0.1:1234`. |
| `--models ID,ID` | Enables the listed installed model IDs. Use the exact IDs shown by the CLI. |
| `--name NAME` | Sets the name shown in the dashboard. |
| `--agent-port PORT` | Overrides the protected agent's automatically selected loopback port. |
| `--ngrok-path PATH` | Sets the path to the ngrok executable when it is outside your terminal's `PATH`. |
| `--no-start` | Saves the pairing and exits. Start later with `free-llm start`. |

```sh
free-llm connect ollama --code FLR-XXXX-XXXX --router-url https://your-router.example --models llama3.2:1b --name "Home desktop" --no-start
```

Advanced configuration can use `FREE_LLM_ROUTER_URL`, `OLLAMA_BASE_URL`, and `LMSTUDIO_BASE_URL` during pairing. `NGROK_PATH` supplies an executable path when none was saved. `FREE_LLM_LOCAL_NODE_CONFIG` selects a single custom pairing file.

### Use Ollama and LM Studio on one computer

Generate a separate code for each runtime in the same router dashboard. Run each `connect` command in its own terminal. The CLI stores each pairing separately and selects different agent ports. Existing pairings keep their saved port.

Run `free-llm status` to see both connections. Use `--runtime ollama` or `--runtime lmstudio` for commands that act on one connection.

```sh
free-llm start --runtime ollama
free-llm models sync --runtime lmstudio
```

Each agent needs its own HTTPS tunnel. If ngrok's default URL is already in use, configure two distinct HTTPS endpoints in ngrok and start them before the local agents. Forward each endpoint to the corresponding protected agent port shown in its terminal. The CLI reuses matching tunnels from ngrok's local API on port `4040`. [Starting named ngrok endpoints](https://ngrok.com/docs/gateway/agent/cli#ngrok-start)

## Manage your connection

- **Pause and resume.** Press **Ctrl+C** in the agent terminal or run `free-llm disconnect` from another terminal. Run `free-llm start` when you're ready to reconnect.
- **Add another model.** Download it in your local runtime, run `free-llm models sync`, then enable it under **Router & Policies → Local LLM Properties**.
- **Upgrade the global command.** Run `npm install --global @free-llm-router/cli@latest` again. Restart the agent to use the updated version.
- **Remove access.** Run `free-llm revoke` while the CLI can reach your router. To remove the globally installed command too, run `npm uninstall --global @free-llm-router/cli` afterward. Installed models stay on your computer.

New pairings and their logs live in `~/.freellm/ollama/` or `~/.freellm/lmstudio/`. Existing pairings in `~/.freellm/local-node.json` are still used. The CLI uses OS credential protection where available and a local fallback otherwise. Keep the device credential, router key, pairing code, and ngrok authtoken private. [Local node security details](https://github.com/Pr0fess0rOP/free-llm-router/blob/main/docs/LOCAL_NODE_SECURITY.md)

## Troubleshooting

| What you see | What to check |
| --- | --- |
| `free-llm` is missing after using `npx` | Run the full `npx` command again or complete the global installation above. |
| `free-llm` is missing after a global install | Open a new terminal and check that npm's global executable directory is on `PATH`. If PowerShell blocks a script shim, try `free-llm.cmd --help`. |
| Ollama is offline or no models appear | Open Ollama or run `ollama serve`. Verify `ollama ls`, then sync the inventory if you already paired. |
| LM Studio is offline or shows a model as unavailable | Start the server in LM Studio's **Developer** tab. Load a chat model or enable on-demand loading. Set `LMSTUDIO_API_TOKEN` if the server requires authentication, then run `free-llm models sync`. |
| The pairing code expired or was already used | Generate a fresh code in **Providers → Local LLMs**. If the node is already paired, run `status` and then `start`. |
| ngrok is missing or the tunnel keeps retrying | Check `ngrok version` and confirm that your authtoken is configured. Use `--ngrok-path` during pairing or set `NGROK_PATH` before starting an existing connection. |
| The node is online but requests use cloud providers | Check that the model is enabled, the local routing gate is on, and the node's routing mode fits the request. Use **Playground → Local LLM** to test the exact target. |

[Full troubleshooting guide](https://github.com/Pr0fess0rOP/free-llm-router/blob/main/docs/LOCAL_NODE_TROUBLESHOOTING.md) · [Maintainer publishing guide](https://github.com/Pr0fess0rOP/free-llm-router/blob/main/packages/cli/PUBLISHING.md)
