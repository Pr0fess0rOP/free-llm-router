export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export type CapabilityObservationSource =
  | "user"
  | "probe"
  | "runtime"
  | "catalog"
  | "provider";

export type CapabilityUnknownMode = "flexible" | "strict";

export interface CapabilityRoutingSettings {
  unknownMode: CapabilityUnknownMode;
}

export type ApiClientApplication =
  | "codex-cli"
  | "claude-code"
  | "openai-python"
  | "openai-javascript"
  | "anthropic-python"
  | "anthropic-javascript"
  | "anthropic-compatible"
  | "curl"
  | "unknown";

export interface ApiClientApplicationInfo {
  id: ApiClientApplication;
  name: string;
  detectedBy: "user-agent" | "stainless" | "anthropic-version" | "unknown";
  language?: string;
  sdkVersion?: string;
}

export type ToolCallOutcome =
  | "not-requested"
  | "generated"
  | "none-generated"
  | "request-failed"
  | "not-observed-streaming";

export type StructuredOutputValidation =
  | "not-requested"
  | "valid"
  | "invalid"
  | "request-failed"
  | "not-observed"
  | "not-observed-streaming";

export interface RequestToolAnalytics {
  toolRequest: boolean;
  requestedToolCount: number;
  requestedToolNames: string[];
  generatedToolCallCount: number;
  generatedToolNames: string[];
  outcome: ToolCallOutcome;
  structuredOutputRequested: boolean;
  structuredOutputValidation: StructuredOutputValidation;
}

export type RequestIdSource = "client" | "generated";

export type RoutingHeaders = Record<string, string>;

export type ProviderCapabilityName =
  | "streaming"
  | "tools"
  | "jsonMode"
  | "structuredOutputs"
  | "vision"
  | "reasoning"
  | "embeddings";

export interface ModelCapabilityEvidence {
  status?: number;
  message?: string;
  requestId?: string;
  observedAt: string;
}

export interface ModelCapabilityState {
  value: CapabilitySupport;
  source: CapabilityObservationSource;
  lastVerifiedAt?: string;
  evidence?: ModelCapabilityEvidence;
}

export type ModelCapabilityProfile = Partial<
  Record<ProviderCapabilityName, ModelCapabilityState>
> & {
  contextWindow?: number;
  maxOutputTokens?: number;
};

export interface ProviderCapabilities {
  streaming: CapabilitySupport;
  tools: CapabilitySupport;
  jsonMode: CapabilitySupport;
  structuredOutputs: CapabilitySupport;
  vision: CapabilitySupport;
  reasoning: CapabilitySupport;
  embeddings: CapabilitySupport;
  contextWindow?: number;
  maxOutputTokens?: number;
  verifiedAt?: string;
  source?: string;
  notes?: string;
}

export interface CapabilityRequirements {
  required: ProviderCapabilityName[];
  minimumContextTokens?: number;
}

export interface CapabilityMatch {
  level: "full" | "partial" | "incompatible";
  supported: ProviderCapabilityName[];
  unknown: ProviderCapabilityName[];
  unsupported: Array<ProviderCapabilityName | "contextWindow">;
}



export interface DeduplicationSettings {
  enabled: boolean;
  windowMs: number;
  automaticFingerprinting: boolean;
  requireIdempotencyKey: boolean;
  bypassToolRequests: boolean;
  bypassMultimodalRequests: boolean;
  bypassNonDeterministicRequests: boolean;
}

export interface DeduplicationMetadata {
  deduplicated: boolean;
  originalRequestId: string;
  source: "original" | "in-flight" | "completed";
  duplicateCount: number;
  providerCallAvoided: boolean;
  estimatedRequestsSaved: number;
  estimatedInputTokensSaved?: number;
  estimatedOutputTokensSaved?: number;
  estimatedTotalTokensSaved?: number;
}


export type RequestTimelineEventType =
  | "request_received"
  | "authentication_succeeded"
  | "alias_resolved"
  | "routing_started"
  | "provider_ranked"
  | "provider_skipped"
  | "provider_attempt_started"
  | "provider_attempt_succeeded"
  | "provider_attempt_failed"
  | "provider_failover"
  | "retry_scheduled"
  | "retry_stopped"
  | "cooldown_started"
  | "circuit_state_changed"
  | "deduplication_reused"
  | "response_returned"
  | "request_failed";

export interface RequestTimelineEvent {
  id: string;
  type: RequestTimelineEventType;
  timestamp: string;
  elapsedMs: number;
  title: string;
  detail?: string;
  providerId?: string;
  tone: "neutral" | "success" | "warning" | "error";
  details?: Record<string, unknown>;
}

