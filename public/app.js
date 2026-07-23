import { Clerk } from "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@6.21.0/+esm";
import {
  summarizeApiAndModelDashboard,
  summarizeApplicationDashboard,
  summarizeProviderDashboard,
} from "./dashboard-analytics.js";

const storageKey = "free-llm-router-key";
const state = {
  routerKey: localStorage.getItem(storageKey),
  sessionToken: null,
  providers: [],
  account: null,
  authUser: null,
  analytics: { requests: [], frequency: [] },
  analyticsError: null,
  activeSnippet: "curl",
  activeDocsTab: "integration",
  activeAnalysisTab: "analytics",
  activeAnalyticsDashboard: "overview",
  activeSettingsTab: "account",
  activeRouterSettingsTab: "routing",
  routingProviderOrder: [],
  routingDragProvider: null,
  modelAliasesDraft: [],
  modelAliasesDirty: false,
  analyticsFilters: {
    timeRange: "12",
    provider: "all",
    apiFormat: "all",
    status: "all",
    alias: "all",
    clientApplication: "all",
    streaming: "all",
    toolUsage: "all",
    search: "",
  },
  logFilters: {
    timeRange: "12",
    provider: "all",
    apiFormat: "all",
    status: "all",
    alias: "all",
    clientApplication: "all",
    streaming: "all",
    toolUsage: "all",
    search: "",
  },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const authGate = $("#auth-gate");
const welcome = $("#welcome");
const dashboard = $("#dashboard");
const toast = $("#toast");
const modal = $("#key-modal");
const quotaModal = $("#quota-modal");
const modelModal = $("#model-modal");
const drawer = $("#request-drawer");
let pageScrollPosition = 0;

function lockPageScroll() {
  if (document.body.classList.contains("drawer-open")) return;
  pageScrollPosition = window.scrollY;
  document.documentElement.classList.add("drawer-open");
  document.body.classList.add("drawer-open");
  document.body.style.top = `-${pageScrollPosition}px`;
}

function unlockPageScroll() {
  if (!document.body.classList.contains("drawer-open")) return;
  document.documentElement.classList.remove("drawer-open");
  document.body.classList.remove("drawer-open");
  document.body.style.top = "";
  window.scrollTo({ top: pageScrollPosition, left: 0, behavior: "instant" });
}

function closeRequestDrawer() {
  drawer.hidden = true;
  unlockPageScroll();
}

function providerLogoPath(providerId) {
  return `/assets/providers/${encodeURIComponent(providerId)}.svg`;
}

function providerLogoMarkup(provider, size = "normal") {
  const initial = escapeHtml(provider?.name?.trim()?.charAt(0) || "?");
  const name = escapeHtml(provider?.name || "Provider");
  const id = escapeHtml(provider?.id || "");

  return `
    <span class="provider-logo-wrap ${size === "small" ? "small" : ""}" data-provider-initial="${initial}">
      <img
        class="provider-logo"
        src="/assets/providers/${id}.svg"
        alt="${name} logo"
        loading="lazy"
      />
    </span>
  `;
}

function bindProviderLogoFallbacks(root = document) {
  root.querySelectorAll(".provider-logo").forEach((image) => {
    image.addEventListener("error", () => {
      const wrapper = image.closest(".provider-logo-wrap");
      if (!wrapper) return;
      image.remove();
      wrapper.classList.add("logo-fallback");
      wrapper.textContent = wrapper.dataset.providerInitial || "?";
    }, { once: true });
  });
}



function notify(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 2400);
}

async function api(path, options = {}) {
  const freshSessionToken =
    (await window.freeLlmClerk?.session?.getToken()) ?? state.sessionToken;
  state.sessionToken = freshSessionToken;

  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(freshSessionToken ? { "x-clerk-session-token": freshSessionToken } : {}),
      ...(state.routerKey ? { authorization: `Bearer ${state.routerKey}` } : {}),
      ...options.headers,
    },
  });

  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message ?? body?.error ?? "Request failed");
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);
}

function providerDisplayName(providerId) {
  return state.providers.find((provider) => provider.id === providerId)?.name ?? providerId;
}

function providerById(providerId) {
  return state.providers.find((provider) => provider.id === providerId);
}

const routingStrategyLabels = {
  priority: "Priority",
  fastest: "Fastest",
  "round-robin": "Round robin",
  "least-used": "Least used",
  reliability: "Reliability",
  smart: "Smart",
};

function routingStrategyLabel(strategy) {
  return routingStrategyLabels[strategy] ?? "Priority";
}

const aliasStrategyLabels = {
  inherit: "Use router policy",
  ...routingStrategyLabels,
};


const defaultReliabilitySettings = {
  providerTimeoutMs: 30000,
  totalRequestTimeoutMs: 90000,
  maxProviderAttempts: 3,
  initialBackoffMs: 250,
  maxBackoffMs: 3000,
  backoffMultiplier: 2,
  useJitter: true,
  retryStatusCodes: [408, 409, 425, 429, 500, 502, 503, 504],
  retryNetworkErrors: true,
  retryMalformedResponses: true,
  streamingConnectionTimeoutMs: 30000,
  halfOpenProbeTimeoutMs: 10000,
  providerTimeoutOverrides: {},
};

const defaultDeduplicationSettings = {
  enabled: true,
  windowMs: 30000,
  automaticFingerprinting: true,
  requireIdempotencyKey: false,
  bypassToolRequests: true,
  bypassMultimodalRequests: true,
  bypassNonDeterministicRequests: true,
};

function deduplicationSettings(source = state.account?.deduplicationSettings) {
  return {
    ...defaultDeduplicationSettings,
    ...(source ?? {}),
  };
}

function reliabilitySettings(source = state.account?.reliabilitySettings) {
  return {
    ...defaultReliabilitySettings,
    ...(source ?? {}),
    retryStatusCodes: [...(source?.retryStatusCodes ?? defaultReliabilitySettings.retryStatusCodes)],
    providerTimeoutOverrides: {
      ...(source?.providerTimeoutOverrides ?? {}),
    },
  };
}

function millisecondsToSeconds(value) {
  return Math.round((Number(value) || 0) / 1000);
}

function parseRetryStatusCodes(value) {
  return [...new Set(String(value ?? "")
    .split(/[\s,]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 400 && item <= 599))]
    .sort((left, right) => left - right);
}

function aliasStrategyLabel(strategy) {
  return aliasStrategyLabels[strategy] ?? "Use router policy";
}

function cloneModelAliases(aliases) {
  return (Array.isArray(aliases) ? aliases : []).map((alias) => ({
    ...alias,
    requiredCapabilities: [...(alias.requiredCapabilities ?? [])],
    eligibleProviderIds: [...(alias.eligibleProviderIds ?? [])],
    providerOrder: [...(alias.providerOrder ?? [])],
    ...(alias.reliabilityOverrides
      ? {
          reliabilityOverrides: {
            ...alias.reliabilityOverrides,
            ...(alias.reliabilityOverrides.retryStatusCodes
              ? { retryStatusCodes: [...alias.reliabilityOverrides.retryStatusCodes] }
              : {}),
            ...(alias.reliabilityOverrides.providerTimeoutOverrides
              ? { providerTimeoutOverrides: { ...alias.reliabilityOverrides.providerTimeoutOverrides } }
              : {}),
          },
        }
      : {}),
  }));
}

function enabledModelAliases() {
  return (state.account?.modelAliases ?? []).filter((alias) => alias.enabled !== false);
}

function modelAliasById(aliasId, source = state.modelAliasesDraft) {
  return (source ?? []).find((alias) => alias.id === aliasId);
}

function defaultModelForApi(apiFormat) {
  if (apiFormat === "claude-code-compatible") return "claude-free-router";
  if (apiFormat === "openai-responses-compatible") return "codex-free-router";
  return "free-router";
}

function normalizeAliasProviderOrder(alias) {
  const configuredIds = configuredProviders().map((provider) => provider.id);
  const saved = Array.isArray(alias.providerOrder) ? alias.providerOrder : [];
  return [
    ...saved.filter((id) => configuredIds.includes(id)),
    ...configuredIds.filter((id) => !saved.includes(id)),
  ];
}

const providerCapabilityLabels = {
  streaming: "Streaming",
  tools: "Tools",
  jsonMode: "JSON",
  structuredOutputs: "Schema",
  vision: "Vision",
  reasoning: "Reasoning",
  embeddings: "Embeddings",
  contextWindow: "Context window",
};

const providerCapabilityOrder = [
  "streaming",
  "tools",
  "jsonMode",
  "structuredOutputs",
  "vision",
  "reasoning",
  "embeddings",
];

function capabilityLabel(capability) {
  return providerCapabilityLabels[capability] ?? capability;
}

