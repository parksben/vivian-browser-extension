// Background's in-memory state shapes. The concrete `S` object lives in
// background code; these types describe its public surface so the sidebar
// can consume `status_update` broadcasts and `get_status` responses safely.

export type LoopStatus =
  | 'idle'
  | 'perceiving'
  | 'thinking'
  | 'acting'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface LoopHistoryStep {
  op: string;
  desc: string;
  status: 'done' | 'failed';
  durationMs: number;
  error?: string;
}

export interface LoopSnapshot {
  status: LoopStatus;
  goal: string;
  agentId: string;
  stepIndex: number;
  history: LoopHistoryStep[];
  lastScreenshot: string | null;
  lastUrl: string;
  lastTitle: string;
  statusText: string;
  errorMsg: string;
  startedAt: number | null;
}

export interface StatusSnapshot {
  wsConnected: boolean;
  pairingPending: boolean;
  reconnecting: boolean;
  gaveUp?: boolean;
  deviceId: string;
  browserId: string;
  wsUrl: string;
  tabCount: number;
  lastCmd: string;
  loop: LoopSnapshot;
}

// Diagnostic log entry — written by logEvent(), stored in S.logs and
// mirrored to chrome.storage.local.diag_logs.
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';
export type LogSource = 'bg' | 'sidebar' | 'content' | 'ext';

export interface DiagLogEntry {
  t: number;
  level: LogLevel;
  src: LogSource;
  msg: string;
  /** already-serialized JSON string (safeSerialize output) */
  data?: string;
}

export interface DiagBundle {
  ok: true;
  version: string;
  generatedAt: number;
  state: StatusSnapshot & {
    sessionKey: string;
    lastSeenMsgId: string | null;
    wsReconnectCount?: number;
    wsGaveUp?: boolean;
  };
  config: Record<string, unknown>;
  logs: DiagLogEntry[];
  chatHistory: unknown[];
}
