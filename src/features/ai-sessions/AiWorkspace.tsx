import { BookOpen, Bot, ChevronDown, ChevronRight, Command, Copy, FileSearch, GitCompare, Mic, MicOff, PanelLeftOpen, Plus, RotateCw, Send, Square, X } from 'lucide-react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { BUILTIN_JSON_FORMAT_ID, BUILTIN_PROMPTPAD_ID, splitSequenceSteps } from '../../shared/featureModel';
import {
  appendAiSessionHistory,
  commitAiSessionDeletion,
  loadAiSessionHistory,
  loadAiWorkspace,
  saveAiWorkspace,
} from '../../shared/promptpadStorage';
import type { AgentSessionConfig, AgentType, AiSessionGroup, AiSessionRecord, AiWorkspaceArchive, FeatureWindowStepState, GuiAgentType, GuiModelType, NormalizedFeatureDef, Prefs } from '../../shared/types';
import { AiToolPanel, featureToComposerText } from './AiToolPanel';
import { ComposerResizeHandle } from './ComposerResizeHandle';
import { DeleteSessionDialog } from './DeleteSessionDialog';
import { DocumentPanel, type DocumentSearchSnapshot } from './DocumentPanel';
import { chooseDocumentDirectory, chooseDocumentFile, readDocumentFile, type DocumentFileContent } from './documentApi';
import { GitPanel } from './GitPanel';
import { ChangeTrackerPanel } from './ChangeTrackerPanel';
import { GlobalSearchOverlay, type GlobalSearchResult } from './GlobalSearchOverlay';
import { DeleteSessionGroupDialog } from './DeleteSessionGroupDialog';
import { MoveSessionDialog } from './MoveSessionDialog';
import { NewSessionDialog, type NewSessionInput } from './NewSessionDialog';
import { RenameSessionDialog } from './RenameSessionDialog';
import { SessionGroupDialog } from './SessionGroupDialog';
import { SessionGroupRail } from './SessionGroupRail';
import { appendSessionHistory, createAiSession, defaultGuiModel } from './sessionModel';
import { listenSpeechEvents, startSpeechRecognition, stopSpeechRecognition, type SpeechEvent } from './speechApi';
import { agentSessionExists, completeGuiMessage, findAgentSessionId, findPtySessionId, getClipboardText, listAgentSkills, pollPty, preparePtyRestart, setClipboardText, startPty, stopPty, validateWorkingDirectory, writePty, type AgentSkillItem } from './terminalApi';
import { TerminalView } from './TerminalView';
import { SessionReadingView } from './SessionReadingView';
import { PtyHistoryBuffer } from './ptyHistoryBuffer';
import { writeTerminalOutput } from './terminalOutputBus';
import { waitForTerminalGeometry } from './terminalGeometry';
import { usePtyOutput } from './usePtyOutput';
import { featureWindowStateKey, sessionsForGroup, toPersistedSession, upsertFeatureWindowStepState } from './workspaceModel';
import { GUI_MODEL_OPTIONS } from './guiModels';
import type { AgentSessionPreset } from './AgentCenterDemo';
import { AgentPickerDialog, type AgentPickerOption } from './AgentPickerDialog';
import { AgentSessionConfigPanel } from './AgentSessionConfigPanel';

const AGENT_SESSION_ID_CAPTURE_ATTEMPTS = 12;
const AGENT_SESSION_ID_CAPTURE_INTERVAL_MS = 500;
const POLL_DEDUP_LIMIT = 262_144;
const DOCUMENT_PANEL_STATE_KEY = 'agentbox.document-panel-state.v1';
const LAST_SESSION_CWD_KEY = 'agentbox.last-session-cwd.v1';
const BRACKETED_PASTE_START = '\u001b[200~';
const BRACKETED_PASTE_END = '\u001b[201~';
const SESSION_RAIL_MIN_WIDTH = 220;
const SESSION_RAIL_MAX_WIDTH = 520;
const TOOL_PANEL_MIN_WIDTH = 280;
const TOOL_PANEL_MAX_WIDTH = 620;
const WORKBENCH_MIN_WIDTH = 420;
const LAYOUT_DIVIDER_WIDTH = 8;
const TOOL_DOCK_WIDTH = 34;

interface AiWorkspaceProps {
  agentPreset?: AgentSessionPreset | null;
  onAgentPresetConsumed?: () => void;
  features?: NormalizedFeatureDef[];
  globalSearchOpen?: boolean;
  onDeleteFeature?: (feature: NormalizedFeatureDef) => void;
  onEditFeature?: (feature: NormalizedFeatureDef) => void;
  onGlobalSearchOpenChange?: (open: boolean) => void;
  onMessage: (message: string) => void;
  onPrefsChange?: (prefs: Prefs) => void;
  onToolInvoke?: (feature: NormalizedFeatureDef, insertText: (text: string) => void) => void;
  prefs?: Prefs;
}

const EMPTY_PREFS: Prefs = { favorites: [], order: [] };

interface FeatureWindow {
  id: string;
  featureId: string;
  name: string;
  groupId: string | null;
  sessionId: string | null;
  steps: string[];
  done: Record<number, boolean>;
  collapsed: boolean;
}

interface ComposerSelection {
  start: number;
  end: number;
}

interface ComposerAssistItem {
  agent?: AgentType | 'all';
  id: string;
  command: string;
  source: string;
  kind: string;
  description: string;
  insertText: string;
}

interface SlashCommandQuery {
  end: number;
  start: number;
  token: string;
}

interface InsertTextOptions {
  appendWhenAtEnd?: boolean;
}

interface ComposerHistoryEntry {
  selection: ComposerSelection;
  value: string;
}

interface ComposerHistoryState {
  undo: ComposerHistoryEntry[];
  redo: ComposerHistoryEntry[];
}

interface ComposerEditGroup {
  kind: string;
  lastAt: number;
}

interface SpeechRecordingState {
  baseValue: string;
  end: number;
  hasInserted: boolean;
  recordingId: string;
  sessionId: string;
  start: number;
  status: 'recording' | 'stopping';
  statusMessage?: string;
}

const MAX_COMPOSER_UNDO_DEPTH = 80;
const COMPOSER_UNDO_GROUP_MS = 1200;

export function formatComposerPtyInput(text: string) {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized.includes('\n') || normalized.includes('\t')) {
    return `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}\r`;
  }
  return `${normalized}\r\n`;
}

const BUILTIN_ASSIST_ITEMS: ComposerAssistItem[] = [
  {
    agent: 'all',
    id: 'command-help',
    command: '/help',
    source: 'CLI',
    kind: '命令',
    description: '查看当前 Agent CLI 支持的帮助和命令说明。',
    insertText: '/help',
  },
  {
    agent: 'all',
    id: 'command-clear',
    command: '/clear',
    source: 'CLI',
    kind: '命令',
    description: '清理当前会话上下文或屏幕内容，具体行为以当前 CLI 为准。',
    insertText: '/clear',
  },
  {
    agent: 'all',
    id: 'command-status',
    command: '/status',
    source: 'CLI',
    kind: '命令',
    description: '查看当前 CLI 会话、模型、上下文或连接状态。',
    insertText: '/status',
  },
  {
    agent: 'all',
    id: 'command-model',
    command: '/model',
    source: 'CLI',
    kind: '命令',
    description: '切换或查看当前使用的大模型。不同 CLI 的可用模型和交互方式以实际终端为准。',
    insertText: '/model ',
  },
  {
    agent: 'all',
    id: 'command-mcp',
    command: '/mcp',
    source: 'CLI',
    kind: '命令',
    description: '查看或管理 MCP 相关连接、工具和服务器状态。不同 CLI 的子命令以实际终端为准。',
    insertText: '/mcp ',
  },
  {
    agent: 'all',
    id: 'command-resume',
    command: '/resume',
    source: 'CLI',
    kind: '命令',
    description: '恢复历史会话或查看可恢复会话，具体能力以当前 CLI 为准。',
    insertText: '/resume ',
  },
  {
    agent: 'codex',
    id: 'skill-project-logs',
    command: '/project-logs',
    source: 'public-skills',
    kind: 'Skill',
    description: '查服务日志、按模块或时间段查日志、根据 traceId / 异常关键词 / 错误码定位日志，或查看服务启动日志。',
    insertText: '/project-logs ',
  },
  {
    agent: 'codex',
    id: 'skill-incident-debug',
    command: '/incident-debug',
    source: 'public-skills',
    kind: 'Agent',
    description: '线上问题排查与依赖查询编排入口，适合告警根因、traceId 全量日志、堆栈片段和容器运行时诊断。',
    insertText: '/incident-debug ',
  },
  {
    agent: 'codex',
    id: 'skill-env-resolver',
    command: '/env-resolver',
    source: 'public-skills',
    kind: 'Skill',
    description: '把测试、沙箱、线上、动态测试、动态沙箱等口语环境归一化为ExampleCompany标准环境枚举。',
    insertText: '/env-resolver ',
  },
  {
    agent: 'codex',
    id: 'skill-metrics',
    command: '/metrics',
    source: 'public-skills',
    kind: 'Skill',
    description: '查询服务指标、容器资源、接口耗时、错误率和告警相关监控数据。',
    insertText: '/metrics ',
  },
  {
    agent: 'codex',
    id: 'skill-runtime-diagnostics',
    command: '/runtime-diagnostics',
    source: 'public-skills',
    kind: 'Skill',
    description: '远程连接机器执行 Arthas 诊断命令，适合线程、堆栈、方法耗时、类加载和 JVM 行为排查。',
    insertText: '/runtime-diagnostics ',
  },
  {
    agent: 'codex',
    id: 'skill-api-docs',
    command: '/api-docs',
    source: 'public-tools',
    kind: 'Skill',
    description: '根据接口名、服务名或关键词查找内部 API 文档，确认上下游契约和已有能力。',
    insertText: '/api-docs ',
  },
];