function formatTokenCapacity(tokens) {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return "Unknown";
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(0)}K`;
  }
  return String(value);
}

function providerCapabilityBadges(provider, limit = 4) {
  const capabilities = provider?.capabilities ?? {};
  const supported = providerCapabilityOrder.filter(
    (name) => capabilities[name] === "supported",
  );
  const visible = supported.slice(0, limit);
  const hiddenCount = Math.max(0, supported.length - visible.length);

  const badges = visible.map((name) => `
    <span class="capability-chip supported">
      <span class="capability-chip-dot"></span>
      ${escapeHtml(capabilityLabel(name))}
    </span>
  `);

  if (hiddenCount > 0) {
    badges.push(`<span class="capability-chip more">+${hiddenCount} more</span>`);
  }

  if (badges.length === 0) {
    const unknownCount = providerCapabilityOrder.filter(
      (name) => capabilities[name] === "unknown",
    ).length;
    return unknownCount
      ? `<span class="capability-chip unknown">Capabilities unverified</span>`
      : `<span class="capability-chip unsupported">No verified capabilities</span>`;
  }

  return badges.join("");
}

function providerCapabilityCounts(provider) {
  const capabilities = provider?.capabilities ?? {};
  return providerCapabilityOrder.reduce((counts, name) => {
    const status = capabilities[name] ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, { supported: 0, unknown: 0, unsupported: 0 });
}

function providerCapacityFactsMarkup(provider) {
  const capabilities = provider?.capabilities ?? {};
  const facts = [
    capabilities.contextWindow
      ? `<span><small>Context</small><strong>${escapeHtml(formatTokenCapacity(capabilities.contextWindow))}</strong></span>`
      : "",
    capabilities.maxOutputTokens
      ? `<span><small>Max output</small><strong>${escapeHtml(formatTokenCapacity(capabilities.maxOutputTokens))}</strong></span>`
      : "",
    provider.freeTier
      ? `<span><small>Access</small><strong>${escapeHtml(provider.freeTier)}</strong></span>`
      : "",
  ].filter(Boolean);
  return facts.join("");
}

function providerCapabilitySummary(provider) {
  const capabilities = provider?.capabilities ?? {};
  const supported = providerCapabilityOrder
    .filter((name) => capabilities[name] === "supported")
    .slice(0, 4)
    .map(capabilityLabel);
  const context = capabilities.contextWindow
    ? `${formatTokenCapacity(capabilities.contextWindow)} context`
    : null;
  return [...supported, context].filter(Boolean).join(" · ") || "Capabilities unverified";
}

function capabilityStateMarkup(status) {
  const normalized = ["supported", "unsupported", "unknown"].includes(status)
    ? status
    : "unknown";
  const symbol = normalized === "supported" ? "✓" : normalized === "unsupported" ? "—" : "?";
  const label = normalized === "supported"
    ? "Supported"
    : normalized === "unsupported"
      ? "Not supported"
      : "Unverified";
  return `<span class="capability-state ${normalized}" title="${label}" aria-label="${label}">${symbol}</span>`;
}

function capabilityMatchLabel(level) {
  if (level === "full") return "Verified match";
  if (level === "partial") return "Unverified match";
  return "Incompatible";
}

function providerEvaluationReason(evaluation, selectedProviderId, selectedCandidateRank) {
  const providerName = providerDisplayName(evaluation.providerId);
  const match = evaluation.match ?? {};
  const unsupported = (match.unsupported ?? []).map(capabilityLabel);
  const unknown = (match.unknown ?? []).map(capabilityLabel);

  if (evaluation.providerId === selectedProviderId) {
    const rank = evaluation.candidateRank ? `Candidate #${evaluation.candidateRank}` : "Selected candidate";
    const recovery = evaluation.state === "half-open" ? " · recovery probe" : "";
    return {
      tone: evaluation.state === "half-open" ? "testing" : "selected",
      label: evaluation.state === "half-open" ? "Recovered" : "Selected",
      detail: `${rank} · ${capabilityMatchLabel(match.level)}${recovery}`,
    };
  }

  if (evaluation.state === "incompatible") {
    return {
      tone: "skipped",
      label: "Skipped",
      detail: unsupported.length
        ? `Missing ${unsupported.join(", ")}`
        : "Request requirements are not supported",
    };
  }

  if (evaluation.state === "quota-exhausted") {
    const reset = evaluation.quotaResetAt
      ? new Date(evaluation.quotaResetAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "the next quota window";
    return {
      tone: "quota-exhausted",
      label: "Quota reached",
      detail: `Skipped at ${evaluation.quotaConsumedPercent ?? 100}% usage. Resets ${reset}`,
    };
  }

  if (evaluation.state === "cooldown") {
    const until = evaluation.cooldownUntil
      ? new Date(evaluation.cooldownUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
      : "later";
    return {
      tone: "cooldown",
      label: "Cooldown",
      detail: evaluation.cooldownReason === "rate_limit"
        ? `Skipped after a rate limit. Available at ${until}`
        : `Temporarily unavailable until ${until}`,
    };
  }

  if (evaluation.state === "circuit-open") {
    const remaining = evaluation.circuitOpenUntil
      ? formatCooldownRemaining(evaluation.circuitOpenUntil - Date.now())
      : "later";
    const failure = formatProviderFailureType(evaluation.lastFailureType);
    return {
      tone: "circuit-open",
      label: "Circuit open",
      detail: `${failure ? `${failure} · ` : ""}Recovery available in ${remaining}`,
    };
  }

  if (evaluation.state === "half-open") {
    return {
      tone: "testing",
      label: "Testing",
      detail: "A single half-open recovery probe is in progress",
    };
  }

  if (
    evaluation.state === "candidate"
    && evaluation.candidateRank
    && selectedCandidateRank
    && evaluation.candidateRank < selectedCandidateRank
  ) {
    return {
      tone: "attempted",
      label: "Attempted",
      detail: `Candidate #${evaluation.candidateRank} was tried before the selected provider`,
    };
  }

  if (unknown.length) {
    return {
      tone: "partial",
      label: "Fallback",
      detail: `Support unverified for ${unknown.join(", ")}`,
    };
  }

  return {
    tone: "eligible",
    label: "Fallback",
    detail: evaluation.candidateRank
      ? `Eligible candidate #${evaluation.candidateRank}`
      : `${providerName} was eligible`,
  };
}

function normalizedRoutingProviderOrder() {
  const configuredIds = configuredProviders().map((provider) => provider.id);
  const saved = state.account?.routingPolicy?.providerOrder ?? [];
  return [
    ...saved.filter((id) => configuredIds.includes(id)),
    ...configuredIds.filter((id) => !saved.includes(id)),
  ];
}

function configuredProviders() {
  return state.providers.filter((provider) => provider.configured);
}
function setCircuitActionBusy(
  button,
  busy,
  busyLabel = "Testing…",
) {
  if (!button) return;

  const label = button.querySelector(
    "[data-circuit-action-label]",
  );

  if (label && !button.dataset.originalActionLabel) {
    button.dataset.originalActionLabel =
      label.textContent.trim();
  }

  button.disabled = busy;
  button.classList.toggle("is-loading", busy);
  button.setAttribute("aria-busy", String(busy));

  if (label) {
    label.textContent = busy
      ? busyLabel
      : button.dataset.originalActionLabel;
  }
}
function providerCooldown(provider) {
  const stats = provider?.routingStats ?? {};
  const cooldownUntil = Number(stats.cooldownUntil ?? 0);
  const active = Number.isFinite(cooldownUntil) && cooldownUntil > Date.now();
  return {
    active,
    cooldownUntil,
    reason: stats.cooldownReason ?? "rate_limit",
    rateLimitCount: Number(stats.rateLimitCount ?? 0),
    retryAfterSeconds: Number(stats.lastRetryAfterSeconds ?? 0),
  };
}

function providerCircuit(provider) {
  const stats = provider?.routingStats ?? {};
  const state = stats.circuitState ?? "closed";
  const circuitOpenUntil = Number(stats.circuitOpenUntil ?? 0);
  const now = Date.now();
  return {
    state,
    open: state === "open" && circuitOpenUntil > now,
    ready: state === "open" && circuitOpenUntil <= now,
    halfOpen: state === "half-open",
    circuitOpenUntil,
    failureCount: Number(stats.circuitFailureCount ?? 0),
    openCount: Number(stats.circuitOpenCount ?? 0),
    lastFailureType: stats.lastFailureType,
    probeActive: stats.halfOpenProbeActive === true,
  };
}

function providerQuota(provider) {
  return provider?.quota ?? null;
}

function formatUsageNumber(value) {
  const number = Math.max(0, Number(value) || 0);
  return new Intl.NumberFormat(undefined, { notation: number >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(number);
}

function quotaResetLabel(resetAt) {
  const timestamp = typeof resetAt === "number" ? resetAt : Date.parse(resetAt ?? "");
  if (!Number.isFinite(timestamp)) return "Reset time unavailable";
  return `Resets ${new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function providerQuotaRows(provider) {
  const quota = providerQuota(provider);
  const config = quota?.config;
  const usage = quota?.usage ?? provider?.routingStats?.quotaUsage;
  if (!config || !usage) return [];
  return [
    config.dailyRequestLimit
      ? { key: "daily_requests", label: "Daily requests", used: usage.daily?.requests ?? 0, limit: config.dailyRequestLimit, resetAt: usage.daily?.resetAt }
      : null,
    config.monthlyRequestLimit
      ? { key: "monthly_requests", label: "Monthly requests", used: usage.monthly?.requests ?? 0, limit: config.monthlyRequestLimit, resetAt: usage.monthly?.resetAt }
      : null,
    config.dailyTokenLimit
      ? { key: "daily_tokens", label: "Daily tokens", used: usage.daily?.totalTokens ?? 0, limit: config.dailyTokenLimit, resetAt: usage.daily?.resetAt }
      : null,
    config.monthlyTokenLimit
      ? { key: "monthly_tokens", label: "Monthly tokens", used: usage.monthly?.totalTokens ?? 0, limit: config.monthlyTokenLimit, resetAt: usage.monthly?.resetAt }
      : null,
  ].filter(Boolean).map((row) => ({
    ...row,
    percent: Math.min(100, Math.max(0, Math.round((row.used / row.limit) * 100))),
  }));
}

function providerQuotaMarkup(provider) {
  if (!provider.configured) return "";
  const quota = providerQuota(provider);
  const usage = quota?.usage ?? provider.routingStats?.quotaUsage;
  const rows = providerQuotaRows(provider);
  const dailyRequests = usage?.daily?.requests ?? 0;
  const dailyTokens = usage?.daily?.totalTokens ?? 0;

  if (!rows.length) {
    return `
      <div class="provider-quota-block unconfigured">
        <div class="provider-quota-heading">
          <span>Usage tracking</span>
          <small>${formatUsageNumber(dailyRequests)} requests · ${formatUsageNumber(dailyTokens)} tokens today</small>
        </div>
        <p>Add provider limits to protect free-tier capacity and make routing quota-aware.</p>
      </div>
    `;
  }

  return `
    <div class="provider-quota-block ${quota?.exhausted ? "exhausted" : quota?.warning ? "warning" : "healthy"}">
      <div class="provider-quota-heading">
        <span>Usage & quotas</span>
        <small>${quota?.exhausted ? "Limit reached" : quota?.warning ? `${quota.consumedPercent}% used` : `${quota?.consumedPercent ?? 0}% max usage`}</small>
      </div>
      <div class="provider-quota-list">
        ${rows.map((row) => `
          <div class="provider-quota-row ${row.percent >= 100 ? "exhausted" : row.percent >= (quota?.config?.warningThresholdPercent ?? 80) ? "warning" : ""}">
            <div><span>${escapeHtml(row.label)}</span><strong>${formatUsageNumber(row.used)} / ${formatUsageNumber(row.limit)}</strong></div>
            <div class="provider-quota-track" role="progressbar" aria-label="${escapeHtml(row.label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${row.percent}"><span style="width: ${row.percent}%"></span></div>
          </div>
        `).join("")}
      </div>
      <small class="provider-quota-reset">${escapeHtml(quotaResetLabel(quota?.nextResetAt ?? rows[0]?.resetAt))}</small>
    </div>
  `;
}

function formatProviderFailureType(type) {
  return ({
    server_error: "Server error",
    timeout: "Timeout",
    connection_error: "Connection failure",
    malformed_response: "Malformed response",
  })[type] ?? "";
}

function circuitCountdownMarkup(circuitOpenUntil) {
  const remaining = formatCooldownRemaining(circuitOpenUntil - Date.now());
  return `<span class="cooldown-countdown circuit-countdown" data-circuit-until="${circuitOpenUntil}">${escapeHtml(remaining)}</span>`;
}

function circuitActionsMarkup(
  providerId,
  {
    compact = false,
    showReset = true,
    retryLabel = "Test recovery",
  } = {},
) {
  return `
    <span
      class="circuit-action-group ${compact ? "compact" : ""}"
      aria-label="Circuit recovery actions"
    >
      <button
        class="circuit-action circuit-retry-button"
        type="button"
        data-retry-circuit="${escapeHtml(providerId)}"
      >
        <span
          class="circuit-action-icon"
          aria-hidden="true"
        ></span>

        <span data-circuit-action-label>
          ${escapeHtml(retryLabel)}
        </span>
      </button>

      ${showReset
      ? `
            <button
              class="circuit-action circuit-reset-button"
              type="button"
              data-reset-circuit="${escapeHtml(providerId)}"
              aria-label="Reset circuit without testing"
              title="Reset circuit without testing"
            ></button>
          `
      : ""
    }
    </span>
  `;
}

function formatCooldownRemaining(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(Number(milliseconds) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function cooldownCountdownMarkup(cooldownUntil) {
  const remaining = formatCooldownRemaining(cooldownUntil - Date.now());
  return `<span class="cooldown-countdown" data-cooldown-until="${cooldownUntil}">${escapeHtml(remaining)}</span>`;
}

function awarenessDetailMarkup(awareness) {
  if (awareness.cooldownUntil) {
    return `Rate limit · available in ${cooldownCountdownMarkup(awareness.cooldownUntil)}`;
  }
  if (awareness.circuitOpenUntil) {
    return `${escapeHtml(awareness.failureLabel || "Provider failure")} · recovery in ${circuitCountdownMarkup(awareness.circuitOpenUntil)}`;
  }
  return escapeHtml(awareness.detail);
}

function updateCooldownCountdowns() {
  let expired = false;
  document.querySelectorAll("[data-cooldown-until]").forEach((element) => {
    const until = Number(element.dataset.cooldownUntil ?? 0);
    const remaining = until - Date.now();
    if (remaining <= 0) {
      element.textContent = "ready";
      expired = true;
      return;
    }
    element.textContent = formatCooldownRemaining(remaining);
  });

  let circuitExpired = false;
  document.querySelectorAll("[data-circuit-until]").forEach((element) => {
    const until = Number(element.dataset.circuitUntil ?? 0);
    const remaining = until - Date.now();
    if (remaining <= 0) circuitExpired = true;
    element.textContent = remaining <= 0 ? "ready" : formatCooldownRemaining(remaining);
  });

  if (expired) {
    let changed = false;
    state.providers.forEach((provider) => {
      if (provider.routingStats?.cooldownUntil && provider.routingStats.cooldownUntil <= Date.now()) {
        provider.routingStats.cooldownUntil = 0;
        provider.routingStats.cooldownReason = undefined;
        changed = true;
      }
    });
    if (changed && !dashboard.hidden) {
      renderProviders($("#provider-search")?.value ?? "");
      renderHealthList();
      renderRoutingProviderOrder();
    }
  }

  if (circuitExpired && !dashboard.hidden) {
    renderProviders($("#provider-search")?.value ?? "");
    renderHealthList();
    renderRoutingProviderOrder();
  }
}

function isRateLimitRequest(request) {
  if (!request) return false;

  const text = `${request.status} ${request.providerId ?? ""} ${request.providerModel ?? ""} ${formatJson(request.response ?? {})}`.toLowerCase();

  return (
    Number(request.status) === 429 ||
    text.includes("rate limit") ||
    text.includes("ratelimit") ||
    text.includes("quota") ||
    text.includes("too many requests") ||
    text.includes("requests per")
  );
}

function recentProviderRequests(providerId, hours = 24) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  return (state.analytics.requests ?? []).filter((request) => {
    const createdAt = Date.parse(request.createdAt);
    return request.providerId === providerId && createdAt >= cutoff;
  });
}

function providerAwareness(provider) {
  if (!provider.configured) {
    return {
      level: "available",
      label: "Available",
      detail: "No API key saved yet.",
      count: 0,
      latest: null,
    };
  }

  const quota = providerQuota(provider);
  if (quota?.exhausted) {
    return {
      level: "quota-exhausted",
      label: "Quota reached",
      detail: `Configured quota is exhausted. ${quotaResetLabel(quota.nextResetAt)}.`,
      quotaResetAt: quota.nextResetAt,
      count: quota.consumedPercent,
      latest: null,
    };
  }

  const cooldown = providerCooldown(provider);
  if (cooldown.active) {
    return {
      level: "cooldown",
      label: "Cooldown",
      detail: "Temporarily skipped after a provider rate limit.",
      cooldownUntil: cooldown.cooldownUntil,
      count: cooldown.rateLimitCount,
      latest: null,
    };
  }

  const circuit = providerCircuit(provider);
  if (circuit.halfOpen) {
    return {
      level: "testing",
      label: "Testing recovery",
      detail: "A single recovery probe is in progress.",
      count: circuit.failureCount,
      latest: null,
    };
  }
  if (circuit.open) {
    return {
      level: "circuit-open",
      label: "Circuit open",
      detail: "Temporarily skipped after repeated provider failures.",
      circuitOpenUntil: circuit.circuitOpenUntil,
      failureLabel: formatProviderFailureType(circuit.lastFailureType),
      count: circuit.failureCount,
      latest: null,
    };
  }
  if (circuit.ready) {
    return {
      level: "recovery-ready",
      label: "Ready to test",
      detail: `${formatProviderFailureType(circuit.lastFailureType) || "Provider failure"} · recovery delay ended.`,
      count: circuit.failureCount,
      latest: null,
    };
  }

  if (quota?.warning) {
    return {
      level: "quota-warning",
      label: "Quota warning",
      detail: `${quota.consumedPercent}% of a configured quota has been used.`,
      count: quota.consumedPercent,
      latest: null,
    };
  }

  const recent = recentProviderRequests(provider.id, 24);
  const latest = recent[0];
  const failures = recent.filter((request) => Number(request.status) >= 400);

  if (failures.length >= 3) {
    return {
      level: "failing",
      label: "Failing",
      detail: `${failures.length} failed requests in the last 24 hours.`,
      count: failures.length,
      latest: failures[0],
    };
  }

  const latestSuccess = recent.find((request) => Number(request.status) >= 200 && Number(request.status) < 300);
  if (latestSuccess) {
    return {
      level: "healthy",
      label: "Healthy",
      detail: `Last successful use ${formatTimestamp(latestSuccess.createdAt)}.`,
      count: recent.length,
      latest: latestSuccess,
    };
  }

  const lastRateLimitAt = provider.routingStats?.lastRateLimitAt;
  if (lastRateLimitAt) {
    return {
      level: "connected",
      label: "Ready",
      detail: `Previous rate-limit cooldown ended. Ready to retry.`,
      count: recent.length,
      latest,
    };
  }

  if (latest) {
    return {
      level: "connected",
      label: "Connected",
      detail: `Last request ${formatTimestamp(latest.createdAt)}.`,
      count: recent.length,
      latest,
    };
  }

  return {
    level: "connected",
    label: "Connected",
    detail: "Key saved. No recent traffic yet.",
    count: 0,
    latest: null,
  };
}

function formatTimestamp(value) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function formatClerkDate(value) {
  if (!value) return "Unavailable";
  return formatTimestamp(value);
}

function getClerkLoginMethod(user) {
  if (!user) return "Unknown";

  const externalAccounts = user.externalAccounts ?? [];
  if (externalAccounts.length > 0) {
    const providers = externalAccounts
      .map((account) => {
        const provider = account.provider ?? account.strategy ?? "OAuth";
        return provider
          .replace("oauth_", "")
          .replace("enterprise_", "")
          .replace(/_/g, " ")
          .replace(/\b\w/g, (letter) => letter.toUpperCase());
      })
      .filter(Boolean);

    if (providers.length > 0) {
      return `${providers.join(", ")} OAuth`;
    }
  }

  const emailAddresses = user.emailAddresses ?? [];
  const hasPassword =
    user.passwordEnabled === true ||
    user.twoFactorEnabled === true ||
    emailAddresses.length > 0;

  if (hasPassword) return "Email signup / email login";

  return "Clerk authentication";
}

function getPrimaryEmail(user) {
  return (
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "No email available"
  );
}

function getDisplayName(user) {
  const fullName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  return fullName || user?.username || getPrimaryEmail(user);
}

function saveAuthUserFromClerk(clerk) {
  const user = clerk?.user;
  if (!user) return;

  state.authUser = {
    id: user.id,
    name: getDisplayName(user),
    email: getPrimaryEmail(user),
    loginMethod: getClerkLoginMethod(user),
    createdAt: user.createdAt,
    lastSignInAt: user.lastSignInAt,
    imageUrl: user.imageUrl,
    username: user.username,
  };
}
function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function responsePreview(response) {
  if (typeof response === "string") return response;
  const openAIContent = response?.choices?.[0]?.message?.content;
  if (typeof openAIContent === "string") return openAIContent;
  const responsesText = Array.isArray(response?.output)
    ? response.output
      .filter((item) => item?.type === "message" && Array.isArray(item.content))
      .flatMap((item) => item.content)
      .filter((part) => part?.type === "output_text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    : "";
  if (responsesText) return responsesText;
  const anthropicText = Array.isArray(response?.content)
    ? response.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
    : "";
  return anthropicText || formatJson(response);
}

function statusLabel(status) {
  return Number(status) >= 200 && Number(status) < 300 ? "Success" : "Failed";
}

const retryStopReasonLabels = {
  maximum_attempts_reached: "Maximum attempts reached",
  total_request_deadline_exceeded: "Total request deadline exceeded",
  error_not_retryable: "Error is not retryable",
  no_more_candidates: "No more eligible providers",
};

function retryStopReasonLabel(reason) {
  return retryStopReasonLabels[reason] ?? String(reason ?? "").replaceAll("_", " ");
}

const providerFailoverReasonLabels = {
  provider_authentication_failed: "Provider credential rejected",
  provider_access_denied: "Provider access denied",
  provider_model_or_endpoint_unavailable: "Model or endpoint unavailable on provider",
};

function providerFailoverReasonLabel(reason) {
  return providerFailoverReasonLabels[reason] ?? String(reason ?? "").replaceAll("_", " ");
}

function timelineElapsedLabel(value) {
  const elapsed = Math.max(0, Number(value) || 0);
  return elapsed >= 1_000
    ? `${(elapsed / 1_000).toFixed(elapsed >= 10_000 ? 1 : 2)} s`
    : `${Math.round(elapsed)} ms`;
}

function timelineProviderText(value, providerId) {
  const text = String(value ?? "");
  if (!providerId) return text;
  const providerName = providerDisplayName(providerId);
  const escapedProviderId = String(providerId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`(^|[^a-zA-Z0-9_-])${escapedProviderId}(?=$|[^a-zA-Z0-9_-])`, "g"),
    (_match, prefix) => `${prefix}${providerName}`,
  );
}

function timelineCopyText(events) {
  return events.map((event) => {
    const title = timelineProviderText(event.title, event.providerId);
    const providerName = event.providerId ? providerDisplayName(event.providerId) : "";
    const provider = providerName && !title.toLowerCase().includes(providerName.toLowerCase())
      ? ` [${providerName}]`
      : "";
    const detailText = timelineProviderText(event.detail, event.providerId);
    const detail = detailText ? ` — ${detailText}` : "";
    return `${String(Math.round(event.elapsedMs ?? 0)).padStart(6, " ")} ms  ${title}${provider}${detail}`;
  }).join("\n");
}

function timingValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return numeric >= 1_000
    ? `${(numeric / 1_000).toFixed(numeric >= 10_000 ? 1 : 2)} s`
    : `${Math.round(numeric)} ms`;
}

function performanceCopyText(performance) {
  const lines = [
    `Total request: ${timingValue(performance.totalLatencyMs)}`,
    `Router preparation: ${timingValue(performance.routerPreparationMs)}`,
    `Provider processing: ${timingValue(performance.providerLatencyMs)}`,
    `Provider headers: ${timingValue(performance.providerHeadersMs)}`,
    `Response body: ${timingValue(performance.responseBodyMs)}`,
    `Response processing: ${timingValue(performance.responseProcessingMs)}`,
    `Retry delay: ${timingValue(performance.retryDelayMs)}`,
    `Router overhead: ${timingValue(performance.routerOverheadMs)}`,
  ];
  if (performance.firstTokenMs !== undefined) lines.push(`Time to first token: ${timingValue(performance.firstTokenMs)}`);
  if (performance.providerFirstTokenMs !== undefined) lines.push(`Provider first token: ${timingValue(performance.providerFirstTokenMs)}`);
  if (performance.streamDurationMs !== undefined) lines.push(`Stream duration: ${timingValue(performance.streamDurationMs)}`);
  if (performance.tokensPerSecond !== undefined) lines.push(`Throughput: ${performance.tokensPerSecond} tokens/s`);
  if (performance.slowestStage) lines.push(`Slowest stage: ${performance.slowestStage}`);
  if (Array.isArray(performance.attempts) && performance.attempts.length) {
    lines.push("", "Provider attempts:");
    performance.attempts.forEach((attempt) => {
      lines.push(
        `${attempt.attempt}. ${providerDisplayName(attempt.providerId)} — ${attempt.success ? "success" : "failed"} — ${timingValue(attempt.latencyMs)}`,
      );
    });
  }
  return lines.join("\n");
}

function apiFormatFor(request) {
  if (request?.apiFormat === "claude-code-compatible") return "claude-code-compatible";
  if (request?.apiFormat === "openai-responses-compatible") return "openai-responses-compatible";
  if (request?.apiFormat === "openai-compatible") return "openai-compatible";
  if (request?.endpoint === "/v1/messages") return "claude-code-compatible";
  if (request?.endpoint === "/v1/responses") return "openai-responses-compatible";
  if (request?.endpoint === "/v1/chat/completions") return "openai-compatible";
  const requestedModel = String(request?.request?.model ?? "");
  if (requestedModel.startsWith("claude-")) return "claude-code-compatible";
  if (requestedModel.startsWith("codex-")) return "openai-responses-compatible";
  return "openai-compatible";
}

function apiFormatLabel(apiFormat) {
  if (apiFormat === "claude-code-compatible") return "Claude";
  if (apiFormat === "openai-responses-compatible") return "Codex";
  return "OpenAI";
}

function endpointFor(request) {
  if (typeof request?.endpoint === "string" && request.endpoint) return request.endpoint;
  const format = apiFormatFor(request);
  if (format === "claude-code-compatible") return "/v1/messages";
  if (format === "openai-responses-compatible") return "/v1/responses";
  return "/v1/chat/completions";
}

function snippetFor(kind) {
  const baseUrl = `${location.origin}/v1`;
  const gatewayUrl = location.origin;
  const key = state.routerKey || "YOUR_ROUTER_KEY";
  const snippets = {
    curl: `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "free-router",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
    javascript: `const response = await fetch("${baseUrl}/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer ${key}",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "free-router",
    messages: [{ role: "user", content: "Hello" }]
  })
});

const data = await response.json();`,
    python: `import requests

response = requests.post(
    "${baseUrl}/chat/completions",
    headers={
        "Authorization": "Bearer ${key}",
        "Content-Type": "application/json",
    },
    json={
        "model": "free-router",
        "messages": [{"role": "user", "content": "Hello"}],
    },
)

print(response.json())`,
    openai: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "${key}",
  baseURL: "${baseUrl}"
});

const completion = await client.chat.completions.create({
  model: "free-router",
  messages: [{ role: "user", content: "Hello" }]
});

console.log(completion.choices[0].message.content);`,
    codex: `# PowerShell
$env:FREE_LLM_ROUTER_KEY = "${key}"

# Add this to $HOME/.codex/config.toml
model = "codex-free-router"
model_provider = "free_llm_router"

[model_providers.free_llm_router]
name = "Free LLM Router"
base_url = "${baseUrl}"
env_key = "FREE_LLM_ROUTER_KEY"
wire_api = "responses"
supports_websockets = false
request_max_retries = 3
stream_max_retries = 5
stream_idle_timeout_ms = 300000

# Then launch Codex
codex`,
    claude: `# PowerShell
$env:ANTHROPIC_BASE_URL = "${gatewayUrl}"
$env:ANTHROPIC_AUTH_TOKEN = "${key}"
$env:ANTHROPIC_MODEL = "claude-free-router"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-free-router"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-free-router"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-free-router"
claude`,
  };
  return snippets[kind] ?? snippets.curl;
}

function renderSnippets() {
  $$(".snippet-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.snippet === state.activeSnippet);
  });
  const usageCode = $("#usage-code");
  if (usageCode) usageCode.textContent = snippetFor(state.activeSnippet);
  const overviewCodexCode = $("#overview-codex-code");

  if (overviewCodexCode) {
    overviewCodexCode.textContent = snippetFor("codex");
  }

  const overviewClaudeCode = $("#overview-claude-code");

  if (overviewClaudeCode) {
    overviewClaudeCode.textContent = snippetFor("claude");
  }
}

function renderHealthList() {
  const healthList = $("#health-list");
  if (!healthList) return;

  const configured = configuredProviders();

  healthList.innerHTML = configured.length
    ? configured.map((provider) => {
      const awareness = providerAwareness(provider);

      return `
        <article class="health-row ${awareness.level}">
          ${providerLogoMarkup(provider, "small")}
          <span class="health-dot ${awareness.level}"></span>
          <div>
            <strong>${escapeHtml(provider.name)}</strong>
            <small>${awarenessDetailMarkup(awareness)}</small>
          </div>
          <span class="health-row-actions">
            <span class="status ${awareness.level}">${escapeHtml(awareness.label)}</span>
            ${awareness.level === "cooldown" ? `
              <button class="ghost compact-button cooldown-clear-button" type="button"
                data-clear-cooldown="${escapeHtml(provider.id)}">Clear</button>
            ` : ""}
            ${["circuit-open", "recovery-ready", "testing"].includes(
        awareness.level,
      )
          ? circuitActionsMarkup(provider.id, {
            compact: true,
            showReset: false,
            retryLabel: "Test",
          })
          : ""
        }
          </span>
        </article>
      `;
    }).join("")
    : `<div class="inline-empty">
        <strong>No provider keys yet</strong>
        <span>Add a provider to unlock routing and analytics.</span>
      </div>`;
}

function providerModelCatalog(provider) {
  const catalog = provider?.modelCatalog;
  const models = Array.isArray(catalog?.models) && catalog.models.length
    ? catalog.models.map((model) => ({ ...model }))
    : [{ id: provider?.model ?? "", status: "unknown" }].filter((model) => model.id);
  const activeModelId = catalog?.activeModelId && models.some((model) => model.id === catalog.activeModelId)
    ? catalog.activeModelId
    : models[0]?.id ?? provider?.model ?? "";
  return { activeModelId, models };
}

function providerModelStatusLabel(status) {
  return ({
    healthy: "Healthy",
    unavailable: "Unavailable",
    unauthorized: "Unauthorized",
    "rate-limited": "Rate limited",
    error: "Error",
    unknown: "Not tested",
  })[status] ?? "Not tested";
}

function providerModelStatusTone(status) {
  if (status === "healthy") return "connected";
  if (["unavailable", "unauthorized", "error"].includes(status)) return "failed";
  if (status === "rate-limited") return "cooldown";
  return "unknown";
}

function activeProviderModel(provider) {
  const catalog = providerModelCatalog(provider);
  return catalog.models.find((model) => model.id === catalog.activeModelId)
    ?? { id: catalog.activeModelId, status: "unknown" };
}

function renderProviders(query = "") {
  const normalized = query.trim().toLowerCase();
  const providers = state.providers.filter((provider) => {
    const capabilityText = providerCapabilityOrder
      .filter((name) => provider.capabilities?.[name] === "supported")
      .map(capabilityLabel)
      .join(" ");
    const modelText = providerModelCatalog(provider).models.map((model) => model.id).join(" ");
    return `${provider.name} ${modelText} ${provider.description} ${capabilityText}`
      .toLowerCase()
      .includes(normalized);
  });
  const providerList = $("#provider-list");
  if (!providerList) return;

  providerList.innerHTML = providers.map((provider) => {
    const awareness = providerAwareness(provider);
    const counts = providerCapabilityCounts(provider);

    return `
      <article class="provider-card ${provider.configured ? "configured" : ""} ${awareness.level}">
        <div class="provider-card-top">
          <div class="provider-card-header">
            ${providerLogoMarkup(provider)}
            <div class="provider-title-block">
              <h3>${escapeHtml(provider.name)}</h3>
              <span title="${escapeHtml(provider.model)}">${escapeHtml(provider.model)}</span>
              <small class="provider-model-count">${providerModelCatalog(provider).models.length} saved model${providerModelCatalog(provider).models.length === 1 ? "" : "s"} · <span class="model-health-text ${providerModelStatusTone(activeProviderModel(provider).status)}">${escapeHtml(providerModelStatusLabel(activeProviderModel(provider).status))}</span></small>
            </div>
          </div>
          <span class="status ${awareness.level}">${escapeHtml(awareness.label)}</span>
        </div>

        <p class="provider-description">${escapeHtml(provider.description)}</p>

        <div class="provider-capability-block">
          <div class="provider-capability-heading">
            <span>Verified capabilities</span>
            <small>${counts.supported} supported · ${counts.unknown} unverified</small>
          </div>
          <div class="provider-capability-list" aria-label="Provider capabilities">
            ${providerCapabilityBadges(provider)}
          </div>
        </div>

        ${providerQuotaMarkup(provider)}

        <div class="provider-facts">
          ${providerCapacityFactsMarkup(provider)}
        </div>

        <div class="provider-card-footer">
          <span class="provider-awareness-copy">
            <span class="awareness-dot ${awareness.level}"></span>
            <span>
              <strong>${escapeHtml(awareness.label)}</strong>
              <small>${awarenessDetailMarkup(awareness)}</small>
            </span>
          </span>
          <span class="provider-actions">
            ${awareness.level === "cooldown" ? `
              <button class="cooldown-clear-button" type="button" data-clear-cooldown="${escapeHtml(provider.id)}">
                Clear cooldown
              </button>
            ` : ""}
            ${["circuit-open", "recovery-ready", "testing"].includes(
      awareness.level,
    )
        ? circuitActionsMarkup(provider.id)
        : ""
      }
            
            <span class="provider-key-actions">
              <button
                class="model-configure-button"
                type="button"
                data-models="${escapeHtml(provider.id)}"
              >
                Models
              </button>
              ${provider.configured ? `
                <button
                  class="quota-configure-button"
                  type="button"
                  data-quota="${escapeHtml(provider.id)}"
                >
                  ${provider.quota?.config ? "Edit quota" : "Set quota"}
                </button>
              ` : ""}
              <button
                type="button"
                data-add="${escapeHtml(provider.id)}"
              >
                ${provider.configured ? "Replace key" : "Add key"}
              </button>
            
              ${provider.configured
        ? `
                    <button
                      class="remove"
                      type="button"
                      data-remove="${escapeHtml(provider.id)}"
                    >
                      Remove
                    </button>
                  `
        : ""
      }
            </span>
          </span>
        </div>
      </article>
    `;
  }).join("") || `<div class="empty-state-card compact-empty provider-empty-state">
    <strong>No providers match that search.</strong>
    <span>Try searching by provider name, model, or capability.</span>
  </div>`;

  bindProviderLogoFallbacks(providerList);
}

function openProviderModal(providerId) {
  const provider = providerById(providerId);

  if (!provider) {
    notify("Provider not found.");
    return;
  }

  $("#modal-provider-id").value = provider.id;
  $("#modal-title").textContent = `${provider.configured ? "Replace" : "Add"} ${provider.name} key`;
  $("#modal-description").textContent = `${provider.freeTier} Model: ${provider.model}`;
  $("#provider-website").href = provider.website;
  $("#provider-key").value = "";

  const logoSlot = $("#modal-provider-logo");
  if (logoSlot) {
    logoSlot.innerHTML = providerLogoMarkup(provider);
  }

  const nameSlot = $("#modal-provider-name");
  if (nameSlot) {
    nameSlot.textContent = provider.name;
  }

  const modelSlot = $("#modal-provider-model");
  if (modelSlot) {
    modelSlot.textContent = provider.model;
  }

  modal.hidden = false;
  $("#provider-key").focus();
}

function setQuotaInput(selector, value) {
  const input = $(selector);
  if (input) input.value = value ?? "";
}

function renderQuotaModalUsage(provider) {
  const usage = providerQuota(provider)?.usage ?? provider?.routingStats?.quotaUsage;
  const target = $("#quota-current-usage");
  if (!target) return;
  if (!usage) {
    target.innerHTML = `<span><small>Today</small><strong>0 requests</strong><em>0 tokens</em></span><span><small>This month</small><strong>0 requests</strong><em>0 tokens</em></span>`;
    return;
  }
  target.innerHTML = `
    <span><small>Today</small><strong>${formatUsageNumber(usage.daily?.requests)} requests</strong><em>${formatUsageNumber(usage.daily?.totalTokens)} tokens</em></span>
    <span><small>This month</small><strong>${formatUsageNumber(usage.monthly?.requests)} requests</strong><em>${formatUsageNumber(usage.monthly?.totalTokens)} tokens</em></span>
  `;
}

function renderProviderModelModal(providerId) {
  const provider = providerById(providerId);
  if (!provider) return;
  const catalog = providerModelCatalog(provider);
  $("#model-provider-id").value = provider.id;
  $("#model-modal-title").textContent = `${provider.name} models`;
  $("#model-provider-logo").innerHTML = providerLogoMarkup(provider);
  $("#model-provider-name").textContent = provider.name;
  $("#model-active-summary").textContent = `Active: ${catalog.activeModelId}`;
  const list = $("#provider-model-list");
  list.innerHTML = catalog.models.map((model) => {
    const active = model.id === catalog.activeModelId;
    const checked = model.lastCheckedAt ? new Date(model.lastCheckedAt).toLocaleString() : "Never tested";
    return `
      <article class="provider-model-row ${active ? "active" : ""}" data-provider-model-id="${escapeHtml(model.id)}">
        <span class="provider-model-radio" aria-hidden="true">${active ? "●" : "○"}</span>
        <span class="provider-model-copy">
          <strong title="${escapeHtml(model.id)}">${escapeHtml(model.id)}</strong>
          <small>${active ? "Active for new requests" : "Saved, not used automatically"} · ${escapeHtml(checked)}</small>
          ${model.lastError ? `<em title="${escapeHtml(model.lastError)}">${escapeHtml(model.lastError)}</em>` : ""}
        </span>
        <span class="provider-model-row-actions">
          <span class="status ${providerModelStatusTone(model.status)}">${escapeHtml(providerModelStatusLabel(model.status))}</span>
          ${active ? "" : `<button class="ghost compact-button" type="button" data-model-action="activate">Set active</button>`}
          <button class="ghost compact-button" type="button" data-model-action="test" ${provider.configured ? "" : "disabled"}>Test</button>
          <button class="ghost compact-button" type="button" data-model-action="edit">Edit</button>
          <button class="ghost compact-button danger" type="button" data-model-action="delete" ${active || catalog.models.length === 1 ? "disabled" : ""}>Delete</button>
        </span>
      </article>`;
  }).join("");
  bindProviderLogoFallbacks(modelModal);
}

function openProviderModelModal(providerId) {
  const provider = providerById(providerId);
  if (!provider) { notify("Provider not found."); return; }
  renderProviderModelModal(providerId);
  $("#provider-model-id").value = "";
  modelModal.hidden = false;
  $("#provider-model-id").focus();
}

async function saveProviderModelCatalog(providerId, catalog, message, { reopenModal = true } = {}) {
  await api(`/api/providers/${encodeURIComponent(providerId)}/models`, {
    method: "PUT",
    body: JSON.stringify(catalog),
  });
  await loadDashboard();
  if (reopenModal) openProviderModelModal(providerId);
  if (message) notify(message);
}

function openQuotaModal(providerId) {
  const provider = providerById(providerId);
  if (!provider) {
    notify("Provider not found.");
    return;
  }
  const config = providerQuota(provider)?.config ?? {};
  $("#quota-provider-id").value = provider.id;
  $("#quota-modal-title").textContent = `${provider.name} quota`;
  $("#quota-modal-description").textContent = "Set the limits from your provider plan. The router will warn near the threshold and skip this provider after a limit is reached.";
  $("#quota-provider-logo").innerHTML = providerLogoMarkup(provider);
  $("#quota-provider-name").textContent = provider.name;
  $("#quota-provider-model").textContent = provider.model;
  setQuotaInput("#quota-daily-requests", config.dailyRequestLimit);
  setQuotaInput("#quota-monthly-requests", config.monthlyRequestLimit);
  setQuotaInput("#quota-daily-tokens", config.dailyTokenLimit);
  setQuotaInput("#quota-monthly-tokens", config.monthlyTokenLimit);
  setQuotaInput("#quota-warning-threshold", config.warningThresholdPercent ?? 80);
  $("#quota-remove").disabled = !providerQuota(provider)?.config;
  renderQuotaModalUsage(provider);
  quotaModal.hidden = false;
  bindProviderLogoFallbacks(quotaModal);
  $("#quota-daily-requests").focus();
}

function quotaFormPayload() {
  return {
    dailyRequestLimit: $("#quota-daily-requests").value,
    monthlyRequestLimit: $("#quota-monthly-requests").value,
    dailyTokenLimit: $("#quota-daily-tokens").value,
    monthlyTokenLimit: $("#quota-monthly-tokens").value,
    warningThresholdPercent: $("#quota-warning-threshold").value || 80,
  };
}

function clientApplicationFor(request) {
  const application = request?.clientApplication;
  if (application?.id && application?.name) return application;
  return { id: "unknown", name: "Unknown client", detectedBy: "unknown" };
}

function requestIsStreaming(request) {
  if (typeof request?.streaming === "boolean") return request.streaming;
  return request?.request?.stream === true;
}

function toolAnalyticsFor(request) {
  if (request?.toolAnalytics && typeof request.toolAnalytics === "object") {
    return request.toolAnalytics;
  }
  const tools = Array.isArray(request?.request?.tools) ? request.request.tools : [];
  return {
    toolRequest: tools.length > 0,
    requestedToolCount: tools.length,
    requestedToolNames: [],
    generatedToolCallCount: 0,
    generatedToolNames: [],
    outcome: tools.length ? "not-observed" : "not-requested",
    structuredOutputRequested: Boolean(request?.request?.response_format || request?.request?.text?.format),
    structuredOutputValidation: "not-observed",
  };
}

function fallbackPathFor(request) {
  if (Array.isArray(request?.fallbackPath) && request.fallbackPath.length) return request.fallbackPath;
  if (Array.isArray(request?.providerAttempts) && request.providerAttempts.length) {
    return request.providerAttempts.map((attempt) => attempt.providerId).filter(Boolean);
  }
  return request?.providerId ? [request.providerId] : [];
}

function fallbackUsedFor(request) {
  if (typeof request?.fallbackUsed === "boolean") return request.fallbackUsed;
  return fallbackPathFor(request).length > 1;
}

function providerAttemptCountFor(request) {
  if (Number.isFinite(Number(request?.providerAttemptCount))) return Number(request.providerAttemptCount);
  const attempts = fallbackPathFor(request).length;
  return attempts || (request?.deduplication?.deduplicated ? 0 : request?.providerId ? 1 : 0);
}

function requestAliasFor(request) {
  return request?.resolvedAlias || request?.requestedModel || request?.request?.model || "unknown";
}

function renderSelectOptions(select, options, allLabel, current) {
  if (!select) return "all";
  select.innerHTML = `<option value="all">${escapeHtml(allLabel)}</option>${options.map((option) => `
    <option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>
  `).join("")}`;
  select.value = options.some((option) => option.value === current) ? current : "all";
  return select.value;
}

function renderFilterDimensionOptions(prefix, filters) {
  const requests = state.analytics.requests ?? [];
  const aliases = [...new Set(requests.map(requestAliasFor).filter((value) => value && value !== "unknown"))]
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value }));
  filters.alias = renderSelectOptions(
    $(`#${prefix}-alias-filter`),
    aliases,
    "All model aliases",
    filters.alias,
  );

  const clients = new Map();
  requests.forEach((request) => {
    const application = clientApplicationFor(request);
    clients.set(application.id, application.name);
  });
  filters.clientApplication = renderSelectOptions(
    $(`#${prefix}-client-filter`),
    [...clients.entries()].sort((left, right) => left[1].localeCompare(right[1])).map(([value, label]) => ({ value, label })),
    "All clients",
    filters.clientApplication,
  );
}

