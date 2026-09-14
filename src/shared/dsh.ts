/** dsh /api 协议层类型（M0 实测确认，见方案 §13） */

export interface ClientRequest {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

export interface RpcOk<T> { ok: true; value: T }
export interface RpcErr { ok: false; error: { code: string; message: string; details?: unknown } }
export type RpcResult<T> = RpcOk<T> | RpcErr

export interface ServerResponse<T = unknown> {
  type: 'server-response'
  rpcId: string
  result: RpcResult<T>
}

/** mux 帧：外面套一层 server-request，payload 才是真帧 */
export interface ServerRequest {
  type: 'server-request'
  rpcId: string
  method: string
  payload: MuxFrame
}

export interface SessionEventEnvelope {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: string
}

export type MuxFrame =
  | { type: 'session/event'; sessionId: string; event: SessionEventEnvelope; view?: unknown }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | { type: 'approval/requested'; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: string; approvalId: string; outcome: string }
  | { type: 'question/requested'; sessionId: string; questions: QuestionItem[] }
  | { type: 'question/resolved'; sessionId: string; questionRpcId: string; outcome: string }
  | { type: 'session/queue'; sessionId: string; items: unknown[] }
  | { type: 'session/jobs'; sessionId: string; jobs: unknown[] }
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: { code: string; message: string } }
  | { type: 'host/session-added'; sessionId: string; blank: boolean; parentSessionId?: string; origin?: string }
  | { type: 'host/session-removed'; sessionId: string }
  | { type: 'host/session-status'; sessionId: string; running: boolean }
  | { type: 'host/agent-error'; sessionId: string; message: string }
  | { type: 'host/archived-sessions-changed'; archivedSessionIds: string[] }
  | { type: string; [k: string]: unknown }

export interface QuestionOption { label: string; description?: string }
export interface QuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

/** session.list 的一条（projections 里藏了 title / tokenUsage 等） */
export interface RawSessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  agentPreset?: string
  parentSessionId?: string
  origin?: string
  projections?: { asOfSeq?: number; values?: Record<string, unknown> }
}

export interface HostDescription {
  version?: string
  cwd?: string
  provider?: string
  model?: string
  attachedSessions?: number
  home?: string
  canOpenPath?: boolean
}

export interface ModelCatalog {
  current?: { provider: string; model: string; reasoningEffort?: string }
  routable?: boolean
  groups?: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
  failures?: unknown[]
}