export function AiWorkspace({
  agentPreset = null,
  onAgentPresetConsumed,
  features = [],
  globalSearchOpen = false,
  onDeleteFeature,
  onEditFeature,
  onGlobalSearchOpenChange,
  onMessage,
  onPrefsChange,
  onToolInvoke,
  prefs = EMPTY_PREFS,
}: AiWorkspaceProps) {
  const [groups, setGroups] = useState<AiSessionGroup[]>([]);
  const [sessions, setSessions] = useState<AiSessionRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeHistory, setActiveHistory] = useState('');
  const [activeHistorySessionId, setActiveHistorySessionId] = useState<string | null>(null);
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [creatingSessionGroupId, setCreatingSessionGroupId] = useState<string | null | undefined>(undefined);
  const [creatingSessionPreset, setCreatingSessionPreset] = useState<AgentSessionPreset | null>(null);
  const [agentPickerGroupId, setAgentPickerGroupId] = useState<string | null | undefined>(undefined);
  const [lastSessionCwd, setLastSessionCwd] = useState(() => loadLastSessionCwd());
  const [loading, setLoading] = useState(true);
  const [clearVersions, setClearVersions] = useState<Record<string, number>>({});
  const [composerHeight, setComposerHeight] = useState(72);
  const [renamingSession, setRenamingSession] = useState<AiSessionRecord | null>(null);
  const [deletingSession, setDeletingSession] = useState<AiSessionRecord | null>(null);
  const [movingSession, setMovingSession] = useState<AiSessionRecord | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<AiSessionGroup | null>(null);
  const [deletingGroup, setDeletingGroup] = useState<AiSessionGroup | null>(null);
  const [permanentlyDeletingGroup, setPermanentlyDeletingGroup] = useState<AiSessionGroup | null>(null);
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);
  const [sessionRailCollapsed, setSessionRailCollapsed] = useState(false);
  const [sessionRailWidth, setSessionRailWidth] = useState(280);
  const [toolPanelWidth, setToolPanelWidth] = useState(360);
  const [sidePanelCollapsed, setSidePanelCollapsed] = useState(false);
  const [sidePanelMode, setSidePanelMode] = useState<'tools' | 'documents' | 'git' | 'tracker'>('documents');
  const [featureWindows, setFeatureWindows] = useState<FeatureWindow[]>([]);
  const [featureWindowStates, setFeatureWindowStates] = useState<FeatureWindowStepState[]>([]);
  const [pendingFeatureWindow, setPendingFeatureWindow] = useState<NormalizedFeatureDef | null>(null);
  const [featureWindowGroupMode, setFeatureWindowGroupMode] = useState<'existing' | 'new'>('existing');
  const [featureWindowGroupId, setFeatureWindowGroupId] = useState<string | null>(null);
  const [featureWindowGroupName, setFeatureWindowGroupName] = useState('');
  const [featurePanelSplit, setFeaturePanelSplit] = useState(0.56);
  const [composerAssistQuery, setComposerAssistQuery] = useState<SlashCommandQuery | null>(null);
  const [composerAssistHighlighted, setComposerAssistHighlighted] = useState(0);
  const [composerAssistPanelOpen, setComposerAssistPanelOpen] = useState(false);
  const [composerAssistPanelSearch, setComposerAssistPanelSearch] = useState('');
  const [composerAssistPanelSource, setComposerAssistPanelSource] = useState('all');
  const [speechRecording, setSpeechRecording] = useState<SpeechRecordingState | null>(null);
  const [composerAddMenuOpen, setComposerAddMenuOpen] = useState(false);
  const [composerAddMenuPosition, setComposerAddMenuPosition] = useState<{ bottom: number; left: number } | null>(null);
  const [contextPathDialogOpen, setContextPathDialogOpen] = useState(false);
  const [contextPathDraft, setContextPathDraft] = useState('');
  const [guiReplyingIds, setGuiReplyingIds] = useState<Set<string>>(() => new Set());
  const [agentSkills, setAgentSkills] = useState<AgentSkillItem[]>([]);
  const [documentSnapshot, setDocumentSnapshot] = useState<DocumentSearchSnapshot | null>(null);
  const [readingView, setReadingView] = useState(false);
  const [documentOpenPathRequest, setDocumentOpenPathRequest] = useState<string | null>(null);
  const [detachedFeatureIds, setDetachedFeatureIds] = useState<string[]>([]);

  useEffect(() => {
    if (!agentPreset) {
      return;
    }
    onAgentPresetConsumed?.();
    void createSession({ ...agentPreset, groupId: null });
  }, [agentPreset, onAgentPresetConsumed]);
  const sessionRailExpandedWidthRef = useRef(280);
  const loadedRef = useRef(false);
  const sessionsRef = useRef<AiSessionRecord[]>([]);
  const groupsRef = useRef<AiSessionGroup[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const historiesRef = useRef(new Map<string, string>());
  const displayHistoriesRef = useRef(new Map<string, string>());
  const bufferedHistoryRef = useRef(new PtyHistoryBuffer());
  const pendingHistoryRef = useRef(new PtyHistoryBuffer());
  const bufferedHistoryTimerRef = useRef<number | null>(null);
  const fallbackHistorySessionsRef = useRef(new Set<string>());
  const pollDedupRef = useRef(new Map<string, string>());
  const activeGenerationsRef = useRef(new Map<string, string>());
  const sessionStartedAtRef = useRef(new Map<string, number>());
  const capturingSessionIdsRef = useRef(new Set<string>());
  const pollingPtyRef = useRef(new Set<string>());
  const startingPtyRef = useRef(new Map<string, Promise<void>>());
  const stoppingPtyRef = useRef(new Map<string, Promise<void>>());
  const claudeFallbackRetryRef = useRef(new Set<string>());
  const historyTokenRef = useRef(0);
  const activeHistoryFrameRef = useRef<number | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerAssistRootRef = useRef<HTMLDivElement | null>(null);
  const composerAddMenuRootRef = useRef<HTMLDivElement | null>(null);
  const composerSelectionsRef = useRef(new Map<string, ComposerSelection>());
  const insertToolTextRef = useRef<(text: string) => void>(() => undefined);
  const sendComposerRef = useRef<() => void>(() => undefined);
  const composerHistoryRef = useRef(new Map<string, ComposerHistoryState>());
  const composerEditGroupsRef = useRef(new Map<string, ComposerEditGroup>());
  const speechRecordingRef = useRef<SpeechRecordingState | null>(null);
  const pendingSpeechEventsRef = useRef(new Map<string, SpeechEvent[]>());
  const appliedSpeechTranscriptsRef = useRef(new Set<string>());
  const reportedSpeechErrorsRef = useRef(new Set<string>());
  const applyingSpeechTranscriptRef = useRef(false);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId) ?? null,
    [activeId, sessions],
  );

  useEffect(() => {
    setReadingView(false);
  }, [activeId]);
  const activeGroups = useMemo(() => groups.filter((group) => group.deletedAt === undefined), [groups]);
  const activeSessions = useMemo(() => sessions.filter((session) => {
    const group = session.groupId ? groups.find((item) => item.id === session.groupId) : undefined;
    return group?.deletedAt === undefined;
  }), [groups, sessions]);
  const composer = activeId ? composerDrafts[activeId] ?? '' : '';
  const renderedActiveHistory = activeHistorySessionId === activeId ? activeHistory : '';
  const composerAssistItems = useMemo(
    () => {
      const agent = activeSession?.agent ?? 'terminal';
      return [
      ...BUILTIN_ASSIST_ITEMS.filter((item) => item.agent === 'all' || item.agent === agent),
      ...agentSkills
        .filter((skill) => skill.agent === agent)
        .map((skill) => ({
          agent: skill.agent,
          id: `agent-skill-${skill.agent}-${skill.path}`,
          command: skill.command,
          source: skill.source,
          kind: 'Skill',
          description: skill.description || skill.name,
          insertText: `${skill.command} `,
        })),
      ...features.map((feature) => {
        const name = feature.name.trim() || feature.id;
        return {
          agent: 'all' as const,
          id: `tool-${feature.id}`,
          command: `/${toCommandSlug(name)}`,
          source: feature.builtin ? '内置' : '工具箱',
          kind: feature.type === 'sequence' ? '工作流' : feature.type === 'snippet' ? '片段' : '提示词',
          description: feature.description || feature.script || name,
          insertText: featureToComposerText(feature),
        };
      }),
    ];
    },
    [activeSession?.agent, agentSkills, features],
  );
  const composerAssistMatches = useMemo(
    () => filterComposerAssistItems(composerAssistItems, composerAssistQuery?.token ?? ''),
    [composerAssistItems, composerAssistQuery],
  );
  const composerAssistPanelItems = useMemo(
    () => filterComposerAssistItems(composerAssistItems, composerAssistPanelSearch, composerAssistPanelSource),
    [composerAssistItems, composerAssistPanelSearch, composerAssistPanelSource],
  );
  const composerAssistSources = useMemo(
    () => Array.from(new Set(composerAssistItems.map((item) => item.source))),
    [composerAssistItems],
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    void listen<{ text: string; append_enter: boolean }>('quick-palette-insert-main', (event) => {
      if (disposed) {
        return;
      }
      insertToolTextRef.current(event.payload.text);
      if (event.payload.append_enter) {
        window.setTimeout(() => sendComposerRef.current(), 0);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        dispose = unlisten;
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    void listen<{ featureId: string; sessionId: string; text: string }>('plugin-window-insert', (event) => {
      if (disposed) {
        return;
      }
      const { sessionId, text } = event.payload;
      if (sessionId !== activeIdRef.current) {
        setActiveId(sessionId);
        window.setTimeout(() => insertToolTextRef.current(text), 0);
      } else {
        insertToolTextRef.current(text);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        dispose = unlisten;
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    const listenWindowEvents = async () => {
      const unlistenClosed = await listen<string>('plugin-window-closed', (event) => {
        if (!disposed) {
          setDetachedFeatureIds((current) => current.filter((id) => id !== event.payload));
        }
      });
      const unlistenReady = await listen<string>('plugin-window-ready', (event) => {
        const session = sessionsRef.current.find((item) => item.id === activeIdRef.current);
        if (!disposed && session && detachedFeatureIds.includes(event.payload)) {
          void emitTo(`plugin-${event.payload.replace(/[^a-zA-Z0-9_-]/g, '-')}`, 'plugin-window-context', {
            sessionId: session.id,
            sessionName: session.name,
            groupId: session.groupId,
            cwd: session.cwd,
          });
        }
      });
      dispose = () => {
        unlistenClosed();
        unlistenReady();
      };
    };
    void listenWindowEvents().catch(() => undefined);
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [detachedFeatureIds]);

  useEffect(() => {
    if (!activeSession) {
      return;
    }
    const context = {
      sessionId: activeSession.id,
      sessionName: activeSession.name,
      groupId: activeSession.groupId,
      cwd: activeSession.cwd,
    };
    for (const featureId of detachedFeatureIds) {
      void emitTo(`plugin-${featureId.replace(/[^a-zA-Z0-9_-]/g, '-')}`, 'plugin-window-context', context);
    }
  }, [activeSession, detachedFeatureIds]);

  function insertSpeechTranscript(recording: SpeechRecordingState, recordingId: string, text: string) {
    if (appliedSpeechTranscriptsRef.current.has(recordingId)) {
      return;
    }
    appliedSpeechTranscriptsRef.current.add(recordingId);
    const nextValue = `${recording.baseValue.slice(0, recording.start)}${text}${recording.baseValue.slice(recording.end)}`;
    const nextCursor = recording.start + text.length;
    applyingSpeechTranscriptRef.current = true;
    setComposerDraft(recording.sessionId, nextValue, {
      forceUndoBoundary: !recording.hasInserted,
      recordUndo: !recording.hasInserted,
      selection: { start: nextCursor, end: nextCursor },
      undoKind: 'speech',
    });
    if (speechRecordingRef.current?.recordingId === recordingId) {
      speechRecordingRef.current = { ...recording, hasInserted: true };
      setSpeechRecording(speechRecordingRef.current);
    }
    window.setTimeout(() => {
      applyingSpeechTranscriptRef.current = false;
    }, 0);
  }

  function handleSpeechEvent(event: SpeechEvent, queueIfPending = true) {
    const recording = speechRecordingRef.current;
    if (!recording) {
      if (queueIfPending) {
        const queued = pendingSpeechEventsRef.current.get(event.recordingId) ?? [];
        pendingSpeechEventsRef.current.set(event.recordingId, [...queued.slice(-7), event]);
        if (pendingSpeechEventsRef.current.size > 8) {
          const oldest = pendingSpeechEventsRef.current.keys().next().value;
          if (oldest) {
            pendingSpeechEventsRef.current.delete(oldest);
          }
        }
      }
      return;
    }
    if (recording.recordingId !== event.recordingId) {
      return;
    }
    if (event.kind === 'transcript' && typeof event.text === 'string') {
      insertSpeechTranscript(recording, event.recordingId, event.text);
      return;
    }
    if (event.kind === 'status' && event.message) {
      speechRecordingRef.current = { ...recording, status: 'stopping', statusMessage: event.message };
      setSpeechRecording(speechRecordingRef.current);
      return;
    }
    if (event.kind === 'error') {
      reportedSpeechErrorsRef.current.add(event.recordingId);
      speechRecordingRef.current = null;
      setSpeechRecording(null);
      onMessage(event.message || '语音识别失败');
      return;
    }
    if (event.kind === 'stopped') {
      speechRecordingRef.current = null;
      setSpeechRecording(null);
    }
  }

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    void listenSpeechEvents((event: SpeechEvent) => {
      if (!disposed) {
        handleSpeechEvent(event);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        dispose = unlisten;
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      dispose?.();
      speechRecordingRef.current = null;
      pendingSpeechEventsRef.current.clear();
      appliedSpeechTranscriptsRef.current.clear();
      reportedSpeechErrorsRef.current.clear();
    };
  }, [onMessage]);

  useEffect(() => {
    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (composerAddMenuOpen && !composerAddMenuRootRef.current?.contains(target)) {
        setComposerAddMenuOpen(false);
      }
      if (composerAssistRootRef.current?.contains(target)) {
        return;
      }
      closeComposerAssist();
      setComposerAssistPanelOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [composerAddMenuOpen]);

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onGlobalSearchOpenChange?.(true);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    setFeatureWindowGroupId((current) => current ?? groups[0]?.id ?? null);
  }, [groups]);

  useEffect(() => {
    let cancelled = false;
    void listAgentSkills(activeSession?.cwd ?? null)
      .then((items) => {
        if (!cancelled) {
          setAgentSkills(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgentSkills([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeSession?.cwd]);

  useEffect(() => {
    setComposerAssistHighlighted((current) => Math.min(current, Math.max(composerAssistMatches.length - 1, 0)));
  }, [composerAssistMatches.length]);

  useEffect(() => {
    let loadedSuccessfully = false;
    void loadAiWorkspace()
      .then((archive) => {
        loadedSuccessfully = true;
        const restored = archive.sessions.map((session) => ({ ...session, status: 'stopped' as const, history: '' }));
        setGroups(archive.groups);
        setSessions(restored);
        setFeatureWindowStates(archive.featureWindowStates ?? []);
        const firstActive = restored.find((session) => {
          const group = session.groupId ? archive.groups.find((item) => item.id === session.groupId) : undefined;
          return group?.deletedAt === undefined;
        });
        setActiveId(firstActive?.id ?? null);
        if (!loadLastSessionCwd()) {
          const latest = [...restored].sort((left, right) => right.createdAt - left.createdAt)[0];
          if (latest?.cwd) {
            setLastSessionCwd(latest.cwd);
          }
        }
      })
      .catch((error) => {
        if (hasTauriRuntime()) {
          onMessage(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        loadedRef.current = loadedSuccessfully;
        setLoading(false);
      });
  }, [onMessage]);

  useEffect(() => {
    if (!activeId) {
      setActiveHistory('');
      setActiveHistorySessionId(null);
      return;
    }
    const cached = historiesRef.current.get(activeId);
    if (cached !== undefined) {
      setActiveHistorySessionId(activeId);
      setActiveHistory(displayHistoriesRef.current.get(activeId) ?? cached);
      return;
    }
    const token = historyTokenRef.current + 1;
    historyTokenRef.current = token;
    setActiveHistorySessionId(activeId);
    setActiveHistory('');
    void loadAiSessionHistory(activeId)
      .then((history) => {
        historiesRef.current.set(activeId, history);
        displayHistoriesRef.current.set(activeId, history);
        if (historyTokenRef.current === token && activeIdRef.current === activeId) {
          setActiveHistorySessionId(activeId);
          setActiveHistory(history);
        }
      })
      .catch((error) => onMessage(error instanceof Error ? error.message : String(error)));
  }, [activeId, onMessage]);

  useEffect(() => {
    if (!loadedRef.current) {
      return;
    }
    const archive = currentArchive(groups, sessions, featureWindowStates);
    const timer = window.setTimeout(() => {
      void saveAiWorkspace(archive).catch((error) => {
        onMessage(error instanceof Error ? error.message : String(error));
      });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [featureWindowStates, groups, onMessage, sessions]);

  const flushBufferedPtyHistory = useCallback(() => {
    bufferedHistoryTimerRef.current = null;
    const entries = bufferedHistoryRef.current.drain();
    for (const [sessionId, data] of entries) {
      historiesRef.current.set(sessionId, appendSessionHistory(historiesRef.current.get(sessionId) ?? '', data));
      displayHistoriesRef.current.set(sessionId, appendSessionHistory(displayHistoriesRef.current.get(sessionId) ?? '', data));
      pendingHistoryRef.current.push(sessionId, data);
      if (fallbackHistorySessionsRef.current.has(sessionId) && activeIdRef.current === sessionId) {
        scheduleActiveHistoryFlush(sessionId);
      }
    }
    fallbackHistorySessionsRef.current.clear();
  }, []);

  const persistPendingPtyHistory = useCallback(() => {
    for (const [sessionId, data] of pendingHistoryRef.current.drain()) {
      if (data) {
        void appendAiSessionHistory(sessionId, data).catch((error) => {
          onMessage(error instanceof Error ? error.message : String(error));
        });
      }
    }
  }, [onMessage]);

  useEffect(() => {
    const timer = window.setInterval(persistPendingPtyHistory, 1000);
    return () => {
      window.clearInterval(timer);
      if (bufferedHistoryTimerRef.current !== null) {
        window.clearTimeout(bufferedHistoryTimerRef.current);
        flushBufferedPtyHistory();
      }
      persistPendingPtyHistory();
    };
  }, [flushBufferedPtyHistory, persistPendingPtyHistory]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const session of sessionsRef.current) {
        const generation = activeGenerationsRef.current.get(session.id) ?? session.generation;
        if (generation && (session.status === 'running' || session.status === 'starting')) {
          void drainPty(session.id, generation);
        }
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    if (activeHistoryFrameRef.current !== null) {
      window.cancelAnimationFrame(activeHistoryFrameRef.current);
    }
  }, []);

  const appendPtyOutput = useCallback((sessionId: string, data: string) => {
    if (!data) {
      return;
    }
    const writtenDirectly = writeTerminalOutput(sessionId, data);
    if (!writtenDirectly) {
      fallbackHistorySessionsRef.current.add(sessionId);
    }
    bufferedHistoryRef.current.push(sessionId, data);
    if (bufferedHistoryTimerRef.current === null) {
      bufferedHistoryTimerRef.current = window.setTimeout(flushBufferedPtyHistory, 32);
    }
    if (markSessionErrorFromOutput(sessionId, data)) {
      return;
    }
    markSessionRunningFromOutput(sessionId);
  }, [flushBufferedPtyHistory]);

  const drainPty = useCallback(async (sessionId: string, generation: string) => {
    const key = `${sessionId}:${generation}`;
    if (pollingPtyRef.current.has(key)) {
      return;
    }
    pollingPtyRef.current.add(key);
    try {
      const result = await pollPty(sessionId, generation);
      appendPtyOutput(sessionId, consumePolledOutput(sessionId, result.data));
      if (!result.running) {
        handlePtyExit({ sessionId, generation, error: result.error });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('已停止或已重新启动')) {
        onMessage(message);
      }
    } finally {
      pollingPtyRef.current.delete(key);
    }
  }, [appendPtyOutput, onMessage]);

  const handlePtyOutput = useCallback((event: { sessionId: string; generation: string; data: string }) => {
    const expectedGeneration = activeGenerationsRef.current.get(event.sessionId) ??
      sessionsRef.current.find((item) => item.id === event.sessionId)?.generation;
    if (expectedGeneration !== event.generation) {
      return;
    }
    rememberEventOutputForPollDedup(event.sessionId, event.data);
    appendPtyOutput(event.sessionId, event.data);
    const session = sessionsRef.current.find((item) => item.id === event.sessionId);
    const startedAt = sessionStartedAtRef.current.get(event.sessionId);
    if (session?.agent === 'codex' && !session.cliSessionId && startedAt) {
      void captureAgentSessionId(event.sessionId, event.generation, session.agent, session.cwd, startedAt);
    }
  }, [appendPtyOutput]);

  const handlePtyExit = useCallback((event: { sessionId: string; generation: string; error?: string | null }) => {
    if (activeGenerationsRef.current.get(event.sessionId) === event.generation) {
      activeGenerationsRef.current.delete(event.sessionId);
    }
    const session = sessionsRef.current.find((item) => item.id === event.sessionId);
    setSessions((current) => current.map((session) => {
      if (session.id !== event.sessionId || session.generation !== event.generation) {
        return session;
      }
      // CLI 可能先输出恢复失败，再发送无错误的退出事件；退出事件不能覆盖已确认的恢复错误。
      const message = event.error
        ? formatSessionRecoveryError(session, event.error)
        : session.error;
      return {
        ...session,
        status: message ? 'error' : 'stopped',
        generation: undefined,
        error: message,
        updatedAt: Date.now(),
      };
    }));
    if (event.error) {
      onMessage(formatSessionRecoveryError(session, event.error));
    }
  }, [onMessage]);

  usePtyOutput({ onError: onMessage, onExit: handlePtyExit, onOutput: handlePtyOutput });

  async function createSession(input: NewSessionInput): Promise<boolean> {
    // 统一入口做第二层校验，覆盖 Agent Picker、功能窗口等非新建弹窗入口。
    try {
      await validateWorkingDirectory(input.cwd.trim());
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
    const now = Date.now();
    const id = globalThis.crypto?.randomUUID?.() ?? `ai-${now}`;
    const generation = createGeneration();
    const cliSessionId = input.resumeExisting ? input.cliSessionId : input.agent === 'claude' ? id : undefined;
    if (input.resumeExisting && cliSessionId) {
      const existing = findExistingCliSession(cliSessionId);
      if (existing) {
        onMessage(`该会话 ID 已存在于「${existing.groupName}」分组第 ${existing.position} 个：${existing.session.name}`);
        return false;
      }
    }
    const session = {
      ...createAiSession({ ...input, id, now }),
      groupId: input.groupId ?? null,
      generation,
      cliSessionId,
      status: 'starting' as const,
    };
    rememberLastSessionCwd(input.cwd);
    setLastSessionCwd(input.cwd);
    historiesRef.current.set(id, '');
    displayHistoriesRef.current.set(id, '');
    setComposerDrafts((current) => ({ ...current, [id]: '' }));
    activeGenerationsRef.current.set(id, generation);
    sessionStartedAtRef.current.set(id, now);
    setSessions((current) => [session, ...current]);
    setActiveId(id);
    setCreatingSessionGroupId(undefined);
    if (input.agent === 'gui') {
      activeGenerationsRef.current.delete(id);
      sessionStartedAtRef.current.delete(id);
      updateSession(id, (current) => ({ ...current, status: 'running', generation: undefined, error: undefined, agentConfigInitialized: Boolean(current.agentConfig), updatedAt: Date.now() }));
      return true;
    }
    const geometry = await waitForTerminalGeometry(id);
    if (activeGenerationsRef.current.get(id) !== generation) {
      return false;
    }
    const startup = startPty(id, generation, input.agent, input.cwd, {
      cliSessionId,
      model: input.model ?? input.agentConfig?.model,
      resume: input.resumeExisting === true,
      fallbackResume: false,
      agentContext: buildAgentContext(input.agentConfig),
      cols: geometry.cols,
      rows: geometry.rows,
    });
    startingPtyRef.current.set(id, startup);
    try {
      await startup;
      if (activeGenerationsRef.current.get(id) !== generation) {
        return false;
      }
      updateSession(id, (current) => ({ ...current, status: 'running', error: undefined, agentConfigInitialized: Boolean(current.agentConfig), updatedAt: Date.now() }));
      if (input.agent === 'codex' && !input.resumeExisting) {
        void captureAgentSessionId(id, generation, input.agent, input.cwd, now);
      }
    } catch (error) {
      if (activeGenerationsRef.current.get(id) === generation) {
        activeGenerationsRef.current.delete(id);
        const message = error instanceof Error ? error.message : String(error);
        updateSession(id, (current) => ({ ...current, status: 'error', generation: undefined, error: message }));
        onMessage(message);
      }
    } finally {
      if (startingPtyRef.current.get(id) === startup) {
        startingPtyRef.current.delete(id);
      }
    }
    return true;
  }

  async function restartSession(session: AiSessionRecord) {
    if (session.agent === 'gui') {
      updateSession(session.id, (current) => ({ ...current, status: 'running', error: undefined, updatedAt: Date.now() }));
      return;
    }
    if (session.agent === 'terminal') {
      void startExistingSession(session, {
        fallbackResume: false,
        clearCliSessionId: true,
        resume: false,
      });
      return;
    }
    if (session.agent === 'claude' && session.cliSessionId) {
      try {
        if (!await agentSessionExists('claude', session.cwd, session.cliSessionId)) {
          await restartFailedSession(session);
          return;
        }
      } catch (error) {
        onMessage(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    const cliSessionId = session.agent === 'codex' && !session.cliSessionId
      ? await resolveSessionCliSessionId(session)
      : session.cliSessionId;
    if (session.agent === 'codex' && !cliSessionId) {
      const message = formatSessionRecoveryError(session, 'Codex 恢复会话缺少 CLI 会话 ID，已拒绝使用最近会话兜底');
      setClearVersions((current) => ({ ...current, [session.id]: (current[session.id] ?? 0) + 1 }));
      updateSession(session.id, (current) => ({
        ...current,
        status: 'error',
        generation: undefined,
        error: message,
        updatedAt: Date.now(),
      }));
      onMessage(message);
      return;
    }
    claudeFallbackRetryRef.current.delete(session.id);
    void startExistingSession(session, {
      cliSessionId,
      fallbackResume: session.agent === 'claude' && !cliSessionId,
      clearCliSessionId: false,
    });
  }

  async function stopSession(session: AiSessionRecord) {
    if (session.agent === 'gui') {
      updateSession(session.id, (current) => ({ ...current, status: 'stopped', error: undefined, updatedAt: Date.now() }));
      return;
    }
    if (session.generation === undefined) {
      return;
    }
    if (stoppingPtyRef.current.has(session.id)) {
      return;
    }
    const generation = session.generation;
    const startup = startingPtyRef.current.get(session.id);
    const stopMarker = Promise.resolve();
    stoppingPtyRef.current.set(session.id, stopMarker);
    activeGenerationsRef.current.delete(session.id);
    updateSession(session.id, (current) => ({ ...current, status: 'stopping', updatedAt: Date.now() }));
    let stopped = false;
    try {
      let startupFailed = false;
      if (startup) {
        try {
          await startup;
        } catch {
          startupFailed = true;
        }
      }
      if (!startup && session.status === 'starting') {
        stopped = true;
      } else if (startupFailed) {
        stopped = true;
      } else {
        await captureMissingSessionId(session);
        try {
          await stopPty(session.id, generation);
          stopped = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('已停止或已重新启动')) {
            stopped = true;
          } else {
            onMessage(message);
          }
        }
      }
    } finally {
      if (stopped) {
        updateSession(session.id, (current) => ({
          ...current,
          status: 'stopped',
          generation: undefined,
          error: undefined,
          updatedAt: Date.now(),
        }));
      } else {
        activeGenerationsRef.current.set(session.id, generation);
        updateSession(session.id, (current) => ({
          ...current,
          status: 'running',
          generation,
          updatedAt: Date.now(),
        }));
      }
      if (stoppingPtyRef.current.get(session.id) === stopMarker) {
        stoppingPtyRef.current.delete(session.id);
      }
    }
  }

  async function duplicateSession(session: AiSessionRecord) {
    await createSession({
      name: session.name,
      agent: session.agent,
      guiAgent: session.guiAgent,
      guiModel: session.guiModel,
      cwd: session.cwd,
      groupId: session.groupId,
    });
  }

  async function deleteSession(session: AiSessionRecord) {
    const stopped = await stopSessionsForDeletion([session.id]);
    if (!stopped) {
      return;
    }
    const nextSessions = sessionsRef.current.filter((item) => item.id !== session.id);
    const nextArchive = currentArchive(groupsRef.current, nextSessions, featureWindowStates);
    await commitAiSessionDeletion(nextArchive, [session.id]);
    historiesRef.current.delete(session.id);
    displayHistoriesRef.current.delete(session.id);
    bufferedHistoryRef.current.delete(session.id);
    pendingHistoryRef.current.delete(session.id);
    activeGenerationsRef.current.delete(session.id);
    setSessions(nextSessions);
    setActiveId((current) => (current === session.id ? nextSessions[0]?.id ?? null : current));
    setDeletingSession(null);
  }

  function renameSession(session: AiSessionRecord, name: string) {
    updateSession(session.id, (current) => ({ ...current, name, updatedAt: Date.now() }));
    setRenamingSession(null);
  }

  function togglePinned(session: AiSessionRecord) {
    updateSession(session.id, (current) => ({ ...current, pinned: !current.pinned, updatedAt: Date.now() }));
  }

  function createGroup(name: string) {
    const now = Date.now();
    setGroups((current) => [...current, { id: globalThis.crypto?.randomUUID?.() ?? `group-${now}`, name, createdAt: now, collapsed: false, pinned: false }]);
    setCreatingGroup(false);
  }

  function renameGroup(name: string) {
    if (!renamingGroup) {
      return;
    }
    setGroups((current) => current.map((group) => (group.id === renamingGroup.id ? { ...group, name } : group)));
    setRenamingGroup(null);
  }

  function toggleGroupPinned(group: AiSessionGroup) {
    setGroups((current) => {
      const next = current.map((item) => (
        item.id === group.id ? { ...item, pinned: item.pinned !== true } : item
      ));
      void saveAiWorkspace(currentArchive(next, sessionsRef.current, featureWindowStates)).catch((error) => {
        onMessage(error instanceof Error ? error.message : String(error));
      });
      return next;
    });
  }

  function toggleSessionRail() {
    setSessionRailCollapsed((current) => {
      const nextCollapsed = !current;
      if (nextCollapsed) {
        sessionRailExpandedWidthRef.current = Math.max(sessionRailWidth, 220);
        setSessionRailWidth(40);
      } else {
        setSessionRailWidth(Math.max(sessionRailExpandedWidthRef.current, 220));
      }
      return nextCollapsed;
    });
  }

  async function deleteGroup(group: AiSessionGroup) {
    const sessionIds = sessionsRef.current.filter((session) => session.groupId === group.id).map((session) => session.id);
    const stopped = await stopSessionsForDeletion(sessionIds);
    if (!stopped) {
      throw new Error('有会话停止失败，已保留分组和会话');
    }
    const nextGroups = groupsRef.current.map((item) => item.id === group.id ? { ...item, deletedAt: Date.now(), collapsed: false } : item);
    const nextSessions = sessionsRef.current.map((item) => sessionIds.includes(item.id)
      ? { ...item, status: 'stopped' as const, generation: undefined, updatedAt: Date.now() }
      : item);
    for (const sessionId of sessionIds) {
      activeGenerationsRef.current.delete(sessionId);
      sessionStartedAtRef.current.delete(sessionId);
    }
    setGroups(nextGroups);
    setSessions(nextSessions);
    const nextActive = nextSessions.find((session) => !groupsRef.current.find((candidate) => candidate.id === session.groupId)?.deletedAt && !sessionIds.includes(session.id));
    setActiveId((current) => (current && sessionIds.includes(current) ? nextActive?.id ?? null : current));
    setDeletingGroup(null);
  }

  function restoreGroup(group: AiSessionGroup) {
    setGroups((current) => current.map((item) => item.id === group.id ? { ...item, deletedAt: undefined, collapsed: false } : item));
  }

  async function permanentlyDeleteGroup(group: AiSessionGroup) {
    const sessionIds = sessionsRef.current.filter((session) => session.groupId === group.id).map((session) => session.id);
    const nextGroups = groupsRef.current.filter((item) => item.id !== group.id);
    const nextSessions = sessionsRef.current.filter((item) => item.groupId !== group.id);
    const nextFeatureWindowStates = featureWindowStates.filter((state) => state.groupId !== group.id);
    await commitAiSessionDeletion(currentArchive(nextGroups, nextSessions, nextFeatureWindowStates), sessionIds);
    for (const sessionId of sessionIds) {
      historiesRef.current.delete(sessionId);
      displayHistoriesRef.current.delete(sessionId);
      bufferedHistoryRef.current.delete(sessionId);
      pendingHistoryRef.current.delete(sessionId);
      activeGenerationsRef.current.delete(sessionId);
      sessionStartedAtRef.current.delete(sessionId);
    }
    setGroups(nextGroups);
    setSessions(nextSessions);
    setFeatureWindowStates(nextFeatureWindowStates);
    setPermanentlyDeletingGroup(null);
  }

  function moveSessionToGroup(groupId: string | null) {
    if (!movingSession) {
      return;
    }
    updateSession(movingSession.id, (current) => ({ ...current, groupId, updatedAt: Date.now() }));
    setMovingSession(null);
  }

  async function stopSessionsForDeletion(sessionIds: string[]) {
    const results = await Promise.allSettled(sessionIds.map(async (sessionId) => {
      const startup = startingPtyRef.current.get(sessionId);
      if (startup) {
        await startup.catch(() => undefined);
      }
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (session?.generation !== undefined && (session.status === 'running' || session.status === 'starting')) {
        await stopPty(session.id, session.generation);
      }
    }));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      onMessage(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
      return false;
    }
    return true;
  }

  async function toggleSpeechInput() {
    if (!activeSession) {
      return;
    }
    if (speechRecordingRef.current) {
      await stopSpeechInput();
      return;
    }
    const textarea = composerTextareaRef.current;
    const sessionId = activeSession.id;
    const value = composerDrafts[sessionId] ?? '';
    const selection = textarea && activeIdRef.current === sessionId
      ? { start: textarea.selectionStart, end: textarea.selectionEnd }
      : composerSelectionsRef.current.get(sessionId) ?? { start: value.length, end: value.length };
    try {
      const recordingId = await startSpeechRecognition('zh-CN');
      const nextRecording: SpeechRecordingState = {
        baseValue: value,
        end: selection.end,
        hasInserted: false,
        recordingId,
        sessionId,
        start: selection.start,
        status: 'recording',
      };
      speechRecordingRef.current = nextRecording;
      setSpeechRecording(nextRecording);
      appliedSpeechTranscriptsRef.current.delete(recordingId);
      reportedSpeechErrorsRef.current.delete(recordingId);
      const pendingEvents = pendingSpeechEventsRef.current.get(recordingId) ?? [];
      pendingSpeechEventsRef.current.delete(recordingId);
      for (const event of pendingEvents) {
        handleSpeechEvent(event, false);
      }
      textarea?.focus();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function stopSpeechInput() {
    const recording = speechRecordingRef.current;
    if (!recording || recording.status === 'stopping') {
      return;
    }
    const stopping = { ...recording, status: 'stopping' as const };
    speechRecordingRef.current = stopping;
    setSpeechRecording(stopping);
    try {
      const result = await stopSpeechRecognition(recording.recordingId);
      if (result.kind === 'transcript' && typeof result.text === 'string') {
        insertSpeechTranscript(recording, recording.recordingId, result.text);
      } else if (result.kind === 'error' && !reportedSpeechErrorsRef.current.has(recording.recordingId)) {
        reportedSpeechErrorsRef.current.add(recording.recordingId);
        onMessage(result.message || '语音识别失败');
      }
      const current = speechRecordingRef.current;
      if (current?.recordingId === recording.recordingId) {
        speechRecordingRef.current = null;
        setSpeechRecording(null);
      }
    } catch (error) {
      speechRecordingRef.current = null;
      setSpeechRecording(null);
      onMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendComposer() {
    if (!activeSession) {
      return;
    }
    if (activeSession.agent === 'gui') {
      if (activeSession.status !== 'running') {
        onMessage('当前 GUI 会话已停止，请先重新启动');
        return;
      }
      if (!composer.trim()) {
        return;
      }
      const prompt = composer;
      await appendGuiMessage(activeSession.id, 'user', prompt);
      setComposerDraft(activeSession.id, '', { forceUndoBoundary: true, recordUndo: true, undoKind: 'send-clear' });
      updateSession(activeSession.id, (current) => ({ ...current, updatedAt: Date.now() }));
      setGuiReplyingIds((current) => new Set(current).add(activeSession.id));
      try {
        const guiAgent = activeSession.guiAgent ?? normalizeGuiAgentFromSession(activeSession);
        const model = resolveGuiModel(activeSession);
        const reply = await completeGuiMessage(guiAgent, model, activeSession.cwd, buildAgentPrompt(activeSession.agentConfig, prompt));
        await appendGuiMessage(
          activeSession.id,
          'assistant',
          reply.trim() || '已完成，但模型没有返回文本。',
          `已接收你的输入，并使用 ${guiAgent === 'claude' ? 'Claude' : 'Codex'} / ${model} 在工作目录 ${activeSession.cwd} 下生成回复。`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendGuiMessage(activeSession.id, 'system', `GUI 模型回复失败：${message}`);
        onMessage(message);
      } finally {
        setGuiReplyingIds((current) => {
          const next = new Set(current);
          next.delete(activeSession.id);
          return next;
        });
      }
      return;
    }
    if (activeSession.status !== 'running' || activeSession.generation === undefined) {
      onMessage('当前会话已停止，请先重新启动');
      return;
    }
    if (!composer.trim()) {
      return;
    }
    try {
      await writePty(activeSession.id, activeSession.generation, formatComposerPtyInput(composer));
      setComposerDraft(activeSession.id, '', { forceUndoBoundary: true, recordUndo: true, undoKind: 'send-clear' });
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function appendGuiMessage(sessionId: string, role: GuiMessage['role'], text: string, thinking?: string) {
    const data = `${JSON.stringify({
      id: globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now()}`,
      role,
      text,
      ...(thinking ? { thinking } : {}),
      timestamp: Date.now(),
    })}\n`;
    const nextHistory = appendSessionHistory(historiesRef.current.get(sessionId) ?? (sessionId === activeIdRef.current ? activeHistory : ''), data);
    historiesRef.current.set(sessionId, nextHistory);
    const nextDisplayHistory = appendSessionHistory(
      displayHistoriesRef.current.get(sessionId) ?? (sessionId === activeIdRef.current ? activeHistory : ''),
      data,
    );
    displayHistoriesRef.current.set(sessionId, nextDisplayHistory);
    if (sessionId === activeIdRef.current) {
      setActiveHistorySessionId(sessionId);
      setActiveHistory(nextDisplayHistory);
    }
    await appendAiSessionHistory(sessionId, data);
  }

  function changeGuiAgent(session: AiSessionRecord, guiAgent: GuiAgentType) {
    updateSession(session.id, (current) => ({ ...current, guiAgent, guiModel: defaultGuiModel(guiAgent), updatedAt: Date.now() }));
  }

  function changeGuiModel(session: AiSessionRecord, model: GuiModelType) {
    updateSession(session.id, (current) => ({ ...current, guiModel: model, updatedAt: Date.now() }));
  }

  async function copyGuiMessage(text: string) {
    try {
      await setClipboardText(text);
      onMessage('已复制到剪贴板');
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposerUndoKey(event)) {
      event.preventDefault();
      if (activeSession) {
        undoComposerDraft(activeSession.id);
      }
      return;
    }
    if (isComposerRedoKey(event)) {
      event.preventDefault();
      if (activeSession) {
        redoComposerDraft(activeSession.id);
      }
      return;
    }
    if (composerAssistQuery) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setComposerAssistHighlighted((current) => Math.min(current + 1, Math.max(composerAssistMatches.length - 1, 0)));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setComposerAssistHighlighted((current) => Math.max(current - 1, 0));
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeComposerAssist();
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && composerAssistMatches[composerAssistHighlighted]) {
        event.preventDefault();
        insertComposerAssistItem(composerAssistMatches[composerAssistHighlighted], true);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendComposer();
    }
  }

  function setComposerDraft(
    sessionId: string,
    value: string,
    options: {
      forceUndoBoundary?: boolean;
      recordUndo?: boolean;
      selection?: ComposerSelection;
      undoKind?: string;
    } = {},
  ) {
    setComposerDrafts((current) => {
      const previousValue = current[sessionId] ?? '';
      if (shouldRecordComposerUndo(sessionId, previousValue, value, options)) {
        pushComposerUndo(sessionId, {
          selection: composerSelectionsRef.current.get(sessionId) ?? { start: previousValue.length, end: previousValue.length },
          value: previousValue,
        });
      }
      updateComposerEditGroup(sessionId, previousValue, value, options);
      const nextSelection = options.selection ?? { start: value.length, end: value.length };
      composerSelectionsRef.current.set(sessionId, nextSelection);
      return { ...current, [sessionId]: value };
    });
  }

  function shouldRecordComposerUndo(
    sessionId: string,
    previousValue: string,
    value: string,
    options: { forceUndoBoundary?: boolean; recordUndo?: boolean; undoKind?: string },
  ) {
    if (!options.recordUndo || previousValue === value) {
      return false;
    }
    if (options.forceUndoBoundary) {
      return true;
    }
    const kind = options.undoKind ?? 'edit';
    const currentGroup = composerEditGroupsRef.current.get(sessionId);
    return !currentGroup || currentGroup.kind !== kind || Date.now() - currentGroup.lastAt > COMPOSER_UNDO_GROUP_MS;
  }

  function updateComposerEditGroup(
    sessionId: string,
    previousValue: string,
    value: string,
    options: { forceUndoBoundary?: boolean; recordUndo?: boolean; undoKind?: string },
  ) {
    if (!options.recordUndo || previousValue === value || options.forceUndoBoundary) {
      composerEditGroupsRef.current.delete(sessionId);
      return;
    }
    composerEditGroupsRef.current.set(sessionId, {
      kind: options.undoKind ?? 'edit',
      lastAt: Date.now(),
    });
  }

  function pushComposerUndo(sessionId: string, entry: ComposerHistoryEntry) {
    const history = composerHistoryRef.current.get(sessionId) ?? { undo: [], redo: [] };
    const last = history.undo[history.undo.length - 1];
    if (last?.value === entry.value && last.selection.start === entry.selection.start && last.selection.end === entry.selection.end) {
      history.redo = [];
      composerHistoryRef.current.set(sessionId, history);
      return;
    }
    composerHistoryRef.current.set(sessionId, {
      undo: [...history.undo, entry].slice(-MAX_COMPOSER_UNDO_DEPTH),
      redo: [],
    });
  }

  function applyComposerHistoryEntry(sessionId: string, entry: ComposerHistoryEntry) {
    composerSelectionsRef.current.set(sessionId, entry.selection);
    composerEditGroupsRef.current.delete(sessionId);
    setComposerDrafts((current) => ({ ...current, [sessionId]: entry.value }));
    window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea || activeIdRef.current !== sessionId) {
        return;
      }
      textarea.focus();
      const start = clamp(entry.selection.start, 0, entry.value.length);
      const end = clamp(entry.selection.end, 0, entry.value.length);
      textarea.setSelectionRange(start, end);
      updateComposerAssist(textarea);
    });
  }

  function undoComposerDraft(sessionId: string) {
    const history = composerHistoryRef.current.get(sessionId);
    const entry = history?.undo[history.undo.length - 1];
    if (!history || !entry) {
      return;
    }
    const currentValue = composerDrafts[sessionId] ?? '';
    const currentSelection = composerSelectionsRef.current.get(sessionId) ?? { start: currentValue.length, end: currentValue.length };
    composerHistoryRef.current.set(sessionId, {
      undo: history.undo.slice(0, -1),
      redo: [...history.redo, { selection: currentSelection, value: currentValue }].slice(-MAX_COMPOSER_UNDO_DEPTH),
    });
    applyComposerHistoryEntry(sessionId, entry);
  }

  function redoComposerDraft(sessionId: string) {
    const history = composerHistoryRef.current.get(sessionId);
    const entry = history?.redo[history.redo.length - 1];
    if (!history || !entry) {
      return;
    }
    const currentValue = composerDrafts[sessionId] ?? '';
    const currentSelection = composerSelectionsRef.current.get(sessionId) ?? { start: currentValue.length, end: currentValue.length };
    composerHistoryRef.current.set(sessionId, {
      undo: [...history.undo, { selection: currentSelection, value: currentValue }].slice(-MAX_COMPOSER_UNDO_DEPTH),
      redo: history.redo.slice(0, -1),
    });
    applyComposerHistoryEntry(sessionId, entry);
  }

  function recordComposerSelection(sessionId: string, textarea: HTMLTextAreaElement) {
    composerSelectionsRef.current.set(sessionId, {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    });
  }

  function updateComposerAssist(textarea: HTMLTextAreaElement, resetHighlighted = true) {
    const query = getSlashCommandQuery(textarea.value, textarea.selectionStart);
    setComposerAssistQuery(query);
    if (resetHighlighted || !query) {
      setComposerAssistHighlighted(0);
    }
  }

  function updateComposerAssistFromKeyUp(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
      return;
    }
    updateComposerAssist(event.currentTarget, false);
  }

  function closeComposerAssist() {
    setComposerAssistQuery(null);
    setComposerAssistHighlighted(0);
  }

  function insertComposerText(
    text: string,
    sessionId = activeId,
    selection?: ComposerSelection,
    options: InsertTextOptions = {},
  ) {
    if (!sessionId) {
      return;
    }
    let nextCursor = 0;
    setComposerDrafts((current) => {
      const draft = current[sessionId] ?? '';
      const inserted = insertTextIntoDraft(draft, text, selection, options);
      if (inserted.value !== draft) {
        pushComposerUndo(sessionId, {
          selection: selection ?? composerSelectionsRef.current.get(sessionId) ?? { start: draft.length, end: draft.length },
          value: draft,
        });
        composerEditGroupsRef.current.delete(sessionId);
      }
      nextCursor = inserted.cursor;
      composerSelectionsRef.current.set(sessionId, { start: inserted.cursor, end: inserted.cursor });
      return { ...current, [sessionId]: inserted.value };
    });
    activeIdRef.current = sessionId;
    setActiveId(sessionId);
    window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea || activeIdRef.current !== sessionId) {
        return;
      }
      textarea.focus();
      textarea.setSelectionRange(nextCursor, nextCursor);
    });
  }

  function insertToolText(text: string, sessionId = activeId) {
    if (!sessionId) {
      return;
    }
    const activeTextarea = sessionId === activeIdRef.current ? composerTextareaRef.current : null;
    const liveSelection = activeTextarea
      ? { start: activeTextarea.selectionStart, end: activeTextarea.selectionEnd }
      : undefined;
    const storedSelection = composerSelectionsRef.current.get(sessionId);
    insertComposerText(text, sessionId, liveSelection ?? storedSelection, { appendWhenAtEnd: true });
  }

  function insertContextText(text: string) {
    insertToolText(text);
    setComposerAddMenuOpen(false);
  }

  insertToolTextRef.current = insertToolText;
  sendComposerRef.current = sendComposer;

  async function loadSearchSessionHistory(sessionId: string) {
    const cached = historiesRef.current.get(sessionId);
    if (cached !== undefined) {
      return cached;
    }
    const history = await loadAiSessionHistory(sessionId);
    historiesRef.current.set(sessionId, history);
    return history;
  }

  function openGlobalSearchResult(result: GlobalSearchResult) {
    onGlobalSearchOpenChange?.(false);
    if (result.kind === 'session') {
      setActiveId(result.sessionId);
      return;
    }
    if (result.kind === 'tool') {
      const feature = features.find((item) => item.id === result.featureId);
      if (!feature) {
        onMessage('该工具已不存在');
        return;
      }
      setSidePanelMode('tools');
      setSidePanelCollapsed(false);
      invokeTool(feature);
      return;
    }
    setSidePanelMode('documents');
    setSidePanelCollapsed(false);
    setDocumentOpenPathRequest(result.path);
    insertToolText(`请阅读文件 ${result.path}，并结合当前会话给出结论。`);
  }

  function toggleSidePanel(mode: 'tools' | 'documents' | 'git' | 'tracker') {
    if (sidePanelMode === mode && !sidePanelCollapsed) {
      setSidePanelCollapsed(true);
      return;
    }
    setSidePanelMode(mode);
    setSidePanelCollapsed(false);
  }

  async function insertCurrentDocument() {
    const state = loadDocumentPanelState();
    if (!state?.rootPath || !state.selectedPath) {
      onMessage('当前没有打开的文档');
      return;
    }
    try {
      const file = await readDocumentFile(state.rootPath, state.selectedPath);
      insertContextText(formatFileContext(file, '当前文档'));
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function insertSelectedDocumentText() {
    const text = window.getSelection()?.toString().trim();
    if (!text) {
      onMessage('当前没有选中的文档内容');
      return;
    }
    const state = loadDocumentPanelState();
    const path = state?.selectedPath ? `文件：${state.selectedPath}\n\n` : '';
    insertContextText(`${path}选中内容：\n${text}`);
  }

  function openComposerAddMenu(button: HTMLButtonElement) {
    const rect = button.getBoundingClientRect();
    setComposerAddMenuPosition({
      bottom: Math.max(16, window.innerHeight - rect.top + 8),
      left: Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - 252)),
    });
    setComposerAddMenuOpen((current) => !current);
    setComposerAssistPanelOpen(false);
    closeComposerAssist();
  }

  function openContextPathDialog() {
    setComposerAddMenuOpen(false);
    setContextPathDraft('');
    setContextPathDialogOpen(true);
  }

  function insertPathText(path: string) {
    const value = path.trim();
    if (!value) {
      onMessage('请输入要插入的路径');
      return false;
    }
    insertContextText(value);
    setContextPathDialogOpen(false);
    setContextPathDraft('');
    return true;
  }

  async function chooseAndInsertContextPath(kind: 'file' | 'directory') {
    try {
      const path = kind === 'file' ? await chooseDocumentFile() : await chooseDocumentDirectory();
      if (!path) {
        return;
      }
      setContextPathDraft(path);
      insertPathText(path);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function insertClipboardContext() {
    try {
      const text = (await getClipboardText()).trim();
      if (!text) {
        onMessage('剪贴板没有可插入的文本');
        return;
      }
      insertContextText(`剪贴板内容：\n${text}`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function insertComposerAssistItem(item: ComposerAssistItem, replaceSlashToken: boolean) {
    if (!activeSession) {
      return;
    }
    const textarea = composerTextareaRef.current;
    const slashQuery = replaceSlashToken && textarea
      ? getSlashCommandQuery(textarea.value, textarea.selectionStart)
      : null;
    const selection = slashQuery
      ? { start: slashQuery.start, end: slashQuery.end }
      : textarea
        ? { start: textarea.selectionStart, end: textarea.selectionEnd }
        : composerSelectionsRef.current.get(activeSession.id);
    insertComposerText(item.insertText, activeSession.id, selection, { appendWhenAtEnd: false });
    closeComposerAssist();
    setComposerAssistPanelOpen(false);
  }

  function invokeTool(feature: NormalizedFeatureDef) {
    if (feature.id === BUILTIN_PROMPTPAD_ID || feature.id === BUILTIN_JSON_FORMAT_ID) {
      onToolInvoke?.(feature, insertToolText);
      return;
    }
    if (feature.type === 'sequence') {
      if (feature.seqRule === 'confirm') {
        openConfirmSequence(feature);
        return;
      }
      insertToolText(featureToComposerText(feature));
      return;
    }
    if (feature.type === 'prompt' || feature.type === 'snippet') {
      insertToolText(featureToComposerText(feature));
      return;
    }
    onToolInvoke?.(feature, insertToolText);
  }

  async function detachTool(feature: NormalizedFeatureDef, startDragging = false) {
    if (detachedFeatureIds.includes(feature.id)) {
      onMessage(`「${feature.name}」已经在独立窗口中打开`);
      return;
    }
    try {
      const label = await invoke<string>('open_plugin_window', { pluginId: feature.id, title: feature.name });
      setDetachedFeatureIds((current) => current.includes(feature.id) ? current : [...current, feature.id]);
      if (startDragging) {
        await invoke('start_plugin_window_follow', { pluginId: feature.id });
      }
      onMessage(`「${feature.name}」已脱离为独立插件窗口`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : `无法打开「${feature.name}」独立窗口`);
    }
  }

  function openConfirmSequence(feature: NormalizedFeatureDef) {
    if (groups.length > 0) {
      setFeatureWindowGroupId(groups[0].id);
      setFeatureWindowGroupMode('existing');
    } else {
      setFeatureWindowGroupId(null);
      setFeatureWindowGroupMode('new');
    }
    setFeatureWindowGroupName(feature.name);
    setPendingFeatureWindow(feature);
  }

  function createFeatureWindow() {
    if (!pendingFeatureWindow) {
      return;
    }
    const now = Date.now();
    let groupId = featureWindowGroupMode === 'existing' ? featureWindowGroupId : null;
    if (featureWindowGroupMode === 'new') {
      const name = featureWindowGroupName.trim() || pendingFeatureWindow.name;
      groupId = globalThis.crypto?.randomUUID?.() ?? `group-${now}`;
      setGroups((current) => [...current, { id: groupId!, name, createdAt: now, collapsed: false, pinned: false }]);
    }
    const existingWindow = featureWindows.find(
      (window) => window.featureId === pendingFeatureWindow.id && window.groupId === groupId,
    );
    if (existingWindow) {
      const groupName = groupId
        ? groupsRef.current.find((group) => group.id === groupId)?.name ?? '未知分组'
        : '未分组';
      onMessage(`「${pendingFeatureWindow.name}」在「${groupName}」分组里已经打开，不能重复创建`);
      setPendingFeatureWindow(null);
      return;
    }
    const groupSessions = sessionsRef.current.filter((session) => session.groupId === groupId);
    setFeatureWindows((current) => [
      {
        id: globalThis.crypto?.randomUUID?.() ?? `feature-window-${now}`,
        featureId: pendingFeatureWindow.id,
        name: pendingFeatureWindow.name,
        groupId,
        sessionId: groupSessions[0]?.id ?? null,
        steps: splitSequenceSteps(pendingFeatureWindow.script),
        done: featureWindowStates.find(
          (state) => featureWindowStateKey(state.featureId, state.groupId) === featureWindowStateKey(pendingFeatureWindow.id, groupId),
        )?.done ?? {},
        collapsed: false,
      },
      ...current,
    ]);
    if (groupSessions[0]) {
      setActiveId(groupSessions[0].id);
    }
    setPendingFeatureWindow(null);
  }

  function executeFeatureWindowStep(window: FeatureWindow, step: string) {
    if (!window.sessionId) {
      onMessage('请先绑定一个会话');
      return;
    }
    insertToolText(step, window.sessionId);
  }

  function toggleFeatureWindowStepDone(windowId: string, index: number) {
    setFeatureWindows((current) => current.map((window) => (
      window.id === windowId ? toggleWindowStepDone(window, index) : window
    )));
  }

  function toggleFeatureWindow(windowId: string) {
    setFeatureWindows((current) => current.map((window) => (
      window.id === windowId ? { ...window, collapsed: !window.collapsed } : window
    )));
  }

  function closeFeatureWindow(windowId: string) {
    setFeatureWindows((current) => current.filter((window) => window.id !== windowId));
  }

  function bindFeatureWindowSession(windowId: string, sessionId: string | null) {
    setFeatureWindows((current) => current.map((window) => (
      window.id === windowId ? { ...window, sessionId } : window
    )));
    if (sessionId) {
      setActiveId(sessionId);
    }
  }

  function createSessionForFeatureWindow(window: FeatureWindow) {
    setCreatingSessionGroupId(window.groupId);
  }

  function openAgentSessionPicker(groupId: string | null) {
    setAgentPickerGroupId(groupId);
  }

  function createSessionFromAgent(agent: AgentPickerOption) {
    setAgentPickerGroupId(undefined);
    void createSession({
      name: agent.name,
      agent: agent.agent,
      model: agent.model,
      cwd: agent.cwd,
      groupId: agentPickerGroupId ?? null,
      guiAgent: agent.guiAgent,
      guiModel: agent.guiModel,
      agentConfig: { ...agent.agentConfig, model: agent.agentConfig?.model ?? agent.model },
    });
  }

  function startFeaturePanelResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const divider = event.currentTarget;
    const pointerId = event.pointerId;
    divider.setPointerCapture(pointerId);
    divider.classList.add('active');
    document.body.classList.add('resizing-layout');
    const move = (moveEvent: globalThis.PointerEvent) => {
      const rect = divider.parentElement?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const gap = 0.04;
      setFeaturePanelSplit(clamp((moveEvent.clientX - rect.left) / rect.width, gap, 1 - gap));
    };
    const up = (upEvent: globalThis.PointerEvent) => {
      divider.releasePointerCapture(upEvent.pointerId);
      divider.classList.remove('active');
      document.body.classList.remove('resizing-layout');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function startHorizontalResize(kind: 'sessions' | 'tools', event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const divider = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startSessionRailWidth = sessionRailWidth;
    const startToolPanelWidth = toolPanelWidth;
    divider.setPointerCapture(pointerId);
    divider.classList.add('active');
    document.body.classList.add('resizing-layout');

    const move = (moveEvent: globalThis.PointerEvent) => {
      const workspace = divider.parentElement;
      const workspaceRect = workspace?.getBoundingClientRect();
      const workspaceWidth = workspaceRect?.width || workspace?.clientWidth || window.innerWidth;
      const currentSessionRailWidth = sessionRailCollapsed ? 40 : sessionRailWidth;
      const currentToolPanelWidth = sidePanelCollapsed ? 0 : startToolPanelWidth;
      const toolDividerWidth = sidePanelCollapsed ? 0 : LAYOUT_DIVIDER_WIDTH;
      // 中间工作区不能被压缩为 0，否则文档面板继续变宽时，Markdown 内容会被挤到屏幕外。
      const fixedWidthWithoutWorkbench = currentSessionRailWidth
        + LAYOUT_DIVIDER_WIDTH
        + toolDividerWidth
        + currentToolPanelWidth
        + TOOL_DOCK_WIDTH;

      if (kind === 'sessions') {
        const maxWidth = Math.min(
          SESSION_RAIL_MAX_WIDTH,
          Math.max(SESSION_RAIL_MIN_WIDTH, workspaceWidth - (fixedWidthWithoutWorkbench - currentSessionRailWidth) - WORKBENCH_MIN_WIDTH),
        );
        const nextWidth = clamp(startSessionRailWidth + moveEvent.clientX - startX, 40, maxWidth);
        setSessionRailWidth(nextWidth);
        if (nextWidth > 56) {
          sessionRailExpandedWidthRef.current = nextWidth;
          if (sessionRailCollapsed) {
            setSessionRailCollapsed(false);
          }
        } else if (nextWidth <= 40 && !sessionRailCollapsed) {
          setSessionRailCollapsed(true);
        }
      } else {
        // 文档面板可以占满中间工作区；只保留两条布局分隔线和右侧停靠栏，
        // 让它的左边缘最多到达会话列表边界，不能继续越过会话列表。
        const availableWidth = workspaceWidth
          - currentSessionRailWidth
          - LAYOUT_DIVIDER_WIDTH
          - LAYOUT_DIVIDER_WIDTH
          - TOOL_DOCK_WIDTH;
        const maxWidth = sidePanelMode === 'documents' || sidePanelMode === 'git' || sidePanelMode === 'tracker'
          ? Math.max(TOOL_PANEL_MIN_WIDTH, availableWidth)
          : Math.min(TOOL_PANEL_MAX_WIDTH, Math.max(TOOL_PANEL_MIN_WIDTH, availableWidth));
        setToolPanelWidth(clamp(startToolPanelWidth + startX - moveEvent.clientX, TOOL_PANEL_MIN_WIDTH, maxWidth));
      }
    };
    const up = (upEvent: globalThis.PointerEvent) => {
      divider.releasePointerCapture(upEvent.pointerId);
      divider.classList.remove('active');
      document.body.classList.remove('resizing-layout');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function updateSession(id: string, updater: (session: AiSessionRecord) => AiSessionRecord) {
    setSessions((current) => current.map((session) => (session.id === id ? updater(session) : session)));
  }

  function markSessionRunningFromOutput(sessionId: string) {
    setSessions((current) => {
      let changed = false;
      const next = current.map((session) => {
        if (session.id !== sessionId || session.error || (session.status === 'running' && !session.error)) {
          return session;
        }
        changed = true;
        return { ...session, status: 'running' as const, error: undefined, updatedAt: Date.now() };
      });
      return changed ? next : current;
    });
  }

  function markSessionErrorFromOutput(sessionId: string, data: string) {
    const currentSession = sessionsRef.current.find((session) => session.id === sessionId);
    if (!currentSession) {
      return false;
    }
    const message = parseRecoveryErrorFromOutput(currentSession, data);
    if (!message) {
      return false;
    }
    activeGenerationsRef.current.delete(sessionId);
    updateSession(sessionId, (session) => ({
      ...session,
      status: 'error',
      generation: undefined,
      error: message,
      updatedAt: Date.now(),
    }));
    onMessage(message);
    return true;
  }

  function scheduleActiveHistoryFlush(sessionId: string) {
    if (activeHistoryFrameRef.current !== null) {
      return;
    }
    activeHistoryFrameRef.current = window.requestAnimationFrame(() => {
      activeHistoryFrameRef.current = null;
      if (activeIdRef.current === sessionId) {
        setActiveHistory(displayHistoriesRef.current.get(sessionId) ?? '');
      }
    });
  }

  function rememberEventOutputForPollDedup(sessionId: string, data: string) {
    if (!data) {
      return;
    }
    const current = pollDedupRef.current.get(sessionId) ?? '';
    const next = `${current}${data}`;
    pollDedupRef.current.set(sessionId, next.length > POLL_DEDUP_LIMIT ? next.slice(-POLL_DEDUP_LIMIT) : next);
  }

  function consumePolledOutput(sessionId: string, data: string) {
    if (!data) {
      return '';
    }
    const known = pollDedupRef.current.get(sessionId) ?? '';
    if (!known) {
      return data;
    }
    if (known.startsWith(data)) {
      pollDedupRef.current.set(sessionId, known.slice(data.length));
      return '';
    }
    if (data.startsWith(known)) {
      pollDedupRef.current.delete(sessionId);
      return data.slice(known.length);
    }
    pollDedupRef.current.delete(sessionId);
    return data;
  }

  function toggleWindowStepDone(window: FeatureWindow, index: number): FeatureWindow {
    const done = { ...window.done };
    if (done[index]) {
      delete done[index];
    } else {
      done[index] = true;
    }
    setFeatureWindowStates((current) => upsertFeatureWindowStepState(current, window.featureId, window.groupId, done));
    return { ...window, done };
  }

  async function restartFailedSession(session: AiSessionRecord) {
    const now = Date.now();
    const generation = createGeneration();
    const cliSessionId = session.agent === 'claude'
      ? (globalThis.crypto?.randomUUID?.() ?? `ai-${now}`)
      : undefined;
    historiesRef.current.set(session.id, '');
    displayHistoriesRef.current.set(session.id, '');
    bufferedHistoryRef.current.delete(session.id);
    pendingHistoryRef.current.delete(session.id);
    pollDedupRef.current.delete(session.id);
    if (activeIdRef.current === session.id) {
      setActiveHistorySessionId(session.id);
      setActiveHistory('');
    }
    setClearVersions((current) => ({ ...current, [session.id]: (current[session.id] ?? 0) + 1 }));
    setComposerDrafts((current) => ({ ...current, [session.id]: '' }));
    activeGenerationsRef.current.set(session.id, generation);
    sessionStartedAtRef.current.set(session.id, now);
    updateSession(session.id, (current) => ({
      ...current,
      status: 'starting',
      generation,
      cliSessionId: cliSessionId ?? (session.agent === 'codex' ? undefined : current.cliSessionId),
      error: undefined,
      updatedAt: Date.now(),
    }));
    const geometry = await waitForTerminalGeometry(session.id);
    if (activeGenerationsRef.current.get(session.id) !== generation) {
      return;
    }
    const startup = preparePtyRestart(session.id).then(() => startPty(session.id, generation, session.agent, session.cwd, {
      cliSessionId,
      model: session.model ?? session.agentConfig?.model,
      resume: false,
      fallbackResume: false,
      agentContext: buildAgentContext(session.agentConfig),
      cols: geometry.cols,
      rows: geometry.rows,
    }));
    startingPtyRef.current.set(session.id, startup);
    try {
      await startup;
      if (activeGenerationsRef.current.get(session.id) !== generation) {
        return;
      }
      updateSession(session.id, (current) => ({ ...current, status: 'running', error: undefined, updatedAt: Date.now() }));
      if (session.agent === 'codex' && !cliSessionId) {
        void captureAgentSessionId(session.id, generation, session.agent, session.cwd, now);
      }
    } catch (error) {
      if (activeGenerationsRef.current.get(session.id) === generation) {
        activeGenerationsRef.current.delete(session.id);
        const message = error instanceof Error ? error.message : String(error);
        updateSession(session.id, (current) => ({ ...current, status: 'error', generation: undefined, error: message, updatedAt: Date.now() }));
        onMessage(message);
      }
    } finally {
      if (startingPtyRef.current.get(session.id) === startup) {
        startingPtyRef.current.delete(session.id);
      }
    }
  }

  async function restartSessionWithFallback(session: AiSessionRecord) {
    await startExistingSession(session, {
      cliSessionId: undefined,
      fallbackResume: true,
      clearCliSessionId: true,
    });
  }

  async function startExistingSession(
    session: AiSessionRecord,
    launch: { cliSessionId?: string; fallbackResume: boolean; clearCliSessionId: boolean; resume?: boolean },
  ) {
    const startedAt = Date.now();
    const generation = createGeneration();
    flushBufferedPtyHistory();
    displayHistoriesRef.current.set(session.id, '');
    bufferedHistoryRef.current.delete(session.id);
    fallbackHistorySessionsRef.current.delete(session.id);
    pollDedupRef.current.delete(session.id);
    if (activeIdRef.current === session.id) {
      setActiveHistorySessionId(session.id);
      setActiveHistory('');
    }
    setClearVersions((current) => ({ ...current, [session.id]: (current[session.id] ?? 0) + 1 }));
    activeGenerationsRef.current.set(session.id, generation);
    sessionStartedAtRef.current.set(session.id, startedAt);
    updateSession(session.id, (current) => ({
      ...current,
      status: 'starting',
      generation,
      cliSessionId: launch.clearCliSessionId ? undefined : (launch.cliSessionId ?? current.cliSessionId),
      error: undefined,
      updatedAt: Date.now(),
    }));
    const geometry = await waitForTerminalGeometry(session.id);
    if (activeGenerationsRef.current.get(session.id) !== generation) {
      return;
    }
    const startup = preparePtyRestart(session.id).then(() => startPty(session.id, generation, session.agent, session.cwd, {
      cliSessionId: launch.clearCliSessionId ? undefined : launch.cliSessionId,
      model: session.model ?? session.agentConfig?.model,
      resume: launch.resume ?? true,
      fallbackResume: launch.fallbackResume,
      agentContext: buildAgentContext(session.agentConfig),
      cols: geometry.cols,
      rows: geometry.rows,
    }));
    startingPtyRef.current.set(session.id, startup);
    try {
      await startup;
      if (activeGenerationsRef.current.get(session.id) !== generation) {
        return;
      }
      claudeFallbackRetryRef.current.delete(session.id);
      updateSession(session.id, (current) => ({ ...current, status: 'running', agentConfigInitialized: Boolean(current.agentConfig), updatedAt: Date.now() }));
      if (session.agent === 'codex' && !launch.cliSessionId) {
        void captureAgentSessionId(session.id, generation, session.agent, session.cwd, startedAt);
      }
    } catch (error) {
      if (activeGenerationsRef.current.get(session.id) === generation) {
        activeGenerationsRef.current.delete(session.id);
        const message = error instanceof Error ? error.message : String(error);
        const recoveryMessage = formatSessionRecoveryError(session, message);
        updateSession(session.id, (current) => ({ ...current, status: 'error', generation: undefined, error: recoveryMessage, updatedAt: Date.now() }));
        onMessage(recoveryMessage);
      }
    } finally {
      if (startingPtyRef.current.get(session.id) === startup) {
        startingPtyRef.current.delete(session.id);
      }
    }
  }

  async function resolveSessionCliSessionId(session: AiSessionRecord) {
    if (session.cliSessionId) {
      return session.cliSessionId;
    }
    const startedAt = sessionStartedAtRef.current.get(session.id) ?? session.updatedAt ?? session.createdAt;
    if (!startedAt) {
      return undefined;
    }
    try {
      const cliSessionId = await findAgentSessionId(session.agent, session.cwd, startedAt);
      if (cliSessionId) {
        updateSession(session.id, (current) => ({ ...current, cliSessionId, updatedAt: Date.now() }));
        return cliSessionId;
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
    return undefined;
  }

  function findExistingCliSession(cliSessionId: string) {
    const session = sessionsRef.current.find((item) => item.cliSessionId === cliSessionId);
    if (!session) {
      return undefined;
    }
    const groupName = session.groupId
      ? groupsRef.current.find((group) => group.id === session.groupId)?.name ?? '未知分组'
      : '未分组';
    const position = sessionsForGroup(sessionsRef.current, session.groupId).findIndex((item) => item.id === session.id) + 1;
    return { groupName, position, session };
  }

  async function captureAgentSessionId(
    sessionId: string,
    generation: string,
    agent: AiSessionRecord['agent'],
    cwd: string,
    startedAt: number,
  ) {
    if (capturingSessionIdsRef.current.has(sessionId)) {
      return;
    }
    capturingSessionIdsRef.current.add(sessionId);
    try {
      for (let attempt = 0; attempt < AGENT_SESSION_ID_CAPTURE_ATTEMPTS; attempt += 1) {
        const current = sessionsRef.current.find((session) => session.id === sessionId);
        if (current?.cliSessionId) {
          return;
        }
        if (activeGenerationsRef.current.get(sessionId) !== generation) {
          return;
        }
        if (current && current.status !== 'running' && current.status !== 'starting' && current.status !== 'stopping') {
          return;
        }
        try {
          const cliSessionId = await findPtySessionId(sessionId, generation, agent, cwd);
          if (cliSessionId) {
            updateSession(sessionId, (session) => ({ ...session, cliSessionId, updatedAt: Date.now() }));
            return;
          }
        } catch (error) {
          if (attempt === AGENT_SESSION_ID_CAPTURE_ATTEMPTS - 1) {
            onMessage(error instanceof Error ? error.message : String(error));
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, AGENT_SESSION_ID_CAPTURE_INTERVAL_MS));
      }
    } finally {
      capturingSessionIdsRef.current.delete(sessionId);
    }
  }

  async function captureMissingSessionId(session: AiSessionRecord) {
    if (session.cliSessionId || session.agent !== 'codex') {
      return;
    }
    const generation = activeGenerationsRef.current.get(session.id) ?? session.generation;
    if (!generation) {
      return;
    }
    try {
      const cliSessionId = await findPtySessionId(session.id, generation, session.agent, session.cwd);
      if (cliSessionId) {
        updateSession(session.id, (current) => ({ ...current, cliSessionId, updatedAt: Date.now() }));
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section
      className={`${sidePanelCollapsed ? 'ai-workspace tools-collapsed' : 'ai-workspace'} ${sessionRailCollapsed ? 'sessions-collapsed' : ''}`}
      aria-label="AI 工作台"
      style={{
        '--session-rail-width': `${sessionRailCollapsed ? 40 : sessionRailWidth}px`,
        '--tool-panel-width': `${toolPanelWidth}px`,
        '--feature-tool-panel-fr': `${featurePanelSplit}fr`,
        '--feature-window-panel-fr': `${1 - featurePanelSplit}fr`,
        '--terminal-composer-height': `${composerHeight + 54}px`,
      } as CSSProperties}
    >
      <>
        <aside className={sessionRailCollapsed ? 'session-rail session-rail-collapsed' : 'session-rail'}>
          {sessionRailCollapsed ? (
            <div className="session-rail-collapsed-shell">
              <button
                aria-label="展开会话列表"
                className="ai-session-dock-button"
                onClick={toggleSessionRail}
                title="会话列表"
                type="button"
              >
                <PanelLeftOpen size={17} />
              </button>
            </div>
          ) : (
            <SessionGroupRail
              activeId={activeId}
              groups={groups}
              loading={loading}
              onCollapseRail={toggleSessionRail}
              onCreateGroup={() => setCreatingGroup(true)}
              onCreateAgentSession={openAgentSessionPicker}
              onCreateSession={(groupId) => setCreatingSessionGroupId(groupId)}
              onDeleteGroup={setDeletingGroup}
              onPermanentlyDeleteGroup={setPermanentlyDeletingGroup}
              onDeleteSession={setDeletingSession}
              onDuplicateSession={(session) => void duplicateSession(session)}
              onMoveSession={setMovingSession}
              onRenameGroup={setRenamingGroup}
              onRenameSession={setRenamingSession}
          onRestoreGroup={restoreGroup}
              onSelectSession={setActiveId}
              onToggleGroup={(groupId) => {
                if (groupId === null) {
                  setUngroupedCollapsed((current) => !current);
                } else {
                  setGroups((current) => current.map((group) => (group.id === groupId ? { ...group, collapsed: !group.collapsed } : group)));
                }
              }}
              onToggleGroupPin={toggleGroupPinned}
              onTogglePin={togglePinned}
              sessions={sessions}
              ungroupedCollapsed={ungroupedCollapsed}
            />
          )}
        </aside>

        <div
          aria-label="调整会话列表宽度"
          className="layout-resize-divider session-resize-divider"
          onPointerDown={(event) => startHorizontalResize('sessions', event)}
          role="separator"
        />
      </>

      <div className={activeSession?.agentConfig ? 'terminal-workbench agent-session-workbench' : 'terminal-workbench'}>
        {activeSession ? (
          <>
            {activeSession.agentConfig && <AgentSessionConfigPanel agent={activeSession.agent} config={activeSession.agentConfig} cwd={activeSession.cwd} initialized={activeSession.agentConfigInitialized === true} />}
            <header className="terminal-toolbar">
              <div>
                <strong>{activeSession.name}</strong>
                <span>{activeSession.cwd}</span>
              </div>
              <div className="terminal-actions">
                {activeSession.agent !== 'gui' && <button aria-pressed={readingView} aria-label={readingView ? '切换到终端视图' : '切换到阅读视图'} className={readingView ? 'icon-button active' : 'icon-button'} onClick={() => setReadingView((current) => !current)} title={readingView ? '切换到终端视图' : '阅读视图'} type="button">
                  <BookOpen size={16} />
                </button>}
                {activeSession.status === 'running' || activeSession.status === 'starting' || activeSession.status === 'stopping' ? (
                  <button aria-label="停止会话" className="icon-button" disabled={activeSession.status === 'stopping'} onClick={() => void stopSession(activeSession)} title="停止会话" type="button">
                    <Square size={16} />
                  </button>
                ) : (
                  <button aria-label="重新启动" className="icon-button" onClick={() => void restartSession(activeSession)} title="重新启动" type="button">
                    <RotateCw size={16} />
                  </button>
                )}
              </div>
            </header>

            <div className="terminal-stack">
              <div className="terminal-slot" hidden={readingView}>
                {activeSession.agent === 'gui' ? (
                  <GuiSessionView
                    composerHeight={composerHeight}
                    cwd={activeSession.cwd}
                    guiAgent={activeSession.guiAgent ?? normalizeGuiAgentFromSession(activeSession)}
                    history={renderedActiveHistory}
                    model={resolveGuiModel(activeSession)}
                    name={activeSession.name}
                    onChangeAgent={(agent) => changeGuiAgent(activeSession, agent)}
                    onChangeModel={(model) => changeGuiModel(activeSession, model)}
                    onCopy={(text) => void copyGuiMessage(text)}
                    replying={guiReplyingIds.has(activeSession.id)}
                  />
                ) : (
                  <TerminalView
                    key={`${activeSession.id}:${clearVersions[activeSession.id] ?? 0}`}
                    active={!readingView}
                    clearVersion={clearVersions[activeSession.id] ?? 0}
                    generation={activeSession.generation}
                    history={renderedActiveHistory}
                    layoutHeight={composerHeight}
                    onError={onMessage}
                    // 切换会话会重新挂载 xterm；重放该会话自己的缓存历史，避免回来后空白。
                    // TerminalView 只在初始化时重放，实时输出仍由当前 PTY 直接写入。
                    replayHistory
                    sessionId={activeSession.id}
                  />
                )}
              </div>
              {activeSession.agent !== 'gui' && readingView && <div className="terminal-slot"><SessionReadingView
                agent={activeSession.agent}
                cliSessionId={activeSession.cliSessionId}
                cwd={activeSession.cwd}
                history={renderedActiveHistory}
              /></div>}
            </div>

            {activeSession.error && (
              <div className="terminal-error recovery-error">
                <div>
                  <strong>会话恢复失败</strong>
                  <span>{activeSession.error}</span>
                </div>
                {canCreateReplacementSession(activeSession) && (
                  <button className="primary-button" onClick={() => void restartFailedSession(activeSession)} type="button">
                    在此重启新会话
                  </button>
                )}
              </div>
            )}

            <div className="terminal-composer-shell" ref={composerAssistRootRef}>
              <ComposerResizeHandle height={composerHeight} onHeightChange={setComposerHeight} />
              {composerAssistQuery && composerAssistMatches.length > 0 && (
                <ComposerAssistPopover
                  highlightedIndex={composerAssistHighlighted}
                  items={composerAssistMatches}
                  onPick={(item) => insertComposerAssistItem(item, true)}
                />
              )}
              <div className="terminal-composer">
                <div className="terminal-composer-box">
                  <textarea
                    aria-label="发送到当前终端"
                    onChange={(event) => {
                      if (!activeSession) {
                        return;
                      }
                      if (speechRecordingRef.current?.sessionId === activeSession.id && !applyingSpeechTranscriptRef.current) {
                        void stopSpeechInput();
                      }
                      setComposerDraft(activeSession.id, event.target.value, {
                        recordUndo: true,
                        selection: {
                          start: event.currentTarget.selectionStart,
                          end: event.currentTarget.selectionEnd,
                        },
                        undoKind: getComposerInputUndoKind(event.nativeEvent),
                      });
                      recordComposerSelection(activeSession.id, event.currentTarget);
                      updateComposerAssist(event.currentTarget);
                    }}
                    onClick={(event) => {
                      if (!activeSession) {
                        return;
                      }
                      recordComposerSelection(activeSession.id, event.currentTarget);
                      updateComposerAssist(event.currentTarget);
                    }}
                    onFocus={(event) => {
                      if (!activeSession) {
                        return;
                      }
                      recordComposerSelection(activeSession.id, event.currentTarget);
                      updateComposerAssist(event.currentTarget);
                    }}
                    onKeyDown={handleComposerKeyDown}
                    onKeyUp={(event) => {
                      if (!activeSession) {
                        return;
                      }
                      recordComposerSelection(activeSession.id, event.currentTarget);
                      updateComposerAssistFromKeyUp(event);
                    }}
                    onSelect={(event) => {
                      if (!activeSession) {
                        return;
                      }
                      recordComposerSelection(activeSession.id, event.currentTarget);
                      updateComposerAssist(event.currentTarget);
                    }}
                    placeholder="随心输入，输入 / 或 $ 唤起命令和 Skill"
                    ref={composerTextareaRef}
                    style={{ height: `${composerHeight}px` }}
                    value={composer}
                  />
                  <div className="terminal-composer-footer">
                    <div className="terminal-composer-left-actions">
                      <div className="composer-add-menu-wrap" ref={composerAddMenuRootRef}>
                        <button
                          aria-expanded={composerAddMenuOpen}
                          aria-haspopup="menu"
                          aria-label="添加上下文"
                          className="composer-inline-button"
                          onClick={(event) => openComposerAddMenu(event.currentTarget)}
                          type="button"
                          title="添加上下文"
                        >
                          +
                        </button>
                        {composerAddMenuOpen && (
                          <div
                            aria-label="添加上下文菜单"
                            className="composer-add-menu"
                            role="menu"
                            style={composerAddMenuPosition ? { bottom: composerAddMenuPosition.bottom, left: composerAddMenuPosition.left } : undefined}
                          >
                            <button aria-label="插入当前文档" onClick={() => void insertCurrentDocument()} role="menuitem" type="button">
                              <strong>当前文档</strong>
                              <span>插入正在查看的完整文档内容</span>
                            </button>
                            <button aria-label="插入选中文档内容" onClick={insertSelectedDocumentText} role="menuitem" type="button">
                              <strong>选中文档内容</strong>
                              <span>插入页面里鼠标选中的文本</span>
                            </button>
                            <button aria-label="插入路径" onClick={openContextPathDialog} role="menuitem" type="button">
                              <strong>路径</strong>
                              <span>插入文件、文件夹、压缩包等本地路径</span>
                            </button>
                            <button aria-label="插入剪贴板" onClick={() => void insertClipboardContext()} role="menuitem" type="button">
                              <strong>剪贴板</strong>
                              <span>插入系统剪贴板中的文本</span>
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        aria-label={speechRecording?.sessionId === activeSession.id
                          ? speechRecording.status === 'stopping' ? speechRecording.statusMessage ?? '正在转写语音' : '停止语音输入'
                          : '开始语音输入'}
                        className={speechRecording?.sessionId === activeSession.id ? 'composer-inline-button composer-speech-button recording' : 'composer-inline-button composer-speech-button'}
                        disabled={speechRecording?.status === 'stopping'}
                        onClick={() => void toggleSpeechInput()}
                        title={speechRecording?.sessionId === activeSession.id
                          ? speechRecording.status === 'stopping' ? speechRecording.statusMessage ?? '正在将录音转换为文字' : '停止并转换为文字'
                          : '开始语音输入'}
                        type="button"
                      >
                        {speechRecording?.sessionId === activeSession.id ? <MicOff size={16} /> : <Mic size={16} />}
                        <span>{speechRecording?.sessionId === activeSession.id
                          ? speechRecording.status === 'stopping' ? speechRecording.statusMessage ?? '转写中' : '停止'
                          : '语音'}</span>
                      </button>
                      <button
                        aria-label="Skill / Agent / 命令"
                        className={composerAssistPanelOpen ? 'composer-inline-button composer-assist-button active' : 'composer-inline-button composer-assist-button'}
                        onClick={() => setComposerAssistPanelOpen((current) => !current)}
                        title="Skill / Agent / 命令"
                        type="button"
                      >
                        <Command size={16} />
                        <span>Skill</span>
                      </button>
                    </div>
                    <div className="terminal-composer-right-actions">
                      <span className="composer-agent-label">{agentDisplayName(activeSession.agent)}</span>
                      <button
                        aria-label="发送"
                        className="composer-send-button"
                        disabled={activeSession.agent === 'gui' && guiReplyingIds.has(activeSession.id)}
                        onClick={() => void sendComposer()}
                        title="发送"
                        type="button"
                      >
                        <Send size={17} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              {composerAssistPanelOpen && (
                <ComposerAssistPanel
                  activeSource={composerAssistPanelSource}
                  items={composerAssistPanelItems}
                  onChangeSearch={setComposerAssistPanelSearch}
                  onChangeSource={setComposerAssistPanelSource}
                  onClose={() => setComposerAssistPanelOpen(false)}
                  onPick={(item) => insertComposerAssistItem(item, false)}
                  search={composerAssistPanelSearch}
                  sources={composerAssistSources}
                />
              )}
            </div>
          </>
        ) : (
          <div className="workbench-empty">
            <Bot size={32} />
            <span>新建一个 Claude Code 或 Codex 会话</span>
            <button className="primary-button" onClick={() => setCreatingSessionGroupId(null)} type="button"><Plus size={16} />新建会话</button>
          </div>
        )}
      </div>

      {!sidePanelCollapsed && (
        <>
          <div
            aria-label="调整工具列表宽度"
            className="layout-resize-divider tool-resize-divider"
            onPointerDown={(event) => startHorizontalResize('tools', event)}
            role="separator"
          />

          <div className={sidePanelMode === 'tools' && featureWindows.length > 0 ? 'ai-side-panel has-feature-windows' : 'ai-side-panel'}>
            {sidePanelMode === 'tools' ? (
              <>
                <AiToolPanel
                  detachedFeatureIds={detachedFeatureIds}
                  features={features}
                  onCollapse={() => setSidePanelCollapsed(true)}
                  onDelete={onDeleteFeature}
                  onDetach={(feature, startDragging) => void detachTool(feature, startDragging)}
                  onEdit={onEditFeature}
                  onInvoke={invokeTool}
                  onPrefsChange={onPrefsChange}
                  prefs={prefs}
                />
                {featureWindows.length > 0 && (
                  <>
                    <div
                      aria-label="调整工具列表和功能窗口列表宽度"
                      className="layout-resize-divider feature-window-resize-divider"
                      onPointerDown={startFeaturePanelResize}
                      role="separator"
                    />
                    <FeatureWindowList
                      groups={activeGroups}
                      onBindSession={bindFeatureWindowSession}
                      onClose={closeFeatureWindow}
                      onCreateSession={createSessionForFeatureWindow}
                      onExecuteStep={executeFeatureWindowStep}
                      onToggleDone={toggleFeatureWindowStepDone}
                      onToggle={toggleFeatureWindow}
                      sessions={activeSessions}
                      windows={featureWindows}
                    />
                  </>
                )}
              </>
            ) : sidePanelMode === 'documents' ? (
              <DocumentPanel
                onCollapse={() => setSidePanelCollapsed(true)}
                onError={onMessage}
                onInsertText={insertToolText}
                onSnapshotChange={setDocumentSnapshot}
                openPathRequest={documentOpenPathRequest}
              />
            ) : sidePanelMode === 'git' ? (
              <GitPanel
                cwd={activeSession?.cwd ?? null}
                onCollapse={() => setSidePanelCollapsed(true)}
                onError={onMessage}
                onInsertText={insertToolText}
              />
            ) : (
              <ChangeTrackerPanel
                cwd={activeSession?.cwd ?? null}
                onCollapse={() => setSidePanelCollapsed(true)}
                onError={onMessage}
                onInsertText={insertToolText}
              />
            )}
          </div>
        </>
      )}

      <aside className="ai-tool-dock fixed-end-dock vertical-dock" aria-label="右侧插件栏">
        <button
          aria-label={sidePanelMode === 'documents' && !sidePanelCollapsed ? '收起文档目录' : '显示文档目录'}
          className={sidePanelMode === 'documents' && !sidePanelCollapsed ? 'ai-tool-dock-button active' : 'ai-tool-dock-button'}
          onClick={() => toggleSidePanel('documents')}
          title="文档目录"
          type="button"
        >
          📁
        </button>
        <button
          aria-label={sidePanelMode === 'tools' && !sidePanelCollapsed ? '收起工具箱' : '显示工具箱'}
          className={sidePanelMode === 'tools' && !sidePanelCollapsed ? 'ai-tool-dock-button active' : 'ai-tool-dock-button'}
          onClick={() => toggleSidePanel('tools')}
          title="工具箱"
          type="button"
        >
          🧰
        </button>
        <button
          aria-label={sidePanelMode === 'git' && !sidePanelCollapsed ? '收起 Git 变更' : '显示 Git 变更'}
          className={sidePanelMode === 'git' && !sidePanelCollapsed ? 'ai-tool-dock-button active' : 'ai-tool-dock-button'}
          onClick={() => toggleSidePanel('git')}
          title="Git 变更"
          type="button"
        >
          <GitCompare size={17} />
        </button>
        <button
          aria-label={sidePanelMode === 'tracker' && !sidePanelCollapsed ? '收起实时追踪' : '显示实时追踪'}
          className={sidePanelMode === 'tracker' && !sidePanelCollapsed ? 'ai-tool-dock-button active' : 'ai-tool-dock-button'}
          onClick={() => toggleSidePanel('tracker')}
          title="实时追踪"
          type="button"
        >
          <FileSearch size={17} />
        </button>
      </aside>

      <GlobalSearchOverlay
        documentSnapshot={documentSnapshot}
        features={features}
        groups={activeGroups}
        loadSessionHistory={loadSearchSessionHistory}
        onClose={() => onGlobalSearchOpenChange?.(false)}
        onOpenResult={openGlobalSearchResult}
        open={globalSearchOpen}
        sessions={activeSessions}
      />

      {creatingSessionGroupId !== undefined && (
        <NewSessionDialog
          groups={activeGroups}
          initialAgent={creatingSessionPreset?.agent}
          initialModel={creatingSessionPreset?.model}
          initialCwd={creatingSessionPreset?.cwd ?? lastSessionCwd}
          initialGroupId={creatingSessionGroupId}
          initialGuiAgent={creatingSessionPreset?.guiAgent}
          initialGuiModel={creatingSessionPreset?.guiModel}
          initialName={creatingSessionPreset?.name}
          initialAgentConfig={creatingSessionPreset?.agentConfig}
          onCancel={() => { setCreatingSessionPreset(null); setCreatingSessionGroupId(undefined); }}
          onCreate={async (input) => { await createSession(input); setCreatingSessionPreset(null); }}
          onError={onMessage}
        />
      )}
      {agentPickerGroupId !== undefined && <AgentPickerDialog onCancel={() => setAgentPickerGroupId(undefined)} onSelect={createSessionFromAgent} />}
      {creatingGroup && (
        <SessionGroupDialog groups={activeGroups} mode="create" onCancel={() => setCreatingGroup(false)} onSave={createGroup} />
      )}
      {renamingGroup && (
        <SessionGroupDialog group={renamingGroup} groups={activeGroups} mode="rename" onCancel={() => setRenamingGroup(null)} onSave={renameGroup} />
      )}
      {deletingGroup && (
        <DeleteSessionGroupDialog
          groupName={deletingGroup.name}
          onCancel={() => setDeletingGroup(null)}
          onConfirm={() => deleteGroup(deletingGroup)}
          runningCount={sessions.filter((session) => session.groupId === deletingGroup.id && (session.status === 'running' || session.status === 'starting')).length}
          sessionCount={sessions.filter((session) => session.groupId === deletingGroup.id).length}
        />
      )}
      {permanentlyDeletingGroup && (
        <DeleteSessionGroupDialog
          groupName={permanentlyDeletingGroup.name}
          onCancel={() => setPermanentlyDeletingGroup(null)}
          onConfirm={() => permanentlyDeleteGroup(permanentlyDeletingGroup)}
          permanent
          runningCount={0}
          sessionCount={sessions.filter((session) => session.groupId === permanentlyDeletingGroup.id).length}
        />
      )}
      {renamingSession && (
        <RenameSessionDialog
          name={renamingSession.name}
          onCancel={() => setRenamingSession(null)}
          onSave={(name) => renameSession(renamingSession, name)}
        />
      )}
      {movingSession && (
        <MoveSessionDialog
          currentGroupId={movingSession.groupId}
          groups={activeGroups}
          onCancel={() => setMovingSession(null)}
          onSave={moveSessionToGroup}
          sessionName={movingSession.name}
        />
      )}
      {deletingSession && (
        <DeleteSessionDialog
          name={deletingSession.name}
          onCancel={() => setDeletingSession(null)}
          onConfirm={() => deleteSession(deletingSession)}
        />
      )}
      {contextPathDialogOpen && (
        <ContextPathDialog
          onCancel={() => setContextPathDialogOpen(false)}
          onChange={setContextPathDraft}
          onChooseDirectory={() => void chooseAndInsertContextPath('directory')}
          onChooseFile={() => void chooseAndInsertContextPath('file')}
          onSubmit={() => insertPathText(contextPathDraft)}
          value={contextPathDraft}
        />
      )}
      {pendingFeatureWindow && (
        <FeatureWindowBindDialog
          featureName={pendingFeatureWindow.name}
          groupId={featureWindowGroupId}
          groupMode={featureWindowGroupMode}
          groupName={featureWindowGroupName}
          groups={activeGroups}
          onCancel={() => setPendingFeatureWindow(null)}
          onChangeGroupId={setFeatureWindowGroupId}
          onChangeGroupMode={setFeatureWindowGroupMode}
          onChangeGroupName={setFeatureWindowGroupName}
          onCreate={createFeatureWindow}
        />
      )}
    </section>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isComposerUndoKey(event: KeyboardEvent<HTMLTextAreaElement>) {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
}

function isComposerRedoKey(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (!(event.metaKey || event.ctrlKey)) {
    return false;
  }
  const key = event.key.toLowerCase();
  return (event.shiftKey && key === 'z') || key === 'y';
}

function getComposerInputUndoKind(event: Event) {
  if (event instanceof InputEvent) {
    if (event.inputType.includes('delete')) {
      return 'delete';
    }
    if (event.inputType.includes('FromPaste') || event.inputType.includes('FromDrop')) {
      return 'paste';
    }
    if (event.inputType.includes('FromCut')) {
      return 'cut';
    }
    if (event.inputType === 'insertLineBreak') {
      return 'line-break';
    }
  }
  return 'insert';
}

function toCommandSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'tool';
}

function getSlashCommandQuery(value: string, cursor: number): SlashCommandQuery | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(?:^|\s)([/$][A-Za-z0-9_\-\u4e00-\u9fa5]*)$/);
  if (!match) {
    return null;
  }
  const token = match[1];
  return {
    end: cursor,
    start: cursor - token.length,
    token,
  };
}

function filterComposerAssistItems(items: ComposerAssistItem[], query: string, source = 'all') {
  const normalized = query.replace(/^[/$]/, '').trim().toLowerCase();
  return items.filter((item) => {
    const sourceMatched = source === 'all' || item.source === source;
    if (!sourceMatched) {
      return false;
    }
    if (!normalized) {
      return true;
    }
    return `${item.command} ${item.source} ${item.kind} ${item.description}`.toLowerCase().includes(normalized);
  });
}

function formatFileContext(file: DocumentFileContent, label: string) {
  return `${label}：${file.path}\n\n内容：\n${file.content}`;
}

function loadDocumentPanelState(): { rootPath: string; selectedPath: string | null } | null {
  try {
    const raw = localStorage.getItem(DOCUMENT_PANEL_STATE_KEY);
    if (!raw) {
      return null;
    }
    const value = JSON.parse(raw) as Partial<{ rootPath: string; selectedPath: string | null }>;
    return typeof value.rootPath === 'string' ? { rootPath: value.rootPath, selectedPath: value.selectedPath ?? null } : null;
  } catch {
    return null;
  }
}

function insertTextIntoDraft(
  draft: string,
  text: string,
  selection?: ComposerSelection,
  options: InsertTextOptions = {},
): { cursor: number; value: string } {
  if (
    selection &&
    selection.start >= 0 &&
    selection.end >= selection.start &&
    selection.end <= draft.length
  ) {
    if (options.appendWhenAtEnd && selection.start === draft.length && selection.end === draft.length) {
      const prefix = draft.length === 0 || draft.endsWith('\n') ? '' : '\n';
      const value = `${draft}${prefix}${text}`;
      return { cursor: value.length, value };
    }
    const value = `${draft.slice(0, selection.start)}${text}${draft.slice(selection.end)}`;
    return { cursor: selection.start + text.length, value };
  }
  const prefix = draft.length === 0 || draft.endsWith('\n') ? '' : '\n';
  const value = `${draft}${prefix}${text}`;
  return { cursor: value.length, value };
}

function currentArchive(
  groups: AiSessionGroup[],
  sessions: AiSessionRecord[],
  featureWindowStates: FeatureWindowStepState[],
): AiWorkspaceArchive {
  return {
    version: 2,
    groups,
    sessions: sessions.map(toPersistedSession),
    featureWindowStates,
  };
}

function hasTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function createGeneration() {
  return globalThis.crypto?.randomUUID?.() ?? `pty-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadLastSessionCwd() {
  try {
    return window.localStorage.getItem(LAST_SESSION_CWD_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

function rememberLastSessionCwd(cwd: string) {
  try {
    window.localStorage.setItem(LAST_SESSION_CWD_KEY, cwd.trim());
  } catch {
    // 本地存储不可用时，当前运行周期内的 React 状态仍会保留目录。
  }
}

function canCreateReplacementSession(session: AiSessionRecord) {
  return session.status === 'error' || session.status === 'stopped';
}

function parseRecoveryErrorFromOutput(session: AiSessionRecord, output: string) {
  const activeWriter = output.match(/thread\s+([0-9a-f-]+)\s+already has an active writer/i);
  if (activeWriter) {
    return formatSessionRecoveryError(session, `thread ${activeWriter[1]} already has an active writer`);
  }
  const match = output.match(/No conversation found with session ID:\s*([0-9a-f-]+)/i);
  if (!match) {
    return undefined;
  }
  return formatSessionRecoveryError(session, `No conversation found with session ID: ${match[1]}`);
}

function formatSessionRecoveryError(session: AiSessionRecord | undefined, error: string) {
  const normalized = error.trim();
  if (normalized.includes('检测到仍在运行的 codex resume 进程')) {
    const sessionId = normalized.match(/Codex 会话\s+([0-9a-f-]+)/i)?.[1] ?? session?.cliSessionId;
    const pids = normalized.match(/PID\s+([0-9, ]+)/i)?.[1]?.trim();
    return `原因：应用在本机进程列表中检测到会话${sessionId ? ` ${sessionId}` : ''}仍有 codex resume 进程${pids ? `（PID ${pids}）` : ''}。它可能来自其他终端，也可能是本应用尚未退出的旧进程。修复：关闭对应进程后再次恢复原会话；也可以点击“在此重启新会话”，在当前目录启动新的 Codex，并用新 ID 覆盖当前列表项。`;
  }
  if (normalized.includes('already has an active writer') || normalized.includes('正在其他终端运行')) {
    const sessionId = normalized.match(/(?:thread|Codex 会话)\s+([0-9a-f-]+)/i)?.[1] ?? session?.cliSessionId;
    return `原因：Codex 报告会话${sessionId ? ` ${sessionId}` : ''}的 writer 尚未释放。无法仅凭该错误判断是其他终端、Codex Desktop，还是本应用的残留进程。修复：可再次点击顶部“重新启动”恢复原会话；也可以点击“在此重启新会话”，在当前目录启动新的 Codex，并用新 ID 覆盖当前列表项。`;
  }
  if (session?.agent === 'codex' && (
    normalized.includes('缺少 CLI 会话 ID') ||
    normalized.includes('Codex 恢复会话缺少 CLI 会话 ID')
  )) {
    return '原因：该 Codex 会话没有捕获到 CLI session id，不能准确恢复到原会话。修复：点击“在此重启新会话”，会在相同目录直接重启并覆盖当前会话。';
  }
  if (normalized.includes('No conversation found with session ID:')) {
    const sessionId = normalized.split('No conversation found with session ID:')[1]?.trim();
    const agentName = session?.agent === 'codex' ? 'Codex' : 'Claude Code';
    return `原因：CLI 没有找到会话 ID${sessionId ? ` ${sessionId}` : ''} 对应的会话，可能已被清理、目录不匹配或本机没有该会话记录。修复：点击“在此重启新会话”，会在相同目录直接重启并覆盖当前会话。`;
  }
  if (normalized.includes('恢复会话缺少 CLI 会话 ID')) {
    const agentName = session?.agent === 'codex' ? 'Codex' : 'Claude Code';
    return `原因：该 ${agentName} 会话缺少 CLI session id，不能准确恢复。修复：点击“在此重启新会话”，会在相同目录直接重启并覆盖当前会话。`;
  }
  return normalized || '会话恢复失败，请点击“在此重启新会话”在相同目录直接重新启动。';
}

interface FeatureWindowListProps {
  groups: AiSessionGroup[];
  sessions: AiSessionRecord[];
  windows: FeatureWindow[];
  onBindSession: (windowId: string, sessionId: string | null) => void;
  onClose: (windowId: string) => void;
  onCreateSession: (window: FeatureWindow) => void;
  onExecuteStep: (window: FeatureWindow, step: string) => void;
  onToggleDone: (windowId: string, index: number) => void;
  onToggle: (windowId: string) => void;
}

function FeatureWindowList({
  groups,
  onBindSession,
  onClose,
  onCreateSession,
  onExecuteStep,
  onToggleDone,
  onToggle,
  sessions,
  windows,
}: FeatureWindowListProps) {
  return (
    <aside aria-label="功能窗口列表" className="feature-window-panel">
      <header className="feature-window-panel-header">
        <strong>功能窗口列表</strong>
      </header>
      <div className="feature-window-list">
        {windows.map((window) => {
          const groupSessions = sessions.filter((session) => session.groupId === window.groupId);
          const groupName = window.groupId
            ? groups.find((group) => group.id === window.groupId)?.name ?? '未知分组'
            : '未分组';
          return (
            <article className={window.collapsed ? 'feature-window-card collapsed' : 'feature-window-card'} key={window.id}>
              <header>
                <button
                  aria-label={window.collapsed ? `展开${window.name}` : `收起${window.name}`}
                  className="icon-button"
                  onClick={() => onToggle(window.id)}
                  title={window.collapsed ? '展开窗口' : '收起窗口'}
                  type="button"
                >
                  {window.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </button>
                <div>
                  <strong>{window.name}</strong>
                  <span>绑定分组：{groupName}</span>
                </div>
                <button aria-label={`关闭${window.name}`} className="icon-button" onClick={() => onClose(window.id)} title="关闭窗口" type="button">
                  <X size={16} />
                </button>
              </header>
              {!window.collapsed && (
                <div className="feature-window-body">
                  <div className="feature-window-session">
                    <label>
                      绑定会话
                      <select
                        aria-label={`${window.name} 绑定会话`}
                        onChange={(event) => onBindSession(window.id, event.target.value || null)}
                        value={window.sessionId ?? ''}
                      >
                        <option value="">未绑定</option>
                        {groupSessions.map((session) => (
                          <option key={session.id} value={session.id}>{session.name}</option>
                        ))}
                      </select>
                    </label>
                    <button className="small-button" onClick={() => onCreateSession(window)} type="button">
                      在该分组新建会话
                    </button>
                  </div>
                  {window.steps.map((step, index) => {
                    const done = window.done[index] === true;
                    return (
                    <section className="feature-window-step" key={`${window.id}-${index}`}>
                      <div className="feature-window-step-title">
                        <span>步骤 {index + 1}</span>
                        {done && <span className="done-badge">完成</span>}
                      </div>
                      <pre>{step}</pre>
                      <div className="feature-window-step-actions">
                        <button className="small-button" onClick={() => onExecuteStep(window, step)} type="button">
                          执行
                        </button>
                        <button aria-label={`执行步骤 ${index + 1}`} className="sr-only-action" onClick={() => onExecuteStep(window, step)} type="button">
                          执行步骤 {index + 1}
                        </button>
                        <button
                          aria-label={done ? `取消完成步骤 ${index + 1}` : `完成步骤 ${index + 1}`}
                          className="small-button"
                          onClick={() => onToggleDone(window.id, index)}
                          type="button"
                        >
                          {done ? '取消完成' : '完成'}
                        </button>
                      </div>
                    </section>
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </aside>
  );
}

interface ComposerAssistPopoverProps {
  highlightedIndex: number;
  items: ComposerAssistItem[];
  onPick: (item: ComposerAssistItem) => void;
}

function ComposerAssistPopover({ highlightedIndex, items, onPick }: ComposerAssistPopoverProps) {
  const highlightedOptionRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const highlightedOption = highlightedOptionRef.current;
    if (highlightedOption && typeof highlightedOption.scrollIntoView === 'function') {
      highlightedOption.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  return (
    <div className="composer-assist-popover" role="listbox">
      <div className="composer-assist-head">
        <span>匹配 Skill / 命令</span>
        <span>↑↓ 选择 · Enter 插入 · Esc 关闭</span>
      </div>
      <div className="composer-assist-list">
        {items.map((item, index) => (
          <button
            aria-selected={index === highlightedIndex}
            className={index === highlightedIndex ? 'composer-assist-row active' : 'composer-assist-row'}
            key={item.id}
            onClick={() => onPick(item)}
            onMouseDown={(event) => event.preventDefault()}
            role="option"
            ref={index === highlightedIndex ? highlightedOptionRef : undefined}
            type="button"
          >
            <span className="composer-assist-command">{item.command}</span>
            <span className="composer-assist-source">({item.source})</span>
            <span className="composer-assist-desc">{item.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

interface ComposerAssistPanelProps {
  activeSource: string;
  items: ComposerAssistItem[];
  onChangeSearch: (value: string) => void;
  onChangeSource: (value: string) => void;
  onClose: () => void;
  onPick: (item: ComposerAssistItem) => void;
  search: string;
  sources: string[];
}

function ComposerAssistPanel({
  activeSource,
  items,
  onChangeSearch,
  onChangeSource,
  onClose,
  onPick,
  search,
  sources,
}: ComposerAssistPanelProps) {
  return (
    <section aria-label="Skill 和命令列表" className="composer-assist-panel">
      <header className="composer-assist-panel-head">
        <div>
          <strong>Skill / Agent / 命令</strong>
          <span>点击插入到当前输入框光标处</span>
        </div>
        <button aria-label="关闭 Skill 列表" className="icon-button" onClick={onClose} type="button">
          <X size={15} />
        </button>
      </header>
      <div className="composer-assist-panel-tools">
        <input
          aria-label="搜索 Skill"
          onChange={(event) => onChangeSearch(event.target.value)}
          placeholder="搜索名称、来源或简介"
          value={search}
        />
        <div className="composer-assist-source-tabs">
          <button className={activeSource === 'all' ? 'active' : ''} onClick={() => onChangeSource('all')} type="button">
            全部
          </button>
          {sources.map((source) => (
            <button className={activeSource === source ? 'active' : ''} key={source} onClick={() => onChangeSource(source)} type="button">
              {source}
            </button>
          ))}
        </div>
      </div>
      <div className="composer-assist-panel-list">
        {items.length > 0 ? (
          items.map((item) => (
            <button className="composer-assist-row panel-row" key={item.id} onClick={() => onPick(item)} type="button">
              <span className="composer-assist-command">{item.command}</span>
              <span className="composer-assist-source">({item.source})</span>
              <span className="composer-assist-kind">{item.kind}</span>
              <span className="composer-assist-desc">{item.description}</span>
            </button>
          ))
        ) : (
          <div className="composer-assist-empty">没有匹配项</div>
        )}
      </div>
    </section>
  );
}

interface ContextPathDialogProps {
  onCancel: () => void;
  onChange: (value: string) => void;
  onChooseDirectory: () => void;
  onChooseFile: () => void;
  onSubmit: () => void;
  value: string;
}

function ContextPathDialog({
  onCancel,
  onChange,
  onChooseDirectory,
  onChooseFile,
  onSubmit,
  value,
}: ContextPathDialogProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onCancel();
      }
    }}>
      <form aria-labelledby="context-path-title" aria-modal="true" className="session-dialog context-path-dialog" onSubmit={submit} role="dialog">
        <header>
          <div>
            <h2 id="context-path-title">插入路径</h2>
            <p>支持文件、文件夹、文档、压缩包等任意本地路径。</p>
          </div>
          <button aria-label="关闭插入路径" className="icon-button" onClick={onCancel} type="button">
            <X size={15} />
          </button>
        </header>
        <label>
          路径
          <input
            autoFocus
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
              }
            }}
            placeholder="/tmp/agentbox-project/requirements/..."
            value={value}
          />
        </label>
        <div className="context-path-actions">
          <button className="ghost-button" onClick={onChooseFile} type="button">选择文件</button>
          <button className="ghost-button" onClick={onChooseDirectory} type="button">选择目录</button>
        </div>
        <footer>
          <button className="ghost-button" onClick={onCancel} type="button">取消</button>
          <button className="primary-button" type="submit">插入路径</button>
        </footer>
      </form>
    </div>
  );
}

interface GuiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking?: string;
  timestamp: number;
}

function GuiSessionView({
  composerHeight,
  cwd,
  guiAgent,
  history,
  model,
  name,
  onChangeAgent,
  onChangeModel,
  onCopy,
  replying,
}: {
  composerHeight: number;
  cwd: string;
  guiAgent: GuiAgentType;
  history: string;
  model: GuiModelType;
  name: string;
  onChangeAgent: (agent: GuiAgentType) => void;
  onChangeModel: (model: GuiModelType) => void;
  onCopy: (text: string) => void;
  replying: boolean;
}) {
  const messages = parseGuiMessages(history);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    if (typeof list.scrollTo === 'function') {
      list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    } else {
      list.scrollTop = list.scrollHeight;
    }
  }, [history, replying, composerHeight]);

  const modelOptions = GUI_MODEL_OPTIONS[guiAgent];
  const selectedModel = modelOptions.some((item) => item.id === model) ? model : defaultGuiModel(guiAgent);

  return (
    <section aria-label="GUI 会话" className="gui-session-view">
      <header className="gui-session-hero">
        <div>
          <span>{`GUI 会话 · ${guiAgent === 'claude' ? 'Claude' : 'Codex'} · ${selectedModel}`}</span>
          <strong>{name}</strong>
          <small>{cwd}</small>
        </div>
        <div className="gui-selector-row">
          <label>
            Agent
            <select
              aria-label="GUI Agent"
              onChange={(event) => onChangeAgent(event.target.value as GuiAgentType)}
              value={guiAgent}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label>
            Model
            <select aria-label="GUI Model" onChange={(event) => onChangeModel(event.target.value)} value={selectedModel}>
              {modelOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </div>
      </header>
      <div className="gui-message-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="gui-empty-state">
            <strong>随时输入任务、页面、文件或链接</strong>
            <span>这里会以客户端式记录展示你的 GUI 会话内容，右侧工具箱和文档上下文都可以插入到下方输入框。</span>
          </div>
        ) : (
          messages.map((message) => (
            <article className={`gui-message ${message.role}`} key={message.id}>
              <div className="gui-message-actions">
                <time>{formatGuiMessageTime(message.timestamp)}</time>
                <button aria-label="复制消息" className="gui-copy-button" onClick={() => onCopy(message.text)} title="复制" type="button">
                  <Copy size={14} />
                </button>
              </div>
              {message.thinking && (
                <details className="gui-thinking">
                  <summary>思考过程</summary>
                  <p>{message.thinking}</p>
                </details>
              )}
              {message.role === 'assistant'
                ? <div className="gui-markdown">{renderGuiMarkdown(message.text)}</div>
                : <p>{message.text}</p>}
            </article>
          ))
        )}
        {replying && (
          <article className="gui-message assistant pending">
            <div className="gui-message-actions"><time>正在回复</time></div>
            <details className="gui-thinking" open>
              <summary>思考过程</summary>
              <p>已收到输入，正在调用 {guiAgent === 'claude' ? 'Claude' : 'Codex'} / {selectedModel} 生成回复。</p>
            </details>
            <p>模型处理中...</p>
          </article>
        )}
      </div>
    </section>
  );
}

function parseGuiMessages(history: string): GuiMessage[] {
  return history
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        const value = JSON.parse(line) as Partial<GuiMessage>;
        if (
          typeof value.id === 'string' &&
          (value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
          typeof value.text === 'string' &&
          typeof value.timestamp === 'number'
        ) {
          return { ...value, thinking: typeof value.thinking === 'string' ? value.thinking : undefined } as GuiMessage;
        }
      } catch {
        // Older or manually edited GUI history falls back to plain text below.
      }
      return {
        id: `legacy-${index}`,
        role: 'system' as const,
        text: line,
        timestamp: Date.now(),
      };
    });
}

function renderGuiMarkdown(text: string): ReactNode[] {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += index < lines.length ? 1 : 0;
      blocks.push(
        <pre className="gui-markdown-code" key={`code-${index}`}>
          {fence[1] && <span>{fence[1]}</span>}
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    if (isMarkdownTable(lines, index)) {
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index])) {
          rows.push(splitMarkdownTableRow(lines[index]));
        }
        index += 1;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div className="gui-markdown-table-wrap" key={`table-${index}`}>
          <table className="gui-markdown-table">
            {head && <thead><tr>{head.map((cell, cellIndex) => <th key={cellIndex}>{renderGuiInlineMarkdown(cell)}</th>)}</tr></thead>}
            <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderGuiInlineMarkdown(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level + 1, 4)}` as 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={`heading-${index}`}>{renderGuiInlineMarkdown(heading[2])}</Tag>);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderGuiInlineMarkdown(item)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{renderGuiInlineMarkdown(item)}</li>)}</ol>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index]) &&
      !/^#{1,4}\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !isMarkdownTable(lines, index)
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`p-${index}`}>{renderGuiInlineMarkdown(paragraph.join('\n'))}</p>);
  }

  return blocks;
}

function renderGuiInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(<code className="gui-inline-code" key={`${match.index}-code`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<strong key={`${match.index}-strong`}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function isMarkdownTable(lines: string[], index: number) {
  return (
    index + 1 < lines.length &&
    /^\s*\|.*\|\s*$/.test(lines[index]) &&
    /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])
  );
}

function splitMarkdownTableRow(row: string) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function formatGuiMessageTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp);
}

function agentDisplayName(agent: AgentType) {
  if (agent === 'claude') return 'Claude Code';
  if (agent === 'codex') return 'Codex';
  if (agent === 'gui') return 'GUI';
  return '终端';
}

function normalizeGuiAgentFromSession(session: AiSessionRecord): GuiAgentType {
  if (session.guiAgent === 'codex' || session.guiAgent === 'claude') {
    return session.guiAgent;
  }
  return session.guiModel === 'codex' ? 'codex' : 'claude';
}

function resolveGuiModel(session: AiSessionRecord): string {
  const guiAgent = session.guiAgent ?? normalizeGuiAgentFromSession(session);
  const model = session.guiModel;
  return model && GUI_MODEL_OPTIONS[guiAgent].some((item) => item.id === model)
    ? model
    : defaultGuiModel(guiAgent);
}

function buildAgentPrompt(config: AgentSessionConfig | undefined, prompt: string): string {
  const instruction = buildAgentInstructionBlock(config);
  if (!instruction) return prompt;
  return `${instruction}\n\n[用户任务]\n${prompt}`;
}

function buildAgentContext(config: AgentSessionConfig | undefined): string | undefined {
  return buildAgentInstructionBlock(config);
}

function buildAgentInstructionBlock(config: AgentSessionConfig | undefined): string | undefined {
  if (!config || (!config.model && !config.systemPrompt && !config.behaviorRules?.length && !config.skills?.length && !config.knowledgeBases?.length && !config.mcps?.length)) return undefined;
  const sections = [
    '优先级：本配置是当前会话的最高优先级上下文。',
    config.agentName ? `Agent 名称：${config.agentName}` : '',
    config.agentId ? `Agent ID：${config.agentId}` : '',
    config.model ? `模型：${config.model}` : '',
    '执行原则：先按配置中的行为规则、系统提示词、Skill、知识库和 MCP 组织思路；只有在配置无法覆盖时，再向用户追问或泛化处理。',
    config.behaviorRules?.length ? `行为规则：\n${config.behaviorRules.map((rule) => `- ${rule}`).join('\n')}` : '',
    config.systemPrompt ? `角色与工作规则:\n${config.systemPrompt}` : '',
    config.skills?.length ? `可用 Skill：${config.skills.join(', ')}` : '',
    config.knowledgeBases?.length ? `参考知识库：${config.knowledgeBases.join(', ')}` : '',
    config.mcps?.length ? `可用 MCP：${config.mcps.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return `[Agent 配置]\n${sections}`;
}

interface FeatureWindowBindDialogProps {
  featureName: string;
  groupId: string | null;
  groupMode: 'existing' | 'new';
  groupName: string;
  groups: AiSessionGroup[];
  onCancel: () => void;
  onChangeGroupId: (groupId: string | null) => void;
  onChangeGroupMode: (mode: 'existing' | 'new') => void;
  onChangeGroupName: (name: string) => void;
  onCreate: () => void;
}

function FeatureWindowBindDialog({
  featureName,
  groupId,
  groupMode,
  groupName,
  groups,
  onCancel,
  onChangeGroupId,
  onChangeGroupMode,
  onChangeGroupName,
  onCreate,
}: FeatureWindowBindDialogProps) {
  return (
    <div className="modal-backdrop">
      <section aria-label="启动功能窗口" className="session-dialog" role="dialog">
        <h2>启动功能窗口</h2>
        <p>{featureName}</p>
        <fieldset>
          <legend>绑定方式</legend>
          <div className="segmented">
            <button
              className={groupMode === 'existing' ? 'active' : ''}
              disabled={groups.length === 0}
              onClick={() => onChangeGroupMode('existing')}
              type="button"
            >
              复用已有分组
            </button>
            <button className={groupMode === 'new' ? 'active' : ''} onClick={() => onChangeGroupMode('new')} type="button">
              新建分组
            </button>
          </div>
        </fieldset>
        {groupMode === 'existing' && groups.length > 0 ? (
          <label>
            会话分组
            <select
              aria-label="功能窗口绑定分组"
              onChange={(event) => onChangeGroupId(event.target.value || null)}
              value={groupId ?? groups[0]?.id ?? ''}
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>{group.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            新分组名称
            <input aria-label="新分组名称" onChange={(event) => onChangeGroupName(event.target.value)} value={groupName} />
          </label>
        )}
        <footer>
          <button onClick={onCancel} type="button">取消</button>
          <button className="primary-button" onClick={onCreate} type="button">创建窗口</button>
        </footer>
      </section>
    </div>
  );
}