function renderAnalyticsDimensionFilters() {
  renderFilterDimensionOptions("analytics", state.analyticsFilters);
}

function renderLogDimensionFilters() {
  renderFilterDimensionOptions("logs", state.logFilters);
}

function analyticsBarRows(items, valueKey = "count", formatter = (value) => String(value)) {
  if (!items.length) return `<div class="analytics-chart-empty">No matching data yet.</div>`;
  const max = Math.max(1, ...items.map((item) => Number(item[valueKey]) || 0));
  return items.slice(0, 8).map((item) => {
    const value = Number(item[valueKey]) || 0;
    const width = Math.max(value > 0 ? 4 : 0, Math.round((value / max) * 100));
    return `<div class="analytics-bar-row">
      <div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(formatter(value, item))}</strong></div>
      <span class="analytics-bar-track"><span style="width:${width}%"></span></span>
    </div>`;
  }).join("");
}

function advancedAnalytics(requests) {
  const upstream = requests.filter((request) => request.deduplication?.deduplicated !== true);
  const totalTokens = upstream.reduce((sum, request) => sum + Number(request.usage?.totalTokens ?? 0), 0);
  const reportedTokens = upstream.reduce((sum, request) => sum + (request.usage?.source === "reported" ? Number(request.usage.totalTokens ?? 0) : 0), 0);
  const estimatedTokens = upstream.reduce((sum, request) => sum + (request.usage?.source === "estimated" ? Number(request.usage.totalTokens ?? 0) : 0), 0);
  const fallbacks = upstream.filter(fallbackUsedFor);
  const totalAttempts = upstream.reduce((sum, request) => sum + providerAttemptCountFor(request), 0);
  const toolRequests = requests.filter((request) => toolAnalyticsFor(request).toolRequest);
  const generatedToolCalls = requests.reduce((sum, request) => sum + Number(toolAnalyticsFor(request).generatedToolCallCount ?? 0), 0);

  const clientCounts = new Map();
  requests.forEach((request) => {
    const application = clientApplicationFor(request);
    const current = clientCounts.get(application.id) ?? { application, count: 0 };
    current.count += 1;
    clientCounts.set(application.id, current);
  });
  const clients = [...clientCounts.values()].sort((left, right) => right.count - left.count);

  const paths = new Map();
  upstream.forEach((request) => {
    const path = fallbackPathFor(request);
    if (path.length <= 1) return;
    const key = path.join(" → ");
    paths.set(key, (paths.get(key) ?? 0) + 1);
  });

  const providerStats = new Map();
  upstream.forEach((request) => {
    const attempts = Array.isArray(request.providerAttempts) && request.providerAttempts.length
      ? request.providerAttempts
      : [{ providerId: request.providerId, success: request.status >= 200 && request.status < 300 }];
    attempts.forEach((attempt) => {
      if (!attempt.providerId) return;
      const current = providerStats.get(attempt.providerId) ?? { providerId: attempt.providerId, attempts: 0, successes: 0 };
      current.attempts += 1;
      if (attempt.success) current.successes += 1;
      providerStats.set(attempt.providerId, current);
    });
  });
  const providers = [...providerStats.values()].map((item) => ({
    ...item,
    successRate: item.attempts ? item.successes / item.attempts : 0,
  })).sort((left, right) => right.successRate - left.successRate || right.attempts - left.attempts);

  const apiCounts = new Map();
  requests.forEach((request) => {
    const format = apiFormatFor(request);
    apiCounts.set(format, (apiCounts.get(format) ?? 0) + 1);
  });

  return {
    upstream,
    totalTokens,
    reportedTokens,
    estimatedTokens,
    fallbackCount: fallbacks.length,
    fallbackRate: upstream.length ? fallbacks.length / upstream.length : 0,
    averageAttempts: upstream.length ? totalAttempts / upstream.length : 0,
    toolRequestCount: toolRequests.length,
    generatedToolCalls,
    clients,
    paths: [...paths.entries()].map(([label, count]) => ({ label, count })).sort((left, right) => right.count - left.count),
    providers,
    apiFormats: [...apiCounts.entries()].map(([format, count]) => ({ format, count })).sort((left, right) => right.count - left.count),
  };
}

function tokenTrendBuckets(requests, bucketCount = 12) {
  const upstream = requests.filter((request) => request.deduplication?.deduplicated !== true && request.usage);
  const now = Date.now();
  const parsed = upstream.map((request) => Date.parse(request.createdAt)).filter(Number.isFinite);
  const earliest = parsed.length ? Math.min(...parsed) : now - 11 * 60 * 60 * 1000;
  const configuredHours = state.analyticsFilters.timeRange === "all" ? null : Number(state.analyticsFilters.timeRange);
  const rangeStart = configuredHours && Number.isFinite(configuredHours)
    ? now - configuredHours * 60 * 60 * 1000
    : earliest;
  const span = Math.max(1, now - rangeStart);
  const size = span / bucketCount;
  return Array.from({ length: bucketCount }, (_, index) => {
    const start = rangeStart + index * size;
    const end = index === bucketCount - 1 ? now + 1 : start + size;
    const matching = upstream.filter((request) => {
      const timestamp = Date.parse(request.createdAt);
      return timestamp >= start && timestamp < end;
    });
    return {
      label: span > 48 * 60 * 60 * 1000
        ? new Date(start).toLocaleDateString([], { month: "short", day: "numeric" })
        : new Date(start).toLocaleTimeString([], { hour: "numeric" }),
      input: matching.reduce((sum, request) => sum + Number(request.usage?.inputTokens ?? 0), 0),
      output: matching.reduce((sum, request) => sum + Number(request.usage?.outputTokens ?? 0), 0),
      total: matching.reduce((sum, request) => sum + Number(request.usage?.totalTokens ?? 0), 0),
    };
  });
}

function renderAdvancedAnalytics(requests) {
  const analytics = advancedAnalytics(requests);
  $("#analysis-total-tokens").textContent = formatUsageNumber(analytics.totalTokens);
  $("#analysis-token-source").textContent = `${formatUsageNumber(analytics.reportedTokens)} reported · ${formatUsageNumber(analytics.estimatedTokens)} estimated`;
  $("#analysis-fallback-rate").textContent = `${Math.round(analytics.fallbackRate * 1000) / 10}%`;
  $("#analysis-fallback-count").textContent = `${analytics.fallbackCount} fallback request${analytics.fallbackCount === 1 ? "" : "s"}`;
  $("#analysis-average-attempts").textContent = analytics.averageAttempts ? analytics.averageAttempts.toFixed(2) : "0";
  $("#analysis-tool-requests").textContent = formatUsageNumber(analytics.toolRequestCount);
  $("#analysis-tool-call-count").textContent = `${formatUsageNumber(analytics.generatedToolCalls)} generated call${analytics.generatedToolCalls === 1 ? "" : "s"}`;
  $("#analysis-top-client").textContent = analytics.clients[0]?.application.name ?? "—";
  $("#analysis-top-client-count").textContent = analytics.clients[0] ? `${analytics.clients[0].count} request${analytics.clients[0].count === 1 ? "" : "s"}` : "No client data yet";
  $("#analysis-reliable-provider").textContent = analytics.providers[0] ? providerDisplayName(analytics.providers[0].providerId) : "—";
  $("#analysis-reliable-provider-rate").textContent = analytics.providers[0]
    ? `${Math.round(analytics.providers[0].successRate * 100)}% across ${analytics.providers[0].attempts} attempt${analytics.providers[0].attempts === 1 ? "" : "s"}`
    : "No provider attempts yet";

  const tokenChart = $("#analytics-token-chart");
  const buckets = tokenTrendBuckets(requests);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
  tokenChart.innerHTML = buckets.map((bucket) => {
    const inputHeight = Math.round((bucket.input / max) * 100);
    const outputHeight = Math.round((bucket.output / max) * 100);
    return `<div class="analytics-token-bucket" title="${escapeHtml(bucket.label)} · ${formatUsageNumber(bucket.total)} tokens">
      <div class="analytics-token-stack"><span class="token-output" style="height:${Math.max(bucket.output ? 3 : 0, outputHeight)}%"></span><span class="token-input" style="height:${Math.max(bucket.input ? 3 : 0, inputHeight)}%"></span></div>
      <small>${escapeHtml(bucket.label)}</small>
    </div>`;
  }).join("");

  $("#analytics-client-chart").innerHTML = analyticsBarRows(
    analytics.clients.map((item) => ({ label: item.application.name, count: item.count })),
    "count",
    (value) => `${value} request${value === 1 ? "" : "s"}`,
  );
  $("#analytics-fallback-chart").innerHTML = analyticsBarRows(
    analytics.paths,
    "count",
    (value) => `${value} route${value === 1 ? "" : "s"}`,
  );
  $("#analytics-provider-chart").innerHTML = analyticsBarRows(
    analytics.providers.map((item) => ({ label: providerDisplayName(item.providerId), rate: item.successRate * 100, attempts: item.attempts })),
    "rate",
    (value, item) => `${Math.round(value)}% · ${item.attempts} attempts`,
  );

  const toolSummary = [
    { label: "Tools requested", count: requests.filter((request) => toolAnalyticsFor(request).toolRequest).length },
    { label: "Calls generated", count: analytics.generatedToolCalls },
    { label: "Tool request failures", count: requests.filter((request) => toolAnalyticsFor(request).outcome === "request-failed").length },
    { label: "Structured output valid", count: requests.filter((request) => toolAnalyticsFor(request).structuredOutputValidation === "valid").length },
    { label: "Structured output invalid", count: requests.filter((request) => toolAnalyticsFor(request).structuredOutputValidation === "invalid").length },
  ];
  $("#analytics-tool-chart").innerHTML = analyticsBarRows(toolSummary);
  $("#analytics-api-chart").innerHTML = analyticsBarRows(
    analytics.apiFormats.map((item) => ({ label: apiFormatLabel(item.format), count: item.count })),
  );
}

function percentLabel(rate) {
  return `${Math.round((Number(rate) || 0) * 1000) / 10}%`;
}

function millisecondsLabel(value) {
  const milliseconds = Math.round(Number(value) || 0);
  return milliseconds ? `${formatUsageNumber(milliseconds)} ms` : "—";
}

function renderDashboardMetrics(selector, metrics) {
  const target = $(selector);
  if (!target) return;
  target.innerHTML = metrics.map((metric) => `
    <article class="dashboard-metric-card">
      <span>${escapeHtml(metric.label)}</span>
      <strong title="${escapeHtml(metric.value)}">${escapeHtml(metric.value)}</strong>
      <small>${escapeHtml(metric.detail)}</small>
    </article>
  `).join("");
}

function dashboardLogButton(filter, value) {
  return `<button class="dashboard-log-link" type="button" data-dashboard-log-filter="${escapeHtml(filter)}" data-dashboard-log-value="${escapeHtml(value)}">View logs</button>`;
}

function analyticsTableMarkup(headers, rows) {
  if (!rows.length) return `<div class="analytics-chart-empty">No matching data yet.</div>`;
  return `<div class="analytics-table-scroll"><table>
    <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table></div>`;
}

function renderProviderDashboard(requests) {
  const providers = summarizeProviderDashboard(requests);
  const byReliability = [...providers].filter((item) => item.attempts > 0)
    .sort((left, right) => right.successRate - left.successRate || right.attempts - left.attempts);
  const bySpeed = [...providers].filter((item) => item.averageAttemptLatencyMs > 0)
    .sort((left, right) => left.averageAttemptLatencyMs - right.averageAttemptLatencyMs);
  const byRecovery = [...providers].sort((left, right) => right.fallbackRecoveries - left.fallbackRecoveries);
  const mostUsed = providers[0];

  renderDashboardMetrics("#provider-dashboard-summary", [
    { label: "Most used provider", value: mostUsed ? providerDisplayName(mostUsed.providerId) : "—", detail: mostUsed ? `${mostUsed.completedRequests} completed requests` : "No provider traffic" },
    { label: "Most reliable", value: byReliability[0] ? providerDisplayName(byReliability[0].providerId) : "—", detail: byReliability[0] ? `${percentLabel(byReliability[0].successRate)} across ${byReliability[0].attempts} attempts` : "No attempts yet" },
    { label: "Fastest attempts", value: bySpeed[0] ? providerDisplayName(bySpeed[0].providerId) : "—", detail: bySpeed[0] ? `${millisecondsLabel(bySpeed[0].averageAttemptLatencyMs)} average` : "No latency data" },
    { label: "Fallback recoveries", value: byRecovery[0]?.fallbackRecoveries ? providerDisplayName(byRecovery[0].providerId) : "—", detail: byRecovery[0]?.fallbackRecoveries ? `${byRecovery[0].fallbackRecoveries} requests rescued` : "No fallback recoveries" },
  ]);

  $("#provider-dashboard-volume").innerHTML = analyticsBarRows(
    providers.map((item) => ({ label: providerDisplayName(item.providerId), count: item.completedRequests })),
    "count",
    (value) => `${value} request${value === 1 ? "" : "s"}`,
  );
  $("#provider-dashboard-success").innerHTML = analyticsBarRows(
    providers.map((item) => ({ label: providerDisplayName(item.providerId), rate: item.successRate * 100, attempts: item.attempts })),
    "rate",
    (value, item) => `${Math.round(value)}% · ${item.attempts} attempts`,
  );
  $("#provider-dashboard-latency").innerHTML = analyticsBarRows(
    providers.filter((item) => item.averageAttemptLatencyMs > 0).map((item) => ({ label: providerDisplayName(item.providerId), latency: item.averageAttemptLatencyMs })),
    "latency",
    (value) => millisecondsLabel(value),
  );
  $("#provider-dashboard-tokens").innerHTML = analyticsBarRows(
    providers.map((item) => ({ label: providerDisplayName(item.providerId), tokens: item.tokens })),
    "tokens",
    (value) => `${formatUsageNumber(value)} tokens`,
  );

  $("#provider-dashboard-table").innerHTML = analyticsTableMarkup(
    ["Provider", "Served", "Attempts", "Attempt success", "Average", "P95", "Tokens", "Fallbacks", ""],
    providers.map((item) => `<tr>
      <td><strong>${escapeHtml(providerDisplayName(item.providerId))}</strong><small>${escapeHtml(providerById(item.providerId)?.model ?? item.providerId)}</small></td>
      <td>${formatUsageNumber(item.completedRequests)}</td>
      <td>${formatUsageNumber(item.attempts)}</td>
      <td><span class="dashboard-rate-pill ${item.successRate >= 0.95 ? "strong" : item.successRate < 0.75 ? "weak" : ""}">${percentLabel(item.successRate)}</span></td>
      <td>${millisecondsLabel(item.averageAttemptLatencyMs)}</td>
      <td>${millisecondsLabel(item.p95AttemptLatencyMs)}</td>
      <td>${formatUsageNumber(item.tokens)}</td>
      <td>${formatUsageNumber(item.fallbackRecoveries)}</td>
      <td>${dashboardLogButton("provider", item.providerId)}</td>
    </tr>`),
  );
}

