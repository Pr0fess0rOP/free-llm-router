# Security Policy

## Supported Versions

We provide security updates for the latest stable release of Free LLM Router.

| Version | Supported          |
| ------- | ------------------ |
| 0.6.x   | :white_check_mark: |
| < 0.6.0 | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Free LLM Router, please report it responsibly by:

1. **Do not** disclose the vulnerability publicly until it has been addressed.
2. Email the maintainer at `pathik.viramgama@email.com`.
3. Include as much detail as possible about the vulnerability, including steps to reproduce.
4. Allow reasonable time for us to respond and address the issue.

We will acknowledge receipt of your report within 48 hours and provide regular updates on our progress toward fixing the issue.

## Security Practices

### API Key Security

- Provider API keys are never displayed again after saving in the dashboard.
- Keys are encrypted at rest using AES-256-GCM when `ACCOUNT_ENCRYPTION_KEY` is set in your environment.
- Keys are stored separately for each router/account.
- Keys are never forwarded to upstream providers in request headers.

### Authentication

- Dashboard authentication is handled securely by Clerk.
- Router authentication uses private `flm_...` keys generated securely per router.
- Router keys should be treated like API keys and kept confidential.
- Session tokens are validated using `@clerk/backend`.

### Data Protection & Analytics

- Request and response bodies are sanitized before storage in analytics.
- Sensitive fields like authorization headers, API keys, tokens, and passwords are redacted.
- Very long strings are truncated in stored analytics to prevent denial of service.
- Object depth and array sizes are strictly limited in stored analytics.

### Rate Limiting & Protections

- Persistent rate-limit cooldowns are stored per-router/provider.
- The router honors upstream `Retry-After` headers and implements exponential backoff.
- A Circuit breaker pattern protects against repeatedly failing providers.
- Quota tracking prevents exceeding provider limits.
- Request deduplication coalesces identical in-flight requests to prevent duplicate provider calls.

### Network Security

- It is highly recommended to run this service behind a reverse proxy handling HTTPS.
- Implements proper CORS headers.
- Validates and sanitizes request IDs.
- Strictly strips sensitive headers (authorization, keys, etc.) before sending to upstream providers.

### Dependencies

We monitor dependencies for known vulnerabilities and recommend keeping dependencies up to date:
- `@clerk/backend`
- `@upstash/redis`
- `dotenv`

## Best Practices for Deployments

1. **Always set `ACCOUNT_ENCRYPTION_KEY`** in production to encrypt stored provider keys.
2. **Keep your router keys (`flm_...`) secure** - treat them like API keys.
3. **Regularly rotate provider API keys** through the dashboard if you suspect any leaks.
4. **Monitor provider quotas** and set appropriate usage limits.
5. **Keep Node.js updated** to the latest active LTS version.
6. **Review dependencies** regularly using `npm audit`.

## Policy Updates

This security policy may be updated from time to time as the project evolves. Please check back periodically.