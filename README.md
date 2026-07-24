# Free LLM Router 🚀

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

Bring your own LLM API keys and route **OpenAI Chat Completions**, **OpenAI Responses/Codex**, and **Claude Code** through one gateway with a beautiful, self-hosted dashboard.

Free LLM Router handles provider failover, request deduplication, analytics, rate-limit cooldowns, and more—making it easier, cheaper, and more reliable to use AI in your applications.

## ![Feature Showcase](public/assets/demo/feature-showcase.gif)


## 📖 What is this product?

Imagine you have several different AI assistants (like different brands of smart speakers or chat apps) that you pay for separately. Each one has its own strengths—some are fast, some are cheap, some are good at specific tasks like coding or understanding images.

**Free LLM Router** is like a smart switchboard that lets you use ALL of these AI assistants through ONE simple connection, without having to manage each service separately.

### How it works

1. **You sign in once** — Log into the dashboard with your Clerk account.
2. **You add your AI service keys** — These are like passwords for each AI service you want to use (you only have to enter them once).
3. **You get one master key** — The system gives you a special code (starting with `flm_`) that you use in your apps.
4. **Your apps talk to the router** — Instead of your app talking directly to each AI service, it talks to this router.
5. **The router chooses the best AI** — Behind the scenes, it picks which AI service to use based on what you need, cost, speed, availability, and rate-limits.

---

## ✨ Key Features

- **One Connection, Many AIs:** Talk to OpenRouter, Groq, Anthropic, OpenAI, DeepSeek, Together AI, and more through one simple API.
- **Automatic Failover & Circuit Breakers:** If an AI service is having issues, the router silently switches to another one.
- **Rate-Limit & Quota Protection:** Automatically honors `Retry-After` headers and tracks your free-tier limits to avoid unexpected charges.
- **Request Deduplication:** Coalesces identical in-flight requests and briefly reuses successful responses, saving provider quota.
- **Model Aliases & Capabilities:** Create virtual models (like `vision-router`) that only route to providers with specific capabilities.
- **Comprehensive Dashboard:** Manage providers, test prompts in the Playground, and view detailed request analytics and performance timings.
- **Full Compatibility:** Works out of the box as an OpenAI-compatible endpoint, Codex CLI gateway, and Claude Code gateway.

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (version 20 or higher)
- [Git](https://git-scm.com/)
- A [Clerk](https://clerk.com/) account (for authentication)

### 1. Installation

```bash
git clone https://github.com/your-username/free-llm-router.git
cd free-llm-router
npm install
```

### 2. Configuration

Create a `.env` file in the root directory:

```env
# Required for Clerk authentication
CLERK_SECRET_KEY=sk_test_your_clerk_secret_key
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_your_clerk_publishable_key

# Strongly recommended for production (encrypts stored API keys)
# Generate with: openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
ACCOUNT_ENCRYPTION_KEY=your_32_byte_base64url_secret
```

### 3. Start the Server

```bash
npm run dev
```

The dashboard will start at `http://localhost:8787`.

### 4. Create a Router & Add Keys

1. Open `http://localhost:8787` and sign in.
2. Create your first router to generate your `flm_...` router key.
3. Go to the **Providers** page and add your API keys for services like Groq or OpenRouter.
4. Head to the **Playground** to test your setup immediately!

For detailed setup instructions, see [Getting Started](docs/GETTING_STARTED.md).

---

## 📚 Documentation

Detailed documentation has been moved to the `docs/` folder to keep this README concise:

- **[Detailed Manual & Feature Guide](docs/MANUAL.md)** - Comprehensive explanation of all features, routing logic, and architecture.
- **[Architecture & Flow](docs/ARCHITECTURE.md)** - Deep dive into request flows and system design.
- **[Simple Explanation](docs/SIMPLE_EXPLANATION.md)** - A non-technical overview of the product.
- **[Getting Started](docs/GETTING_STARTED.md)** - Step-by-step setup and testing guide.

---

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) to learn how to get started, run tests, and submit pull requests.

## 🛡️ Security

Please review our [Security Policy](SECURITY.md) for information on reporting vulnerabilities and our security practices.

## 💬 Support & Community

- **Code of Conduct:** Please read our [Code of Conduct](CODE_OF_CONDUCT.md).
- **Need Help?** See our [Support Guide](SUPPORT.md) on how to get assistance or report issues.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