function renderApiModelDashboard(requests) {
  const { apis, aliases } = summarizeApiAndModelDashboard(requests);
  const totalRequests = requests.length;
  const streamingRequests = requests.filter(requestIsStreaming).length;
  const toolRequests = requests.filter((request) => toolAnalyticsFor(request).toolRequest).length;
  const topApi = apis[0];
  const topAlias = aliases[0];

  renderDashboardMetrics("#api-model-dashboard-summary", [
    { label: "Most used API", value: topApi ? apiFormatLabel(topApi.id) : "—", detail: topApi ? `${topApi.requests} requests` : "No API traffic" },
    { label: "Most used alias", value: topAlias?.name ?? "—", detail: topAlias ? `${topAlias.requests} requests` : "No alias traffic" },
    { label: "Streaming share", value: percentLabel(totalRequests ? streamingRequests / totalRequests : 0), detail: `${streamingRequests} streaming requests` },
    { label: "Tool-enabled share", value: percentLabel(totalRequests ? toolRequests / totalRequests : 0), detail: `${toolRequests} requests supplied tools` },
  ]);

  $("#api-dashboard-volume").innerHTML = analyticsBarRows(
    apis.map((item) => ({ label: apiFormatLabel(item.id), count: item.requests })),
    "count",
    (value) => `${value} request${value === 1 ? "" : "s"}`,
  );
  $("#api-dashboard-success").innerHTML = analyticsBarRows(
    apis.map((item) => ({ label: apiFormatLabel(item.id), rate: item.successRate * 100, requests: item.requests })),
    "rate",
    (value, item) => `${Math.round(value)}% · ${item.requests} requests`,
  );
  $("#model-dashboard-volume").innerHTML = analyticsBarRows(
    aliases.map((item) => ({ label: item.name, count: item.requests })),
    "count",
    (value) => `${value} request${value === 1 ? "" : "s"}`,
  );
  $("#model-dashboard-fallback").innerHTML = analyticsBarRows(
    aliases.map((item) => ({ label: item.name, rate: item.fallbackRate * 100, fallbacks: item.fallbackRequests })),
    "rate",
    (value, item) => `${Math.round(value * 10) / 10}% · ${item.fallbacks} fallbacks`,
  );

  $("#api-dashboard-table").innerHTML = analyticsTableMarkup(
    ["API format", "Requests", "Success", "Average latency", "Tokens", "Streaming", "Tools", "Fallback", ""],
    apis.map((item) => `<tr>
      <td><strong>${escapeHtml(apiFormatLabel(item.id))}</strong><small>${escapeHtml(item.id)}</small></td>
      <td>${formatUsageNumber(item.requests)}</td>
      <td>${percentLabel(item.successRate)}</td>
      <td>${millisecondsLabel(item.averageLatencyMs)}</td>
      <td>${formatUsageNumber(item.tokens)}</td>
      <td>${percentLabel(item.streamingRate)}</td>
      <td>${percentLabel(item.toolRate)}</td>
      <td>${percentLabel(item.fallbackRate)}</td>
      <td>${dashboardLogButton("apiFormat", item.id)}</td>
    </tr>`),
  );

  $("#model-dashboard-table").innerHTML = analyticsTableMarkup(
    ["Model alias", "Requests", "Success", "Average latency", "Tokens", "Attempts", "Streaming", "Fallback", ""],
    aliases.map((item) => `<tr>
      <td><strong>${escapeHtml(item.name)}</strong></td>
      <td>${formatUsageNumber(item.requests)}</td>
      <td>${percentLabel(item.successRate)}</td>
      <td>${millisecondsLabel(item.averageLatencyMs)}</td>
      <td>${formatUsageNumber(item.tokens)}</td>
      <td>${item.averageAttempts ? item.averageAttempts.toFixed(2) : "0"}</td>
      <td>${percentLabel(item.streamingRate)}</td>
      <td>${percentLabel(item.fallbackRate)}</td>
      <td>${dashboardLogButton("alias", item.id)}</td>
    </tr>`),
  );
}

function renderApplicationDashboard(requests) {
  const applications = summarizeApplicationDashboard(requests);
  const byReliability = [...applications].filter((item) => item.requests > 0)
    .sort((left, right) => right.successRate - left.successRate || right.requests - left.requests);
  const bySpeed = [...applications].filter((item) => item.averageLatencyMs > 0)
    .sort((left, right) => left.averageLatencyMs - right.averageLatencyMs);
  const byTools = [...applications].sort((left, right) => right.toolRequests - left.toolRequests);
  const top = applications[0];

  renderDashboardMetrics("#application-dashboard-summary", [
    { label: "Most used application", value: top?.name ?? "—", detail: top ? `${top.requests} requests` : "No client traffic" },
    { label: "Highest success rate", value: byReliability[0]?.name ?? "—", detail: byReliability[0] ? `${percentLabel(byReliability[0].successRate)} across ${byReliability[0].requests} requests` : "No reliability data" },
    { label: "Fastest application", value: bySpeed[0]?.name ?? "—", detail: bySpeed[0] ? `${millisecondsLabel(bySpeed[0].averageLatencyMs)} average` : "No latency data" },
    { label: "Most tool traffic", value: byTools[0]?.toolRequests ? byTools[0].name : "—", detail: byTools[0]?.toolRequests ? `${byTools[0].toolRequests} tool-enabled requests` : "No tool-enabled traffic" },
  ]);

  $("#application-dashboard-volume").innerHTML = analyticsBarRows(
    applications.map((item) => ({ label: item.name, count: item.requests })),
    "count",
    (value) => `${value} request${value === 1 ? "" : "s"}`,
  );
  $("#application-dashboard-success").innerHTML = analyticsBarRows(
    applications.map((item) => ({ label: item.name, rate: item.successRate * 100, requests: item.requests })),
    "rate",
    (value, item) => `${Math.round(value)}% · ${item.requests} requests`,
  );
  $("#application-dashboard-latency").innerHTML = analyticsBarRows(
    applications.filter((item) => item.averageLatencyMs > 0).map((item) => ({ label: item.name, latency: item.averageLatencyMs })),
    "latency",
    (value) => millisecondsLabel(value),
  );
  $("#application-dashboard-tools").innerHTML = analyticsBarRows(
    applications.map((item) => ({ label: item.name, count: item.toolRequests })),
    "count",
    (value) => `${value} tool request${value === 1 ? "" : "s"}`,
  );

  $("#application-dashboard-table").innerHTML = analyticsTableMarkup(
    ["Application", "Requests", "Success", "Average latency", "Tokens", "Streaming", "Tools", "Top API", "Top alias", ""],
    applications.map((item) => `<tr>
      <td><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.application.detectedBy ?? "unknown detection")}</small></td>
      <td>${formatUsageNumber(item.requests)}</td>
      <td>${percentLabel(item.successRate)}</td>
      <td>${millisecondsLabel(item.averageLatencyMs)}</td>
      <td>${formatUsageNumber(item.tokens)}</td>
      <td>${percentLabel(item.streamingRate)}</td>
      <td>${formatUsageNumber(item.toolRequests)}</td>
      <td>${escapeHtml(apiFormatLabel(item.topApiFormat))}</td>
      <td>${escapeHtml(item.topAlias)}</td>
      <td>${dashboardLogButton("clientApplication", item.id)}</td>
    </tr>`),
  );
}

