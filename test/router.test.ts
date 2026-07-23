import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRouter } from "../src/router.js";
import type { ProviderRuntime } from "../src/types.js";

function provider(id: string, priority: number): ProviderRuntime {
  return {
    id,
    baseUrl: `https://${id}.example/v1`,
    model: `${id}-model`,
    priority,
    capabilities: {
      streaming: "supported",
      tools: "supported",
      jsonMode: "supported",
      structuredOutputs: "supported",
      vision: "supported",
      reasoning: "supported",
      embeddings: "unsupported",
    },
    cooldownMs: 60_000,
    apiKeyValue: "secret",
    cooldownUntil: 0,
    failures: 0,
    circuitState: "closed",
    circuitOpenUntil: 0,
    circuitFailureCount: 0,
    circuitOpenCount: 0,
    halfOpenProbeActive: false,
  };
}

test("fails over after a 429 response", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("first")) {
      return new Response(
        JSON.stringify({ error: { message: "rate limited" } }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const first = provider("first", 10);
  const second = provider("second", 20);
  const router = new ProviderRouter([first, second], fetcher);
  const result = await router.chatCompletion({
    model: "free-router",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(result.providerId, "second");
  assert.deepEqual(calls, [
    "https://first.example/v1/chat/completions",
    "https://second.example/v1/chat/completions",
  ]);
  assert.ok(first.cooldownUntil > Date.now());
});

test("forwards streaming responses without buffering", async () => {
  const fetcher: typeof fetch = async () =>
    new Response("data: hello\n\ndata: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });

  const router = new ProviderRouter([provider("stream", 10)], fetcher);
  const result = await router.chatCompletion({ stream: true, messages: [] });

  assert.equal(result.response.headers.get("content-type"), "text/event-stream");
  assert.equal(await result.response.text(), "data: hello\n\ndata: [DONE]\n\n");
});

test("skips a provider while it is cooling down", async () => {
  const calls: string[] = [];
  const first = provider("first", 10);
  first.cooldownUntil = Date.now() + 60_000;

  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ choices: [] }));
  };

  const router = new ProviderRouter([first, provider("second", 20)], fetcher);
  const result = await router.chatCompletion({ messages: [] });

  assert.equal(result.providerId, "second");
  assert.deepEqual(calls, ["https://second.example/v1/chat/completions"]);
});

test("priority policy respects the saved provider order", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ choices: [] }));
  };

  const router = new ProviderRouter(
    [provider("first", 10), provider("second", 20)],
    fetcher,
    {
      policy: {
        strategy: "priority",
        providerOrder: ["second", "first"],
      },
    },
  );

  const result = await router.chatCompletion({ messages: [] });
  assert.equal(result.providerId, "second");
  assert.deepEqual(calls, ["https://second.example/v1/chat/completions"]);
});

test("round-robin policy rotates from the supplied cursor", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ choices: [] }));
  };

  const router = new ProviderRouter(
    [provider("first", 10), provider("second", 20), provider("third", 30)],
    fetcher,
    {
      policy: { strategy: "round-robin", providerOrder: [] },
      roundRobinCursor: 1,
    },
  );

  const result = await router.chatCompletion({ messages: [] });
  assert.equal(result.providerId, "second");
  assert.deepEqual(calls, ["https://second.example/v1/chat/completions"]);
});

test("fastest policy prefers the lowest observed latency", async () => {
  const fetcher: typeof fetch = async (input) =>
    new Response(JSON.stringify({ selected: String(input) }));

  const router = new ProviderRouter(
    [provider("slow", 10), provider("fast", 20)],
    fetcher,
    {
      policy: { strategy: "fastest", providerOrder: [] },
      stats: {
        slow: {
          providerId: "slow",
          attempts: 4,
          successes: 4,
          failures: 0,
          averageLatencyMs: 1600,
          successScore: 0.95,
          consecutiveFailures: 0,
        },
        fast: {
          providerId: "fast",
          attempts: 4,
          successes: 4,
          failures: 0,
          averageLatencyMs: 280,
          successScore: 0.95,
          consecutiveFailures: 0,
        },
      },
    },
  );

  assert.equal((await router.chatCompletion({ messages: [] })).providerId, "fast");
});