export type ProviderRecoveryAction =
  | "retry_with_backoff"
  | "immediate_failover"
  | "stop";

export type ProviderFailoverReason =
  | "provider_authentication_failed"
  | "provider_access_denied"
  | "provider_model_or_endpoint_unavailable"
  | "provider_capability_unsupported";

export type RetryStopReason =
  | "maximum_attempts_reached"
  | "total_request_deadline_exceeded"
  | "error_not_retryable"
  | "no_more_candidates";

export interface ReliabilitySettings {
  providerTimeoutMs: number;
  totalRequestTimeoutMs: number;
  maxProviderAttempts: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  backoffMultiplier: number;
  useJitter: boolean;
  retryStatusCodes: number[];
  retryNetworkErrors: boolean;
  retryMalformedResponses: boolean;
  streamingConnectionTimeoutMs: number;
  halfOpenProbeTimeoutMs: number;
  providerTimeoutOverrides: Record<string, number>;
}

export type ReliabilityOverrides = Partial<ReliabilitySettings>;


export type ProviderModelStatus =
  | "unknown"
  | "healthy"
  | "unavailable"
  | "unauthorized"
  | "rate-limited"
  | "error";

export interface ProviderModelOption {
  id: string;
  status: ProviderModelStatus;
  lastStatus?: number;
  lastError?: string;
  lastCheckedAt?: string;
  capabilities?: ModelCapabilityProfile;
}

export interface ProviderModelCatalog {
  activeModelId: string;
  models: ProviderModelOption[];
}

export interface ProviderQuotaConfig {
  dailyRequestLimit?: number;
  monthlyRequestLimit?: number;
  dailyTokenLimit?: number;
  monthlyTokenLimit?: number;
  warningThresholdPercent: number;
}