function bindDashboardLogLinks() {
  $$('[data-dashboard-log-filter]').forEach((button) => {
    button.addEventListener("click", () => {
      state.logFilters = {
        ...state.logFilters,
        timeRange: state.analyticsFilters.timeRange,
        provider: "all",
        apiFormat: "all",
        alias: "all",
        clientApplication: "all",
        status: "all",
        streaming: "all",
        toolUsage: "all",
        search: "",
        [button.dataset.dashboardLogFilter]: button.dataset.dashboardLogValue,
      };
      switchAnalysisTab("logs");
      renderAnalytics();
      document.querySelector('[data-analysis-panel="logs"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderExpandedDashboards(requests) {
  renderProviderDashboard(requests);
  renderApiModelDashboard(requests);
  renderApplicationDashboard(requests);
  bindDashboardLogLinks();
}

function filteredRequests(filters = state.analyticsFilters) {
  const now = Date.now();
  const { timeRange, provider, apiFormat, status, alias, clientApplication, streaming, toolUsage, search } = filters;
  const query = search.trim().toLowerCase();

  return (state.analytics.requests ?? []).filter((request) => {
    const createdAt = Date.parse(request.createdAt);
    if (timeRange !== "all") {
      const hours = Number(timeRange);
      if (Number.isFinite(hours) && now - createdAt > hours * 60 * 60 * 1000) return false;
    }
    if (provider !== "all" && request.providerId !== provider) return false;
    if (apiFormat !== "all" && apiFormatFor(request) !== apiFormat) return false;
    if (status === "success" && !(request.status >= 200 && request.status < 300)) return false;
    if (status === "failed" && request.status >= 200 && request.status < 300) return false;
    if (alias !== "all" && requestAliasFor(request) !== alias) return false;
    if (clientApplication !== "all" && clientApplicationFor(request).id !== clientApplication) return false;
    if (streaming === "streaming" && !requestIsStreaming(request)) return false;
    if (streaming === "non-streaming" && requestIsStreaming(request)) return false;
    const toolAnalytics = toolAnalyticsFor(request);
    if (toolUsage === "tools" && !toolAnalytics.toolRequest) return false;
    if (toolUsage === "tool-calls" && !(toolAnalytics.generatedToolCallCount > 0)) return false;
    if (toolUsage === "no-tools" && toolAnalytics.toolRequest) return false;
    if (query) {
      const haystack = `${request.requestId ?? ""} ${request.clientRequestId ?? ""} ${request.deduplication?.originalRequestId ?? ""} ${request.providerId} ${request.providerModel ?? ""} ${request.requestedModel ?? ""} ${request.resolvedAlias ?? ""} ${apiFormatLabel(apiFormatFor(request))} ${endpointFor(request)} ${formatJson(request.request)} ${responsePreview(request.response)} ${formatJson(request.providerEvaluations ?? [])} ${formatJson(request.routingHeaders ?? {})} ${clientApplicationFor(request).name} ${formatJson(toolAnalyticsFor(request))} ${fallbackPathFor(request).join(" ")}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function buildFrequencyBuckets(requests) {
  const hours = state.analyticsFilters.timeRange === "all"
    ? 12
    : Math.min(Math.max(Number(state.analyticsFilters.timeRange) || 12, 1), 24);
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  return Array.from({ length: hours }, (_, index) => {
    const bucketStart = now - (hours - index - 1) * hourMs;
    const bucketEnd = bucketStart + hourMs;
    return {
      label: new Date(bucketStart).toLocaleTimeString("en-US", { hour: "numeric" }),
      count: requests.filter((request) => {
        const createdAt = Date.parse(request.createdAt);
        return createdAt >= bucketStart && createdAt < bucketEnd;
      }).length,
    };
  });
}

function renderFrequencyChart(requests) {
  const chart = $("#request-frequency-chart");
  if (!chart) return;

  const buckets = buildFrequencyBuckets(requests);
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  chart.innerHTML = buckets.map((bucket) => {
    const height = Math.max(6, Math.round((bucket.count / max) * 100));
    return `
      <div class="frequency-bucket">
        <div class="frequency-track">
          <span class="frequency-fill" style="height: ${height}%"></span>
        </div>
        <strong>${bucket.count}</strong>
        <span>${escapeHtml(bucket.label)}</span>
      </div>
    `;
  }).join("");
}

function renderProviderFilter(prefix, filters) {
  const select = $(`#${prefix}-provider-filter`);
  if (!select) return;
  const current = select.value || filters.provider;
  const ids = [...new Set((state.analytics.requests ?? []).map((request) => request.providerId).filter(Boolean))];
  select.innerHTML = `<option value="all">All providers</option>${ids.map((id) => `
    <option value="${escapeHtml(id)}">${escapeHtml(providerDisplayName(id))}</option>
  `).join("")}`;
  select.value = ids.includes(current) ? current : "all";
  filters.provider = select.value;
}

function renderAnalyticsProviderFilter() {
  renderProviderFilter("analytics", state.analyticsFilters);
}

function renderLogProviderFilter() {
  renderProviderFilter("logs", state.logFilters);
}

function renderAnalyticsLoading() {
  const list = $("#request-log-list");
  if (list) {
    list.innerHTML = Array.from({ length: 4 }, () => `
      <div class="request-log-skeleton" aria-hidden="true">
        <span class="skeleton-circle"></span>
        <span class="skeleton-lines"><span></span><span></span></span>
        <span class="skeleton-pills"><span></span><span></span><span></span></span>
      </div>
    `).join("");
  }
  const chart = $("#request-frequency-chart");
  if (chart) chart.innerHTML = `<div class="chart-loading">Loading request activity…</div>`;
}

function renderAnalytics() {
  renderAnalyticsProviderFilter();
  renderAnalyticsDimensionFilters();
  renderLogProviderFilter();
  renderLogDimensionFilters();
  const requests = filteredRequests(state.analyticsFilters);
  const total = requests.length;
  const successCount = requests.filter((request) => request.status >= 200 && request.status < 300).length;
  const failureCount = Math.max(0, total - successCount);
  const providerCounts = requests
    .filter((request) => request.deduplication?.deduplicated !== true)
    .reduce((counts, request) => {
      counts[request.providerId] = (counts[request.providerId] ?? 0) + 1;
      return counts;
    }, {});
  const apiCounts = requests.reduce((counts, request) => {
    const apiFormat = apiFormatFor(request);
    counts[apiFormat] = (counts[apiFormat] ?? 0) + 1;
    return counts;
  }, {});
  const topProvider = Object.entries(providerCounts).sort((left, right) => right[1] - left[1])[0];
  const topApi = Object.entries(apiCounts).sort((left, right) => right[1] - left[1])[0];
  const successful = requests.filter((request) => request.status >= 200 && request.status < 300);
  const averageLatency = successful.length
    ? Math.round(successful.reduce((sum, request) => sum + request.latencyMs, 0) / successful.length)
    : 0;

  $("#analysis-total").textContent = String(total);
  $("#analysis-success-rate").textContent = total ? `${Math.round((successCount / total) * 100)}%` : "—";
  $("#analysis-failure-count").textContent = failureCount ? `${failureCount} failed request${failureCount === 1 ? "" : "s"}` : "No failures";
  $("#analysis-top-provider").textContent = topProvider ? providerDisplayName(topProvider[0]) : "—";
  $("#analysis-top-provider-count").textContent = topProvider
    ? `${topProvider[1]} upstream request${topProvider[1] === 1 ? "" : "s"}`
    : "No requests yet";
  $("#analysis-latency").textContent = successful.length ? `${averageLatency} ms` : "—";
  $("#analysis-top-api").textContent = topApi ? apiFormatLabel(topApi[0]) : "—";
  $("#analysis-top-api-count").textContent = topApi
    ? `${topApi[1]} request${topApi[1] === 1 ? "" : "s"}`
    : "No requests yet";

  renderAdvancedAnalytics(requests);
  renderExpandedDashboards(requests);
  renderFrequencyChart(requests);

  const logRequests = filteredRequests(state.logFilters);
  const logCount = $("#request-log-count");
  if (logCount) logCount.textContent = `${logRequests.length} request${logRequests.length === 1 ? "" : "s"}`;

  const requestLogList = $("#request-log-list");
  if (state.analyticsError) {
    requestLogList.innerHTML = `
      <div class="empty-state-card compact-empty analytics-error-state">
        <strong>Analytics could not be loaded.</strong>
        <span>${escapeHtml(state.analyticsError)}</span>
        <button class="secondary" type="button" data-retry-analytics>Try again</button>
      </div>
    `;
    requestLogList.querySelector("[data-retry-analytics]")?.addEventListener("click", () => {
      renderAnalyticsLoading();
      void loadAnalytics();
    });
    return;
  }

  requestLogList.innerHTML = logRequests.map((request) => {
    const provider = providerById(request.providerId) ?? {
      id: request.providerId,
      name: providerDisplayName(request.providerId),
      model: request.providerModel ?? request.providerId,
    };
    const apiFormat = apiFormatFor(request);
    const endpoint = endpointFor(request);

    return `
      <button class="request-log-row" type="button" data-log-id="${escapeHtml(request.id)}">
        <span class="request-provider-info">
          ${providerLogoMarkup(provider, "small")}
          <span>
            <strong>${escapeHtml(providerDisplayName(request.providerId))}</strong>
            <small>${escapeHtml(request.providerModel ?? request.providerId)}</small>
          </span>
        </span>
        ${request.requestId ? `<span class="request-id-row-badge" title="${escapeHtml(request.requestId)}">${escapeHtml(request.requestId.length > 22 ? `${request.requestId.slice(0, 19)}…` : request.requestId)}</span>` : ""}
        <span class="request-log-meta">
          <span class="api-format-badge ${apiFormat}">${escapeHtml(apiFormatLabel(apiFormat))}</span>
          ${request.resolvedAlias ? `<span class="model-alias-log-badge">${escapeHtml(request.resolvedAlias)}</span>` : ""}
          ${request.deduplication?.deduplicated ? `<span class="deduplication-log-badge">Deduplicated</span>` : ""}
          ${fallbackUsedFor(request) ? `<span class="analytics-feature-badge fallback">Fallback · ${providerAttemptCountFor(request)} attempts</span>` : ""}
          ${toolAnalyticsFor(request).toolRequest ? `<span class="analytics-feature-badge tools">Tools · ${toolAnalyticsFor(request).requestedToolCount}</span>` : ""}
          <span class="analytics-client-badge">${escapeHtml(clientApplicationFor(request).name)}</span>
          <span class="endpoint-chip">${escapeHtml(endpoint)}</span>
          ${request.capabilityMatch ? `<span class="capability-match-badge ${escapeHtml(request.capabilityMatch)}">${escapeHtml(request.capabilityMatch === "full" ? "Capability match" : "Unverified match")}</span>` : ""}
          ${(request.providerEvaluations ?? []).filter((item) => item.state !== "candidate").length
        ? `<span class="routing-skip-badge">${(request.providerEvaluations ?? []).filter((item) => item.state !== "candidate").length} skipped</span>`
        : ""}
          <span class="status ${request.status >= 200 && request.status < 300 ? "connected" : "failed"}">${request.status}</span>
          <span>${request.latencyMs} ms</span>
          <span>${escapeHtml(formatTimestamp(request.createdAt))}</span>
        </span>
      </button>
    `;
  }).join("") || `<div class="empty-state-card compact-empty">
    <strong>No request logs found.</strong>
    <span>Run a test request or adjust your filters.</span>
  </div>`;

  bindProviderLogoFallbacks(requestLogList);
}

async function loadAnalytics() {
  state.analyticsError = null;
  try {
    const payload = await api("/api/analytics?limit=250");
    state.analytics = payload;
  } catch (error) {
    console.warn("Analytics unavailable:", error);
    state.analytics = { requests: [], frequency: [] };
    state.analyticsError = error instanceof Error
      ? error.message
      : "Analytics route is unavailable on this deployment.";
  }

  renderAnalytics();
}

function openRequestDrawer(logId) {
  const request = (state.analytics.requests ?? []).find(
    (item) => item.id === logId,
  );

  if (!request) return;

  const provider = providerById(request.providerId) ?? {
    id: request.providerId,
    name: providerDisplayName(request.providerId),
    model: request.providerModel ?? request.providerId,
  };

  const apiFormat = apiFormatFor(request);
  const apiLabel = apiFormatLabel(apiFormat);
  const endpoint = endpointFor(request);
  const isSuccessful = request.status >= 200 && request.status < 300;

  $("#drawer-title").textContent = `${apiLabel} request`;
  $("#drawer-meta").innerHTML = `
    ${request.requestId ? `
      <div class="drawer-request-correlation">
        <div>
          <small>Request ID · ${escapeHtml(request.requestIdSource === "client" ? "Client-provided" : "Generated by router")}</small>
          <code id="drawer-request-id">${escapeHtml(request.requestId)}</code>
          ${request.clientRequestId && request.clientRequestId !== request.requestId ? `<span>Client ID: ${escapeHtml(request.clientRequestId)}</span>` : ""}
        </div>
        <button class="copy-button" type="button" data-copy="drawer-request-id">Copy ID</button>
      </div>
    ` : ""}
    <div class="drawer-meta-main">
      <span class="drawer-provider-brand">
        ${providerLogoMarkup(provider, "small")}
        <strong>${escapeHtml(providerDisplayName(request.providerId))}</strong>
      </span>
      <span class="status ${isSuccessful ? "connected" : "failed"}">
        ${statusLabel(request.status)} ${request.status}
      </span>
    </div>

    <div class="drawer-meta-chips">
      <span class="api-format-badge ${apiFormat}">${escapeHtml(apiLabel)}</span>
      <span class="drawer-chip analytics-client-chip">Client: ${escapeHtml(clientApplicationFor(request).name)}</span>
      <span class="drawer-chip">${requestIsStreaming(request) ? "Streaming" : "Non-streaming"}</span>
      ${fallbackUsedFor(request) ? `<span class="drawer-chip fallback-chip">Fallback · ${providerAttemptCountFor(request)} attempts</span>` : ""}
      ${toolAnalyticsFor(request).toolRequest ? `<span class="drawer-chip tools-chip">${toolAnalyticsFor(request).requestedToolCount} tool${toolAnalyticsFor(request).requestedToolCount === 1 ? "" : "s"}</span>` : ""}
      ${request.resolvedAlias ? `<span class="drawer-chip model-alias-chip">Alias: ${escapeHtml(request.resolvedAlias)}</span>` : ""}
      ${request.deduplication?.deduplicated ? `<span class="drawer-chip deduplication-chip">Deduplicated · ${escapeHtml(request.deduplication.source)}</span>` : ""}
      <span class="endpoint-chip">${escapeHtml(endpoint)}</span>
      ${request.routingStrategy ? `
        <span class="drawer-chip routing-chip">
          ${escapeHtml(routingStrategyLabel(request.routingStrategy))} routing
        </span>
      ` : ""}
      ${request.capabilityMatch ? `
        <span class="drawer-chip capability-match-badge ${escapeHtml(request.capabilityMatch)}">
          ${escapeHtml(request.capabilityMatch === "full" ? "Full capability match" : "Unverified capability match")}
        </span>
      ` : ""}
      ${(request.requiredCapabilities ?? []).map((capability) => `
        <span class="drawer-chip capability-requirement-chip">
          Needs ${escapeHtml(capabilityLabel(capability))}
        </span>
      `).join("")}
      ${request.requestedModel ? `<span class="drawer-chip requested-model-chip" title="${escapeHtml(request.requestedModel)}">Requested: ${escapeHtml(request.requestedModel)}</span>` : ""}
      <span class="drawer-chip model-chip" title="${escapeHtml(request.providerModel ?? request.providerId)}">
        Provider model: ${escapeHtml(request.providerModel ?? request.providerId)}
      </span>
      ${request.usage ? `
        <span class="drawer-chip usage-chip">${formatUsageNumber(request.usage.totalTokens)} tokens</span>
        <span class="drawer-chip usage-source-chip">${escapeHtml(request.usage.source === "reported" ? "Provider reported" : "Estimated")}</span>
      ` : ""}
      <span class="drawer-chip">${request.latencyMs} ms</span>
      <span class="drawer-chip">${escapeHtml(formatTimestamp(request.createdAt))}</span>
    </div>
  `;

  const routingHeadersSection = $("#drawer-routing-headers-section");
  const routingHeaders = request.routingHeaders && typeof request.routingHeaders === "object"
    ? Object.entries(request.routingHeaders)
    : [];
  if (routingHeaders.length) {
    routingHeadersSection.hidden = false;
    routingHeadersSection.innerHTML = `
      <details class="drawer-routing-headers-details">
        <summary>
          <span><strong>Returned routing headers</strong><small>${routingHeaders.length} header${routingHeaders.length === 1 ? "" : "s"}</small></span>
          <span>Inspect</span>
        </summary>
        <div class="drawer-routing-headers-list">
          ${routingHeaders.sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `
            <div><code>${escapeHtml(name)}</code><span>${escapeHtml(String(value))}</span></div>
          `).join("")}
        </div>
        <pre id="drawer-routing-headers-copy" class="visually-hidden" aria-hidden="true"></pre>
        <button class="copy-button routing-headers-copy" type="button" data-copy="drawer-routing-headers-copy">Copy headers</button>
      </details>
    `;
    $("#drawer-routing-headers-copy").textContent = routingHeaders
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
  } else {
    routingHeadersSection.hidden = true;
    routingHeadersSection.innerHTML = "";
  }

  const performanceSection = $("#drawer-performance-section");
  const performance = request.performance && typeof request.performance === "object"
    ? request.performance
    : null;
  if (performance) {
    const stages = [
      ["Router preparation", performance.routerPreparationMs],
      ["Provider processing", performance.providerLatencyMs],
      ["Retry delay", performance.retryDelayMs],
      ["Response processing", performance.responseProcessingMs],
      ["Router overhead", performance.routerOverheadMs],
    ].filter(([, value]) => Number(value) > 0);
    const maxStage = Math.max(1, ...stages.map(([, value]) => Number(value) || 0));
    const attempts = Array.isArray(performance.attempts) ? performance.attempts : [];
    performanceSection.hidden = false;
    performanceSection.innerHTML = `
      <div class="drawer-section-heading">
        <div><h3>Performance breakdown</h3><span>${escapeHtml(performance.slowestStage ? `Slowest: ${performance.slowestStage}` : "Normalized request timing")}</span></div>
        <button class="copy-button" type="button" data-copy="drawer-performance-copy">Copy timings</button>
      </div>
      <div class="drawer-performance-summary">
        <span><small>Total request</small><strong>${escapeHtml(timingValue(performance.totalLatencyMs))}</strong></span>
        <span><small>Provider time</small><strong>${escapeHtml(timingValue(performance.providerLatencyMs))}</strong></span>
        <span><small>${performance.firstTokenMs !== undefined ? "Time to first token" : "Response body"}</small><strong>${escapeHtml(timingValue(performance.firstTokenMs ?? performance.responseBodyMs))}</strong></span>
        <span><small>${performance.streamDurationMs !== undefined ? "Stream duration" : "Router overhead"}</small><strong>${escapeHtml(timingValue(performance.streamDurationMs ?? performance.routerOverheadMs))}</strong></span>
      </div>
      ${performance.deduplicated ? `<p class="drawer-performance-note">Deduplicated response — no new provider call was made.</p>` : ""}
      <div class="drawer-performance-bars">
        ${stages.map(([label, value]) => `
          <div class="drawer-performance-bar-row">
            <div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(timingValue(value))}</span></div>
            <span class="drawer-performance-track"><span style="width:${Math.max(3, Math.round((Number(value) / maxStage) * 100))}%"></span></span>
          </div>
        `).join("")}
      </div>
      ${attempts.length ? `
        <div class="drawer-performance-attempts">
          <strong>Provider attempts</strong>
          ${attempts.map((attempt) => `
            <div>
              <span>${escapeHtml(String(attempt.attempt))}</span>
              <strong>${escapeHtml(providerDisplayName(attempt.providerId))}</strong>
              <small>${escapeHtml(attempt.success ? "Succeeded" : `Failed${attempt.status ? ` · ${attempt.status}` : ""}`)}</small>
              <b>${escapeHtml(timingValue(attempt.latencyMs))}</b>
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${performance.tokensPerSecond !== undefined ? `<p class="drawer-performance-note">Streaming throughput: <strong>${escapeHtml(String(performance.tokensPerSecond))} tokens/s</strong></p>` : ""}
      <pre id="drawer-performance-copy" class="visually-hidden" aria-hidden="true"></pre>
    `;
    $("#drawer-performance-copy").textContent = performanceCopyText(performance);
  } else {
    performanceSection.hidden = true;
    performanceSection.innerHTML = "";
  }

  const timelineSection = $("#drawer-timeline-section");
  const timeline = Array.isArray(request.timeline) ? request.timeline : [];
  if (timeline.length) {
    timelineSection.hidden = false;
    timelineSection.innerHTML = `
      <div class="drawer-section-heading timeline-section-heading">
        <div><h3>Full request timeline</h3><span>${timeline.length} chronological event${timeline.length === 1 ? "" : "s"}</span></div>
        <button class="copy-button" type="button" data-copy="drawer-timeline-copy">Copy timeline</button>
      </div>
      <div class="drawer-timeline-list">
        ${timeline.map((event) => {
          const eventProvider = event.providerId
            ? providerById(event.providerId) ?? { id: event.providerId, name: providerDisplayName(event.providerId) }
            : null;
          return `
            <article class="drawer-timeline-event ${escapeHtml(event.tone ?? "neutral")}">
              <div class="drawer-timeline-time">
                <strong>+${escapeHtml(timelineElapsedLabel(event.elapsedMs))}</strong>
                <small>${escapeHtml(new Date(event.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }))}</small>
              </div>
              <span class="drawer-timeline-marker" aria-hidden="true"></span>
              <div class="drawer-timeline-copy">
                <div class="drawer-timeline-title">
                  ${eventProvider ? providerLogoMarkup(eventProvider, "small") : ""}
                  <strong>${escapeHtml(timelineProviderText(event.title, event.providerId))}</strong>
                </div>
                ${event.detail ? `<p>${escapeHtml(timelineProviderText(event.detail, event.providerId))}</p>` : ""}
                ${event.details && Object.keys(event.details).length ? `
                  <details class="drawer-timeline-details">
                    <summary>Raw event details</summary>
                    <pre><code>${escapeHtml(formatJson(event.details))}</code></pre>
                  </details>
                ` : ""}
              </div>
              <span class="drawer-timeline-type">${escapeHtml(String(event.type ?? "event").replaceAll("_", " "))}</span>
            </article>
          `;
        }).join("")}
      </div>
      <pre id="drawer-timeline-copy" class="visually-hidden" aria-hidden="true"></pre>
    `;
    $("#drawer-timeline-copy").textContent = timelineCopyText(timeline);
  } else {
    timelineSection.hidden = true;
    timelineSection.innerHTML = "";
  }

  const decision = $("#drawer-routing-decision");
  const evaluations = Array.isArray(request.providerEvaluations)
    ? [...request.providerEvaluations].sort((left, right) => {
      if (left.providerId === request.providerId) return -1;
      if (right.providerId === request.providerId) return 1;
      return (left.candidateRank ?? 999) - (right.candidateRank ?? 999);
    })
    : [];

  if (evaluations.length) {
    const selectedCandidateRank = evaluations.find(
      (item) => item.providerId === request.providerId,
    )?.candidateRank;
    decision.hidden = false;
    decision.innerHTML = `
      <div class="routing-decision-heading">
        <span>Routing decision</span>
        <small>${evaluations.length} provider${evaluations.length === 1 ? "" : "s"} evaluated</small>
      </div>
      <div class="routing-decision-list">
        ${evaluations.map((evaluation) => {
      const evaluationProvider = providerById(evaluation.providerId) ?? {
        id: evaluation.providerId,
        name: providerDisplayName(evaluation.providerId),
      };
      const reason = providerEvaluationReason(
        evaluation,
        request.providerId,
        selectedCandidateRank,
      );
      return `
            <article class="routing-decision-row ${reason.tone}">
              ${providerLogoMarkup(evaluationProvider, "small")}
              <span class="routing-decision-copy">
                <strong>${escapeHtml(providerDisplayName(evaluation.providerId))}</strong>
                <small>${escapeHtml(reason.detail)}</small>
              </span>
              <span class="routing-decision-status ${reason.tone}">${escapeHtml(reason.label)}</span>
            </article>
          `;
    }).join("")}
      </div>
    `;
  } else {
    decision.hidden = true;
    decision.innerHTML = "";
  }

  const attemptsSection = $("#drawer-attempts-section");
  const attempts = Array.isArray(request.providerAttempts) ? request.providerAttempts : [];
  if (attempts.length) {
    attemptsSection.hidden = false;
    attemptsSection.innerHTML = `
      <div class="drawer-section-heading"><h3>Provider attempts</h3><span>${attempts.length} upstream call${attempts.length === 1 ? "" : "s"}</span></div>
      <div class="drawer-attempt-list">
        ${attempts.map((attempt, index) => {
      const attemptProvider = providerById(attempt.providerId) ?? {
        id: attempt.providerId,
        name: providerDisplayName(attempt.providerId),
      };
      const attemptNumber = attempt.attemptNumber ?? index + 1;
      const outcome = attempt.success
        ? `Succeeded${attempt.status ? ` · HTTP ${attempt.status}` : ""}`
        : attempt.status
          ? `Failed · HTTP ${attempt.status}`
          : `Failed${attempt.failureType ? ` · ${String(attempt.failureType).replaceAll("_", " ")}` : ""}`;
      const details = [
        `${formatUsageNumber(attempt.latencyMs ?? 0)} ms elapsed`,
        attempt.providerTimeoutMs ? `${millisecondsToSeconds(attempt.providerTimeoutMs)}s timeout` : "",
        attempt.retryDelayMs ? `${formatUsageNumber(attempt.retryDelayMs)} ms retry delay` : "",
        attempt.recoveryAction === "immediate_failover"
          ? "Immediate provider failover"
          : attempt.retryable === false ? "Not retryable" : attempt.retryable === true ? "Retryable" : "",
      ].filter(Boolean);
      return `
          <article class="drawer-attempt-row ${attempt.success ? "success" : "failed"}">
            <div class="drawer-attempt-provider">
              ${providerLogoMarkup(attemptProvider, "small")}
              <span><small>Attempt ${attemptNumber}</small><strong>${escapeHtml(providerDisplayName(attempt.providerId))}</strong><em>${escapeHtml(attempt.providerModel ?? attemptProvider.model ?? "")}</em></span>
            </div>
            <div class="drawer-attempt-copy">
              <strong>${escapeHtml(outcome)}</strong>
              <small>${escapeHtml(attempt.message ?? details.join(" · "))}</small>
              ${attempt.message && details.length ? `<span>${escapeHtml(details.join(" · "))}</span>` : ""}
              ${attempt.recoveryAction === "immediate_failover" && attempt.failoverReason ? `<em>Failover: ${escapeHtml(providerFailoverReasonLabel(attempt.failoverReason))}</em>` : ""}
              ${attempt.retryStopReason ? `<em>Retry stopped: ${escapeHtml(retryStopReasonLabel(attempt.retryStopReason))}</em>` : ""}
            </div>
            <span class="drawer-attempt-state ${attempt.success ? "success" : "failed"}">${attempt.success ? "Success" : "Failed"}</span>
          </article>
        `;
    }).join("")}
      </div>
    `;
  } else {
    attemptsSection.hidden = true;
    attemptsSection.innerHTML = "";
  }

  bindProviderLogoFallbacks($("#drawer-meta"));
  bindProviderLogoFallbacks(timelineSection);
  bindProviderLogoFallbacks(decision);
  bindProviderLogoFallbacks(attemptsSection);
  const deduplicationSection = $("#drawer-deduplication-section");
  if (request.deduplication?.deduplicated) {
    const dedup = request.deduplication;
    deduplicationSection.hidden = false;
    deduplicationSection.innerHTML = `
      <div class="drawer-section-heading"><h3>Request deduplication</h3><span>Provider call avoided</span></div>
      <div class="drawer-deduplication-grid">
        <span><small>Source</small><strong>${escapeHtml(dedup.source === "in-flight" ? "In-flight request" : "Completed response")}</strong></span>
        <span><small>Original request</small><button class="drawer-original-request-link" type="button" data-original-request-id="${escapeHtml(dedup.originalRequestId)}" title="Open ${escapeHtml(dedup.originalRequestId)}">${escapeHtml(dedup.originalRequestId.length > 21 ? `${dedup.originalRequestId.slice(0, 18)}…` : dedup.originalRequestId)}</button></span>
        <span><small>Requests saved</small><strong>${formatUsageNumber(dedup.estimatedRequestsSaved ?? 1)}</strong></span>
        <span><small>Tokens protected</small><strong>${formatUsageNumber(dedup.estimatedTotalTokensSaved ?? 0)}</strong></span>
      </div>
      <p class="drawer-deduplication-note">This request reused an identical router-scoped operation. Provider quota and usage counters were updated only by the original upstream call.</p>
    `;
    deduplicationSection.querySelector("[data-original-request-id]")?.addEventListener("click", (event) => {
      const originalRequestId = event.currentTarget.dataset.originalRequestId;
      const original = (state.analytics.requests ?? []).find((item) => item.requestId === originalRequestId);
      if (original) openRequestDrawer(original.id);
      else notify(`Original request ${originalRequestId} is outside the currently loaded Analysis history.`);
    });
  } else {
    deduplicationSection.hidden = true;
    deduplicationSection.innerHTML = "";
  }

  const usageSection = $("#drawer-usage-section");
  if (request.usage) {
    usageSection.hidden = false;
    usageSection.innerHTML = `
      <div class="drawer-section-heading"><h3>Token usage</h3><span>${escapeHtml(request.usage.source === "reported" ? "Reported by provider" : "Estimated by router")}</span></div>
      <div class="drawer-usage-grid">
        <span><small>Input</small><strong>${formatUsageNumber(request.usage.inputTokens)}</strong></span>
        <span><small>Output</small><strong>${formatUsageNumber(request.usage.outputTokens)}</strong></span>
        <span><small>Total</small><strong>${formatUsageNumber(request.usage.totalTokens)}</strong></span>
      </div>
    `;
  } else {
    usageSection.hidden = true;
    usageSection.innerHTML = "";
  }

  const toolSection = $("#drawer-tool-analytics-section");
  const toolAnalytics = toolAnalyticsFor(request);
  if (toolAnalytics.toolRequest || toolAnalytics.structuredOutputRequested) {
    toolSection.hidden = false;
    const requestedNames = Array.isArray(toolAnalytics.requestedToolNames) ? toolAnalytics.requestedToolNames : [];
    const generatedNames = Array.isArray(toolAnalytics.generatedToolNames) ? toolAnalytics.generatedToolNames : [];
    toolSection.innerHTML = `
      <div class="drawer-section-heading"><h3>Tool and structured-output analytics</h3><span>${escapeHtml(clientApplicationFor(request).name)}</span></div>
      <div class="drawer-tool-analytics-grid">
        <span><small>Tools requested</small><strong>${formatUsageNumber(toolAnalytics.requestedToolCount)}</strong></span>
        <span><small>Calls generated</small><strong>${formatUsageNumber(toolAnalytics.generatedToolCallCount)}</strong></span>
        <span><small>Tool outcome</small><strong>${escapeHtml(String(toolAnalytics.outcome).replaceAll("-", " "))}</strong></span>
        <span><small>Structured output</small><strong>${escapeHtml(String(toolAnalytics.structuredOutputValidation).replaceAll("-", " "))}</strong></span>
      </div>
      ${requestedNames.length ? `<p><strong>Requested:</strong> ${requestedNames.map(escapeHtml).join(", ")}</p>` : ""}
      ${generatedNames.length ? `<p><strong>Generated:</strong> ${generatedNames.map(escapeHtml).join(", ")}</p>` : ""}
    `;
  } else {
    toolSection.hidden = true;
    toolSection.innerHTML = "";
  }
  $("#drawer-request").textContent = formatJson(request.request);
  $("#drawer-response").textContent = responsePreview(request.response);
  drawer.hidden = false;
  lockPageScroll();
}


// async function switchTab(tabName) {
//   $$("[data-tab]").forEach((button) => {
//     button.classList.toggle("active", button.dataset.tab === tabName);
//   });
//   $$(".tab-panel").forEach((panel) => { panel.hidden = true; });
//   const panel = $(`#${tabName}-panel`);
//   if (panel) panel.hidden = false;

//   if (tabName === "analysis") {
//     renderAnalyticsLoading();
//     try {
//       await loadAnalytics();
//     } catch (error) {
//       notify(error.message);
//     }
//   }
//   renderSnippets();
// }

async function switchTab(tabName) {
  $$("[data-tab]").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.tab === tabName,
    );
  });

  $$(".tab-panel").forEach((panel) => {
    panel.hidden = true;
  });

  const panel = $(`#${tabName}-panel`);

  if (panel) {
    panel.hidden = false;
  }

  if (
    tabName === "overview" ||
    tabName === "providers" ||
    tabName === "settings"
  ) {
    try {
      await refreshProviderProtectionState();
    } catch (error) {
      console.error(
        "Unable to refresh provider protection state:",
        error,
      );
    }
  }

  if (tabName === "analysis") {
    renderAnalyticsLoading();

    try {
      await loadAnalytics();
    } catch (error) {
      notify(error.message);
    }
  }

  renderSnippets();
}

function maskUserId(userId) {
  if (!userId) return "Unavailable";
  if (userId.length <= 12) return `${userId.slice(0, 4)}••••`;
  return `${userId.slice(0, 10)}••••••••${userId.slice(-4)}`;
}


function routingStatsSummary(provider) {
  const stats = provider.routingStats;
  const cooldown = providerCooldown(provider);
  const circuit = providerCircuit(provider);
  if (!stats || !stats.attempts) {
    return {
      success: "New",
      latency: "No latency",
      attempts: "0 attempts",
      cooldown,
      circuit,
    };
  }

  const successRate = Math.round((stats.successes / stats.attempts) * 100);
  return {
    success: `${successRate}% success`,
    latency: Number.isFinite(stats.averageLatencyMs)
      ? `${Math.round(stats.averageLatencyMs)} ms avg`
      : "Latency pending",
    attempts: `${stats.attempts} attempt${stats.attempts === 1 ? "" : "s"}`,
    cooldown,
    circuit,
  };
}

function renderRoutingProviderOrder() {
  const container = $("#routing-provider-order");
  if (!container) return;

  const providers = state.routingProviderOrder
    .map((providerId) => providerById(providerId))
    .filter(Boolean);

  container.innerHTML = providers.length
    ? providers.map((provider, index) => {
      const stats = routingStatsSummary(provider);
      return `
        <article class="routing-provider-row ${stats.cooldown.active ? "cooldown" : ""} ${stats.circuit.open ? "circuit-open" : ""} ${stats.circuit.halfOpen ? "testing" : ""}" draggable="true"
          data-routing-provider="${escapeHtml(provider.id)}">
          <span class="routing-drag-handle" aria-hidden="true">⋮⋮</span>
          <span class="routing-order-number">${index + 1}</span>
          ${providerLogoMarkup(provider, "small")}
          <span class="routing-provider-copy">
            <strong>${escapeHtml(provider.name)}</strong>
            <small title="${escapeHtml(provider.model)}">${escapeHtml(provider.model)}</small>
            <span class="routing-row-metrics">
              <span>${escapeHtml(stats.success)}</span>
              <span>${escapeHtml(stats.latency)}</span>
              <span>${escapeHtml(stats.attempts)}</span>
              ${stats.cooldown.active ? `<span class="routing-cooldown-metric">Cooldown ${cooldownCountdownMarkup(stats.cooldown.cooldownUntil)}</span>` : ""}
              ${stats.circuit.open ? `<span class="routing-circuit-metric">Circuit open ${circuitCountdownMarkup(stats.circuit.circuitOpenUntil)}</span>` : ""}
              ${stats.circuit.ready ? `<span class="routing-circuit-metric ready">Circuit ready to test</span>` : ""}
              ${stats.circuit.halfOpen ? `<span class="routing-circuit-metric testing">Testing recovery</span>` : ""}
              ${!stats.circuit.open &&
          !stats.circuit.ready &&
          !stats.circuit.halfOpen
          ? `
                  <span class="routing-circuit-metric closed">
                    Circuit closed ·
                    ${stats.circuit.failureCount}/3 failures
                  </span>
                `
          : ""}
            </span>
            <span class="routing-capability-summary">${escapeHtml(providerCapabilitySummary(provider))}</span>
          </span>
          <span class="routing-provider-actions">
            ${stats.cooldown.active
          ? `
                  <button
                    class="ghost compact-button cooldown-clear-button"
                    type="button"
                    data-clear-cooldown="${escapeHtml(provider.id)}"
                  >
                    Clear cooldown
                  </button>
                `
          : ""
        }

            ${stats.circuit.open ||
          stats.circuit.ready ||
          stats.circuit.halfOpen
          ? circuitActionsMarkup(provider.id, {
            compact: true,
            retryLabel: "Test",
          })
          : ""
        }

            <span
              class="routing-order-actions"
              aria-label="Provider priority controls"
            >
              <button
                class="ghost compact-button"
                type="button"
                data-routing-move="up"
                aria-label="Move ${escapeHtml(provider.name)} up"
                title="Move up"
                ${index === 0 ? "disabled" : ""}
              >
                ↑
              </button>

              <button
                class="ghost compact-button"
                type="button"
                data-routing-move="down"
                aria-label="Move ${escapeHtml(provider.name)} down"
                title="Move down"
                ${index === providers.length - 1 ? "disabled" : ""}
              >
                ↓
              </button>
            </span>
          </span>
        </article>
      `;
    }).join("")
    : `<div class="inline-empty routing-empty">
        <strong>No configured providers</strong>
        <span>Add provider keys before creating a fallback order.</span>
        <button class="secondary" type="button" data-open-tab="providers">Add providers</button>
      </div>`;

  bindProviderLogoFallbacks(container);
  container.querySelectorAll("[data-open-tab]").forEach((button) =>
    button.addEventListener("click", () => { void switchTab(button.dataset.openTab); }),
  );
}

function capabilitySourceLabel(source) {
  return ({
    user: "Manual override",
    probe: "Capability probe",
    runtime: "Runtime evidence",
    catalog: "Built-in catalog",
    provider: "Provider default",
  })[source] ?? "Provider default";
}

function modelEffectiveCapabilities(provider, model) {
  return model?.effectiveCapabilities
    ?? (model?.id === provider?.model ? provider?.capabilities : null)
    ?? provider?.providerCapabilities
    ?? provider?.capabilities
    ?? {};
}

function modelCapabilitySource(provider, model, capability) {
  return model?.capabilities?.[capability]?.source
    ?? model?.capabilitySources?.[capability]
    ?? provider?.capabilitySources?.[capability]
    ?? "provider";
}

function modelCapabilitySelect(provider, model, capability) {
  const explicit = model?.capabilities?.[capability]?.value ?? "inherit";
  const effective = modelEffectiveCapabilities(provider, model)?.[capability] ?? "unknown";
  const source = modelCapabilitySource(provider, model, capability);
  return `
    <label class="model-capability-control">
      <span>
        <strong>${escapeHtml(capabilityLabel(capability))}</strong>
        <small>${escapeHtml(effective === "supported" ? "Supported" : effective === "unsupported" ? "Not supported" : "Unknown")} · ${escapeHtml(capabilitySourceLabel(source))}</small>
      </span>
      <select data-model-capability="${escapeHtml(capability)}" aria-label="${escapeHtml(capabilityLabel(capability))} override">
        <option value="inherit" ${explicit === "inherit" ? "selected" : ""}>Inherit (${escapeHtml(effective)})</option>
        <option value="supported" ${explicit === "supported" ? "selected" : ""}>Supported</option>
        <option value="unsupported" ${explicit === "unsupported" ? "selected" : ""}>Unsupported</option>
        <option value="unknown" ${explicit === "unknown" ? "selected" : ""}>Unknown</option>
      </select>
    </label>`;
}

function renderCapabilityRegistry() {
  const container = $("#provider-capability-registry");
  if (!container) return;

  const mode = state.account?.capabilityRoutingSettings?.unknownMode ?? "flexible";
  const modeSelect = $("#capability-unknown-mode");
  if (modeSelect) modeSelect.value = mode;

  const providers = configuredProviders();
  if (!providers.length) {
    container.innerHTML = `
      <div class="inline-empty routing-empty">
        <strong>No configured providers</strong>
        <span>Add provider keys before testing or overriding model capabilities.</span>
        <button class="secondary" type="button" data-open-tab="providers">Add providers</button>
      </div>
    `;
    container.querySelector("[data-open-tab]")?.addEventListener("click", (event) => {
      void switchTab(event.currentTarget.dataset.openTab);
    });
    return;
  }

  const modelRows = providers.flatMap((provider) =>
    providerModelCatalog(provider).models.map((model) => ({ provider, model })),
  );
  const supportedCount = modelRows.reduce((total, { provider, model }) =>
    total + providerCapabilityOrder.filter((name) => modelEffectiveCapabilities(provider, model)?.[name] === "supported").length, 0);
  const unknownCount = modelRows.reduce((total, { provider, model }) =>
    total + providerCapabilityOrder.filter((name) => modelEffectiveCapabilities(provider, model)?.[name] === "unknown").length, 0);

  container.innerHTML = `
    <div class="capability-registry-overview">
      <span><strong>${providers.length}</strong><small>Configured providers</small></span>
      <span><strong>${modelRows.length}</strong><small>Saved models</small></span>
      <span><strong>${supportedCount}</strong><small>Supported entries</small></span>
      <span><strong>${unknownCount}</strong><small>Unknown entries</small></span>
    </div>

    <div class="model-capability-registry-list">
      ${providers.map((provider) => {
        const catalog = providerModelCatalog(provider);
        return `
          <section class="model-capability-provider-group">
            <header class="model-capability-provider-heading">
              <span>${providerLogoMarkup(provider, "small")}<span><strong>${escapeHtml(provider.name)}</strong><small>${catalog.models.length} saved model${catalog.models.length === 1 ? "" : "s"}</small></span></span>
              <span class="capability-context-pill">Provider transport defaults</span>
            </header>
            <div class="model-capability-card-grid">
              ${catalog.models.map((model) => {
                const active = model.id === catalog.activeModelId;
                const effective = modelEffectiveCapabilities(provider, model);
                const supported = providerCapabilityOrder.filter((name) => effective?.[name] === "supported").length;
                const unknown = providerCapabilityOrder.filter((name) => effective?.[name] === "unknown").length;
                const lastVerified = providerCapabilityOrder
                  .map((name) => model.capabilities?.[name]?.lastVerifiedAt)
                  .filter(Boolean)
                  .sort()
                  .at(-1);
                return `
                  <article class="model-capability-card ${active ? "active" : ""}" data-capability-provider="${escapeHtml(provider.id)}" data-capability-model="${escapeHtml(model.id)}">
                    <div class="model-capability-card-heading">
                      <div>
                        <span class="model-capability-title-row"><strong title="${escapeHtml(model.id)}">${escapeHtml(model.id)}</strong>${active ? '<span class="routing-policy-badge">Active</span>' : '<span class="routing-policy-badge muted">Inactive</span>'}</span>
                        <small>${supported} supported · ${unknown} unknown${lastVerified ? ` · Verified ${escapeHtml(new Date(lastVerified).toLocaleString())}` : ""}</small>
                      </div>
                      <span class="status ${providerModelStatusTone(model.status)}">${escapeHtml(providerModelStatusLabel(model.status))}</span>
                    </div>
                    <div class="model-capability-control-grid">
                      ${providerCapabilityOrder.map((capability) => modelCapabilitySelect(provider, model, capability)).join("")}
                    </div>
                    <div class="model-capability-limit-grid">
                      <label>Context window
                        <input data-model-capability-limit="contextWindow" type="number" min="1" step="1" value="${escapeHtml(model.capabilities?.contextWindow ?? "")}" placeholder="Inherited: ${escapeHtml(effective?.contextWindow ?? "unknown")}" />
                      </label>
                      <label>Maximum output tokens
                        <input data-model-capability-limit="maxOutputTokens" type="number" min="1" step="1" value="${escapeHtml(model.capabilities?.maxOutputTokens ?? "")}" placeholder="Inherited: ${escapeHtml(effective?.maxOutputTokens ?? "unknown")}" />
                      </label>
                    </div>
                    <div class="model-capability-card-actions">
                      <button class="ghost compact-button" type="button" data-capability-action="reset">Reset overrides</button>
                      <button class="secondary compact-button" type="button" data-capability-action="detect" ${provider.configured ? "" : "disabled"}>Detect capabilities</button>
                      <button class="primary compact-button" type="button" data-capability-action="save">Save overrides</button>
                    </div>
                    <p class="model-capability-note">Runtime successes can verify requested capabilities. Only clear capability-specific errors can mark a feature unsupported; 429, timeout, and 5xx failures do not change this registry.</p>
                  </article>`;
              }).join("")}
            </div>
          </section>`;
      }).join("")}
    </div>

    <div class="capability-legend">
      <span>${capabilityStateMarkup("supported")} Supported</span>
      <span>${capabilityStateMarkup("unknown")} Unknown</span>
      <span>${capabilityStateMarkup("unsupported")} Unsupported</span>
      <span><strong>Flexible:</strong> unknown models rank below verified support.</span>
      <span><strong>Strict:</strong> unknown required capabilities are skipped.</span>
    </div>
  `;

  bindProviderLogoFallbacks(container);

  container.querySelectorAll("[data-capability-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const card = button.closest("[data-capability-provider][data-capability-model]");
      const providerId = card?.dataset.capabilityProvider;
      const modelId = card?.dataset.capabilityModel;
      const provider = providerById(providerId);
      if (!provider || !modelId) return;
      const catalog = providerModelCatalog(provider);
      const model = catalog.models.find((item) => item.id === modelId);
      if (!model) return;
      const action = button.dataset.capabilityAction;
      button.disabled = true;
      try {
        if (action === "detect") {
          notify(`Detecting ${provider.name} model capabilities…`);
          await api(`/api/providers/${encodeURIComponent(providerId)}/models/detect`, {
            method: "POST",
            body: JSON.stringify({ modelId }),
          });
          await loadDashboard();
          switchRouterSettingsTab("capabilities");
          notify("Capability detection completed.");
          return;
        }

        const capabilities = action === "reset" ? {} : { ...(model.capabilities ?? {}) };
        if (action !== "reset") {
          const verifiedAt = new Date().toISOString();
          card.querySelectorAll("[data-model-capability]").forEach((select) => {
            const capability = select.dataset.modelCapability;
            if (select.value === "inherit") delete capabilities[capability];
            else capabilities[capability] = {
              value: select.value,
              source: "user",
              lastVerifiedAt: verifiedAt,
            };
          });
          card.querySelectorAll("[data-model-capability-limit]").forEach((input) => {
            const name = input.dataset.modelCapabilityLimit;
            const parsed = Number.parseInt(input.value, 10);
            if (!input.value.trim()) delete capabilities[name];
            else if (Number.isInteger(parsed) && parsed > 0) capabilities[name] = parsed;
            else throw new Error(`${name === "contextWindow" ? "Context window" : "Maximum output tokens"} must be a positive whole number.`);
          });
        }
        model.capabilities = capabilities;
        await saveProviderModelCatalog(
          providerId,
          catalog,
          action === "reset" ? "Capability overrides reset." : "Model capability overrides saved.",
          { reopenModal: false },
        );
        switchRouterSettingsTab("capabilities");
      } catch (error) {
        notify(error.message);
      } finally {
        button.disabled = false;
      }
    });
  });
}

function modelAliasCapabilitySummary(alias) {
  const required = alias.requiredCapabilities ?? [];
  return required.length
    ? required.map(capabilityLabel).join(", ")
    : "No forced capabilities";
}

function modelAliasProviderSummary(alias) {
  const eligible = alias.eligibleProviderIds ?? [];
  return eligible.length
    ? `${eligible.length} selected provider${eligible.length === 1 ? "" : "s"}`
    : "All configured providers";
}

function renderModelAliases() {
  const container = $("#model-alias-list");
  if (!container) return;

  const existingCards = [...container.querySelectorAll("details[data-alias-id]")];
  const openAliasIds = new Set(
    existingCards
      .filter((card) => card.open)
      .map((card) => card.dataset.aliasId)
      .filter(Boolean),
  );

  const aliases = state.modelAliasesDraft;
  const configured = configuredProviders();
  const activeCount = aliases.filter((alias) => alias.enabled !== false).length;
  const countBadge = $("#model-alias-count");
  if (countBadge) countBadge.textContent = `${activeCount} active`;

  container.innerHTML = aliases.map((alias, index) => {
    const providerOrder = normalizeAliasProviderOrder(alias);
    const useAllProviders = !(alias.eligibleProviderIds ?? []).length;
    const system = alias.system === true;
    return `
      <details class="model-alias-card ${alias.enabled === false ? "disabled" : ""}" data-alias-id="${escapeHtml(alias.id)}" ${openAliasIds.has(alias.id) ? "open" : ""}>
        <summary>
          <span class="model-alias-summary-main">
            <span class="model-alias-icon">${escapeHtml(alias.name?.slice(0, 1)?.toUpperCase() || "A")}</span>
            <span>
              <strong>${escapeHtml(alias.name)}</strong>
              <code>${escapeHtml(alias.id)}</code>
            </span>
          </span>
          <span class="model-alias-summary-meta">
            ${system ? `<span class="model-alias-system-badge">System</span>` : ""}
            <span>${escapeHtml(aliasStrategyLabel(alias.routingStrategy))}</span>
            <span>${escapeHtml(modelAliasCapabilitySummary(alias))}</span>
            <span class="status ${alias.enabled === false ? "failed" : "connected"}">${alias.enabled === false ? "Disabled" : "Active"}</span>
          </span>
        </summary>

        <div class="model-alias-editor">
          <div class="model-alias-form-grid">
            <label>Display name
              <input data-alias-field="name" maxlength="80" value="${escapeHtml(alias.name)}" />
            </label>
            <label>Alias ID
              <input data-alias-field="id" maxlength="64" value="${escapeHtml(alias.id)}" ${system ? "disabled" : ""} />
            </label>
            <label>Routing strategy
              <select data-alias-field="routingStrategy">
                ${Object.entries(aliasStrategyLabels).map(([value, label]) => `
                  <option value="${escapeHtml(value)}" ${alias.routingStrategy === value ? "selected" : ""}>${escapeHtml(label)}</option>
                `).join("")}
              </select>
            </label>
            <label class="model-alias-enabled-control">
              <span>Alias status</span>
              <span class="toggle-control">
                <input type="checkbox" data-alias-field="enabled" ${alias.enabled !== false ? "checked" : ""} ${system ? "disabled" : ""} />
                <span>${system ? "Required system alias" : "Available to API clients"}</span>
              </span>
            </label>
          </div>

          <label>Description
            <textarea data-alias-field="description" rows="2" maxlength="240">${escapeHtml(alias.description ?? "")}</textarea>
          </label>

          <section class="model-alias-subsection">
            <div>
              <strong>Required capabilities</strong>
              <small>These requirements are added to whatever the incoming request already needs.</small>
            </div>
            <div class="model-alias-capability-grid">
              ${providerCapabilityOrder.filter((capability) => capability !== "embeddings").map((capability) => `
                <label class="alias-checkbox-chip">
                  <input type="checkbox" data-alias-capability="${escapeHtml(capability)}"
                    ${(alias.requiredCapabilities ?? []).includes(capability) ? "checked" : ""} />
                  <span>${escapeHtml(capabilityLabel(capability))}</span>
                </label>
              `).join("")}
            </div>
          </section>

          <section class="model-alias-subsection">
            <div class="model-alias-subsection-heading">
              <div>
                <strong>Eligible providers</strong>
                <small>${escapeHtml(modelAliasProviderSummary(alias))}</small>
              </div>
              <label class="toggle-control compact-toggle">
                <input type="checkbox" data-alias-all-providers ${useAllProviders ? "checked" : ""} />
                <span>Use all configured providers</span>
              </label>
            </div>
            <div class="model-alias-provider-grid ${useAllProviders ? "is-disabled" : ""}">
              ${configured.length ? configured.map((provider) => `
                <label class="alias-provider-option">
                  ${providerLogoMarkup(provider, "small")}
                  <span><strong>${escapeHtml(provider.name)}</strong><small>${escapeHtml(provider.model)}</small></span>
                  <input type="checkbox" data-alias-provider="${escapeHtml(provider.id)}"
                    ${useAllProviders || (alias.eligibleProviderIds ?? []).includes(provider.id) ? "checked" : ""}
                    ${useAllProviders ? "disabled" : ""} />
                </label>
              `).join("") : `<div class="inline-empty"><strong>No configured providers</strong><span>Add provider keys before restricting an alias.</span></div>`}
            </div>
          </section>

          <section class="model-alias-subsection">
            <div>
              <strong>Alias provider priority</strong>
              <small>This order overrides the router-wide order when the alias is used.</small>
            </div>
            <div class="alias-provider-order">
              ${providerOrder.length ? providerOrder.map((providerId, providerIndex) => {
      const provider = providerById(providerId) ?? { id: providerId, name: providerId, model: providerId };
      return `
                  <div class="alias-provider-order-row" data-alias-order-provider="${escapeHtml(providerId)}">
                    <span>${providerLogoMarkup(provider, "small")}<strong>${escapeHtml(providerDisplayName(providerId))}</strong></span>
                    <span>
                      <button class="ghost compact-button" type="button" data-alias-provider-move="up" ${providerIndex === 0 ? "disabled" : ""}>↑</button>
                      <button class="ghost compact-button" type="button" data-alias-provider-move="down" ${providerIndex === providerOrder.length - 1 ? "disabled" : ""}>↓</button>
                    </span>
                  </div>
                `;
    }).join("") : `<div class="inline-empty"><span>Provider priority will follow the router-wide order.</span></div>`}
            </div>
          </section>

          <section class="model-alias-subsection alias-reliability-section">
            <div class="model-alias-subsection-heading">
              <div><strong>Reliability overrides</strong><small>${escapeHtml(aliasReliabilitySummary(alias))}</small></div>
              <label class="toggle-control compact-toggle">
                <input type="checkbox" data-alias-reliability-enabled ${alias.reliabilityOverrides ? "checked" : ""} />
                <span>Override router limits</span>
              </label>
            </div>
            <div class="alias-reliability-grid ${alias.reliabilityOverrides ? "" : "is-disabled"}">
              <label>Provider timeout
                <span class="input-with-unit"><input type="number" min="1" max="300" step="1" data-alias-reliability="providerTimeoutMs" value="${alias.reliabilityOverrides?.providerTimeoutMs ? millisecondsToSeconds(alias.reliabilityOverrides.providerTimeoutMs) : millisecondsToSeconds(reliabilitySettingsFromDom().providerTimeoutMs)}" ${alias.reliabilityOverrides ? "" : "disabled"} /><span>sec</span></span>
              </label>
              <label>Total deadline
                <span class="input-with-unit"><input type="number" min="1" max="600" step="1" data-alias-reliability="totalRequestTimeoutMs" value="${alias.reliabilityOverrides?.totalRequestTimeoutMs ? millisecondsToSeconds(alias.reliabilityOverrides.totalRequestTimeoutMs) : millisecondsToSeconds(reliabilitySettingsFromDom().totalRequestTimeoutMs)}" ${alias.reliabilityOverrides ? "" : "disabled"} /><span>sec</span></span>
              </label>
              <label>Maximum attempts
                <input type="number" min="1" max="20" step="1" data-alias-reliability="maxProviderAttempts" value="${alias.reliabilityOverrides?.maxProviderAttempts ?? reliabilitySettingsFromDom().maxProviderAttempts}" ${alias.reliabilityOverrides ? "" : "disabled"} />
              </label>
            </div>
          </section>

          <div class="model-alias-card-actions">
            <span>Requested as <code>${escapeHtml(alias.id)}</code></span>
            ${system ? "" : `<button class="secondary danger" type="button" data-delete-alias>Delete alias</button>`}
          </div>
        </div>
      </details>
    `;
  }).join("");

  bindProviderLogoFallbacks(container);
}

function renderPlaygroundModelOptions(forceProtocolDefault = false) {
  const select = $("#test-model-alias");
  if (!select) return;
  const apiFormat = $("#test-api-format")?.value ?? "openai-compatible";
  const aliases = enabledModelAliases();
  const previous = forceProtocolDefault
    ? defaultModelForApi(apiFormat)
    : select.value || defaultModelForApi(apiFormat);

  select.innerHTML = aliases.map((alias) => `
    <option value="${escapeHtml(alias.id)}">${escapeHtml(alias.name)} · ${escapeHtml(alias.id)}</option>
  `).join("");

  const selected = aliases.some((alias) => alias.id === previous)
    ? previous
    : aliases.some((alias) => alias.id === defaultModelForApi(apiFormat))
      ? defaultModelForApi(apiFormat)
      : aliases[0]?.id;
  if (selected) select.value = selected;
}

function switchSettingsTab(tabName) {
  state.activeSettingsTab = tabName;
  $$('[data-settings-tab]').forEach((button) => {
    const active = button.dataset.settingsTab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$('[data-settings-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== tabName;
  });
}

function switchRouterSettingsTab(tabName) {
  state.activeRouterSettingsTab = tabName;
  $$('[data-router-settings-tab]').forEach((button) => {
    const active = button.dataset.routerSettingsTab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$('[data-router-settings-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.routerSettingsPanel !== tabName;
  });
}

function switchAnalysisTab(tabName) {
  state.activeAnalysisTab = tabName;
  $$('[data-analysis-tab]').forEach((button) => {
    const active = button.dataset.analysisTab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$('[data-analysis-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.analysisPanel !== tabName;
  });
}

function switchAnalyticsDashboard(tabName) {
  state.activeAnalyticsDashboard = tabName;
  $$('[data-analytics-dashboard-tab]').forEach((button) => {
    const active = button.dataset.analyticsDashboardTab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$('[data-analytics-dashboard-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.analyticsDashboardPanel !== tabName;
  });
}

function switchDocsTab(tabName) {
  state.activeDocsTab = tabName;
  $$('[data-docs-tab]').forEach((button) => {
    const active = button.dataset.docsTab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  $$('[data-docs-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.docsPanel !== tabName;
  });
}


function renderReliabilitySettings(source = state.account?.reliabilitySettings) {
  const settings = reliabilitySettings(source);
  const setValue = (selector, value) => {
    const input = $(selector);
    if (input) input.value = String(value);
  };
  setValue("#reliability-provider-timeout", millisecondsToSeconds(settings.providerTimeoutMs));
  setValue("#reliability-total-timeout", millisecondsToSeconds(settings.totalRequestTimeoutMs));
  setValue("#reliability-max-attempts", settings.maxProviderAttempts);
  setValue("#reliability-stream-timeout", millisecondsToSeconds(settings.streamingConnectionTimeoutMs));
  setValue("#reliability-probe-timeout", millisecondsToSeconds(settings.halfOpenProbeTimeoutMs));
  setValue("#reliability-status-codes", settings.retryStatusCodes.join(", "));
  setValue("#reliability-initial-backoff", settings.initialBackoffMs);
  setValue("#reliability-max-backoff", settings.maxBackoffMs);
  setValue("#reliability-backoff-multiplier", settings.backoffMultiplier);
  const jitter = $("#reliability-use-jitter");
  const network = $("#reliability-network-errors");
  const malformed = $("#reliability-malformed");
  if (jitter) jitter.checked = settings.useJitter;
  if (network) network.checked = settings.retryNetworkErrors;
  if (malformed) malformed.checked = settings.retryMalformedResponses;

  const overrides = $("#reliability-provider-overrides");
  if (!overrides) return;
  const providers = configuredProviders();
  overrides.innerHTML = providers.length
    ? providers.map((provider) => `
      <label class="provider-timeout-override-row">
        <span>${providerLogoMarkup(provider, "small")}<span><strong>${escapeHtml(provider.name)}</strong><small>${escapeHtml(provider.model)}</small></span></span>
        <span class="input-with-unit compact-unit"><input type="number" min="1" max="300" step="1" data-provider-timeout-override="${escapeHtml(provider.id)}" value="${settings.providerTimeoutOverrides[provider.id] ? millisecondsToSeconds(settings.providerTimeoutOverrides[provider.id]) : ""}" placeholder="Default" /><span>sec</span></span>
      </label>
    `).join("")
    : `<div class="inline-empty"><span>Connect a provider to add a timeout override.</span></div>`;
  bindProviderLogoFallbacks(overrides);
}

function reliabilitySettingsFromDom() {
  const seconds = (selector, fallback) => {
    const value = Number($(selector)?.value);
    return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : fallback;
  };
  const number = (selector, fallback) => {
    const value = Number($(selector)?.value);
    return Number.isFinite(value) ? value : fallback;
  };
  const current = reliabilitySettings();
  const retryStatusCodes = parseRetryStatusCodes($("#reliability-status-codes")?.value);
  const providerTimeoutOverrides = {};
  $$('[data-provider-timeout-override]').forEach((input) => {
    const value = Number(input.value);
    if (Number.isFinite(value) && value > 0) {
      providerTimeoutOverrides[input.dataset.providerTimeoutOverride] = Math.round(value * 1000);
    }
  });
  return {
    providerTimeoutMs: seconds("#reliability-provider-timeout", current.providerTimeoutMs),
    totalRequestTimeoutMs: seconds("#reliability-total-timeout", current.totalRequestTimeoutMs),
    maxProviderAttempts: Math.max(1, Math.round(number("#reliability-max-attempts", current.maxProviderAttempts))),
    initialBackoffMs: Math.max(0, Math.round(number("#reliability-initial-backoff", current.initialBackoffMs))),
    maxBackoffMs: Math.max(0, Math.round(number("#reliability-max-backoff", current.maxBackoffMs))),
    backoffMultiplier: Math.max(1, number("#reliability-backoff-multiplier", current.backoffMultiplier)),
    useJitter: $("#reliability-use-jitter")?.checked === true,
    retryStatusCodes,
    retryNetworkErrors: $("#reliability-network-errors")?.checked === true,
    retryMalformedResponses: $("#reliability-malformed")?.checked === true,
    streamingConnectionTimeoutMs: seconds("#reliability-stream-timeout", current.streamingConnectionTimeoutMs),
    halfOpenProbeTimeoutMs: seconds("#reliability-probe-timeout", current.halfOpenProbeTimeoutMs),
    providerTimeoutOverrides,
  };
}

function renderDeduplicationSettings(source = state.account?.deduplicationSettings) {
  const settings = deduplicationSettings(source);
  const enabled = $("#dedup-enabled");
  const automatic = $("#dedup-automatic-fingerprinting");
  const requireKey = $("#dedup-require-idempotency-key");
  const tools = $("#dedup-bypass-tools");
  const multimodal = $("#dedup-bypass-multimodal");
  const nondeterministic = $("#dedup-bypass-nondeterministic");
  const windowInput = $("#dedup-window");
  if (enabled) enabled.checked = settings.enabled;
  if (automatic) automatic.checked = settings.automaticFingerprinting;
  if (requireKey) requireKey.checked = settings.requireIdempotencyKey;
  if (tools) tools.checked = settings.bypassToolRequests;
  if (multimodal) multimodal.checked = settings.bypassMultimodalRequests;
  if (nondeterministic) nondeterministic.checked = settings.bypassNonDeterministicRequests;
  if (windowInput) windowInput.value = String(Math.round(settings.windowMs / 1000));
}

function deduplicationSettingsFromDom() {
  const current = deduplicationSettings();
  const seconds = Number($("#dedup-window")?.value);
  return {
    enabled: $("#dedup-enabled")?.checked === true,
    windowMs: Number.isFinite(seconds) && seconds > 0
      ? Math.min(300, Math.max(1, Math.round(seconds))) * 1000
      : current.windowMs,
    automaticFingerprinting: $("#dedup-automatic-fingerprinting")?.checked === true,
    requireIdempotencyKey: $("#dedup-require-idempotency-key")?.checked === true,
    bypassToolRequests: $("#dedup-bypass-tools")?.checked === true,
    bypassMultimodalRequests: $("#dedup-bypass-multimodal")?.checked === true,
    bypassNonDeterministicRequests: $("#dedup-bypass-nondeterministic")?.checked === true,
  };
}

function aliasReliabilitySummary(alias) {
  const overrides = alias.reliabilityOverrides;
  if (!overrides) return "Uses router reliability controls";
  const parts = [];
  if (overrides.providerTimeoutMs) parts.push(`${millisecondsToSeconds(overrides.providerTimeoutMs)}s provider timeout`);
  if (overrides.totalRequestTimeoutMs) parts.push(`${millisecondsToSeconds(overrides.totalRequestTimeoutMs)}s total deadline`);
  if (overrides.maxProviderAttempts) parts.push(`${overrides.maxProviderAttempts} attempts`);
  return parts.length ? parts.join(" · ") : "Uses router reliability controls";
}

function renderSettings() {
  if (!state.account) return;

  if (!state.modelAliasesDirty) {
    state.modelAliasesDraft = cloneModelAliases(state.account.modelAliases);
  }

  const policy = state.account.routingPolicy ?? {
    strategy: "priority",
    providerOrder: [],
  };
  state.routingProviderOrder = normalizedRoutingProviderOrder();

  $("#settings-router-name").textContent = state.account.name;
  $("#settings-created-at").textContent = state.account.createdAt
    ? `Created ${formatTimestamp(state.account.createdAt)}`
    : "Created date unavailable";

  const routerNameInput = $("#settings-router-name-input");
  if (routerNameInput) routerNameInput.value = state.account.name;

  const settingsBaseUrl = $("#settings-base-url");
  if (settingsBaseUrl) settingsBaseUrl.textContent = `${location.origin}/v1`;

  const keyPreview = $("#settings-router-key-preview");
  if (keyPreview) {
    keyPreview.textContent = `${state.account.routerKeyPrefix}••••••••••••`;
  }

  const policyRadio = $(`input[name="routingStrategy"][value="${policy.strategy}"]`);
  if (policyRadio) policyRadio.checked = true;

  const policyBadge = $("#settings-policy-badge");
  if (policyBadge) policyBadge.textContent = routingStrategyLabel(policy.strategy);

  $("#settings-storage-mode").textContent = "Encrypted";
  $("#settings-security-mode").textContent = "API keys hidden";

  const auth = state.authUser;

  const accountName = $("#settings-account-name");
  if (accountName) accountName.textContent = auth?.name ?? "Signed-in user";

  const accountEmail = $("#settings-account-email");
  if (accountEmail) accountEmail.textContent = auth?.email ?? "Email unavailable";

  const loginMethod = $("#settings-login-method");
  if (loginMethod) loginMethod.textContent = auth?.loginMethod ?? "Unknown";

  const accountUserId = $("#settings-user-id");
  if (accountUserId) accountUserId.textContent = maskUserId(auth?.id);

  const accountCreatedAt = $("#settings-account-created-at");
  if (accountCreatedAt) {
    accountCreatedAt.textContent = auth?.createdAt
      ? `Account created ${formatClerkDate(auth.createdAt)}`
      : "Account creation date unavailable";
  }

  const lastSignIn = $("#settings-last-sign-in");
  if (lastSignIn) {
    lastSignIn.textContent = auth?.lastSignInAt
      ? `Last sign in ${formatClerkDate(auth.lastSignInAt)}`
      : "Last sign-in unavailable";
  }

  const avatar = $("#settings-account-avatar");
  if (avatar && auth) {
    if (auth.imageUrl) {
      avatar.innerHTML = `<img src="${escapeHtml(auth.imageUrl)}" alt="${escapeHtml(auth.name)} avatar" />`;
    } else {
      avatar.textContent = auth.name?.slice(0, 1).toUpperCase() ?? "U";
    }
  }

  renderRoutingProviderOrder();
  renderReliabilitySettings();
  renderDeduplicationSettings();
  renderModelAliases();
  renderCapabilityRegistry();
  const capabilityMode = $("#capability-unknown-mode");
  if (capabilityMode) capabilityMode.value = state.account.capabilityRoutingSettings?.unknownMode ?? "flexible";
  switchSettingsTab(state.activeSettingsTab);
}


function playgroundRequiredCapabilities(apiFormat, scenario) {
  if (scenario === "tools") return ["tools"];
  if (scenario === "reasoning") return ["reasoning"];
  if (scenario === "schema") return ["structuredOutputs"];
  if (scenario === "json") {
    return apiFormat === "claude-code-compatible"
      ? ["structuredOutputs"]
      : ["jsonMode"];
  }
  return [];
}

function playgroundRequestEnhancements(apiFormat, scenario) {
  const schema = {
    type: "object",
    properties: { result: { type: "string" } },
    required: ["result"],
    additionalProperties: false,
  };
  const parameters = {
    type: "object",
    properties: { category: { type: "string" }, confidence: { type: "number" } },
    required: ["category"],
    additionalProperties: false,
  };

  if (scenario === "tools") {
    if (apiFormat === "claude-code-compatible") {
      return {
        tools: [{
          name: "classify_request",
          description: "Classify the user request",
          input_schema: parameters,
        }],
        tool_choice: { type: "any" },
      };
    }
    if (apiFormat === "openai-responses-compatible") {
      return {
        tools: [{
          type: "function",
          name: "classify_request",
          description: "Classify the user request",
          parameters,
        }],
        tool_choice: "required",
      };
    }
    return {
      tools: [{
        type: "function",
        function: {
          name: "classify_request",
          description: "Classify the user request",
          parameters,
        },
      }],
      tool_choice: "required",
    };
  }

  if (scenario === "schema" || (scenario === "json" && apiFormat === "claude-code-compatible")) {
    if (apiFormat === "claude-code-compatible") {
      return { output_config: { format: { type: "json_schema", name: "playground_result", schema, strict: true } } };
    }
    if (apiFormat === "openai-responses-compatible") {
      return { text: { format: { type: "json_schema", name: "playground_result", schema, strict: true } } };
    }
    return { response_format: { type: "json_schema", json_schema: { name: "playground_result", schema, strict: true } } };
  }

  if (scenario === "json") {
    return apiFormat === "openai-responses-compatible"
      ? { text: { format: { type: "json_object" } } }
      : { response_format: { type: "json_object" } };
  }

  if (scenario === "reasoning") {
    if (apiFormat === "claude-code-compatible") {
      return { thinking: { type: "enabled", budget_tokens: 128 } };
    }
    return apiFormat === "openai-responses-compatible"
      ? { reasoning: { effort: "medium" } }
      : { reasoning_effort: "medium" };
  }

  return {};
}

function renderPlaygroundCapabilityPreview() {
  const preview = $("#test-capability-preview");
  if (!preview) return;
  const apiFormat = $("#test-api-format")?.value ?? "openai-compatible";
  const scenario = $("#test-capability")?.value ?? "basic";
  const aliasId = $("#test-model-alias")?.value ?? defaultModelForApi(apiFormat);
  const alias = modelAliasById(aliasId, state.account?.modelAliases ?? []);
  const requirements = [...new Set([
    ...playgroundRequiredCapabilities(apiFormat, scenario),
    ...(alias?.requiredCapabilities ?? []),
  ])];

  preview.innerHTML = `
    <span class="playground-preview-label">Router requirements</span>
    <span class="playground-preview-chips">
      <span class="model-alias-preview-chip">${escapeHtml(alias?.name ?? aliasId)}</span>
      ${requirements.length
      ? requirements.map((capability) => `<span class="capability-requirement-chip">${escapeHtml(capabilityLabel(capability))}</span>`).join("")
      : `<span class="capability-neutral-chip">No special capability required</span>`}
    </span>
    <small>${escapeHtml(alias ? `${aliasStrategyLabel(alias.routingStrategy)} · ${modelAliasProviderSummary(alias)}` : "The router-wide policy will be used.")}</small>
  `;
}

function updatePlaygroundHint() {
  const count = state.account?.configuredProviderIds?.length ?? 0;
  const apiFormat = $("#test-api-format")?.value ?? "openai-compatible";
  const aliasId = $("#test-model-alias")?.value ?? defaultModelForApi(apiFormat);
  const endpoint = apiFormat === "claude-code-compatible"
    ? "/v1/messages"
    : apiFormat === "openai-responses-compatible"
      ? "/v1/responses"
      : "/v1/chat/completions";
  $("#test-hint").textContent = count
    ? `${apiFormatLabel(apiFormat)} · ${aliasId} · POST ${endpoint}`
    : "Connect a provider to run a test.";
  renderPlaygroundCapabilityPreview();
}

function render() {
  welcome.hidden = true;
  dashboard.hidden = false;

  $("#router-name").textContent = state.account.name;
  const count = state.account.configuredProviderIds.length;
  $("#provider-count").textContent = String(count);
  $("#provider-summary").textContent = count ? "Ready to route requests" : "Add your first provider";
  $("#overview-empty").hidden = count > 0;
  $("#test-button").disabled = count === 0;
  renderPlaygroundModelOptions();
  updatePlaygroundHint();
  $("#base-url").textContent = `${location.origin}/v1`;
  $("#router-key-preview").textContent = `${state.account.routerKeyPrefix}••••••••••••`;

  renderProviders($("#provider-search")?.value ?? "");
  renderHealthList();
  renderSnippets();
  renderAnalytics();
  renderSettings();
}

async function loadDashboard() {
  if (!state.routerKey) return;
  try {
    const payload = await api("/api/me");
    state.account = payload.account;
    state.providers = payload.providers;
    state.modelAliasesDirty = false;
    render();

    try {
      await loadAnalytics();
      renderProviders($("#provider-search")?.value ?? "");
      renderHealthList();
    } catch {
      // Analytics is helpful but should not block dashboard load.
    }
  } catch (error) {
    localStorage.removeItem(storageKey);
    state.routerKey = null;
    welcome.hidden = false;
    dashboard.hidden = true;
  }
}

async function showSignedInState(clerk) {
  state.sessionToken = await clerk.session.getToken();
  saveAuthUserFromClerk(clerk);

  $("#auth-user").textContent =
    state.authUser?.name ||
    clerk.user.firstName ||
    clerk.user.primaryEmailAddress?.emailAddress ||
    "Signed in";
  $("#auth-user").hidden = false;
  $("#sign-out").hidden = false;
  authGate.hidden = true;

  try {
    const payload = await api("/api/user/router");
    if (payload.router) {
      state.routerKey = payload.router.routerKey;
      localStorage.setItem(storageKey, state.routerKey);
      await loadDashboard();
    } else {
      localStorage.removeItem(storageKey);
      state.routerKey = null;
      welcome.hidden = false;
      dashboard.hidden = true;
    }
  } catch (error) {
    authGate.hidden = false;
    welcome.hidden = true;
    dashboard.hidden = true;
    $("#clerk-sign-in").textContent =
      error instanceof Error
        ? `Signed in, but dashboard auth failed: ${error.message}`
        : "Signed in, but dashboard auth failed.";
  }
}

async function loadClerkUi(publishableKey) {
  const encodedDomain = publishableKey.split("_")[2];
  if (!encodedDomain) throw new Error("Invalid Clerk publishable key");
  const clerkDomain = atob(encodedDomain).slice(0, -1);

  await new Promise((resolve, reject) => {
    const existing = document.querySelector("[data-clerk-ui-bundle]");
    if (existing && window.__internal_ClerkUICtor) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.dataset.clerkUiBundle = "true";
    script.src = `https://${clerkDomain}/npm/@clerk/ui@1/dist/ui.browser.js`;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Secure sign-in UI could not be loaded.")),
      { once: true },
    );
    document.head.append(script);
  });
}

async function initializeAuth() {
  try {
    const configResponse = await fetch("/api/auth/config");
    const config = await configResponse.json();
    if (!configResponse.ok) throw new Error(config.error ?? "Authentication unavailable");

    await loadClerkUi(config.publishableKey);
    const clerk = new Clerk(config.publishableKey);
    await clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    window.freeLlmClerk = clerk;
    if (clerk.user) {
      await showSignedInState(clerk);
      return;
    }

    authGate.hidden = false;
    $("#clerk-sign-in").replaceChildren();
    clerk.mountSignIn($("#clerk-sign-in"), {
      fallbackRedirectUrl: "/dashboard",
      signUpFallbackRedirectUrl: "/dashboard",
    });
  } catch (error) {
    $("#clerk-sign-in").textContent =
      error instanceof Error ? error.message : "Sign-in could not be loaded.";
  }
}

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({ name: $("#account-name").value }),
    });
    state.routerKey = payload.routerKey;
    localStorage.setItem(storageKey, state.routerKey);
    await loadDashboard();
    notify("Router created. Save your router key now.");
  } catch (error) {
    notify(error.message);
  }
});

async function signOut() {
  await window.freeLlmClerk?.signOut();
  localStorage.removeItem(storageKey);
  location.reload();
}

$("#sign-out").addEventListener("click", signOut);
$("#settings-sign-out").addEventListener("click", signOut);

$$('[data-settings-tab]').forEach((button) =>
  button.addEventListener("click", () => switchSettingsTab(button.dataset.settingsTab)),
);

$$('[data-router-settings-tab]').forEach((button) =>
  button.addEventListener("click", () => switchRouterSettingsTab(button.dataset.routerSettingsTab)),
);

$$('[data-analysis-tab]').forEach((button) =>
  button.addEventListener("click", () => switchAnalysisTab(button.dataset.analysisTab)),
);

$$('[data-analytics-dashboard-tab]').forEach((button) =>
  button.addEventListener("click", () => switchAnalyticsDashboard(button.dataset.analyticsDashboardTab)),
);

$$('[data-docs-tab]').forEach((button) =>
  button.addEventListener("click", () => switchDocsTab(button.dataset.docsTab)),
);

$("#routing-provider-order").addEventListener("click", (event) => {
  const moveButton = event.target.closest("[data-routing-move]");
  const row = event.target.closest("[data-routing-provider]");
  if (!moveButton || !row) return;

  const currentIndex = state.routingProviderOrder.indexOf(row.dataset.routingProvider);
  const nextIndex = moveButton.dataset.routingMove === "up"
    ? currentIndex - 1
    : currentIndex + 1;
  if (
    currentIndex < 0 ||
    nextIndex < 0 ||
    nextIndex >= state.routingProviderOrder.length
  ) return;

  const reordered = [...state.routingProviderOrder];
  [reordered[currentIndex], reordered[nextIndex]] = [
    reordered[nextIndex],
    reordered[currentIndex],
  ];
  state.routingProviderOrder = reordered;
  renderRoutingProviderOrder();
  $("#routing-save-hint").textContent = "Unsaved provider-order changes.";
});

$("#routing-provider-order").addEventListener("dragstart", (event) => {
  const row = event.target.closest("[data-routing-provider]");
  if (!row) return;
  state.routingDragProvider = row.dataset.routingProvider;
  row.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", state.routingDragProvider);
});

$("#routing-provider-order").addEventListener("dragover", (event) => {
  const row = event.target.closest("[data-routing-provider]");
  if (!row || !state.routingDragProvider) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  $("#routing-provider-order").querySelectorAll(".drag-over").forEach((item) => item.classList.remove("drag-over"));
  if (row.dataset.routingProvider !== state.routingDragProvider) row.classList.add("drag-over");
});

$("#routing-provider-order").addEventListener("drop", (event) => {
  const row = event.target.closest("[data-routing-provider]");
  if (!row || !state.routingDragProvider) return;
  event.preventDefault();
  const sourceIndex = state.routingProviderOrder.indexOf(state.routingDragProvider);
  const targetIndex = state.routingProviderOrder.indexOf(row.dataset.routingProvider);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
  const reordered = [...state.routingProviderOrder];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  state.routingProviderOrder = reordered;
  state.routingDragProvider = null;
  renderRoutingProviderOrder();
  $("#routing-save-hint").textContent = "Unsaved provider-order changes.";
});

$("#routing-provider-order").addEventListener("dragend", () => {
  state.routingDragProvider = null;
  $("#routing-provider-order").querySelectorAll(".dragging, .drag-over").forEach((item) => {
    item.classList.remove("dragging", "drag-over");
  });
});

$$('input[name="routingStrategy"]').forEach((input) =>
  input.addEventListener("change", () => {
    const selected = $('input[name="routingStrategy"]:checked')?.value ?? "priority";
    $("#settings-policy-badge").textContent = routingStrategyLabel(selected);
    $("#routing-save-hint").textContent = "Unsaved routing-policy changes.";
  }),
);

function markModelAliasesDirty(message = "Unsaved model-alias changes.") {
  state.modelAliasesDirty = true;
  const hint = $("#routing-save-hint");
  if (hint) hint.textContent = message;
}

function aliasNameFromId(aliasId) {
  return aliasId
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function newAliasFromPreset(id, name, preset) {
  const base = {
    id,
    name,
    description: "Custom virtual model alias.",
    enabled: true,
    routingStrategy: "inherit",
    requiredCapabilities: [],
    eligibleProviderIds: [],
    providerOrder: configuredProviders().map((provider) => provider.id),
  };

  if (preset === "fastest") {
    return { ...base, description: "Prefer the provider with the lowest observed latency.", routingStrategy: "fastest" };
  }
  if (preset === "reliability") {
    return { ...base, description: "Prefer providers with the strongest success history.", routingStrategy: "reliability" };
  }
  if (preset === "coding") {
    return { ...base, description: "Require streaming and tool support for agentic coding tasks.", routingStrategy: "smart", requiredCapabilities: ["streaming", "tools"] };
  }
  if (preset === "vision") {
    return { ...base, description: "Route image requests only to vision-capable providers.", routingStrategy: "reliability", requiredCapabilities: ["vision"] };
  }
  if (preset === "reasoning") {
    return { ...base, description: "Require reasoning support and use smart routing.", routingStrategy: "smart", requiredCapabilities: ["reasoning"] };
  }
  if (preset === "structured") {
    return { ...base, description: "Require strict structured-output support.", routingStrategy: "reliability", requiredCapabilities: ["structuredOutputs"] };
  }
  return base;
}

function commitPendingAliasCreation({ skipWhenEmpty = false } = {}) {
  const idInput = $("#new-alias-id");
  const nameInput = $("#new-alias-name");
  const presetInput = $("#new-alias-preset");
  const rawId = idInput?.value?.trim() ?? "";
  const rawName = nameInput?.value?.trim() ?? "";

  if (!rawId) {
    if (skipWhenEmpty && !rawName) return true;
    notify("Enter an alias ID before saving.");
    idInput?.focus();
    return false;
  }

  const id = rawId.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) {
    notify("Use a lowercase alias ID with letters, numbers, dots, underscores, or hyphens.");
    idInput?.focus();
    return false;
  }
  if (modelAliasById(id)) {
    notify("That model alias already exists.");
    idInput?.focus();
    return false;
  }

  const name = rawName || aliasNameFromId(id);
  state.modelAliasesDraft.push(
    newAliasFromPreset(id, name, presetInput?.value ?? "inherit"),
  );
  markModelAliasesDirty("New model alias is ready to save.");

  if (idInput) idInput.value = "";
  if (nameInput) nameInput.value = "";
  if (presetInput) presetInput.value = "inherit";

  renderModelAliases();
  const created = [...($("#model-alias-list")?.querySelectorAll("[data-alias-id]") ?? [])]
    .find((item) => item.dataset.aliasId === id);
  if (created) created.open = true;
  return true;
}

function syncModelAliasDraftFromDom() {
  const cards = [...($("#model-alias-list")?.querySelectorAll("[data-alias-id]") ?? [])];
  const nextIds = new Set();

  for (const card of cards) {
    const originalId = card.dataset.aliasId;
    const alias = modelAliasById(originalId);
    if (!alias) continue;

    const idField = card.querySelector('[data-alias-field="id"]');
    const nextId = (idField?.value ?? alias.id).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(nextId)) {
      notify(`Invalid alias ID: ${nextId || "empty"}.`);
      idField?.focus();
      return false;
    }
    if (nextIds.has(nextId)) {
      notify(`Duplicate model alias: ${nextId}.`);
      idField?.focus();
      return false;
    }
    nextIds.add(nextId);

    alias.id = nextId;
    alias.name = card.querySelector('[data-alias-field="name"]')?.value?.trim()
      || aliasNameFromId(nextId);
    alias.description = card.querySelector('[data-alias-field="description"]')?.value?.trim() ?? "";
    alias.routingStrategy = card.querySelector('[data-alias-field="routingStrategy"]')?.value
      ?? alias.routingStrategy;

    const enabledField = card.querySelector('[data-alias-field="enabled"]');
    if (enabledField && !enabledField.disabled) alias.enabled = enabledField.checked;

    alias.requiredCapabilities = [...card.querySelectorAll("[data-alias-capability]:checked")]
      .map((input) => input.dataset.aliasCapability)
      .filter(Boolean);

    const allProviders = card.querySelector("[data-alias-all-providers]")?.checked !== false;
    alias.eligibleProviderIds = allProviders
      ? []
      : [...card.querySelectorAll("[data-alias-provider]:checked")]
        .map((input) => input.dataset.aliasProvider)
        .filter(Boolean);

    const reliabilityEnabled = card.querySelector("[data-alias-reliability-enabled]")?.checked === true;
    if (reliabilityEnabled) {
      const providerTimeoutSeconds = Number(card.querySelector('[data-alias-reliability="providerTimeoutMs"]')?.value);
      const totalTimeoutSeconds = Number(card.querySelector('[data-alias-reliability="totalRequestTimeoutMs"]')?.value);
      const maxAttempts = Number(card.querySelector('[data-alias-reliability="maxProviderAttempts"]')?.value);
      alias.reliabilityOverrides = {
        providerTimeoutMs: Math.max(1, Math.round(providerTimeoutSeconds || millisecondsToSeconds(reliabilitySettingsFromDom().providerTimeoutMs))) * 1000,
        totalRequestTimeoutMs: Math.max(1, Math.round(totalTimeoutSeconds || millisecondsToSeconds(reliabilitySettingsFromDom().totalRequestTimeoutMs))) * 1000,
        maxProviderAttempts: Math.max(1, Math.round(maxAttempts || reliabilitySettingsFromDom().maxProviderAttempts)),
      };
    } else {
      delete alias.reliabilityOverrides;
    }
  }

  return true;
}

