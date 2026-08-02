# Free LLM Router CLI

Connect an Ollama installation on your computer to a deployed Free LLM Router.

## Requirements

- Node.js 20 or newer
- Ollama running on `http://127.0.0.1:11434`
- At least one installed Ollama model
- A one-time pairing code from the Free LLM Router dashboard
- ngrok installed and authenticated

## Connect a Local LLM

Generate a pairing code under **Providers → Local LLMs**, then run:

```powershell
npx --yes @free-llm-router/cli@latest connect ollama `
  --code FLR-XXXX-XXXX `
  --router-url https://your-router.example
```

The pairing code is used once. The CLI stores configuration in the current user's `~/.freellm/` directory and protects the device credential with Windows DPAPI, macOS Keychain, or Linux Secret Service when available.

## Commands

```text
free-llm connect ollama --code <code> --router-url <https-url>
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

`disconnect` stops the node while preserving its pairing. `revoke` invalidates the device credential and removes the local pairing.

Providers shows whether the node is connected. Configure its routing gate, normal/prefer-local/local-only mode, limits, models, capabilities, tests, revocation, and permanent deletion under **Settings → Router & Policies → Local LLM Properties**. Dashboard deletion removes router-side node data but never deletes Ollama models.

## Maintainer: build and inspect

Install the repository dependencies from the repository root, then build from this directory:

```powershell
npm run build
npm run pack:check
```

Publish only after the package contents, project tests, and a local tarball installation have been verified:

```powershell
npm publish --access public
```

See the [complete Local LLM guide](https://github.com/Pr0fess0rOP/free-llm-router/blob/main/docs/CONNECT_LOCAL_LLM.md) and [troubleshooting guide](https://github.com/Pr0fess0rOP/free-llm-router/blob/main/docs/LOCAL_NODE_TROUBLESHOOTING.md).
