import { access, readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { JsonlSessionRepo, NodeExecutionEnv, type AgentHarnessEvent } from "@earendil-works/pi-agent-core/node";
import {
  CheckpointService,
  AUTOMATIC_CONTEXT_RECOVERY_MARKER,
  PiCodingLane,
  PiSolverLane,
  ProofBladeToolRuntime,
  RunRecoveryService,
  RunTelemetry,
  SingleAgentCtfLoop,
  createServices,
  fixtureTask,
  listFixtureProfiles,
  requiresClaimVerification,
  type AppServices,
  type AgentLanePort,
  type AgentOutcome,
  type HarnessEvent,
  type ModelProfileConfig,
  type ProofBladeConfig,
  type RunSnapshot,
  type SolverLaneFactory,
  type TaskContract,
} from "@proofblade/materials";
import type {
  ActiveRunInfo,
  AssistantTurnDebug,
  BootstrapData,
  ChatMessageDebug,
  ChatStreamEvent,
  PiSessionDebug,
  RunDetail,
  RunKind,
  RunListItem,
  ToolCallDebug,
  TokenUsage,
} from "./shared.js";
import { toolPresentation } from "./tool-presentation.js";

interface SessionEntryLike {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: unknown;
}

interface MessageLike {
  role?: string;
  content?: unknown;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
}

interface ContentLike {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  thinking?: string;
  arguments?: unknown;
}

const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
type CodingLaneFactory = (options: Parameters<typeof PiCodingLane.create>[0]) => Promise<AgentLanePort>;

export class DebugDataService {
  private readonly services: AppServices;
  private readonly active = new Map<string, ActiveRunInfo>();
  private readonly activeLanes = new Map<string, AgentLanePort>();
  private readonly chatTasks = new Set<Promise<void>>();
  private readonly solveTasks = new Map<string, { controller: AbortController; promise: Promise<unknown> }>();
  private readonly pauseRequests = new Set<string>();
  private readonly streamEmitters = new Map<string, (event: ChatStreamEvent) => void>();
  private readonly runListCache = new Map<string, { mtimeMs: number; item: RunListItem }>();
  private closing = false;
  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly root: string,
    private readonly config: ProofBladeConfig,
    private readonly configPath: string,
    private readonly createCodingLane: CodingLaneFactory = (options) => PiCodingLane.create(options),
    private readonly createSolverLane?: SolverLaneFactory,
  ) {
    this.services = createServices(root, config);
  }

  public updateModelProfile(profile: ModelProfileConfig): void {
    this.config.modelProfiles.executor = { ...profile, input: [...profile.input] };
  }

  public async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closing = true;
    this.closePromise = this.shutdown();
    return await this.closePromise;
  }

  private async shutdown(): Promise<void> {
    const aborts: Promise<unknown>[] = [];
    for (const [runId, lane] of this.activeLanes) {
      if (!this.solveTasks.has(runId)) aborts.push(Promise.resolve().then(() => lane.abort("GUI shutting down")));
    }
    for (const task of this.solveTasks.values()) task.controller.abort("GUI shutting down");
    const abortResults = await Promise.allSettled(aborts);
    const taskResults = await Promise.allSettled([
      ...this.chatTasks,
      ...[...this.solveTasks.values()].map((task) => task.promise),
    ]);
    const sandboxResult = await Promise.allSettled([this.services.sandbox.close()]);
    const failures = [...abortResults, ...taskResults, ...sandboxResult]
      .flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "GUI shutdown failed");
  }

  public bootstrap(): BootstrapData {
    const profile = this.config.modelProfiles.executor;
    return {
      projectName: "ProofBlade / 证锋",
      projectRoot: this.root,
      configPath: this.configPath,
      storage: this.config.storage,
      model: {
        provider: profile.provider,
        model: profile.model,
        baseUrl: profile.baseUrl,
        thinkingLevel: profile.thinkingLevel ?? "off",
      },
      fixtures: listFixtureProfiles().map(({ id, targetKind, description }) => ({ id, targetKind, description })),
      refreshIntervalMs: 2_000,
    };
  }

  public async listRuns(): Promise<RunListItem[]> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(this.services.runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const items = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && runIdPattern.test(entry.name))
      .map(async (entry): Promise<RunListItem | undefined> => {
        try {
          const eventsStat = await stat(join(this.services.runsRoot, entry.name, "events.jsonl"));
          const cached = this.runListCache.get(entry.name);
          if (cached?.mtimeMs === eventsStat.mtimeMs) return { ...cached.item, active: this.active.get(entry.name) };
          const [snapshot, events] = await Promise.all([
            this.services.control.snapshot(entry.name),
            this.services.control.events(entry.name),
          ]);
          const item: RunListItem = {
            runId: snapshot.runId,
            kind: runKind(snapshot.task),
            objective: snapshot.task.objective,
            targetKind: snapshot.task.target_kind,
            status: snapshot.status,
            phase: snapshot.phase,
            generation: snapshot.generation,
            lastSeq: snapshot.lastSeq,
            updatedAt: eventsStat.mtime.toISOString(),
            counts: {
              tools: events.filter((event) => event.type === "tool_call_recorded").length,
              evidence: Object.keys(snapshot.evidence).length,
              artifacts: Object.keys(snapshot.artifacts).length,
              effects: Object.keys(snapshot.effects).length,
            },
            active: this.active.get(snapshot.runId),
          };
          this.runListCache.set(entry.name, { mtimeMs: eventsStat.mtimeMs, item });
          return item;
        } catch {
          return undefined;
        }
      }));
    return items.filter((item): item is RunListItem => Boolean(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  public async getRun(runId: string): Promise<RunDetail> {
    assertRunId(runId);
    const [snapshot, events, telemetry, sessions, eventsStat] = await Promise.all([
      this.services.control.snapshot(runId),
      this.services.control.events(runId),
      new RunTelemetry(this.services.control).report(runId),
      this.loadSessions(runId),
      stat(join(this.services.runsRoot, runId, "events.jsonl")),
    ]);
    return { kind: runKind(snapshot.task), snapshot, events, telemetry, sessions, active: this.active.get(runId), updatedAt: eventsStat.mtime.toISOString() };
  }

  public async artifact(runId: string, artifactId: string): Promise<{ artifact: RunSnapshot["artifacts"][string]; content: string }> {
    assertRunId(runId);
    const snapshot = await this.services.control.snapshot(runId);
    const artifact = snapshot.artifacts[artifactId];
    if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
    return { artifact, content: await this.services.artifacts.readText(runId, artifact) };
  }

  public async checkpoint(runId: string, reason: string): Promise<unknown> {
    assertRunId(runId);
    return await new CheckpointService(this.services.control, this.services.artifacts).create(runId, reason || "GUI manual checkpoint");
  }

  public async recover(runId: string): Promise<unknown> {
    assertRunId(runId);
    return await new RunRecoveryService(this.services.control, this.services.journal, this.services.sandbox).recover(runId);
  }

  public async startSolve(input: { runId: string; fixtureId: string; mode: "auto" | "assist"; maxTurns?: number }): Promise<ActiveRunInfo> {
    this.assertOpen();
    assertRunId(input.runId);
    const current = this.active.get(input.runId);
    if (current && current.state !== "failed") throw new Error(`Run is already active: ${input.runId}`);
    const task = fixtureTask(input.runId, input.fixtureId, this.root, this.config);
    await this.ensureRunCreated(input.runId, task);
    this.assertOpen();
    const info: ActiveRunInfo = { runId: input.runId, startedAt: new Date().toISOString(), state: "running" };
    this.active.set(input.runId, info);
    const loop = new SingleAgentCtfLoop(this.root, this.config, this.services, this.createSolverLane);
    const controller = new AbortController();
    const runPromise = loop.run({
      runId: input.runId,
      task,
      mode: input.mode,
      maxTurns: input.maxTurns,
      signal: controller.signal,
      onLaneReady: async (lane) => {
        this.activeLanes.set(input.runId, lane);
        if (this.pauseRequests.has(input.runId)) {
          await this.ensurePaused(input.runId, "Paused by user");
          await lane.abort("Paused by user");
        }
      },
    }).then(() => {
      this.active.delete(input.runId);
    }).catch((error: unknown) => {
      if (controller.signal.aborted && error instanceof Error && error.message === "Run aborted") {
        this.active.delete(input.runId);
        return;
      }
      this.active.set(input.runId, { ...info, state: "failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }).finally(() => {
      this.activeLanes.delete(input.runId);
      this.pauseRequests.delete(input.runId);
      if (this.solveTasks.get(input.runId)?.promise === runPromise) this.solveTasks.delete(input.runId);
    });
    this.solveTasks.set(input.runId, { controller, promise: runPromise });
    void runPromise.catch(() => undefined);
    return info;
  }

  private async ensureRunCreated(runId: string, task: TaskContract): Promise<void> {
    try {
      await access(join(this.services.runsRoot, runId, "task.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.services.control.createRun(runId, task);
    }
  }

  public async createConversation(input: { runId: string; title: string; workspacePath?: string }): Promise<RunSnapshot> {
    this.assertOpen();
    assertRunId(input.runId);
    await this.assertRunDoesNotExist(input.runId);
    return await this.services.control.createRun(input.runId, codingConversationTask(input.runId, input.title, input.workspacePath ?? this.root));
  }

  public async createFixtureConversation(input: { runId: string; fixtureId: string; objective: string }): Promise<RunSnapshot> {
    this.assertOpen();
    assertRunId(input.runId);
    await this.assertRunDoesNotExist(input.runId);
    const task = fixtureTask(input.runId, input.fixtureId, this.root, this.config);
    task.objective = input.objective.trim() || task.objective;
    await this.services.control.createRun(input.runId, task);
    const fixture = await this.services.sandbox.build(task);
    const generation = await this.services.sandbox.reset(fixture);
    await this.services.control.dispatch(input.runId, { type: "fixture_reset", generation });
    await this.services.control.dispatch(input.runId, { type: "start_phase", phase: "reconnaissance" });
    return await this.services.control.snapshot(input.runId);
  }

  private async assertRunDoesNotExist(runId: string): Promise<void> {
    try {
      await access(join(this.services.runsRoot, runId, "task.json"));
      throw new Error(`Run already exists: ${runId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  public async chat(
    runId: string,
    prompt: string,
    emit: (event: ChatStreamEvent) => void,
    profile?: ModelProfileConfig,
    capabilities?: { enabledTools?: string[]; enabledSkills?: string[]; enabledMcpServers?: string[] },
    workspacePath?: string,
  ): Promise<void> {
    this.assertOpen();
    const task = this.runChat(runId, prompt, emit, profile, capabilities, workspacePath);
    this.chatTasks.add(task);
    try {
      await task;
    } finally {
      this.chatTasks.delete(task);
    }
  }

  private async runChat(
    runId: string,
    prompt: string,
    emit: (event: ChatStreamEvent) => void,
    profile?: ModelProfileConfig,
    capabilities?: { enabledTools?: string[]; enabledSkills?: string[]; enabledMcpServers?: string[] },
    workspacePath?: string,
  ): Promise<void> {
    assertRunId(runId);
    const text = prompt.trim();
    if (!text) throw new Error("Prompt is required");
    if (this.active.has(runId)) throw new Error(`Run is already active: ${runId}`);
    const snapshot = await this.services.control.snapshot(runId);
    this.assertOpen();
    if (["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(snapshot.status)) {
      throw new Error(`Run is terminal (${snapshot.status}); start a new conversation`);
    }
    if (snapshot.status === "PAUSED") await this.services.control.dispatch(runId, { type: "resume" });
    const info: ActiveRunInfo = { runId, startedAt: new Date().toISOString(), state: "running" };
    this.active.set(runId, info);
    this.streamEmitters.set(runId, emit);
    emit({ type: "started", runId });
    let runtime: ProofBladeToolRuntime | undefined;
    let lane: AgentLanePort | undefined;
    const runConfig = profile ? { ...this.config, modelProfiles: { ...this.config.modelProfiles, executor: profile } } : this.config;
    try {
      if (runKind(snapshot.task) === "chat") {
        lane = await this.createCodingLane({
          projectRoot: codingWorkspace(snapshot.task, workspacePath, this.root),
          runId,
          runDir: join(this.services.runsRoot, runId),
          controlStore: this.services.control,
          config: runConfig,
          capabilities,
          onEvent: (event: AgentHarnessEvent) => emitAgentEvent(event, emit),
        });
      } else {
        this.assertOpen();
        const recovery = await new RunRecoveryService(this.services.control, this.services.journal, this.services.sandbox).recover(runId);
        runtime = new ProofBladeToolRuntime(runId, recovery.fixture, this.services.runsRoot, this.services.control, this.services.artifacts, this.services.journal, this.root);
        lane = await PiSolverLane.create({
          projectRoot: this.root,
          runId,
          runDir: join(this.services.runsRoot, runId),
          controlStore: this.services.control,
          artifactStore: this.services.artifacts,
          config: runConfig,
          runtime,
          onEvent: (event: AgentHarnessEvent) => emitAgentEvent(event, emit),
        });
      }
      this.assertOpen();
      this.activeLanes.set(runId, lane);
      if (this.pauseRequests.has(runId)) {
        await this.ensurePaused(runId, "Paused by user");
        emit({ type: "paused", runId });
        return;
      }
      const outcome = await lane.prompt(text);
      if (this.pauseRequests.has(runId)) {
        await this.ensurePaused(runId, "Paused by user");
        emit({ type: "paused", runId });
        return;
      }
      const recoverableTermination = isRecoverableTermination(outcome.termination);
      if (!recoverableTermination && (outcome.errorMessage || outcome.stopReason === "error")) {
        emit({ type: "error", error: outcome.errorMessage || "模型请求失败" });
        return;
      }
      emit({ type: "done", text: outcome.text, stopReason: recoverableTermination ? "stop" : outcome.stopReason, usage: normalizeUsage(outcome.usage) ?? emptyUsage(), claimVerification: outcome.claimVerification });
    } catch (error) {
      if (this.pauseRequests.has(runId)) {
        await this.ensurePaused(runId, "Paused by user");
        emit({ type: "paused", runId });
      } else {
        emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      await lane?.close().catch(() => undefined);
      await runtime?.close().catch(() => undefined);
      this.activeLanes.delete(runId);
      this.pauseRequests.delete(runId);
      this.streamEmitters.delete(runId);
      this.active.delete(runId);
    }
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("GUI is shutting down");
  }

  public async pause(runId: string, reason = "Paused by user"): Promise<ActiveRunInfo> {
    assertRunId(runId);
    const current = this.active.get(runId);
    if (!current || current.state === "failed") throw new Error(`Run is not active: ${runId}`);
    if (current.state === "paused") return current;
    const stopping: ActiveRunInfo = { ...current, state: "stopping" };
    this.active.set(runId, stopping);
    this.pauseRequests.add(runId);
    this.streamEmitters.get(runId)?.({ type: "stopping", runId });
    await this.ensurePaused(runId, reason);
    const paused: ActiveRunInfo = { ...current, state: "paused" };
    this.active.set(runId, paused);
    const solveTask = this.solveTasks.get(runId);
    if (solveTask) solveTask.controller.abort(reason);
    else await this.activeLanes.get(runId)?.abort(reason);
    return paused;
  }

  private async ensurePaused(runId: string, reason: string): Promise<void> {
    const snapshot = await this.services.control.snapshot(runId);
    if (snapshot.status === "PAUSED" || ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(snapshot.status)) return;
    await this.services.control.dispatch(runId, { type: "pause", reason, lane: "main" });
  }

  private async loadSessions(runId: string): Promise<PiSessionDebug[]> {
    const runDir = join(this.services.runsRoot, runId);
    const env = new NodeExecutionEnv({ cwd: runDir });
    try {
      const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(runDir, "pi-sessions") });
      const metadata = await repo.list();
      const events = await this.services.control.events(runId);
      const snapshot = await this.services.control.snapshot(runId);
      return await Promise.all(metadata.map(async (item): Promise<PiSessionDebug> => {
        const session = await repo.open(item);
        const [entries, branch, stats] = await Promise.all([session.getEntries(), session.getBranch(), session.getSessionStats()]);
        const assistantTurns = assistantTurnsFromEntries(entries);
        return {
          id: item.id,
          createdAt: item.createdAt,
          path: item.path,
          metadata: item.metadata,
          stats,
          usage: usageFromMessages(conversationMessagesFromEntries(branch, events)),
          entries,
          branchEntryIds: branch.map((entry) => entry.id),
          assistantTurns,
          messages: conversationMessagesFromEntries(branch, events),
          toolCalls: correlateToolCalls(entries, events, snapshot, assistantTurns),
        };
      }));
    } finally {
      await env.cleanup();
    }
  }
}

export function runKind(task: Pick<TaskContract, "mode">): RunKind {
  return task.mode === "coding_assistant" ? "chat" : "fixture";
}

export function codingConversationTask(runId: string, title: string, root: string): TaskContract {
  return {
    schema_version: 1,
    task_id: runId,
    mode: "coding_assistant",
    target_kind: "unknown",
    target: root,
    objective: title.trim() || "新对话",
    inputs: [],
    success_criteria: [],
    verification: { kind: "reproduction", required_reproductions: 0 },
    scope: {
      allowed_hosts: ["*"],
      allowed_ports: [],
      external_network: true,
      allowed_workspace: root,
    },
    pause_policy: [],
    constraints: {
      deadline_ms: 86_400_000,
      max_cost_usd: 100,
      max_tool_calls: 1_000,
      max_submissions: 0,
    },
  };
}

export function assistantTurnsFromEntries(entries: readonly SessionEntryLike[]): AssistantTurnDebug[] {
  const turns: AssistantTurnDebug[] = [];
  for (const entry of entries) {
    const message = asMessage(entry.message);
    if (entry.type !== "message" || message?.role !== "assistant") continue;
    const content = asContent(message.content);
    const ordinal = turns.length + 1;
    turns.push({
      id: `${entry.id ?? ordinal}`,
      entryId: `${entry.id ?? ordinal}`,
      timestamp: entry.timestamp ?? "",
      ordinal,
      provider: message.provider,
      model: message.model,
      stopReason: message.stopReason,
      text: content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n"),
      toolCallIds: content.filter((item) => item.type === "toolCall" && item.id).map((item) => item.id!),
      raw: entry,
    });
  }
  return turns;
}

export function conversationMessagesFromEntries(entries: readonly SessionEntryLike[], events: readonly HarnessEvent[] = []): ChatMessageDebug[] {
  const messages: ChatMessageDebug[] = [];
  for (const entry of entries) {
    const message = asMessage(entry.message);
    if (entry.type !== "message" || (message?.role !== "user" && message?.role !== "assistant")) continue;
    const content = asContent(message.content);
    const text = content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n");
    if (message.role === "user" && text.startsWith(AUTOMATIC_CONTEXT_RECOVERY_MARKER)) continue;
    messages.push({
      id: entry.id ?? `${messages.length + 1}`,
      entryId: entry.id ?? `${messages.length + 1}`,
      role: message.role,
      timestamp: entry.timestamp ?? "",
      text,
      thinking: content.filter((item) => item.type === "thinking").map((item) => item.thinking ?? "").join("\n"),
      toolCallIds: content.filter((item) => item.type === "toolCall" && item.id).map((item) => item.id!),
      provider: message.provider,
      model: message.model,
      stopReason: message.stopReason,
      error: message.errorMessage,
      usage: normalizeUsage(message.usage),
      raw: entry,
    });
  }
  const assistantEvents = events.filter((event) => event.type === "assistant_message");
  for (const event of [...assistantEvents].reverse()) {
    const text = typeof event.payload?.text === "string" ? event.payload.text : undefined;
    if (isRecoverableTermination(event.payload?.termination) && text) {
      const piEntryId = typeof event.payload?.piEntryId === "string" ? event.payload.piEntryId : undefined;
      const interrupted = piEntryId
        ? messages.find((item) => item.role === "assistant" && item.entryId === piEntryId && !item.text && (item.stopReason === "error" || item.stopReason === "toolUse"))
        : undefined;
      if (interrupted) {
        interrupted.text = text;
        interrupted.stopReason = typeof event.payload?.stopReason === "string" ? event.payload.stopReason : "stop";
        interrupted.error = undefined;
      }
    }
    if (!isRecord(event.payload?.claimVerification)) continue;
    const message = [...messages].reverse().find((item) => item.role === "assistant" && item.text === text && item.claimVerification === undefined);
    if (message) message.claimVerification = event.payload?.claimVerification as unknown as ChatMessageDebug["claimVerification"];
  }
  let latestUserPrompt = "";
  for (const message of messages) {
    if (message.role === "user") {
      latestUserPrompt = message.text;
      continue;
    }
    if (message.claimVerification || message.stopReason === "toolUse" || !message.text) continue;
    if (requiresClaimVerification(latestUserPrompt, message.text)) {
      message.claimVerification = {
        required: true,
        status: "unverified",
        reason: "历史消息没有候选复现记录。",
      };
    }
  }
  return messages;
}

function isRecoverableTermination(value: unknown): value is NonNullable<AgentOutcome["termination"]> {
  return value === "repeated_tool_failure" || value === "no_progress";
}

export function correlateToolCalls(
  entries: readonly SessionEntryLike[],
  events: readonly HarnessEvent[],
  snapshot: RunSnapshot,
  turns = assistantTurnsFromEntries(entries),
): ToolCallDebug[] {
  const results = new Map<string, { message: MessageLike; entry: SessionEntryLike }>();
  for (const entry of entries) {
    const message = asMessage(entry.message);
    if (entry.type === "message" && message?.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, { message, entry });
  }
  const callEvents = new Map(events.filter((event) => event.type === "tool_call_recorded").map((event) => [String(event.payload?.toolCallId), event]));
  const resultEvents = new Map(events.filter((event) => event.type === "tool_result_recorded").map((event) => [String(event.payload?.toolCallId), event]));
  const output: ToolCallDebug[] = [];
  for (const turn of turns) {
    const assistantEntry = entries.find((entry) => entry.id === turn.entryId);
    const message = asMessage(assistantEntry?.message);
    const calls = asContent(message?.content).filter((item) => item.type === "toolCall");
    calls.forEach((call, callIndex) => {
      const callId = call.id ?? `${turn.entryId}:${callIndex}`;
      const matched = results.get(callId);
      const referenced = collectReferencedIds([call.arguments, matched?.message.details], snapshot);
      const artifacts = Object.values(snapshot.artifacts).filter((item) => referenced.has(item.id));
      const effects = Object.values(snapshot.effects).filter((item) => referenced.has(item.id) || (item.artifactId && referenced.has(item.artifactId)));
      const effectIds = new Set(effects.map((item) => item.id));
      const artifactIds = new Set(artifacts.map((item) => item.id));
      const evidence = Object.values(snapshot.evidence).filter((item) =>
        referenced.has(item.id)
        || Boolean(item.source.artifactId && artifactIds.has(item.source.artifactId))
        || Boolean(item.source.effectId && effectIds.has(item.source.effectId)),
      );
      output.push({
        id: callId,
        name: call.name ?? matched?.message.toolName ?? "unknown",
        timestamp: turn.timestamp,
        status: matched ? (matched.message.isError ? "error" : "success") : "pending",
        assistantEntryId: turn.entryId,
        assistantOrdinal: turn.ordinal,
        callIndex,
        arguments: call.arguments ?? {},
        call,
        result: matched?.message,
        completedAt: matched?.entry.timestamp,
        presentation: toolPresentation(call.name ?? matched?.message.toolName ?? "unknown", call.arguments ?? {}, matched?.message),
        assistantEntry,
        resultEntry: matched?.entry,
        telemetry: { call: callEvents.get(callId), result: resultEvents.get(callId) },
        links: { artifacts, evidence, effects },
      });
    });
  }
  return output;
}

export function codingWorkspace(task: Pick<TaskContract, "mode" | "target" | "scope">, preferred: string | undefined, fallback: string): string {
  if (task.mode !== "coding_assistant") return fallback;
  return preferred || task.scope.allowed_workspace || task.target || fallback;
}

function collectReferencedIds(values: unknown[], snapshot: RunSnapshot): Set<string> {
  const known = new Set([
    ...Object.keys(snapshot.artifacts),
    ...Object.keys(snapshot.evidence),
    ...Object.keys(snapshot.effects),
  ]);
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (known.has(value)) found.add(value);
      for (const id of known) if (value.includes(id)) found.add(id);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit);
  };
  values.forEach(visit);
  return found;
}

function asMessage(value: unknown): MessageLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as MessageLike : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asContent(value: unknown): ContentLike[] {
  return Array.isArray(value) ? value.filter((item): item is ContentLike => Boolean(item && typeof item === "object")) : [];
}

function emitAgentEvent(event: AgentHarnessEvent, emit: (event: ChatStreamEvent) => void): void {
  if (event.type === "before_provider_payload") {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const messageChars = JSON.stringify(messages).length;
    const toolSchemaChars = JSON.stringify(tools).length;
    const systemPromptChars = messages.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).role === "system").map((item) => JSON.stringify(item)).join("").length;
    emit({ type: "context_snapshot", messages: messages.length, tools: tools.length, systemPromptChars, messageChars, toolSchemaChars, estimatedVisibleTokens: Math.ceil((messageChars + toolSchemaChars) / 4) });
    return;
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta") emit({ type: "text_delta", delta: update.delta });
    if (update.type === "thinking_delta") emit({ type: "thinking_delta", delta: update.delta });
    return;
  }
  if (event.type === "tool_execution_start") {
    emit({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
    return;
  }
  if (event.type === "tool_execution_end") {
    emit({ type: "tool_end", toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError });
  }
}

function normalizeUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const number = (key: string): number => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] as number : 0;
  return {
    input: number("input"),
    output: number("output"),
    cacheRead: number("cacheRead"),
    cacheWrite: number("cacheWrite"),
    reasoning: number("reasoning"),
    totalTokens: number("totalTokens") || number("input") + number("output") + number("cacheRead") + number("cacheWrite"),
  };
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 };
}

function usageFromMessages(messages: ChatMessageDebug[]): TokenUsage & { requests: number } {
  const total: TokenUsage & { requests: number } = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, requests: 0 };
  for (const message of messages) {
    if (!message.usage) continue;
    total.requests += 1;
    total.input += message.usage.input;
    total.output += message.usage.output;
    total.cacheRead += message.usage.cacheRead;
    total.cacheWrite += message.usage.cacheWrite;
    total.reasoning += message.usage.reasoning;
    total.totalTokens += message.usage.totalTokens;
  }
  return total;
}

export function assertRunId(runId: string): void {
  if (!runIdPattern.test(runId)) throw new Error("Run ID must contain only letters, numbers, dots, underscores, and hyphens");
}
