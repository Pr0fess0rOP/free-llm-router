## Summary

<!-- Explain what changed in a few sentences. -->

## Why is this change needed?

<!-- Link the related issue and describe the problem being solved. -->

Closes #

## What changed?

- 
- 

## How was it tested?

<!-- Include commands, test cases, screenshots, or a short manual verification. -->

```text
npm run typecheck
npm test
npm run build
```

## Security and privacy

- [ ] I did not commit API keys, tokens, cookies, `.env` files, prompts, responses, or customer data.
- [ ] New or changed endpoints enforce appropriate authentication and authorization.
- [ ] User-controlled input is validated before it reaches providers, storage, logs, or rendered HTML.
- [ ] Provider credentials and router keys are not exposed in logs or responses.
- [ ] I considered rate limits, retries, fallback behavior, and request amplification.
- [ ] I documented any analytics, retention, or privacy impact.
- [ ] This change has no security or privacy impact.

## Compatibility

- [ ] OpenAI Chat Completions behavior remains compatible.
- [ ] OpenAI Responses behavior remains compatible.
- [ ] Anthropic or Claude Code behavior remains compatible.
- [ ] Existing configuration remains backward compatible.
- [ ] A breaking change is documented below.
- [ ] Not applicable.

## Final checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] Tests were added or updated for behavioral changes.
- [ ] Documentation was added or updated where needed.
- [ ] The pull request is focused and does not contain unrelated changes.

## Screenshots or request examples

<!-- Add dashboard screenshots or sanitized API examples when useful. -->

## Breaking changes or migration notes

<!-- Write "None" when there are no breaking changes. -->