test("least-used policy protects the provider with more prior attempts", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [] }));

  const router = new ProviderRouter(
    [provider("busy", 10), provider("quiet", 20)],
    fetcher,
    {
      policy: { strategy: "least-used", providerOrder: [] },
      stats: {
        busy: {
          providerId: "busy",
          attempts: 20,
          successes: 20,
          failures: 0,
          successScore: 0.99,
          consecutiveFailures: 0,
        },
        quiet: {
          providerId: "quiet",
          attempts: 2,
          successes: 2,
          failures: 0,
          successScore: 0.9,
          consecutiveFailures: 0,
        },
      },
    },
  );

  assert.equal((await router.chatCompletion({ messages: [] })).providerId, "quiet");
});

test("reliability policy prefers the strongest success history", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [] }));

  const router = new ProviderRouter(
    [provider("unstable", 10), provider("stable", 20)],
    fetcher,
    {
      policy: { strategy: "reliability", providerOrder: [] },
      stats: {
        unstable: {
          providerId: "unstable",
          attempts: 8,
          successes: 4,
          failures: 4,
          averageLatencyMs: 200,
          successScore: 0.45,
          consecutiveFailures: 2,
        },
        stable: {
          providerId: "stable",
          attempts: 8,
          successes: 8,
          failures: 0,
          averageLatencyMs: 900,
          successScore: 0.98,
          consecutiveFailures: 0,
        },
      },
    },
  );

  assert.equal((await router.chatCompletion({ messages: [] })).providerId, "stable");
});

test("smart policy balances reliability, latency, usage, and priority", async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [] }));

  const router = new ProviderRouter(
    [provider("fast-but-failing", 10), provider("balanced", 20)],
    fetcher,
    {
      policy: { strategy: "smart", providerOrder: [] },
      stats: {
        "fast-but-failing": {
          providerId: "fast-but-failing",
          attempts: 10,
          successes: 4,
          failures: 6,
          averageLatencyMs: 160,
          successScore: 0.38,
          consecutiveFailures: 3,
        },
        balanced: {
          providerId: "balanced",
          attempts: 10,
          successes: 9,
          failures: 1,
          averageLatencyMs: 650,
          successScore: 0.93,
          consecutiveFailures: 0,
        },
      },
    },
  );

  assert.equal((await router.chatCompletion({ messages: [] })).providerId, "balanced");
});

test("capability-aware routing skips providers that explicitly lack required tools", async () => {
  const calls: string[] = [];
  const noTools = provider("no-tools", 10);
  noTools.capabilities.tools = "unsupported";
  const tools = provider("tools", 20);

  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ choices: [] }));
  };

  const router = new ProviderRouter([noTools, tools], fetcher);
  const result = await router.chatCompletion({
    messages: [{ role: "user", content: "Use a tool" }],
    tools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
  });

  assert.equal(result.providerId, "tools");
  assert.equal(result.capabilityMatch.level, "full");
  assert.deepEqual(result.requirements.required, ["tools"]);
  assert.equal(
    result.providerEvaluations.find((item) => item.providerId === "no-tools")?.state,
    "incompatible",
  );
  assert.equal(
    result.providerEvaluations.find((item) => item.providerId === "tools")?.candidateRank,
    1,
  );
  assert.deepEqual(calls, ["https://tools.example/v1/chat/completions"]);
});

