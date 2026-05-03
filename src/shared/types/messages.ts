// Discriminated union of every chrome.runtime.sendMessage payload the
// extension uses. Three message families:
//
//   1. Sidebar → Background (RPC-like: send + await response)
//   2. Background → Sidebar (broadcast via chrome.runtime.sendMessage)
//   3. Background ↔ Content  (both directions)
//
// Each variant's response shape is encoded in `ResponseOf<T>`.

import type { PickedElement, CapturedElement } from './picker';
import type { ChatMessage } from './protocol';
import type { DiagBundle, LogLevel, LogSource, StatusSnapshot } from './state';

// ── 1) Sidebar → Background ──────────────────────────────────────────────────

export type ConnectRequest = {
  type: 'connect';
  url: string;
  token: string;
  name?: string;
};

export type DisconnectRequest = { type: 'disconnect' };
export type GetStatusRequest = { type: 'get_status' };
export type CancelRequest = { type: 'cancel' };

export type FetchHistoryRequest = {
  type: 'sidebar_fetch_history';
  sessionKey: string;
};

export type EnsureAndSendRequest = {
  type: 'sidebar_ensure_and_send';
  sessionKey: string;
  message: string;
};

export type ResetContextRequest = {
  type: 'sidebar_reset_context';
  sessionKey: string;
};

export type ListAgentsRequest = { type: 'sidebar_list_agents' };

export type SidebarOpenedRequest = { type: 'sidebar_opened' };
export type SidebarClosedRequest = { type: 'sidebar_closed' };

// Diagnostics
export type LogEventRequest = {
  type: 'log_event';
  level: LogLevel;
  src: LogSource;
  msg: string;
  data?: unknown;
};

export type DiagGetRequest = { type: 'diag_get' };
export type LogClearRequest = { type: 'log_clear' };

// Element picker control
export type EnterPickModeRequest = { type: 'enter_pick_mode' };
export type ExitPickModeRequest = { type: 'exit_pick_mode' };
export type FlashElementRequest = { type: 'flash_element'; selector: string };

// ── 2) Background → Sidebar (broadcasts) ─────────────────────────────────────

export type StatusUpdateBroadcast = {
  type: 'status_update';
} & StatusSnapshot;

export type ElementPickedBroadcast = {
  type: 'element_picked';
  element: PickedElement;
};

export type PickModeExitedBroadcast = { type: 'pick_mode_exited' };

export type TabActivatedBroadcast = {
  type: 'tab_activated';
  tabId: number;
};

// ── 3) Background ↔ Content ──────────────────────────────────────────────────

// bg → content
export type ContentGetContentRequest = { type: 'get_content' };
export type ContentClickRequest = { type: 'click'; selector: string };
export type ContentFillRequest = {
  type: 'fill';
  selector: string;
  value: string;
};
export type ContentScrollRequest = { type: 'scroll'; x?: number; y?: number };
export type ContentEvalRequest = { type: 'eval'; code: string };
export type ContentEnterPickModeRequest = { type: 'enter_pick_mode' };
export type ContentExitPickModeRequest = { type: 'exit_pick_mode' };

// content → bg
export type ElementPickedCaptureRequest = {
  type: 'element_picked_capture';
  element: CapturedElement;
};

export type PickModeExitedContentRequest = { type: 'pick_mode_exited' };

// ── Aggregates ───────────────────────────────────────────────────────────────

export type SidebarToBackgroundMessage =
  | ConnectRequest
  | DisconnectRequest
  | GetStatusRequest
  | CancelRequest
  | FetchHistoryRequest
  | EnsureAndSendRequest
  | ResetContextRequest
  | ListAgentsRequest
  | SidebarOpenedRequest
  | SidebarClosedRequest
  | LogEventRequest
  | DiagGetRequest
  | LogClearRequest
  | EnterPickModeRequest
  | ExitPickModeRequest
  | FlashElementRequest;

export type BackgroundBroadcast =
  | StatusUpdateBroadcast
  | ElementPickedBroadcast
  | PickModeExitedBroadcast
  | TabActivatedBroadcast;

export type BackgroundToContentMessage =
  | ContentGetContentRequest
  | ContentClickRequest
  | ContentFillRequest
  | ContentScrollRequest
  | ContentEvalRequest
  | ContentEnterPickModeRequest
  | ContentExitPickModeRequest;

export type ContentToBackgroundMessage =
  | ElementPickedCaptureRequest
  | PickModeExitedContentRequest;

export type RuntimeMessage =
  | SidebarToBackgroundMessage
  | BackgroundBroadcast
  | BackgroundToContentMessage
  | ContentToBackgroundMessage;

// ── Response types ───────────────────────────────────────────────────────────
// `ok` is common across every handler; extra fields vary.

export interface OkResponse {
  ok: true;
  error?: never;
  code?: string;
}

export interface ErrResponse {
  ok: false;
  error: string;
  code?: string;
}

export type BasicResponse<T extends object = {}> = (OkResponse & T) | ErrResponse;

export type FetchHistoryResponse = BasicResponse<{ messages: ChatMessage[] }>;
export type ListAgentsResponse = BasicResponse<{ agents: Array<string | { id: string }> }>;
export type DiagGetResponse = DiagBundle | { ok: false; error: string };

// Content-side response to each BackgroundToContentMessage
export interface ContentOkResponse<T = unknown> {
  ok: true;
  result: T;
}
export interface ContentErrResponse {
  ok: false;
  error: string;
}
export type ContentResponse<T = unknown> =
  | ContentOkResponse<T>
  | ContentErrResponse;
