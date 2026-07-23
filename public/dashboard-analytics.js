function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSuccess(request) {
  return number(request?.status) >= 200 && number(request?.status) < 300;
}

function isDeduplicated(request) {
  return request?.deduplication?.deduplicated === true;
}

function apiFormat(request) {
  return request?.apiFormat || "unknown";
}

function aliasName(request) {
  return request?.resolvedAlias || request?.requestedModel || request?.request?.model || "unknown";
}

function clientInfo(request) {
  return request?.clientApplication?.id && request?.clientApplication?.name
    ? request.clientApplication
    : { id: "unknown", name: "Unknown client", detectedBy: "unknown" };
}

function isStreaming(request) {
  return typeof request?.streaming === "boolean" ? request.streaming : request?.request?.stream === true;
}

function hasTools(request) {
  if (request?.toolAnalytics?.toolRequest === true) return true;
  return Array.isArray(request?.request?.tools) && request.request.tools.length > 0;
}

function generatedToolCalls(request) {
  return number(request?.toolAnalytics?.generatedToolCallCount);
}

function fallbackPath(request) {
  if (Array.isArray(request?.fallbackPath) && request.fallbackPath.length) return request.fallbackPath.filter(Boolean);
  if (Array.isArray(request?.providerAttempts) && request.providerAttempts.length) {
    return request.providerAttempts.map((attempt) => attempt?.providerId).filter(Boolean);
  }
  return request?.providerId ? [request.providerId] : [];
}

function attemptsFor(request) {
  if (Array.isArray(request?.providerAttempts) && request.providerAttempts.length) {
    return request.providerAttempts
      .filter((attempt) => attempt?.providerId)
      .map((attempt) => ({
        providerId: attempt.providerId,
        success: attempt.success === true,
        latencyMs: number(attempt.latencyMs),
      }));
  }
  const path = fallbackPath(request);
  if (path.length) {
    return path.map((providerId, index) => ({
      providerId,
      success: index === path.length - 1 && isSuccess(request),
      latencyMs: index === path.length - 1 ? number(request?.latencyMs) : 0,
    }));
  }
  return [];
}

