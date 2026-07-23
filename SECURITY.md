# Security Policy

## Supported Versions

Security fixes are provided for the latest release and the current `main` branch.
Older releases may not receive security updates.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| `main` branch | Yes |
| Older releases | No |

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub Issues,
GitHub Discussions, pull requests, or social media.

Use GitHub's private vulnerability reporting feature instead:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Submit the report privately.

If private vulnerability reporting is unavailable, contact the repository owner
privately through their GitHub profile and ask for a secure reporting channel.
Do not include exploit details or sensitive data in a public message.

## What to Include

A useful report should include:

- A clear description of the vulnerability and its potential impact
- The affected route, component, file, or version
- Reproduction steps or a minimal proof of concept
- Any required configuration or deployment assumptions
- Suggested remediation, when available
- Whether the issue is already being actively exploited

Remove all real API keys, tokens, prompts, customer data, and other secrets from
screenshots, logs, and proof-of-concept material.

## Response Process

We aim to acknowledge complete reports within **three business days**. After
triage, we will share whether the issue is accepted, request additional details
when necessary, and coordinate a reasonable disclosure timeline.

Please allow time for investigation, remediation, testing, and deployment before
publishing vulnerability details. We will credit reporters in the advisory or
release notes when requested and appropriate.

## Security-Relevant Architecture

LLM Router handles credentials and may process sensitive model inputs. Important
security properties include:

- Provider credentials can be encrypted at rest with `ACCOUNT_ENCRYPTION_KEY`.
- Router API keys are sensitive credentials and must not be committed or shared.
- Dashboard authentication is handled through Clerk in hosted deployments.
- Provider requests are sent only to configured provider endpoints.
- Reliability features such as retry handling, cooldowns, circuit breakers,
  quotas, and request deduplication reduce accidental request amplification.

These controls do not replace secure deployment practices.

## Data and Analytics Warning

Depending on configuration and the feature being used, request analytics may
contain model inputs, outputs, tool arguments, identifiers, timing information,
and provider errors. Do not send secrets in prompts or tool arguments. Operators
should restrict datastore access, configure an appropriate retention policy, and
avoid enabling detailed payload storage unless it is required.

## Deployment Recommendations

Production operators should:

1. Set a strong, randomly generated `ACCOUNT_ENCRYPTION_KEY`.
2. Store Clerk, Redis, provider, and deployment credentials only in a trusted
   secret manager or the hosting platform's encrypted environment settings.
3. Keep `.env` files, local provider configuration, logs, and backups out of Git.
4. Rotate any credential that may have been exposed, even if it was later removed
   from the repository.
5. Enforce HTTPS at the reverse proxy or hosting platform.
6. Restrict access to Redis and other persistent storage.
7. Review analytics retention and redact sensitive request data.
8. Keep Node.js and npm dependencies updated.
9. Enable GitHub secret scanning, push protection, Dependabot, and code scanning.
10. Apply request-rate, concurrency, token, and spending limits appropriate for
    the deployment.

## Out of Scope

The following are generally not considered vulnerabilities unless they create a
meaningful security impact:

- Missing security headers without a demonstrated exploit
- Reports based only on automated scanner output
- Denial-of-service reports requiring unrealistic resources
- Social engineering or physical attacks
- Vulnerabilities in unsupported versions
- Provider outages, pricing changes, or upstream model behavior

## Safe Harbor

Good-faith security research that avoids privacy violations, data destruction,
service disruption, and unauthorized access beyond what is necessary to prove
the issue is welcome. Do not access or retain data belonging to other users.