test("known capability support is preferred over unknown support", async () => {
  const calls: string[] = [];
  const unknown = provider("unknown", 10);
  unknown.capabilities.vision = "unknown";
  const supported = provider("supported", 20);

  const fetcher: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ choices: [] }));
  };

  const router = new ProviderRouter([unknown, supported], fetcher);
  const result = await router.chatCompletion({
    messages: [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
    }],
  });

  assert.equal(result.providerId, "supported");
  assert.equal(result.capabilityMatch.level, "full");
  assert.deepEqual(calls, ["https://supported.example/v1/chat/completions"]);
});

test("throws a detailed error when every provider is incompatible", async () => {
  const first = provider("first", 10);
  const second = provider("second", 20);
  first.capabilities.vision = "unsupported";
  second.capabilities.vision = "unsupported";

  const router = new ProviderRouter([first, second], async () => {
    throw new Error("fetch should not run");
  });

  await assert.rejects(
    () => router.chatCompletion({
      messages: [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }],
      }],
    }),
    (error: unknown) => {
      assert.equal((error as { name?: string }).constructor.name, "NoCompatibleProvidersError");
      const typed = error as {
        requirements: { required: string[] };
        providers: Array<{ match: { unsupported: string[] } }>;
      };
      assert.deepEqual(typed.requirements.required, ["vision"]);
      assert.equal(typed.providers.length, 2);
      assert.ok(typed.providers.every((item) => item.match.unsupported.includes("vision")));
      return true;
    },
  );
});

