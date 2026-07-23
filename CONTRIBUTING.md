# Contributing to Free LLM Router

First off, thank you for considering contributing to Free LLM Router! It's people like you that make this tool such a great open-source project.

## How Can I Contribute?

We welcome contributions in many forms, especially:

- **New Provider Adapters:** Adding support for providers that aren't natively OpenAI-compatible.
- **Catalog Updates:** Keeping the provider catalog and available models up to date.
- **Security Enhancements:** Improving credential encryption, router-key rotation, and revocation flows.
- **Testing:** Writing unit and integration tests for routing and management flows.
- **UI/UX:** Improving dashboard accessibility, mobile responsiveness, and overall user experience.
- **Documentation:** Fixing typos, expanding guides, or adding integration examples.

## Local Development Setup

To get your development environment set up:

```bash
# Install dependencies
npm install

# Run TypeScript checks
npm run typecheck

# Run tests
npm test

# Initialize the CLI and start the server
npm run cli -- init
npm run dev
```

The application will be running at `http://localhost:8787`.

## Pull Request Process

1. **Keep Secrets Out:** Ensure that no credentials, `.env` files, or the `.freellm/` directory are included in your commits.
2. **Write Tests:** Add tests for any new behavior or bug fixes to ensure stability.
3. **Run Checks:** Before submitting, run `npm run typecheck`, `npm test`, and `npm run build` locally to verify everything passes.
4. **Document Changes:** Explain what your PR does, any provider-specific API quirks you addressed, and update the README or docs if necessary.
5. **Provider Entries:** If adding a new provider to `providers.json`, ensure it has:
   - A stable `id`
   - An OpenAI-compatible `baseUrl`
   - At least one currently available `model`
   - A URL where users can create an API key
   - A source for free-tier limits, if applicable

## Code Style

- We use TypeScript and ES Modules. Please ensure your code follows the existing types and structures.
- Formatting is typically handled by standard tools in the repository; follow the styling of surrounding code.

Thank you for contributing!
