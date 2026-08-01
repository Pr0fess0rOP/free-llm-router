# Free LLM Router CLI

The CLI is currently built from the root package (`src/cli.ts`) and published through the `free-llm` and `free-llm-router` binaries. This directory documents its local-node surface while preserving a future move to a dedicated `@free-llm-router/cli` workspace package.

## Local Ollama commands

```text
npx @free-llm-router/cli connect ollama --code <code> [--router-url <url>]
npx @free-llm-router/cli start
npx @free-llm-router/cli status
npx @free-llm-router/cli models [sync]
npx @free-llm-router/cli logs
npx @free-llm-router/cli disconnect
npx @free-llm-router/cli revoke
npx @free-llm-router/cli credential rotate
```

For an unpublished local checkout, use `npm run cli -- <command>` from the
repository root. The unscoped `free-llm-router` name on npm belongs to a
different CLI and must not be used for this integration.

Use `free-llm-router serve` to start the router/dashboard server explicitly. `start` starts a paired local node when local-node configuration exists, otherwise it retains the original router-server behavior.

See [the complete guide](../../docs/CONNECT_LOCAL_LLM.md), [security model](../../docs/LOCAL_NODE_SECURITY.md), and [troubleshooting](../../docs/LOCAL_NODE_TROUBLESHOOTING.md).
