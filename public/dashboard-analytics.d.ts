export interface ProviderDashboardItem {
  providerId: string;
  attempts: number;
  successes: number;
  failures: number;
  completedRequests: number;
  completedSuccesses: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  fallbackStarts: number;
  fallbackRecoveries: number;
  streamingRequests: number;
  toolRequests: number;
  successRate: number;
  averageAttemptLatencyMs: number;
  p95AttemptLatencyMs: number;
  averageRequestLatencyMs: number;
  fallbackRate: number;
}

export interface DimensionDashboardItem {
  id: string;
  name: string;
  requests: number;
  successes: number;
  failures: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  upstreamRequests: number;
  fallbackRequests: number;
  providerAttempts: number;
  streamingRequests: number;
  toolRequests: number;
  generatedToolCalls: number;
  successRate: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  fallbackRate: number;
  streamingRate: number;
  toolRate: number;
  averageAttempts: number;
}

export interface ApplicationDashboardItem extends DimensionDashboardItem {
  application: { id: string; name: string; detectedBy?: string };
  apiMix: Array<[string, number]>;
  aliasMix: Array<[string, number]>;
  topApiFormat: string;
  topAlias: string;
}

export function summarizeProviderDashboard(requests?: unknown[]): ProviderDashboardItem[];
export function summarizeApiAndModelDashboard(requests?: unknown[]): {
  apis: DimensionDashboardItem[];
  aliases: DimensionDashboardItem[];
};
export function summarizeApplicationDashboard(requests?: unknown[]): ApplicationDashboardItem[];
