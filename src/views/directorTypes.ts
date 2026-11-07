/**
 * Client mirrors of server/director types (structural, so the web bundle imports nothing from server/).
 * Keep in step with server/director/types.ts and server/agentHub.ts.
 */
export type ExternalServiceView = 'api.weather.gov' | 'rack-monitor' | 'scan-queue' | 'approval-queue' | 'github';

export interface DirectorStepView { tool: string; args: unknown; summary: string; runId?: string; ok: boolean; service?: ExternalServiceView }

export interface PendingActionView {
  id: string;
  kind: 'rig_command' | 'ticket';
  createdAt: string;
  proposedBy: string;
  reason: string;
  incidentId?: string;
  payload: { cmd: string } | { title: string; body: string; labels: string[] };
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  decidedBy?: string;
  result?: string;
  url?: string;
}

export interface DirectorResultView {
  provider: 'nemotron' | 'local_planner';
  model: string | null;
  steps: DirectorStepView[];
  recommendation: {
    nextScan: { assetId: string; point: string; reason: string; holdS: number } | null;
    nextAction: string;
    hypotheses: { label: string; support: string; runIds: string[] }[];
    summary: string;
  };
  runs?: Record<string, unknown>;
  warnings?: string[];
  fallbackReason?: string;
  elapsedMs: number;
  queuedRequests?: { id: string; assetId: string; point: string; status: string }[];
  proposedActions?: PendingActionView[];
  generation?: number;
  trigger?: string;
  usage?: { totalTokens: number; requests: number };
}

export interface DirectorRecordView { id: string; chainId: string; generation: number; trigger: string; at: string; result: DirectorResultView }

export const SERVICE_LABEL: Record<ExternalServiceView, string> = {
  'api.weather.gov': 'NWS API',
  'rack-monitor': 'RACK MONITOR',
  'scan-queue': 'SCAN QUEUE',
  'approval-queue': 'NEEDS APPROVAL',
  github: 'GITHUB',
};
