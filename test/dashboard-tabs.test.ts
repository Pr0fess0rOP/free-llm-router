import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

function attributeValues(html: string, attribute: string): string[] {
  const expression = new RegExp(`${attribute}="([^"]+)"`, "g");
  return [...html.matchAll(expression)].map((match) => match[1]!);
}

test("dashboard exposes compact router settings tabs", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  assert.deepEqual(attributeValues(html, "data-router-settings-tab"), [
    "routing",
    "aliases",
    "capabilities",
  ]);
  assert.deepEqual(attributeValues(html, "data-router-settings-panel"), [
    "routing",
    "aliases",
    "capabilities",
  ]);
  assert.match(html, /data-router-settings-panel="routing">/);
  assert.match(html, /data-router-settings-panel="aliases" hidden>/);
  assert.match(html, /data-router-settings-panel="capabilities" hidden>/);
  assert.match(app, /function switchRouterSettingsTab\(tabName\)/);
  assert.match(app, /data-router-settings-tab/);
  assert.match(styles, /\.router-settings-subpanel\[hidden\]/);
});

test("docs exposes setup and project feature tabs", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");

  assert.deepEqual(attributeValues(html, "data-docs-tab"), ["integration", "features"]);
  assert.deepEqual(attributeValues(html, "data-docs-panel"), ["integration", "features"]);
  assert.match(html, /data-docs-panel="integration">/);
  assert.match(html, /data-docs-panel="features" hidden>/);
  assert.match(html, /Persistent rate-limit cooldowns/);
  assert.match(html, /Full request timeline and Analysis logs/);
  assert.match(html, /Model aliases/);
  assert.match(html, /Model-aware capability registry/);
  assert.match(app, /function switchDocsTab\(tabName\)/);
});


test("project feature docs expose a complete indexed guide with examples", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");

  const featureIds = [
    "feature-request-lifecycle",
    "feature-api-compatibility",
    "feature-provider-keys",
    "feature-provider-models",
    "feature-routing-policies",
    "feature-priority-order",
    "feature-retry-failover",
    "feature-cooldowns",
    "feature-circuit-breaker",
    "feature-model-aliases",
    "feature-capabilities",
    "feature-analysis",
    "feature-request-ids",
    "feature-performance",
    "feature-playground",
    "feature-recovery-controls",
    "feature-provider-quotas",
    "feature-reliability-controls",
    "feature-deduplication",
    "feature-security",
  ];

  for (const featureId of featureIds) {
    assert.match(html, new RegExp(`href="#${featureId}"`));
    assert.match(html, new RegExp(`id="${featureId}"`));
  }

  assert.equal((html.match(/class="docs-example-block"/g) ?? []).length >= 8, true);
  assert.match(html, /one request, three attempts/i);
  assert.match(html, /vision-router/);
  assert.match(html, /invalid_api_key/);
  assert.match(html, /Retry-After: 60/);
  assert.match(html, /Provider quota and usage tracking/);
  assert.match(html, /quota-exhausted/);
  assert.match(html, /Configurable retry and timeout controls/);
  assert.match(html, /total request deadline/i);
  assert.match(html, /Request deduplication and idempotency/);
  assert.match(html, /x-free-llm-deduplicated/);
  assert.match(html, /Request IDs and richer routing headers/);
  assert.match(html, /x-free-llm-provider-attempts/);
  assert.match(html, /request_id/);
  assert.match(html, /Router, provider, first-token, and stream timing/i);
  assert.match(html, /x-free-llm-first-token-ms/);
  assert.match(html, /stream duration/i);
  assert.match(html, /id="quota-modal"/);
});

test("model alias edits preserve the expanded alias", async () => {
  const app = await readFile(new URL("public/app.js", root), "utf8");

  assert.match(app, /const openAliasIds = new Set/);
  assert.match(app, /openAliasIds\.has\(alias\.id\)/);
  assert.match(app, /card\.dataset\.aliasId = nextId/);
  assert.doesNotMatch(app, /openAliasIds\.has\(alias\.id\) \|\|/);
});

test("dashboard HTML keeps element IDs unique", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const ids = attributeValues(html, "id");
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, []);
});

test("provider cards expose quota controls and Analysis token usage", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  assert.match(html, /id="quota-modal"/);
  assert.match(html, /id="quota-form"/);
  assert.match(html, /id="quota-daily-requests"/);
  assert.match(html, /id="quota-monthly-tokens"/);
  assert.match(html, /id="drawer-usage-section"/);
  assert.match(app, /function providerQuotaMarkup\(provider\)/);
  assert.match(app, /data-quota=/);
  assert.match(app, /\/api\/providers\/\$\{encodeURIComponent\(providerId\)\}\/quota/);
  assert.match(app, /providers_quota_exhausted|quota-exhausted/);
  assert.match(styles, /\.provider-quota-track/);
  assert.match(styles, /\.drawer-usage-grid/);
});


