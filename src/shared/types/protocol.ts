// Agent protocol types for `clawtab_cmd` / `clawtab_result` JSON blocks.
// These live in assistant chat messages and drive the browser automation
// loop. See AGENT_PROTOCOL.md for the user-facing spec.

export type ClawtabCmdAction =
  | 'perceive'
  | 'act'
  | 'task_start'
  | 'task_done'
  | 'task_fail'
  | 'cancel';

export type PerceiveInclude =
  | 'screenshot'
  | 'title'
  | 'url'
  | 'dom'
  | 'scroll_position'
  | 'all';

export interface PerceivePayload {
  tabId?: number;
  include?: PerceiveInclude[];
}

export type ActOp =
  | 'click'
  | 'fill'
  | 'clear'
  | 'navigate'
  | 'scroll'
  | 'scroll_by'
  | 'scroll_to_element'
  | 'press'
  | 'select'
  | 'hover'
  | 'wait'
  | 'wait_for'
  | 'get_text'
  | 'get_attribute'
  | 'new_tab'
  | 'close_tab'
  | 'switch_tab'
  | 'go_back'
  | 'go_forward'
  | 'screenshot_element'
  | 'eval';

export interface ActPayload {
  tabId?: number;
  op: ActOp;
  target?: string | number;
  value?: string | number;
  waitAfter?: number;
  captureAfter?: boolean;
  timeout?: number;
}

export interface TaskStartPayload {
  taskId?: string;
  goal?: string;
  agentId?: string;
  tabId?: number;
}

export interface TaskDonePayload {
  summary?: string;
}

export interface TaskFailPayload {
  error?: string;
}

export type ClawtabCmd =
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'perceive';
      payload?: PerceivePayload;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'act';
      payload?: ActPayload;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'task_start';
      payload?: TaskStartPayload;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'task_done';
      payload?: TaskDonePayload;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'task_fail';
      payload?: TaskFailPayload;
      issuedAt?: number;
      timeout?: number;
    }
  | {
      type: 'clawtab_cmd';
      cmdId: string;
      agentId?: string;
      action: 'cancel';
      payload?: Record<string, unknown>;
      issuedAt?: number;
      timeout?: number;
    };

export type ClawtabErrorCode =
  | 'BUSY'
  | 'EXPIRED'
  | 'PERCEIVE_FAILED'
  | 'ACT_FAILED'
  | 'UNKNOWN_ACTION'
  | 'DISCONNECTED';

export interface ClawtabResult {
  type: 'clawtab_result';
  cmdId: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  errorCode?: ClawtabErrorCode;
  op?: ActOp;
  busyStatus?: string;
  browserId: string;
  ts: number;
}

// Chat message as returned by the Gateway's chat.history endpoint. Uses loose
// typing because server shape varies slightly (blocks / content / id).
export interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | string;
  content?: string | Array<{ type: string; text?: string }>;
  blocks?: Array<{ type: string; text?: string }>;
  timestamp?: number;
  ts?: number;
  createdAt?: number;
  attachments?: unknown[];
}