export interface ProviderUsageWindow {
  period: "daily" | "monthly";
  startedAt: string;
  resetAt: string;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ProviderQuotaUsage {
  daily: ProviderUsageWindow;
  monthly: ProviderUsageWindow;
  lastUpdatedAt?: string;
  lastTokenUsageSource?: TokenUsage["source"];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: "reported" | "estimated";
}

export interface ProviderQuotaStatus {
  config: ProviderQuotaConfig;
  usage: ProviderQuotaUsage;
  exhausted: boolean;
  warning: boolean;
  remainingRatio: number;
  consumedPercent: number;
  exhaustedLimits: Array<
    "daily_requests" | "monthly_requests" | "daily_tokens" | "monthly_tokens"
  >;
  nextResetAt?: number;
}

export type ProviderCooldownReason = "rate_limit";

export type ProviderCircuitState = "closed" | "open" | "half-open";

export type ProviderFailureType =
  | "server_error"
  | "timeout"
  | "connection_error"
  | "malformed_response";

export type ProviderCircuitAction =
  | "none"
  | "opened"
  | "reopened"
  | "half_open"
  | "closed";

export interface ProviderCandidateEvaluation {
  providerId: string;
  providerModel?: string;
  match: CapabilityMatch;
  capabilitySources?: Partial<Record<ProviderCapabilityName, CapabilityObservationSource>>;
  state:
    | "candidate"
    | "incompatible"
    | "cooldown"
    | "quota-exhausted"
    | "circuit-open"
    | "half-open";
  candidateRank?: number;
  cooldownUntil?: number;
  cooldownReason?: ProviderCooldownReason;
  circuitState?: ProviderCircuitState;
  circuitOpenUntil?: number;
  circuitFailureCount?: number;
  circuitOpenCount?: number;
  lastFailureType?: ProviderFailureType;
  halfOpenProbeActive?: boolean;
  quotaWarning?: boolean;
  quotaExhausted?: boolean;
  quotaConsumedPercent?: number;
  quotaRemainingRatio?: number;
  quotaResetAt?: number;
  quotaExhaustedLimits?: ProviderQuotaStatus["exhaustedLimits"];
}

export type RoutingStrategy =
  | "priority"
  | "fastest"
  | "round-robin"
  | "least-used"
  | "reliability"
  | "smart";

export interface RoutingPolicy {
  strategy: RoutingStrategy;
  providerOrder: string[];
}

export type ModelAliasRoutingStrategy = RoutingStrategy | "inherit";

export interface ModelAlias {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  routingStrategy: ModelAliasRoutingStrategy;
  requiredCapabilities: ProviderCapabilityName[];
  eligibleProviderIds: string[];
  providerOrder: string[];
  reliabilityOverrides?: ReliabilityOverrides;
  system?: boolean;
}

export interface ProviderRoutingStats {
  providerId: string;
  attempts: number;
  successes: number;
  failures: number;
  averageLatencyMs?: number;
  successScore: number;
  consecutiveFailures: number;
  lastUsedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastStatus?: number;
  lastError?: string;
  rateLimitCount?: number;
  cooldownUntil?: number;
  cooldownStartedAt?: string;
  cooldownReason?: ProviderCooldownReason;
  lastRetryAfterSeconds?: number;
  lastRateLimitAt?: string;
  circuitState?: ProviderCircuitState;
  circuitOpenedAt?: string;
  circuitOpenUntil?: number;
  circuitFailureCount?: number;
  circuitOpenCount?: number;
  lastFailureType?: ProviderFailureType;
  halfOpenProbeActive?: boolean;
  halfOpenStartedAt?: string;
  lastRecoveredAt?: string;
  quotaUsage?: ProviderQuotaUsage;
}

export interface ProviderAttemptMetric {
  providerId: string;
  providerModel?: string;
  success: boolean;
  latencyMs: number;
  headersLatencyMs?: number;
  responseBodyMs?: number;
  firstTokenMs?: number;
  streamDurationMs?: number;
  tokensPerSecond?: number;
  status?: number;
  message?: string;
  cooldownUntil?: number;
  cooldownReason?: ProviderCooldownReason;
  retryAfterSeconds?: number;
  failureType?: ProviderFailureType;
  circuitAction?: ProviderCircuitAction;
  circuitState?: ProviderCircuitState;
  circuitOpenUntil?: number;
  circuitFailureCount?: number;
  circuitOpenCount?: number;
  halfOpenProbeActive?: boolean;
  attemptNumber?: number;
  startedAt?: string;
  completedAt?: string;
  startedElapsedMs?: number;
  completedElapsedMs?: number;
  providerTimeoutMs?: number;
  retryable?: boolean;
  recoveryAction?: ProviderRecoveryAction;
  failoverReason?: ProviderFailoverReason;
  retryDelayMs?: number;
  retryStopReason?: RetryStopReason;
  totalElapsedMs?: number;
  requiredCapabilities?: ProviderCapabilityName[];
  observedSupportedCapabilities?: ProviderCapabilityName[];
  observedUnsupportedCapabilities?: ProviderCapabilityName[];
}


export interface ProviderAttemptTimingBreakdown {
  attempt: number;
  providerId: string;
  success: boolean;
  latencyMs: number;
  headersLatencyMs?: number;
  responseBodyMs?: number;
  firstTokenMs?: number;
  streamDurationMs?: number;
  tokensPerSecond?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  status?: number;
  failureType?: ProviderFailureType;
  startedAt?: string;
  completedAt?: string;
}

export interface RequestPerformanceTiming {
  totalLatencyMs: number;
  routerPreparationMs: number;
  routerOverheadMs: number;
  providerLatencyMs: number;
  providerHeadersMs: number;
  responseBodyMs: number;
  responseProcessingMs: number;
  retryDelayMs: number;
  firstTokenMs?: number;
  providerFirstTokenMs?: number;
  streamDurationMs?: number;
  tokensPerSecond?: number;
  slowestStage?: string;
  deduplicated?: boolean;
  attempts: ProviderAttemptTimingBreakdown[];
}

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKey?: string;
  model: string;
  priority?: number;
  cooldownMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  enabled?: boolean;
  capabilities?: Partial<ProviderCapabilities>;
}

export interface RouterConfig {
  providers: ProviderConfig[];
}

export interface ProviderRuntime extends ProviderConfig {
  capabilities: ProviderCapabilities;
  capabilitySources?: Partial<Record<ProviderCapabilityName, CapabilityObservationSource>>;
  apiKeyValue: string | undefined;
  cooldownUntil: number;
  failures: number;
  circuitState: ProviderCircuitState;
  circuitOpenUntil: number;
  circuitFailureCount: number;
  circuitOpenCount: number;
  halfOpenProbeActive: boolean;
  quotaConfig?: ProviderQuotaConfig;
  quotaUsage?: ProviderQuotaUsage;
}

export interface AttemptFailure {
  provider: string;
  providerModel?: string;
  status?: number;
  message: string;
  retryable?: boolean;
  recoveryAction?: ProviderRecoveryAction;
  failoverReason?: ProviderFailoverReason;
  retryStopReason?: RetryStopReason;
}