test("dashboard exposes configurable reliability controls and attempt timelines", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  for (const id of [
    "reliability-provider-timeout",
    "reliability-total-timeout",
    "reliability-max-attempts",
    "reliability-status-codes",
    "reliability-initial-backoff",
    "reliability-use-jitter",
    "reliability-provider-overrides",
    "drawer-attempts-section",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(app, /function reliabilitySettingsFromDom\(\)/);
  assert.match(app, /reliabilitySettings: reliabilitySettingsFromDom\(\)/);
  assert.match(app, /data-alias-reliability-enabled/);
  assert.match(app, /Retry stopped:/);
  assert.match(styles, /\.reliability-settings-grid/);
  assert.match(styles, /\.drawer-attempt-row/);
});


test("dashboard exposes request deduplication controls and Analysis savings", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  for (const id of [
    "dedup-enabled",
    "dedup-window",
    "dedup-automatic-fingerprinting",
    "dedup-require-idempotency-key",
    "dedup-bypass-tools",
    "dedup-bypass-multimodal",
    "dedup-bypass-nondeterministic",
    "drawer-deduplication-section",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(app, /function deduplicationSettingsFromDom\(\)/);
  assert.match(app, /deduplicationSettings: deduplicationSettingsFromDom\(\)/);
  assert.match(app, /Provider call avoided/);
  assert.match(app, /estimatedTotalTokensSaved/);
  assert.match(styles, /\.deduplication-toggle-grid/);
  assert.match(styles, /\.drawer-deduplication-grid/);
});


test("Analysis drawer exposes the full chronological request timeline", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  assert.match(html, /id="drawer-timeline-section"/);
  assert.match(html, /Full request timeline and Analysis logs/);
  assert.match(html, /Chronological Analysis timeline/);
  assert.match(app, /function timelineCopyText\(events\)/);
  assert.match(app, /function timelineProviderText\(value, providerId\)/);
  assert.match(app, /providerDisplayName\(providerId\)/);
  assert.match(app, /Full request timeline/);
  assert.match(app, /Raw event details/);
  assert.match(app, /data-copy="drawer-timeline-copy"/);
  assert.match(styles, /\.drawer-timeline-list/);
  assert.match(styles, /\.drawer-timeline-event/);
  assert.match(styles, /\.drawer-timeline-details/);
});


test("Analysis exposes request correlation, routing headers, and original-request links", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  assert.match(html, /id="drawer-routing-headers-section"/);
  assert.match(html, /id="feature-request-ids"/);
  assert.match(app, /request\.requestId/);
  assert.match(app, /request\.clientRequestId/);
  assert.match(app, /Returned routing headers/);
  assert.match(app, /data-copy="drawer-request-id"/);
  assert.match(app, /data-original-request-id/);
  assert.match(styles, /\.drawer-request-correlation/);
  assert.match(styles, /\.drawer-routing-headers-list/);
  assert.match(styles, /\.request-id-row-badge/);
});


test("Analysis exposes normalized request performance timing", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  assert.match(html, /id="drawer-performance-section"/);
  assert.match(html, /id="feature-performance"/);
  assert.match(html, /Router, provider, first-token, and stream timing/i);
  assert.match(app, /function performanceCopyText\(performance\)/);
  assert.match(app, /Performance breakdown/);
  assert.match(app, /Time to first token/);
  assert.match(app, /data-copy="drawer-performance-copy"/);
  assert.match(styles, /\.drawer-performance-summary/);
  assert.match(styles, /\.drawer-performance-bar-row/);
  assert.match(styles, /\.drawer-performance-attempts/);
});


test("Analysis separates aggregated analytics from request logs", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  assert.deepEqual(attributeValues(html, "data-analysis-tab"), ["analytics", "logs"]);
  assert.deepEqual(attributeValues(html, "data-analysis-panel"), ["analytics", "logs"]);
  assert.match(html, /data-analysis-panel="analytics">/);
  assert.match(html, /data-analysis-panel="logs" hidden>/);
  assert.match(html, /id="request-log-count"/);
  assert.match(html, /id="logs-search"/);
  assert.match(html, /Routing performance at a glance/);
  assert.match(html, /Inspect individual gateway requests/);
  assert.match(app, /function switchAnalysisTab\(tabName\)/);
  assert.match(app, /state\.logFilters/);
  assert.match(app, /filteredRequests\(state\.analyticsFilters\)/);
  assert.match(app, /filteredRequests\(state\.logFilters\)/);
  assert.match(styles, /\.analysis-primary-tabs/);
  assert.match(styles, /\.analysis-tab-panel\[hidden\]/);
  assert.match(styles, /\.request-log-filter-card/);
});

