# Getting Started with Free LLM Router

This guide will walk you through setting up and running the Free LLM Router for the first time.

## Prerequisites

Before you begin, make sure you have installed:

- [Node.js](https://nodejs.org/) (version 20 or higher)
- [Git](https://git-scm.com/)
- A [Clerk](https://clerk.com/) account (for authentication)

## Step 1: Clone the Repository

```bash
git clone https://github.com/Pr0fess0rOP/free-llm-router.git
cd free-llm-router
```

## Step 2: Install Dependencies

```bash
npm install
```

## Step 3: Set Up Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Required for Clerk authentication
CLERK_SECRET_KEY=sk_test_your_clerk_secret_key
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_your_clerk_publishable_key

# Recommended for production; comma-separate every public dashboard origin
CLERK_AUTHORIZED_PARTIES=https://your-dashboard.example.com

# Strongly recommended for production (encrypts stored API keys)
ACCOUNT_ENCRYPTION_KEY=your_32_byte_base64url_secret

# Optional: Provider API keys (you can also add these via the dashboard)
# OPENROUTER_API_KEY=your_openrouter_key
# GROQ_API_KEY=your_groq_key
# ... (add others as needed)
```

The publishable and secret Clerk keys must belong to the same Clerk instance. If
the dashboard is served through a proxy or custom domain, include its exact
origin (scheme and hostname) in `CLERK_AUTHORIZED_PARTIES`. The router also
recognizes standard forwarded host headers, so preview and proxied deployments
can verify the browser session without weakening Clerk's authorized-party check.

### Generating an Encryption Key

If you want to encrypt your stored API keys (highly recommended), generate a key with:

```bash
# Using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# Or using OpenSSL
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

## Step 4: Start the Development Server

```bash
npm run dev
```

The server will start at `http://localhost:8787`

## Step 5: Sign In and Create Your First Router

1. Open your browser to `http://localhost:8787`
2. Sign in using your Clerk account (Google, GitHub, email, etc.)
3. After signing in, you'll be prompted to create a router
4. Give your router a name (e.g., "My First Router")
5. Click "Create Router"
6. Save the generated router key (it will start with `flm_`) - you'll need this for API calls

## Step 6: Add Provider API Keys

1. Navigate to **Providers → Cloud providers** in the dashboard
2. Click the "Add key" button for the provider you want to configure (e.g., Groq, OpenRouter)
3. Enter your API key for that provider
4. Click "Save"
5. Repeat for any additional providers you want to use

## Step 7: Optionally Connect a Private Local LLM

If Ollama is running on this computer or another computer you control:

1. Open **Providers → Local LLMs**.
2. Select **Connect Ollama** to create a ten-minute, single-use pairing code.
3. Run the generated `npx --yes @free-llm-router/cli@latest connect ollama ...` command beside Ollama.
4. Select which installed models the router may use and give the node a recognizable name.
5. Leave the command running while the node should remain online.

The CLI stores the pairing under the current user's `~/.freellm/` directory. Later, `npx --yes @free-llm-router/cli@latest start` reconnects the same node without another pairing code. To use the shorter `free-llm start` form, first run `npm install --global @free-llm-router/cli@latest`. Providers shows connection status; configuration lives under **Settings → Router & Policies → Local LLM Properties**.

See [Connect a private Ollama node](CONNECT_LOCAL_LLM.md) for routing modes, limits, model capabilities, testing, revocation, deletion, and CLI lifecycle commands.

## Step 8: Test Your Setup

### Using the Playground (Recommended for Beginners)

1. Go to the **Playground** page in the dashboard.
2. Choose **Router request** to exercise the complete routing policy, **Provider + model** to diagnose one hosted model, or **Local LLM** to test one exact Ollama model without cloud fallback.
3. Choose an API format, enter a prompt such as "Say hello in a poetic way," and adjust the generation parameters.
4. Select **Test Request** and inspect the chosen provider or node, exact model, latency, capabilities, and response.

### Using cURL

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer flm_your_router_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "free-router",
    "messages": [{"role": "user", "content": "Say hello in a poetic way"}]
  }'
```

## Step 9: Explore the Dashboard

Take some time to explore these key dashboard sections:

- **Overview**: See your router's status, provider health, and quick stats
- **Providers**: Switch between Cloud providers and Local LLMs, manage API keys, and inspect connection status
- **Playground**: Test routed requests, exact hosted models, or exact local Ollama models
- **Analysis**: Monitor requests, see which providers are being used, and view performance metrics
- **Settings**: Configure routing policies, model aliases, capability registry, and Local LLM properties

## Next Steps

- **Configure Routing Policies**: In Settings → Router & Policies, choose how requests are routed (priority, fastest, reliability, etc.)
- **Set Up Model Aliases**: Create virtual model names with specific capabilities (e.g., a "vision-router" that only uses providers with image understanding)
- **Configure Local Routing**: Gate each node, choose normal/prefer-local/local-only participation, and set local concurrency, queue, token, and timeout limits
- **Enable Quota Protection**: Set daily/monthly limits for each provider to avoid unexpected charges
- **Check Analytics**: Monitor usage patterns, costs, and performance over time
- **Read the Full Documentation**: Refer to `README.md` for detailed information on all features

## Troubleshooting Common Issues

### "Unauthorized" or "Invalid Router Key" Errors
- Double-check that you're using the correct router key (starts with `flm_`)
- Make sure you're signed into the dashboard session is active
- Try regenerating your router key in the dashboard if needed

### Provider Connection Issues
- Verify your API keys are correctly entered in the Providers page
- Check that the provider service is operational (status pages)
- Ensure you have sufficient quota/credits with the provider

### Local LLM Connection Issues

- Run `free-llm status` and `free-llm logs` on the Ollama computer.
- Confirm Ollama responds at `http://127.0.0.1:11434` and ngrok is authenticated.
- Check the node's routing gate, status, enabled models, and capabilities under **Local LLM Properties**.
- Follow the [Local-node troubleshooting guide](LOCAL_NODE_TROUBLESHOOTING.md) for detailed recovery steps.

### CORS Errors When Calling from Browser
- The router is designed primarily for server-to-server calls
- For browser-based applications, consider using a proxy or consult the CORS configuration in `src/server.ts`

## Need Help?

- Check the [Issues](https://github.com/Pr0fess0rOP/free-llm-router/issues) page for known problems
- Review the [Security Policy](../SECURITY.md) and [Local-node Security](LOCAL_NODE_SECURITY.md) guides
- Consult the full [README](../README.md) and [Manual](MANUAL.md) for detailed feature explanations

Happy routing! 🚀