$("#add-model-alias").addEventListener("click", () => {
  commitPendingAliasCreation();
});

$("#model-alias-list").addEventListener("change", (event) => {
  const target = event.target;
  const card = target.closest("[data-alias-id]");
  if (!card) return;
  const originalId = card.dataset.aliasId;
  const alias = modelAliasById(originalId);
  if (!alias) return;

  const field = target.dataset.aliasField;
  if (field === "id") {
    const nextId = target.value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(nextId)) {
      notify("Invalid alias ID.");
      target.value = alias.id;
      return;
    }
    if (nextId !== alias.id && modelAliasById(nextId)) {
      notify("That model alias already exists.");
      target.value = alias.id;
      return;
    }
    alias.id = nextId;
    card.dataset.aliasId = nextId;
  } else if (field === "name") {
    alias.name = target.value.trim() || aliasNameFromId(alias.id);
  } else if (field === "description") {
    alias.description = target.value.trim();
  } else if (field === "routingStrategy") {
    alias.routingStrategy = target.value;
  } else if (field === "enabled") {
    alias.enabled = target.checked;
  }

  const capability = target.dataset.aliasCapability;
  if (capability) {
    const required = new Set(alias.requiredCapabilities ?? []);
    if (target.checked) required.add(capability);
    else required.delete(capability);
    alias.requiredCapabilities = [...required];
  }

  if (target.hasAttribute("data-alias-all-providers")) {
    alias.eligibleProviderIds = target.checked
      ? []
      : configuredProviders().map((provider) => provider.id);
  }

  const providerId = target.dataset.aliasProvider;
  if (providerId) {
    const eligible = new Set(alias.eligibleProviderIds ?? []);
    if (target.checked) eligible.add(providerId);
    else eligible.delete(providerId);
    if (eligible.size === 0) {
      notify("Select at least one provider or enable all configured providers.");
      target.checked = true;
      eligible.add(providerId);
    }
    alias.eligibleProviderIds = [...eligible];
  }

  if (target.hasAttribute("data-alias-reliability-enabled")) {
    if (target.checked) {
      const defaults = reliabilitySettingsFromDom();
      alias.reliabilityOverrides = {
        providerTimeoutMs: defaults.providerTimeoutMs,
        totalRequestTimeoutMs: defaults.totalRequestTimeoutMs,
        maxProviderAttempts: defaults.maxProviderAttempts,
      };
    } else {
      delete alias.reliabilityOverrides;
    }
  }

  const reliabilityField = target.dataset.aliasReliability;
  if (reliabilityField) {
    alias.reliabilityOverrides ??= {};
    const rawValue = Number(target.value);
    if (reliabilityField === "providerTimeoutMs" || reliabilityField === "totalRequestTimeoutMs") {
      alias.reliabilityOverrides[reliabilityField] = Math.max(1, Math.round(rawValue || 1)) * 1000;
    } else if (reliabilityField === "maxProviderAttempts") {
      alias.reliabilityOverrides.maxProviderAttempts = Math.max(1, Math.round(rawValue || 1));
    }
  }

  markModelAliasesDirty();
  renderModelAliases();
});