test("Analysis exposes P4.4 filters, charts, client labels, and tool details", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  for (const id of [
    "analytics-alias-filter",
    "analytics-client-filter",
    "analytics-stream-filter",
    "analytics-tool-filter",
    "analysis-total-tokens",
    "analysis-fallback-rate",
    "analysis-average-attempts",
    "analysis-tool-requests",
    "analysis-top-client",
    "analysis-reliable-provider",
    "analytics-token-chart",
    "analytics-client-chart",
    "analytics-fallback-chart",
    "analytics-provider-chart",
    "analytics-tool-chart",
    "analytics-api-chart",
    "drawer-tool-analytics-section",
    "feature-advanced-analytics",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(app, /function advancedAnalytics\(requests\)/);
  assert.match(app, /function renderAdvancedAnalytics\(requests\)/);
  assert.match(app, /clientApplicationFor\(request\)/);
  assert.match(app, /deduplication\?\.deduplicated !== true/);
  assert.match(styles, /\.analytics-insight-grid/);
  assert.match(styles, /\.analytics-chart-grid/);
  assert.match(styles, /\.drawer-tool-analytics-grid/);
});


test("Analysis exposes expanded provider, API/model, and application dashboards", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");
  const readme = await readFile(new URL("README.md", root), "utf8");

  assert.deepEqual(attributeValues(html, "data-analytics-dashboard-tab"), [
    "overview",
    "providers",
    "api-models",
    "applications",
  ]);
  assert.deepEqual(attributeValues(html, "data-analytics-dashboard-panel"), [
    "overview",
    "providers",
    "api-models",
    "applications",
  ]);

  for (const id of [
    "provider-dashboard-summary",
    "provider-dashboard-table",
    "api-model-dashboard-summary",
    "api-dashboard-table",
    "model-dashboard-table",
    "application-dashboard-summary",
    "application-dashboard-table",
    "feature-expanded-dashboards",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(app, /summarizeProviderDashboard/);
  assert.match(app, /summarizeApiAndModelDashboard/);
  assert.match(app, /summarizeApplicationDashboard/);
  assert.match(app, /function switchAnalyticsDashboard\(tabName\)/);
  assert.match(app, /data-dashboard-log-filter/);
  assert.match(styles, /\.analytics-dashboard-tabs/);
  assert.match(styles, /\.dashboard-metric-grid/);
  assert.match(styles, /\.analytics-detail-table/);
  assert.match(readme, /P4\.5.*Deferred \/ not required for now/);
  assert.match(readme, /\[x\].*P4\.6.*Expanded provider\/API\/application dashboards/);
});

test("provider cards expose a one-active-model catalog manager", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  assert.match(html, /id="model-modal"/);
  assert.match(html, /id="provider-model-list"/);
  assert.match(html, /id="provider-model-add-form"/);
  assert.match(app, /function providerModelCatalog\(provider\)/);
  assert.match(app, /data-model-action="activate"/);
  assert.match(app, /data-model-action="test"/);
  assert.match(app, /data-model-action="edit"/);
  assert.match(app, /data-model-action="delete"/);
  assert.match(app, /\/models\/test/);
  assert.match(styles, /\.provider-model-row\.active/);
});

test("capability registry exposes model-level overrides, probes, and strict routing mode", async () => {
  const html = await readFile(new URL("public/dashboard.html", root), "utf8");
  const app = await readFile(new URL("public/app.js", root), "utf8");
  const styles = await readFile(new URL("public/styles.css", root), "utf8");

  assert.match(html, /id="capability-unknown-mode"/);
  assert.match(html, /Flexible — rank below verified support/);
  assert.match(html, /Strict — skip unknown capabilities/);
  assert.match(app, /data-model-capability=/);
  assert.match(app, /data-capability-action="detect"/);
  assert.match(app, /\/models\/detect/);
  assert.match(app, /source:\s*"user"/);
  assert.match(app, /data-model-capability-limit="contextWindow"/);
  assert.match(app, /data-model-capability-limit="maxOutputTokens"/);
  assert.match(styles, /\.model-capability-card/);
  assert.match(styles, /\.model-capability-control-grid/);
  assert.match(styles, /\.model-capability-limit-grid/);
});
