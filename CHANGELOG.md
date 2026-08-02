# Changelog

All notable changes to Free LLM Router are documented here.

## 0.7.0 - 2026-08-01

### Added

- Private Ollama node pairing with short-lived, single-use pairing codes.
- Local model discovery, health reporting, capability controls, credential rotation, revocation, and node deletion.
- Local-first, cloud-fallback, cloud-first, and local-only routing behavior with account isolation.
- Local LLM routing properties and gate controls under Router & Policies.
- A Local LLM playground for testing a selected node model and generation parameters.
- The public `@free-llm-router/cli` npm package and `free-llm` executable.
- User-level local-node configuration in `~/.freellm` with safe migration from checkout-local configuration.

### Changed

- Cloud providers and Local LLMs now use consistent provider workspace tabs and card styling.
- Local-node settings are managed in Router & Policies instead of provider cards.
- Documentation, integration snippets, CI, and the feature guide now cover the local-node workflow.
- The repository root npm package is private; only `packages/cli` is publishable.

### Removed

- Duplicate local-node CLI command implementations.
- Obsolete root npm publishing metadata.
- Unused provider-logo mapping and download pipeline files.
- Generated presentation workspaces, build output, package caches, and stale repository archives.