$("#model-alias-list").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const card = button.closest("[data-alias-id]");
  if (!card) return;
  const alias = modelAliasById(card.dataset.aliasId);
  if (!alias) return;

  if (button.hasAttribute("data-delete-alias")) {
    state.modelAliasesDraft = state.modelAliasesDraft.filter((item) => item.id !== alias.id);
    markModelAliasesDirty("Model alias will be deleted after saving.");
    renderModelAliases();
    return;
  }

  const direction = button.dataset.aliasProviderMove;
  if (!direction) return;
  const row = button.closest("[data-alias-order-provider]");
  const providerId = row?.dataset.aliasOrderProvider;
  if (!providerId) return;
  const order = normalizeAliasProviderOrder(alias);
  const index = order.indexOf(providerId);
  const nextIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
  [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
  alias.providerOrder = order;
  markModelAliasesDirty("Unsaved alias provider-priority changes.");
  renderModelAliases();
});

$("#reset-reliability-settings")?.addEventListener("click", () => {
  renderReliabilitySettings(defaultReliabilitySettings);
  $("#routing-save-hint").textContent = "Default reliability controls loaded. Save router settings to apply them.";
  notify("Reliability defaults loaded.");
});

$("#reset-deduplication-settings")?.addEventListener("click", () => {
  renderDeduplicationSettings(defaultDeduplicationSettings);
  $("#routing-save-hint").textContent = "Default deduplication controls loaded. Save router settings to apply them.";
  notify("Deduplication defaults loaded.");
});