test("honors Retry-After seconds and records persistent cooldown metadata", async () => {
  const attempts: import("../src/types.js").ProviderAttemptMetric[] = [];
  const first = provider("rate-limited", 10);
  first.cooldownMs = 30_000;
  const second = provider("fallback", 20);
  const before = Date.now();

  const router = new ProviderRouter(
    [first, second],
    async (input) => {
      if (String(input).includes("rate-limited")) {
        return new Response(JSON.stringify({ error: { message: "slow down" } }), {
          status: 429,
          headers: { "retry-after": "120", "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    },
    { onAttempt: (attempt) => { attempts.push(attempt); } },
  );

  const result = await router.chatCompletion({ messages: [] });
  assert.equal(result.providerId, "fallback");
  assert.ok(first.cooldownUntil >= before + 119_000);
  assert.equal(attempts[0]?.cooldownReason, "rate_limit");
  assert.equal(attempts[0]?.retryAfterSeconds, 120);
  assert.equal(
    result.providerEvaluations.find((item) => item.providerId === "rate-limited")?.state,
    "cooldown",
  );
});

test("parses Retry-After HTTP dates", async () => {
  const { parseRetryAfterMs } = await import("../src/router.js");
  const now = Date.parse("2026-07-18T12:00:00.000Z");
  const retryAt = new Date(now + 90_000).toUTCString();
  const parsed = parseRetryAfterMs(retryAt, now);
  assert.ok(parsed !== undefined);
  assert.ok(parsed >= 89_000 && parsed <= 90_000);
});

test("does not call upstream providers while every compatible provider is cooling down", async () => {
  const { AllProvidersCoolingDownError } = await import("../src/router.js");
  const first = provider("first", 10);
  const second = provider("second", 20);
  first.cooldownUntil = Date.now() + 30_000;
  second.cooldownUntil = Date.now() + 60_000;
  let calls = 0;
  const router = new ProviderRouter([first, second], async () => {
    calls += 1;
    return new Response("{}");
  });

  await assert.rejects(
    () => router.chatCompletion({ messages: [] }),
    (error: unknown) => {
      assert.ok(error instanceof AllProvidersCoolingDownError);
      assert.equal(error.providers.length, 2);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("returns a cooldown error when every attempted provider responds with 429", async () => {
  const { AllProvidersCoolingDownError } = await import("../src/router.js");
  const router = new ProviderRouter(
    [provider("first", 10), provider("second", 20)],
    async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
  );

  await assert.rejects(
    () => router.chatCompletion({ messages: [] }),
    (error: unknown) => error instanceof AllProvidersCoolingDownError,
  );
});

test("opens a circuit after the third retryable provider failure", async () => {
  const attempts: import("../src/types.js").ProviderAttemptMetric[] = [];
  const unstable = provider("unstable-circuit", 10);
  const fallback = provider("healthy-fallback", 20);
  const router = new ProviderRouter(
    [unstable, fallback],
    async (input) => {
      if (String(input).includes("unstable-circuit")) {
        return new Response(JSON.stringify({ error: { message: "upstream down" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      stats: {
        "unstable-circuit": {
          providerId: "unstable-circuit",
          attempts: 2,
          successes: 0,
          failures: 2,
          successScore: 0.4,
          consecutiveFailures: 2,
          circuitState: "closed",
          circuitFailureCount: 2,
          circuitOpenCount: 0,
          halfOpenProbeActive: false,
        },
      },
      onAttempt: (attempt) => { attempts.push(attempt); },
    },
  );

  const result = await router.chatCompletion({ messages: [] });
  assert.equal(result.providerId, "healthy-fallback");
  assert.equal(attempts[0]?.failureType, "server_error");
  assert.equal(attempts[0]?.circuitAction, "opened");
  assert.equal(attempts[0]?.circuitState, "open");
  assert.ok((attempts[0]?.circuitOpenUntil ?? 0) > Date.now());
  assert.equal(
    result.providerEvaluations.find((item) => item.providerId === "unstable-circuit")?.state,
    "circuit-open",
  );
});

test("skips providers whose circuit is still open", async () => {
  const calls: string[] = [];
  const open = provider("open-circuit", 10);
  open.circuitState = "open";
  open.circuitOpenUntil = Date.now() + 120_000;
  open.circuitFailureCount = 3;
  open.circuitOpenCount = 1;

  const router = new ProviderRouter(
    [open, provider("closed-circuit", 20)],
    async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ choices: [] }));
    },
  );

  const result = await router.chatCompletion({ messages: [] });
  assert.equal(result.providerId, "closed-circuit");
  assert.deepEqual(calls, ["https://closed-circuit.example/v1/chat/completions"]);
  assert.equal(
    result.providerEvaluations.find((item) => item.providerId === "open-circuit")?.state,
    "circuit-open",
  );
});

test("runs one half-open probe after the circuit delay and closes on success", async () => {
  const recovering = provider("recovering", 10);
  recovering.circuitState = "open";
  recovering.circuitOpenUntil = Date.now() - 1;
  recovering.circuitFailureCount = 3;
  recovering.circuitOpenCount = 1;
  const attempts: import("../src/types.js").ProviderAttemptMetric[] = [];
  let claims = 0;

  const router = new ProviderRouter(
    [recovering],
    async () => new Response(JSON.stringify({ choices: [] }), {
      headers: { "content-type": "application/json" },
    }),
    {
      claimHalfOpenProbe: () => { claims += 1; return true; },
      onAttempt: (attempt) => { attempts.push(attempt); },
    },
  );

  const result = await router.chatCompletion({ messages: [] });
  assert.equal(result.providerId, "recovering");
  assert.equal(claims, 1);
  assert.equal(attempts[0]?.circuitAction, "closed");
  assert.equal(attempts[0]?.circuitState, "closed");
});

test("reopens a half-open circuit immediately when the recovery probe fails", async () => {
  const recovering = provider("still-down", 10);
  recovering.circuitState = "open";
  recovering.circuitOpenUntil = Date.now() - 1;
  recovering.circuitFailureCount = 3;
  recovering.circuitOpenCount = 1;
  const attempts: import("../src/types.js").ProviderAttemptMetric[] = [];

  const router = new ProviderRouter(
    [recovering],
    async () => new Response(JSON.stringify({ error: { message: "still down" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
    {
      claimHalfOpenProbe: () => true,
      onAttempt: (attempt) => { attempts.push(attempt); },
    },
  );

  await assert.rejects(() => router.chatCompletion({ messages: [] }));
  assert.equal(attempts[0]?.circuitAction, "reopened");
  assert.equal(attempts[0]?.circuitOpenCount, 2);
  assert.ok((attempts[0]?.circuitOpenUntil ?? 0) >= Date.now() + 4 * 60_000);
});

test("returns an unavailable error when every compatible circuit is open", async () => {
  const { AllProvidersUnavailableError } = await import("../src/router.js");
  const first = provider("open-one", 10);
  const second = provider("open-two", 20);
  for (const item of [first, second]) {
    item.circuitState = "open";
    item.circuitOpenUntil = Date.now() + 120_000;
    item.circuitFailureCount = 3;
    item.circuitOpenCount = 1;
  }
  let calls = 0;
  const router = new ProviderRouter([first, second], async () => {
    calls += 1;
    return new Response("{}");
  });

  await assert.rejects(
    () => router.chatCompletion({ messages: [] }),
    (error: unknown) => error instanceof AllProvidersUnavailableError,
  );
  assert.equal(calls, 0);
});

test("skips a provider whose configured quota is exhausted", async () => {
  const calls: string[] = [];
  const exhausted = provider("exhausted", 10);
  exhausted.quotaConfig = { dailyRequestLimit: 1, warningThresholdPercent: 80 };
  exhausted.quotaUsage = {
    daily: {
      period: "daily",
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      resetAt: new Date(Date.now() + 60_000).toISOString(),
      requests: 1,
      successfulRequests: 1,
      failedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    monthly: {
      period: "monthly",
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      resetAt: new Date(Date.now() + 120_000).toISOString(),
      requests: 1,
      successfulRequests: 1,
      failedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  };
  const available = provider("available", 20);
  const router = new ProviderRouter([exhausted, available], async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ choices: [] }), {
      headers: { "content-type": "application/json" },
    });
  });

  const result = await router.chatCompletion({ messages: [] });
  assert.equal(result.providerId, "available");
  assert.deepEqual(calls, ["https://available.example/v1/chat/completions"]);
  assert.equal(
    result.providerEvaluations.find((item) => item.providerId === "exhausted")?.state,
    "quota-exhausted",
  );
});

test("demotes a provider that has crossed its quota warning threshold", async () => {
  const warned = provider("warned", 10);
  warned.quotaConfig = { dailyRequestLimit: 10, warningThresholdPercent: 80 };
  warned.quotaUsage = {
    daily: {
      period: "daily",
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      resetAt: new Date(Date.now() + 60_000).toISOString(),
      requests: 8,
      successfulRequests: 8,
      failedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    monthly: {
      period: "monthly",
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      resetAt: new Date(Date.now() + 120_000).toISOString(),
      requests: 8,
      successfulRequests: 8,
      failedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  };

  const router = new ProviderRouter(
    [warned, provider("healthy", 20)],
    async () => new Response(JSON.stringify({ choices: [] }), {
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal((await router.chatCompletion({ messages: [] })).providerId, "healthy");
});

test("returns a quota error without calling upstream when every provider is exhausted", async () => {
  const only = provider("only", 10);
  only.quotaConfig = { dailyTokenLimit: 100, warningThresholdPercent: 80 };
  only.quotaUsage = {
    daily: {
      period: "daily",
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      resetAt: new Date(Date.now() + 60_000).toISOString(),
      requests: 1,
      successfulRequests: 1,
      failedRequests: 0,
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    },
    monthly: {
      period: "monthly",
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      resetAt: new Date(Date.now() + 120_000).toISOString(),
      requests: 1,
      successfulRequests: 1,
      failedRequests: 0,
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    },
  };
  let calls = 0;
  const router = new ProviderRouter([only], async () => {
    calls += 1;
    return new Response();
  });

  await assert.rejects(
    () => router.chatCompletion({ messages: [] }),
    (error: unknown) => {
      assert.equal((error as Error).name, "Error");
      assert.match((error as Error).message, /exhausted their configured quota/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test("stops failover at the configured maximum provider attempts", async () => {
  const { AllProvidersFailedError } = await import("../src/router.js");
  const { DEFAULT_RELIABILITY_SETTINGS } = await import("../src/reliability-settings.js");
  const calls: string[] = [];
  const router = new ProviderRouter(
    [provider("one", 10), provider("two", 20), provider("three", 30)],
    async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ error: { message: "unavailable" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
    {
      reliability: {
        ...DEFAULT_RELIABILITY_SETTINGS,
        maxProviderAttempts: 2,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        useJitter: false,
      },
    },
  );

  await assert.rejects(
    () => router.chatCompletion({ messages: [] }),
    (error: unknown) => {
      assert.ok(error instanceof AllProvidersFailedError);
      assert.equal(error.retryStopReason, "maximum_attempts_reached");
      assert.equal(error.providerAttempts.length, 2);
      assert.equal(error.providerAttempts[1]?.retryStopReason, "maximum_attempts_reached");
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("immediately fails over when a provider model returns 404", async () => {
  const { DEFAULT_RELIABILITY_SETTINGS } = await import("../src/reliability-settings.js");
  const calls: string[] = [];
  const router = new ProviderRouter(
    [provider("openrouter", 10), provider("groq", 20)],
    async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("openrouter")) {
        return new Response(JSON.stringify({
          error: {
            message: "This model is unavailable for free. Use a different slug.",
          },
        }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      reliability: {
        ...DEFAULT_RELIABILITY_SETTINGS,
        initialBackoffMs: 2_000,
        maxBackoffMs: 2_000,
        useJitter: false,
      },
    },
  );

  const result = await router.chatCompletion({ messages: [] });
  assert.equal(result.providerId, "groq");
  assert.deepEqual(calls, [
    "https://openrouter.example/v1/chat/completions",
    "https://groq.example/v1/chat/completions",
  ]);
  assert.equal(result.attempts[0]?.status, 404);
  assert.equal(result.attempts[0]?.retryable, false);
  assert.equal(result.attempts[0]?.recoveryAction, "immediate_failover");
  assert.equal(
    result.attempts[0]?.failoverReason,
    "provider_model_or_endpoint_unavailable",
  );
  assert.equal(result.attempts[0]?.retryDelayMs, undefined);
  assert.equal(result.attempts[0]?.circuitAction, undefined);
  assert.equal(result.attempts[0]?.circuitFailureCount, 0);
});

test("immediately fails over after provider-specific 401 and 403 responses", async () => {
  const { DEFAULT_RELIABILITY_SETTINGS } = await import("../src/reliability-settings.js");

  for (const [status, expectedReason] of [
    [401, "provider_authentication_failed"],
    [403, "provider_access_denied"],
  ] as const) {
    const calls: string[] = [];
    const router = new ProviderRouter(
      [provider(`blocked-${status}`, 10), provider(`healthy-${status}`, 20)],
      async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes(`blocked-${status}`)) {
          return new Response(JSON.stringify({ error: { message: "provider rejected access" } }), {
            status,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      {
        reliability: {
          ...DEFAULT_RELIABILITY_SETTINGS,
          initialBackoffMs: 1_000,
          maxBackoffMs: 1_000,
          useJitter: false,
        },
      },
    );

    const result = await router.chatCompletion({ messages: [] });
    assert.equal(result.providerId, `healthy-${status}`);
    assert.equal(calls.length, 2);
    assert.equal(result.attempts[0]?.recoveryAction, "immediate_failover");
    assert.equal(result.attempts[0]?.failoverReason, expectedReason);
    assert.equal(result.attempts[0]?.retryDelayMs, undefined);
  }
});

test("does not fail over when a client request is rejected with 400", async () => {
  const { AllProvidersFailedError } = await import("../src/router.js");
  const { DEFAULT_RELIABILITY_SETTINGS } = await import("../src/reliability-settings.js");
  const calls: string[] = [];
  const router = new ProviderRouter(
    [provider("invalid-request", 10), provider("unused", 20)],
    async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ error: { message: "invalid request body" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
    {
      reliability: {
        ...DEFAULT_RELIABILITY_SETTINGS,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        useJitter: false,
      },
    },
  );

  await assert.rejects(
    () => router.chatCompletion({ messages: [] }),
    (error: unknown) => {
      assert.ok(error instanceof AllProvidersFailedError);
      assert.equal(error.retryStopReason, "error_not_retryable");
      assert.equal(error.providerAttempts[0]?.retryable, false);
      assert.equal(error.providerAttempts[0]?.recoveryAction, "stop");
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("supports custom retryable statuses and records the configured backoff", async () => {
  const { DEFAULT_RELIABILITY_SETTINGS } = await import("../src/reliability-settings.js");
  const calls: string[] = [];
  const router = new ProviderRouter(
    [provider("teapot", 10), provider("fallback", 20)],
    async (input) => {
      calls.push(String(input));
      if (String(input).includes("teapot")) {
        return new Response(JSON.stringify({ error: { message: "try another provider" } }), {
          status: 418,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      reliability: {
        ...DEFAULT_RELIABILITY_SETTINGS,
        retryStatusCodes: [418],
        initialBackoffMs: 25,
        maxBackoffMs: 25,
        useJitter: false,
      },
    },
  );

  const result = await router.chatCompletion({ messages: [] });
  assert.equal(result.providerId, "fallback");
  assert.equal(result.attempts[0]?.retryDelayMs, 25);
  assert.equal(result.attempts[0]?.retryable, true);
  assert.deepEqual(calls, [
    "https://teapot.example/v1/chat/completions",
    "https://fallback.example/v1/chat/completions",
  ]);
});

test("applies provider-specific timeout overrides and fails over after timeout", async () => {
  const { DEFAULT_RELIABILITY_SETTINGS } = await import("../src/reliability-settings.js");
  const calls: string[] = [];
  const router = new ProviderRouter(
    [provider("slow", 10), provider("fast", 20)],
    async (input, init) => {
      calls.push(String(input));
      if (String(input).includes("slow")) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("aborted"));
          }, { once: true });
        });
      }
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      reliability: {
        ...DEFAULT_RELIABILITY_SETTINGS,
        providerTimeoutMs: 5_000,
        totalRequestTimeoutMs: 5_000,
        providerTimeoutOverrides: { slow: 1_000 },
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        useJitter: false,
      },
    },
  );

  const result = await router.chatCompletion({ messages: [] });
  assert.equal(result.providerId, "fast");
  assert.equal(result.attempts[0]?.providerId, "slow");
  assert.equal(result.attempts[0]?.providerTimeoutMs, 1_000);
  assert.equal(result.attempts[0]?.failureType, "timeout");
  assert.deepEqual(calls, [
    "https://slow.example/v1/chat/completions",
    "https://fast.example/v1/chat/completions",
  ]);
});

test("can disable failover for network failures", async () => {
  const { AllProvidersFailedError } = await import("../src/router.js");
  const { DEFAULT_RELIABILITY_SETTINGS } = await import("../src/reliability-settings.js");
  let calls = 0;
  const router = new ProviderRouter(
    [provider("offline", 10), provider("unused", 20)],
    async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    },
    {
      reliability: {
        ...DEFAULT_RELIABILITY_SETTINGS,
        retryNetworkErrors: false,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
      },
    },
  );

  await assert.rejects(
    () => router.chatCompletion({ messages: [] }),
    (error: unknown) => {
      assert.ok(error instanceof AllProvidersFailedError);
      assert.equal(error.retryStopReason, "error_not_retryable");
      assert.equal(error.providerAttempts[0]?.retryable, false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("can disable failover for malformed successful responses", async () => {
  const { AllProvidersFailedError } = await import("../src/router.js");
  const { DEFAULT_RELIABILITY_SETTINGS } = await import("../src/reliability-settings.js");
  let calls = 0;
  const router = new ProviderRouter(
    [provider("malformed", 10), provider("unused", 20)],
    async () => {
      calls += 1;
      return new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      reliability: {
        ...DEFAULT_RELIABILITY_SETTINGS,
        retryMalformedResponses: false,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
      },
    },
  );

  await assert.rejects(
    () => router.chatCompletion({ messages: [] }),
    (error: unknown) => {
      assert.ok(error instanceof AllProvidersFailedError);
      assert.equal(error.retryStopReason, "error_not_retryable");
      assert.equal(error.providerAttempts[0]?.failureType, "malformed_response");
      assert.equal(error.providerAttempts[0]?.retryable, false);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("enforces the total request deadline across the active provider attempt", async () => {
  const { AllProvidersFailedError } = await import("../src/router.js");
  const { DEFAULT_RELIABILITY_SETTINGS } = await import("../src/reliability-settings.js");
  let calls = 0;
  const router = new ProviderRouter(
    [provider("hanging", 10), provider("unused", 20)],
    async (_input, init) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        }, { once: true });
      });
    },
    {
      reliability: {
        ...DEFAULT_RELIABILITY_SETTINGS,
        providerTimeoutMs: 5_000,
        totalRequestTimeoutMs: 1_000,
        maxProviderAttempts: 2,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
        useJitter: false,
      },
    },
  );

  await assert.rejects(
    () => router.chatCompletion({ messages: [] }),
    (error: unknown) => {
      assert.ok(error instanceof AllProvidersFailedError);
      assert.equal(error.retryStopReason, "total_request_deadline_exceeded");
      const timeoutMs = error.providerAttempts[0]?.providerTimeoutMs ?? 0;
      assert.ok(timeoutMs > 900 && timeoutMs <= 1_000, `Expected timeout ~1000ms, got ${timeoutMs}`);
      assert.equal(error.providerAttempts[0]?.retryStopReason, "total_request_deadline_exceeded");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("strict capability mode skips providers with unknown required support", async () => {
  const unknown = provider("unknown-tools", 10);
  unknown.capabilities.tools = "unknown";
  const supported = provider("verified-tools", 20);
  const calls: string[] = [];
  const router = new ProviderRouter(
    [unknown, supported],
    async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    { capabilityUnknownMode: "strict" },
  );

  const result = await router.chatCompletion({
    messages: [],
    tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
  });
  assert.equal(result.providerId, "verified-tools");
  assert.deepEqual(calls, ["https://verified-tools.example/v1/chat/completions"]);
  assert.equal(result.providerEvaluations.find((item) => item.providerId === "unknown-tools")?.state, "incompatible");
});

test("clear capability-specific client errors update evidence and fail over immediately", async () => {
  const attempts: import("../src/types.js").ProviderAttemptMetric[] = [];
  const calls: string[] = [];
  const router = new ProviderRouter(
    [provider("no-vision", 10), provider("vision-fallback", 20)],
    async (input) => {
      calls.push(String(input));
      if (String(input).includes("no-vision")) {
        return new Response(JSON.stringify({ error: { message: "This model does not support image inputs" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    { onAttempt: (attempt) => { attempts.push(attempt); } },
  );

  const result = await router.chatCompletion({
    messages: [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }],
    }],
  });
  assert.equal(result.providerId, "vision-fallback");
  assert.deepEqual(calls, [
    "https://no-vision.example/v1/chat/completions",
    "https://vision-fallback.example/v1/chat/completions",
  ]);
  assert.equal(attempts[0]?.recoveryAction, "immediate_failover");
  assert.equal(attempts[0]?.failoverReason, "provider_capability_unsupported");
  assert.deepEqual(attempts[0]?.observedUnsupportedCapabilities, ["vision"]);
});
