# Getting Started with Free LLM Router

This guide will walk you through setting up and running the Free LLM Router for the first time.

## Prerequisites

Before you begin, make sure you have installed:

- [Node.js](https://nodejs.org/) (version 20 or higher)
- [Git](https://git-scm.com/)
- A [Clerk](https://clerk.com/) account (for authentication)

## Step 1: Clone the Repository

```bash
git clone https://github.com/your-username/free-llm-router.git
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

# Strongly recommended for production (encrypts stored API keys)
ACCOUNT_ENCRYPTION_KEY=your_32_byte_base64url_secret

# Optional: Provider API keys (you can also add these via the dashboard)
# OPENROUTER_API_KEY=your_openrouter_key
# GROQ_API_KEY=your_groq_key
# ... (add others as needed)
```

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

1. Navigate to the "Providers" page in the dashboard
2. Click the "Add key" button for the provider you want to configure (e.g., Groq, OpenRouter)
3. Enter your API key for that provider
4. Click "Save"
5. Repeat for any additional providers you want to use

## Step 7: Test Your Setup

### Using the Playground (Recommended for Beginners)

1. Go to the "Playground" page in the dashboard
2. Select your router from the dropdown (if not already selected)
3. Choose an API format (OpenAI Chat Completions is a good starting point)
4. Enter a test prompt (e.g., "Say hello in a poetic way")
5. Click "Test Request"
6. You should see a response from one of your configured providers

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

## Step 8: Explore the Dashboard

Take some time to explore these key dashboard sections:

- **Overview**: See your router's status, provider health, and quick stats
- **Providers**: Manage your API keys, view usage, and configure quotas
- **Playground**: Test different prompts and configurations
- **Analysis**: Monitor requests, see which providers are being used, and view performance metrics
- **Settings**: Configure routing policies, model aliases, and capability registry

## Next Steps

- **Configure Routing Policies**: In Settings → Router & Policies, choose how requests are routed (priority, fastest, reliability, etc.)
- **Set Up Model Aliases**: Create virtual model names with specific capabilities (e.g., a "vision-router" that only uses providers with image understanding)
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

### CORS Errors When Calling from Browser
- The router is designed primarily for server-to-server calls
- For browser-based applications, consider using a proxy or consult the CORS configuration in `src/server.ts`

## Need Help?

- Check the [Issues](https://github.com/your-username/free-llm-router/issues) page for known problems
- Review the [Security Policy](SECURITY.md) for best practices
- Consult the full [README](README.md) for detailed feature explanations

Happy routing! 🚀