$("#router-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  // Treat a filled create row as an alias even if the user clicks Save
  // without clicking Add alias first.
  if (!commitPendingAliasCreation({ skipWhenEmpty: true })) return;
  if (!syncModelAliasDraftFromDom()) return;

  const button = $("#save-router-settings");
  const strategy = $('input[name="routingStrategy"]:checked')?.value ?? "priority";
  const name = $("#settings-router-name-input").value.trim();
  const submittedAliases = cloneModelAliases(state.modelAliasesDraft);

  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const payload = await api("/api/router/settings", {
      method: "PATCH",
      body: JSON.stringify({
        name,
        routingPolicy: {
          strategy,
          providerOrder: state.routingProviderOrder,
        },
        reliabilitySettings: reliabilitySettingsFromDom(),
        deduplicationSettings: deduplicationSettingsFromDom(),
        capabilityRoutingSettings: {
          unknownMode: $("#capability-unknown-mode")?.value === "strict" ? "strict" : "flexible",
        },
        modelAliases: submittedAliases,
      }),
    });

    // Support both a direct AccountSummary and a future { account } wrapper.
    const savedAccount = payload?.account ?? payload;
    if (!savedAccount || !Array.isArray(savedAccount.modelAliases)) {
      throw new Error("The router saved an invalid model-alias response. Your draft was kept.");
    }

    const persistedIds = new Set(savedAccount.modelAliases.map((alias) => alias.id));
    const missingIds = submittedAliases
      .map((alias) => alias.id)
      .filter((id) => !persistedIds.has(id));

    if (missingIds.length) {
      throw new Error(
        `The server did not persist: ${missingIds.join(", ")}. Your draft was kept.`,
      );
    }

    state.account = savedAccount;
    state.modelAliasesDraft = cloneModelAliases(savedAccount.modelAliases);
    state.modelAliasesDirty = false;
    $("#routing-save-hint").textContent = "Routing, reliability, deduplication, and model alias settings are active.";
    render();
    switchSettingsTab("router");
    notify("Router settings saved.");
  } catch (error) {
    // Never replace the visible draft with stale server data after a failed save.
    state.modelAliasesDraft = submittedAliases;
    state.modelAliasesDirty = true;
    renderModelAliases();
    $("#routing-save-hint").textContent = "Alias changes were not saved. Your draft is still here.";
    notify(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Save router settings";
  }
});

async function clearCooldownForProvider(providerId, button) {
  if (!providerId || !button) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Clearing…";
  try {
    const payload = await api(
      `/api/providers/${encodeURIComponent(providerId)}/cooldown`,
      { method: "DELETE" },
    );
    const provider = providerById(providerId);
    if (provider) provider.routingStats = payload.routingStats ?? provider.routingStats;
    renderProviders($("#provider-search")?.value ?? "");
    renderHealthList();
    renderRoutingProviderOrder();
    notify("Provider cooldown cleared.");
  } catch (error) {
    notify(error.message);
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function resetCircuitForProvider(
  providerId,
  button,
) {
  if (!providerId || !button) return;

  setCircuitActionBusy(button, true, "Resetting…");

  try {
    const payload = await api(
      `/api/providers/${encodeURIComponent(
        providerId,
      )}/circuit`,
      {
        method: "DELETE",
      },
    );

    const provider = providerById(providerId);

    if (provider) {
      provider.routingStats =
        payload.routingStats ??
        provider.routingStats;
    }

    renderProviders(
      $("#provider-search")?.value ?? "",
    );
    renderHealthList();
    renderRoutingProviderOrder();

    notify("Provider circuit reset.");
  } catch (error) {
    notify(error.message);
    setCircuitActionBusy(button, false);
  }
}
async function refreshProviderProtectionState() {
  if (!state.routerKey) return;

  const payload = await api("/api/me");

  state.account = {
    ...state.account,
    ...payload.account,
  };

  state.providers = Array.isArray(payload.providers)
    ? payload.providers
    : state.providers;

  renderProviders($("#provider-search")?.value ?? "");
  renderHealthList();
  renderRoutingProviderOrder();
}

async function retryCircuitForProvider(
  providerId,
  button,
) {
  if (!providerId || !button) return;

  setCircuitActionBusy(button, true, "Testing…");

  try {
    const payload = await api(
      `/api/providers/${encodeURIComponent(
        providerId,
      )}/circuit/retry`,
      {
        method: "POST",
      },
    );

    const provider = providerById(providerId);

    if (provider) {
      provider.routingStats =
        payload.routingStats ??
        provider.routingStats;
    }

    renderProviders(
      $("#provider-search")?.value ?? "",
    );
    renderHealthList();
    renderRoutingProviderOrder();

    notify(
      "Provider recovered and the circuit is closed.",
    );
  } catch (error) {
    await loadDashboard().catch(() => { });
    notify(error.message);
  } finally {
    setCircuitActionBusy(button, false);
  }
}
$("#provider-search").addEventListener("input", (event) => renderProviders(event.target.value));
$("#open-provider-modal").addEventListener("click", () => {
  const firstAvailableProvider =
    state.providers.find((provider) => !provider.configured) ?? state.providers[0];

  if (firstAvailableProvider) {
    openProviderModal(firstAvailableProvider.id);
  }
});

$("#provider-list").addEventListener("click", async (event) => {
  const addButton = event.target.closest("[data-add]");
  const quotaButton = event.target.closest("[data-quota]");
  const modelsButton = event.target.closest("[data-models]");
  const removeButton = event.target.closest("[data-remove]");
  if (quotaButton) {
    openQuotaModal(quotaButton.dataset.quota);
  }
  if (modelsButton) {
    openProviderModelModal(modelsButton.dataset.models);
  }
  if (addButton) {
    openProviderModal(addButton.dataset.add);
  }
  if (removeButton && confirm("Remove this provider key from your router?")) {
    try {
      await api(`/api/providers/${encodeURIComponent(removeButton.dataset.remove)}`, { method: "DELETE" });
      await loadDashboard();
      notify("Provider key removed.");
    } catch (error) {
      notify(error.message);
    }
  }
});


$("#provider-model-add-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const providerId = $("#model-provider-id").value;
  const provider = providerById(providerId);
  const modelId = $("#provider-model-id").value.trim();
  if (!provider || !modelId) return;
  const catalog = providerModelCatalog(provider);
  if (catalog.models.some((model) => model.id === modelId)) { notify("That model is already saved."); return; }
  catalog.models.push({ id: modelId, status: "unknown" });
  if (event.submitter?.dataset.modelAddAction === "activate") catalog.activeModelId = modelId;
  try {
    await saveProviderModelCatalog(providerId, catalog, event.submitter?.dataset.modelAddAction === "activate" ? "Model added and activated." : "Model added.");
  } catch (error) { notify(error.message); }
});

$("#provider-model-list")?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-model-action]");
  const row = event.target.closest("[data-provider-model-id]");
  if (!button || !row) return;
  const providerId = $("#model-provider-id").value;
  const provider = providerById(providerId);
  if (!provider) return;
  const modelId = row.dataset.providerModelId;
  const catalog = providerModelCatalog(provider);
  const action = button.dataset.modelAction;
  button.disabled = true;
  try {
    if (action === "activate") {
      catalog.activeModelId = modelId;
      await saveProviderModelCatalog(providerId, catalog, "Active model updated.");
    } else if (action === "delete") {
      if (!confirm(`Delete ${modelId} from this provider?`)) return;
      catalog.models = catalog.models.filter((model) => model.id !== modelId);
      await saveProviderModelCatalog(providerId, catalog, "Model removed.");
    } else if (action === "edit") {
      const nextId = prompt("Edit provider model ID", modelId)?.trim();
      if (!nextId || nextId === modelId) return;
      if (catalog.models.some((model) => model.id === nextId)) { notify("That model is already saved."); return; }
      catalog.models = catalog.models.map((model) => model.id === modelId ? { ...model, id: nextId, status: "unknown" } : model);
      if (catalog.activeModelId === modelId) catalog.activeModelId = nextId;
      await saveProviderModelCatalog(providerId, catalog, "Model ID updated.");
    } else if (action === "test") {
      const result = await api(`/api/providers/${encodeURIComponent(providerId)}/models/test`, {
        method: "POST",
        body: JSON.stringify({ modelId }),
      });
      await loadDashboard();
      openProviderModelModal(providerId);
      notify(result.ok ? "Model test succeeded." : `Model test failed: ${result.message}`);
    }
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const providerId = $("#modal-provider-id").value;
    await api(`/api/providers/${encodeURIComponent(providerId)}`, {
      method: "PUT",
      body: JSON.stringify({ apiKey: $("#provider-key").value }),
    });
    modal.hidden = true;
    await loadDashboard();
    notify("Provider key saved.");
  } catch (error) {
    notify(error.message);
  }
});

$("#quota-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const providerId = $("#quota-provider-id").value;
    await api(`/api/providers/${encodeURIComponent(providerId)}/quota`, {
      method: "PUT",
      body: JSON.stringify(quotaFormPayload()),
    });
    quotaModal.hidden = true;
    await loadDashboard();
    notify("Provider quota saved.");
  } catch (error) {
    notify(error.message);
  } finally {
    if (button) button.disabled = false;
  }
});

$("#quota-remove").addEventListener("click", async () => {
  const providerId = $("#quota-provider-id").value;
  if (!providerId || !confirm("Remove the configured limits? Existing usage counters will be preserved.")) return;
  try {
    await api(`/api/providers/${encodeURIComponent(providerId)}/quota`, { method: "DELETE" });
    quotaModal.hidden = true;
    await loadDashboard();
    notify("Provider quota limits removed.");
  } catch (error) {
    notify(error.message);
  }
});

$("#quota-reset-usage").addEventListener("click", async () => {
  const providerId = $("#quota-provider-id").value;
  if (!providerId || !confirm("Reset this provider's daily and monthly usage counters?")) return;
  try {
    await api(`/api/providers/${encodeURIComponent(providerId)}/usage`, { method: "DELETE" });
    await loadDashboard();
    const provider = providerById(providerId);
    if (provider) renderQuotaModalUsage(provider);
    quotaModal.hidden = false;
    notify("Provider usage reset.");
  } catch (error) {
    notify(error.message);
  }
});

$("#test-api-format").addEventListener("change", () => {
  renderPlaygroundModelOptions(true);
  updatePlaygroundHint();
});
$("#test-model-alias").addEventListener("change", updatePlaygroundHint);
$("#test-capability").addEventListener("change", updatePlaygroundHint);

$("#test-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#test-button");
  const result = $("#test-result");
  const status = $("#test-status");
  const provider = $("#test-provider");
  const output = $("#test-output");
  const routingDecision = $("#test-routing-decision");
  const apiFormat = $("#test-api-format").value;
  const scenario = $("#test-capability").value;
  const isClaudeCompatible = apiFormat === "claude-code-compatible";
  const isResponsesCompatible = apiFormat === "openai-responses-compatible";
  const endpoint = isClaudeCompatible
    ? "/v1/messages"
    : isResponsesCompatible
      ? "/v1/responses"
      : "/v1/chat/completions";
  const apiLabel = apiFormatLabel(apiFormat);
  const selectedModel = $("#test-model-alias").value || defaultModelForApi(apiFormat);
  const prompt = $("#test-prompt").value.trim();
  const temperature = Number($("#test-temperature").value || 0.2);
  const maxTokens = Number($("#test-max-tokens").value || 256);
  const enhancements = playgroundRequestEnhancements(apiFormat, scenario);

  const requestBody = isClaudeCompatible
    ? {
      model: selectedModel,
      stream: false,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      ...enhancements,
    }
    : isResponsesCompatible
      ? {
        model: selectedModel,
        stream: false,
        temperature,
        max_output_tokens: maxTokens,
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        }],
        ...enhancements,
      }
      : {
        model: selectedModel,
        stream: false,
        temperature,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        ...enhancements,
      };

  button.disabled = true;
  button.textContent = "Sending…";
  result.hidden = false;
  result.classList.remove("error");
  routingDecision.hidden = true;
  routingDecision.innerHTML = "";
  status.textContent = `Testing ${apiLabel}`;
  provider.textContent = endpoint;
  output.textContent = "";

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${state.routerKey}`,
        "content-type": "application/json",
        ...(isClaudeCompatible ? { "anthropic-version": "2023-06-01" } : {}),
      },
      body: JSON.stringify(requestBody),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? "Test request failed");

    const content = isClaudeCompatible
      ? (Array.isArray(body.content)
        ? body.content
          .filter((block) => block?.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("\n")
        : "")
      : isResponsesCompatible
        ? (Array.isArray(body.output)
          ? body.output
            .filter((item) => item?.type === "message" && Array.isArray(item.content))
            .flatMap((item) => item.content)
            .filter((part) => part?.type === "output_text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
          : "")
        : body.choices?.[0]?.message?.content;

    const handledBy = response.headers.get("x-free-llm-provider");
    const routingPolicy = response.headers.get("x-free-llm-routing-policy");
    const capabilityMatch = response.headers.get("x-free-llm-capability-match");
    const resolvedAlias = response.headers.get("x-free-llm-model-alias");
    const resolvedProviderModel = response.headers.get("x-free-llm-provider-model");
    const requiredHeader = response.headers.get("x-free-llm-required-capabilities");
    const requiredCapabilities = requiredHeader && requiredHeader !== "none"
      ? requiredHeader.split(",").map((item) => item.trim()).filter(Boolean)
      : [];

    status.textContent = `${apiLabel} endpoint is working`;
    provider.textContent = handledBy
      ? `${endpoint} · Handled by ${providerDisplayName(handledBy)}`
      : `${endpoint} · Request completed`;

    routingDecision.hidden = false;
    routingDecision.innerHTML = `
      <span><small>Model alias</small><strong>${escapeHtml(resolvedAlias && resolvedAlias !== "none" ? resolvedAlias : selectedModel)}</strong></span>
      <span><small>Selected provider</small><strong>${escapeHtml(handledBy ? providerDisplayName(handledBy) : "Unknown")}</strong></span>
      <span><small>Provider model</small><strong>${escapeHtml(resolvedProviderModel ?? "Unknown")}</strong></span>
      <span><small>Routing policy</small><strong>${escapeHtml(routingPolicy ? routingStrategyLabel(routingPolicy) : "Unknown")}</strong></span>
      <span><small>Capability match</small><strong>${escapeHtml(capabilityMatchLabel(capabilityMatch ?? "full"))}</strong></span>
      <span><small>Required</small><strong>${escapeHtml(requiredCapabilities.length ? requiredCapabilities.map(capabilityLabel).join(", ") : "Basic text")}</strong></span>
    `;

    output.textContent = typeof content === "string" && content
      ? content
      : JSON.stringify(body, null, 2);
    // await loadAnalytics();
  } catch (error) {
    result.classList.add("error");
    status.textContent = `${apiLabel} test failed`;
    provider.textContent = endpoint;
    routingDecision.hidden = true;
    output.textContent = error instanceof Error ? error.message : "Request failed";
  } finally {

    await Promise.allSettled([
      loadAnalytics(),
      refreshProviderProtectionState(),
    ]);

    button.disabled = state.account.configuredProviderIds.length === 0;
    button.textContent = "Send test request";
  }
});

$$("[data-tab]").forEach((button) =>
  button.addEventListener("click", () => { void switchTab(button.dataset.tab); }),
);

$$("[data-open-tab]").forEach((button) =>
  button.addEventListener("click", () => { void switchTab(button.dataset.openTab); }),
);

$$(".snippet-tab").forEach((button) =>
  button.addEventListener("click", () => {
    state.activeSnippet = button.dataset.snippet;
    renderSnippets();
  }),
);

$("#refresh-analytics").addEventListener("click", async () => {
  renderAnalyticsLoading();
  try {
    await loadAnalytics();
    notify("Analytics refreshed.");
  } catch (error) {
    notify(error.message);
  }
});

async function clearAnalyticsLogs() {
  if (!confirm("Clear all request logs for this router?")) return;
  try {
    await api("/api/analytics", { method: "DELETE" });
    state.analytics = { requests: [], frequency: [] };
    state.analyticsError = null;
    renderAnalytics();
    notify("Analytics cleared.");
  } catch (error) {
    notify(error.message);
  }
}

$("#clear-analytics").addEventListener("click", clearAnalyticsLogs);
$("#settings-clear-analytics").addEventListener("click", clearAnalyticsLogs);

$("#analytics-time-filter").addEventListener("change", (event) => {
  state.analyticsFilters.timeRange = event.target.value;
  renderAnalytics();
});
$("#analytics-provider-filter").addEventListener("change", (event) => {
  state.analyticsFilters.provider = event.target.value;
  renderAnalytics();
});
$("#analytics-api-filter").addEventListener("change", (event) => {
  state.analyticsFilters.apiFormat = event.target.value;
  renderAnalytics();
});
$("#analytics-status-filter").addEventListener("change", (event) => {
  state.analyticsFilters.status = event.target.value;
  renderAnalytics();
});
$("#analytics-alias-filter").addEventListener("change", (event) => {
  state.analyticsFilters.alias = event.target.value;
  renderAnalytics();
});
$("#analytics-client-filter").addEventListener("change", (event) => {
  state.analyticsFilters.clientApplication = event.target.value;
  renderAnalytics();
});
$("#analytics-stream-filter").addEventListener("change", (event) => {
  state.analyticsFilters.streaming = event.target.value;
  renderAnalytics();
});
$("#analytics-tool-filter").addEventListener("change", (event) => {
  state.analyticsFilters.toolUsage = event.target.value;
  renderAnalytics();
});
$("#analytics-search").addEventListener("input", (event) => {
  state.analyticsFilters.search = event.target.value;
  renderAnalytics();
});

const logFilterBindings = [
  ["#logs-time-filter", "timeRange", "change"],
  ["#logs-provider-filter", "provider", "change"],
  ["#logs-api-filter", "apiFormat", "change"],
  ["#logs-status-filter", "status", "change"],
  ["#logs-alias-filter", "alias", "change"],
  ["#logs-client-filter", "clientApplication", "change"],
  ["#logs-stream-filter", "streaming", "change"],
  ["#logs-tool-filter", "toolUsage", "change"],
  ["#logs-search", "search", "input"],
];
logFilterBindings.forEach(([selector, key, eventName]) => {
  $(selector)?.addEventListener(eventName, (event) => {
    state.logFilters[key] = event.target.value;
    renderAnalytics();
  });
});

$("#request-log-list").addEventListener("click", (event) => {
  const row = event.target.closest("[data-log-id]");
  if (row) openRequestDrawer(row.dataset.logId);
});

$$('[data-close-modal]').forEach((element) =>
  element.addEventListener("click", () => {
    const parentModal = element.closest(".modal");
    if (parentModal) parentModal.hidden = true;
  }),
);
$$('[data-close-drawer]').forEach((element) =>
  element.addEventListener("click", closeRequestDrawer),
);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $$(".modal").forEach((element) => { element.hidden = true; });
    if (!drawer.hidden) closeRequestDrawer();
  }
});

document.addEventListener("click", async (event) => {
  const clearButton = event.target.closest("[data-clear-cooldown]");
  if (!clearButton) return;
  event.preventDefault();
  event.stopPropagation();
  await clearCooldownForProvider(clearButton.dataset.clearCooldown, clearButton);
});

document.addEventListener("click", async (event) => {
  const retryButton = event.target.closest("[data-retry-circuit]");
  const resetButton = event.target.closest("[data-reset-circuit]");
  if (!retryButton && !resetButton) return;
  event.preventDefault();
  event.stopPropagation();
  if (retryButton) {
    await retryCircuitForProvider(retryButton.dataset.retryCircuit, retryButton);
  } else if (resetButton) {
    await resetCircuitForProvider(resetButton.dataset.resetCircuit, resetButton);
  }
});

document.addEventListener("click", async (event) => {
  const copy = event.target.closest("[data-copy], [data-copy-key], [data-copy-value]");
  if (!copy) return;
  const value = copy.hasAttribute("data-copy-key")
    ? state.routerKey
    : copy.hasAttribute("data-copy-value")
      ? copy.dataset.copyValue
      : document.getElementById(copy.dataset.copy).textContent;
  await navigator.clipboard.writeText(value ?? "");
  notify("Copied to clipboard.");
});

window.setInterval(updateCooldownCountdowns, 1_000);
initializeAuth();