function percentile(values, percentileValue) {
  const sorted = values.map(number).filter((value) => value >= 0).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const position = Math.max(0, Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[position] ?? 0;
}

function average(total, count) {
  return count ? total / count : 0;
}

function percentage(count, total) {
  return total ? count / total : 0;
}

function finalizeProvider(item) {
  return {
    ...item,
    successRate: percentage(item.successes, item.attempts),
    averageAttemptLatencyMs: average(item.attemptLatencyTotal, item.attemptLatencyValues.length),
    p95AttemptLatencyMs: percentile(item.attemptLatencyValues, 95),
    averageRequestLatencyMs: average(item.requestLatencyTotal, item.completedRequests),
    fallbackRate: percentage(item.fallbackStarts, item.startedRequests),
  };
}

export function summarizeProviderDashboard(requests = []) {
  const providers = new Map();
  const upstream = requests.filter((request) => !isDeduplicated(request));
  const ensure = (providerId) => {
    const current = providers.get(providerId) ?? {
      providerId,
      attempts: 0,
      successes: 0,
      failures: 0,
      attemptLatencyTotal: 0,
      attemptLatencyValues: [],
      completedRequests: 0,
      completedSuccesses: 0,
      requestLatencyTotal: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      startedRequests: 0,
      fallbackStarts: 0,
      fallbackRecoveries: 0,
      streamingRequests: 0,
      toolRequests: 0,
    };
    providers.set(providerId, current);
    return current;
  };

  for (const request of upstream) {
    const path = fallbackPath(request);
    if (path[0]) {
      const starter = ensure(path[0]);
      starter.startedRequests += 1;
      if (path.length > 1) starter.fallbackStarts += 1;
    }

    for (const attempt of attemptsFor(request)) {
      const item = ensure(attempt.providerId);
      item.attempts += 1;
      if (attempt.success) item.successes += 1;
      else item.failures += 1;
      item.attemptLatencyTotal += attempt.latencyMs;
      if (attempt.latencyMs > 0) item.attemptLatencyValues.push(attempt.latencyMs);
    }

    if (!request?.providerId) continue;
    const finalProvider = ensure(request.providerId);
    finalProvider.completedRequests += 1;
    if (isSuccess(request)) finalProvider.completedSuccesses += 1;
    finalProvider.requestLatencyTotal += number(request?.latencyMs);
    finalProvider.tokens += number(request?.usage?.totalTokens);
    finalProvider.inputTokens += number(request?.usage?.inputTokens);
    finalProvider.outputTokens += number(request?.usage?.outputTokens);
    if (isStreaming(request)) finalProvider.streamingRequests += 1;
    if (hasTools(request)) finalProvider.toolRequests += 1;
    if (path.length > 1 && isSuccess(request)) finalProvider.fallbackRecoveries += 1;
  }

  return [...providers.values()]
    .map(finalizeProvider)
    .sort((left, right) => right.completedRequests - left.completedRequests || right.attempts - left.attempts);
}

function createDimensionItem(id, name) {
  return {
    id,
    name,
    requests: 0,
    successes: 0,
    failures: 0,
    latencyTotal: 0,
    latencyValues: [],
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    upstreamRequests: 0,
    fallbackRequests: 0,
    providerAttempts: 0,
    streamingRequests: 0,
    toolRequests: 0,
    generatedToolCalls: 0,
  };
}

function addRequestToDimension(item, request) {
  item.requests += 1;
  if (isSuccess(request)) item.successes += 1;
  else item.failures += 1;
  const latency = number(request?.latencyMs);
  item.latencyTotal += latency;
  if (latency > 0) item.latencyValues.push(latency);
  if (isStreaming(request)) item.streamingRequests += 1;
  if (hasTools(request)) item.toolRequests += 1;
  item.generatedToolCalls += generatedToolCalls(request);

  if (!isDeduplicated(request)) {
    item.upstreamRequests += 1;
    item.tokens += number(request?.usage?.totalTokens);
    item.inputTokens += number(request?.usage?.inputTokens);
    item.outputTokens += number(request?.usage?.outputTokens);
    const path = fallbackPath(request);
    if (path.length > 1) item.fallbackRequests += 1;
    item.providerAttempts += attemptsFor(request).length || (request?.providerId ? 1 : 0);
  }
}

function finalizeDimension(item) {
  return {
    ...item,
    successRate: percentage(item.successes, item.requests),
    averageLatencyMs: average(item.latencyTotal, item.requests),
    p95LatencyMs: percentile(item.latencyValues, 95),
    fallbackRate: percentage(item.fallbackRequests, item.upstreamRequests),
    streamingRate: percentage(item.streamingRequests, item.requests),
    toolRate: percentage(item.toolRequests, item.requests),
    averageAttempts: average(item.providerAttempts, item.upstreamRequests),
  };
}

export function summarizeApiAndModelDashboard(requests = []) {
  const apis = new Map();
  const aliases = new Map();

  for (const request of requests) {
    const format = apiFormat(request);
    const apiItem = apis.get(format) ?? createDimensionItem(format, format);
    addRequestToDimension(apiItem, request);
    apis.set(format, apiItem);

    const alias = aliasName(request);
    const aliasItem = aliases.get(alias) ?? createDimensionItem(alias, alias);
    addRequestToDimension(aliasItem, request);
    aliases.set(alias, aliasItem);
  }

  return {
    apis: [...apis.values()].map(finalizeDimension).sort((left, right) => right.requests - left.requests),
    aliases: [...aliases.values()].map(finalizeDimension).sort((left, right) => right.requests - left.requests),
  };
}

export function summarizeApplicationDashboard(requests = []) {
  const applications = new Map();

  for (const request of requests) {
    const client = clientInfo(request);
    const item = applications.get(client.id) ?? {
      ...createDimensionItem(client.id, client.name),
      application: client,
      apiFormats: new Map(),
      aliases: new Map(),
    };
    addRequestToDimension(item, request);
    const format = apiFormat(request);
    item.apiFormats.set(format, (item.apiFormats.get(format) ?? 0) + 1);
    const alias = aliasName(request);
    item.aliases.set(alias, (item.aliases.get(alias) ?? 0) + 1);
    applications.set(client.id, item);
  }

  return [...applications.values()]
    .map((item) => {
      const finalized = finalizeDimension(item);
      const apiMix = [...item.apiFormats.entries()].sort((left, right) => right[1] - left[1]);
      const aliasMix = [...item.aliases.entries()].sort((left, right) => right[1] - left[1]);
      return {
        ...finalized,
        application: item.application,
        apiMix,
        aliasMix,
        topApiFormat: apiMix[0]?.[0] ?? "unknown",
        topAlias: aliasMix[0]?.[0] ?? "unknown",
      };
    })
    .sort((left, right) => right.requests - left.requests);
}
