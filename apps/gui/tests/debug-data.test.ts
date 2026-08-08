import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DebugDataService, assistantTurnsFromEntries, assertRunId, codingConversationTask, codingWorkspace, conversationMessagesFromEntries, correlateToolCalls, runKind } from "../src/debug-data.js";
import { SingleAgentCtfLoop } from "@proofblade/materials";
import type { AgentLanePort, AgentOutcome, HarnessEvent, ProofBladeConfig, RunSnapshot } from "@proofblade/materials";
import type { ChatStreamEvent } from "../src/shared.js";

const entries = [
  { type: "message", id: "user-1", timestamp: "2026-08-05T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "inspect" }] } },
  { type: "message", id: "assistant-1", timestamp: "2026-08-05T00:00:01.000Z", message: { role: "assistant", provider: "test", model: "fixture", stopReason: "toolUse", content: [{ type: "text", text: "checking" }, { type: "toolCall", id: "call-1", name: "inspect_target", arguments: { path: "input.txt" } }] } },
  { type: "message", id: "result-1", timestamp: "2026-08-05T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "inspect_target", details: { artifactId: "A-1", evidenceId: "EV-1" }, isError: false } },
];

const snapshot = {
  artifacts: { "A-1": { id: "A-1", path: "artifacts/A-1.txt", sha256: "hash", bytes: 1, mime: "text/plain", sensitivity: "public" } },
  evidence: { "EV-1": { id: "EV-1", kind: "observation", summary: "found", source: { artifactId: "A-1" }, confidence: 1, supports: [], refutes: [], createdSeq: 2 } },
  effects: {},
} as unknown as RunSnapshot;

const events = [
  { type: "tool_call_recorded", payload: { toolCallId: "call-1", toolName: "inspect_target" } },
  { type: "tool_result_recorded", payload: { toolCallId: "call-1", toolName: "inspect_target", isError: false } },
] as HarnessEvent[];

test("correlates a Pi tool call with result, telemetry, artifact, and evidence", () => {
  const turns = assistantTurnsFromEntries(entries);
  const calls = correlateToolCalls(entries, events, snapshot, turns);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.text, "checking");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.id, "call-1");
  assert.equal(calls[0]?.status, "success");
  assert.match(calls[0]?.presentation.input ?? "", /input\.txt/);
  assert.match(calls[0]?.presentation.output ?? "", /artifactId/);
  assert.equal(calls[0]?.telemetry.call?.type, "tool_call_recorded");
  assert.deepEqual(calls[0]?.links.artifacts.map((item) => item.id), ["A-1"]);
  assert.deepEqual(calls[0]?.links.evidence.map((item) => item.id), ["EV-1"]);
});

test("marks a tool call without a result as pending", () => {
  const calls = correlateToolCalls(entries.slice(0, 2), [], snapshot);
  assert.equal(calls[0]?.status, "pending");
});

test("projects user and assistant Pi entries into a conversation without tool-result bubbles", () => {
  const messages = conversationMessagesFromEntries(entries);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.text, "inspect");
  assert.equal(messages[1]?.role, "assistant");
  assert.deepEqual(messages[1]?.toolCallIds, ["call-1"]);
});

test("[contract:hidden-context-recovery-turn] hides automatic context recovery prompts from chat", () => {
  const messages = conversationMessagesFromEntries([
    { type: "message", id: "user", message: { role: "user", content: [{ type: "text", text: "solve" }] } },
    { type: "message", id: "recovery", message: { role: "user", content: [{ type: "text", text: "[ProofBlade automatic context recovery]\nContinue the unfinished task." }] } },
    { type: "message", id: "assistant", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } },
  ]);
  assert.deepEqual(messages.map((message) => [message.role, message.text]), [["user", "solve"], ["assistant", "done"]]);
});

test("projects persisted provider failures into assistant conversation messages", () => {
  const messages = conversationMessagesFromEntries([{
    type: "message",
    id: "assistant-error",
    timestamp: "2026-08-05T00:00:03.000Z",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." },
  }]);
  assert.equal(messages[0]?.stopReason, "error");
  assert.equal(messages[0]?.error, "Connection error.");
});

test("[contract:repeated-tool-failure-conversation] projects a persisted breaker termination as a normal assistant reply", () => {
  const messages = conversationMessagesFromEntries([{
    type: "message",
    id: "assistant-breaker",
    timestamp: "2026-08-05T00:00:03.000Z",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage: "ProofBlade repeated tool failure." },
  }], [{
    type: "assistant_message",
    payload: { text: "ProofBlade repeated tool failure. Change the approach before continuing.", stopReason: "stop", termination: "repeated_tool_failure", piEntryId: "assistant-breaker" },
  }] as HarnessEvent[]);
  assert.equal(messages[0]?.text, "ProofBlade repeated tool failure. Change the approach before continuing.");
  assert.equal(messages[0]?.stopReason, "stop");
  assert.equal(messages[0]?.error, undefined);
});

test("[contract:no-progress-conversation] projects a persisted convergence stop onto its exact tool-use entry", () => {
  const messages = conversationMessagesFromEntries([{
    type: "message",
    id: "assistant-no-progress",
    timestamp: "2026-08-05T00:00:03.000Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "read-3", name: "read", arguments: { path: "firmware.asm" } }], stopReason: "toolUse" },
  }], [{
    type: "assistant_message",
    payload: { text: "Repeated exploration produced no new information.", stopReason: "stop", termination: "no_progress", piEntryId: "assistant-no-progress" },
  }] as HarnessEvent[]);
  assert.equal(messages[0]?.text, "Repeated exploration produced no new information.");
  assert.equal(messages[0]?.stopReason, "stop");
  assert.equal(messages[0]?.error, undefined);
});

test("[contract:repeated-tool-failure-entry-link] an old breaker event cannot overwrite a later provider failure", () => {
  const messages = conversationMessagesFromEntries([
    {
      type: "message",
      id: "old-breaker",
      timestamp: "2026-08-05T00:00:03.000Z",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "old breaker raw error" },
    },
    {
      type: "message",
      id: "new-provider-failure",
      timestamp: "2026-08-05T00:01:03.000Z",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: "new provider failure" },
    },
  ], [{
    type: "assistant_message",
    payload: {
      text: "breaker recovery guidance",
      stopReason: "stop",
      termination: "repeated_tool_failure",
      piEntryId: "old-breaker",
    },
  }] as HarnessEvent[]);

  assert.deepEqual(messages.map((message) => ({ id: message.id, text: message.text, stopReason: message.stopReason, error: message.error })), [
    { id: "old-breaker", text: "breaker recovery guidance", stopReason: "stop", error: undefined },
    { id: "new-provider-failure", text: "", stopReason: "error", error: "new provider failure" },
  ]);
});

test("projects durable claim verification onto the matching assistant message", () => {
  const projected = conversationMessagesFromEntries(entries, [{
    type: "assistant_message",
    payload: { text: "checking", claimVerification: { required: true, status: "unverified", reason: "missing reproduction" } },
  }] as HarnessEvent[]);
  assert.equal(projected[1]?.claimVerification?.status, "unverified");
  assert.equal(projected[1]?.claimVerification?.reason, "missing reproduction");
});

test("marks a legacy challenge answer without reproduction metadata as unverified", () => {
  const legacy = conversationMessagesFromEntries([
    { type: "message", id: "legacy-user", message: { role: "user", content: [{ type: "text", text: "完成这道题，并得到flag" }] } },
    { type: "message", id: "legacy-tool-turn", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "正在检查文件" }] } },
    { type: "message", id: "legacy-answer", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "最终答案：LCTF2026EV-ARM-GW-042" }] } },
  ]);
  assert.equal(legacy[1]?.claimVerification, undefined);
  assert.equal(legacy[2]?.claimVerification?.status, "unverified");
  assert.equal(legacy[2]?.claimVerification?.reason, "历史消息没有候选复现记录。");
});

test("rejects path-like run identifiers", () => {
  assert.doesNotThrow(() => assertRunId("RUN-001.safe"));
  assert.throws(() => assertRunId("../runs/other"));
});

test("creates ordinary coding conversations without fixture semantics", () => {
  const task = codingConversationTask("CHAT-001", "普通对话", "D:/workspace");
  assert.equal(runKind(task), "chat");
  assert.equal(task.mode, "coding_assistant");
  assert.equal(task.target, "D:/workspace");
  assert.deepEqual(task.success_criteria, []);
  assert.equal(task.verification.required_reproductions, 0);
  assert.equal(runKind({ mode: "ctf_solve" }), "fixture");
  assert.equal(codingWorkspace(task, "D:/selected", "D:/fallback"), "D:/selected");
  assert.equal(codingWorkspace(task, undefined, "D:/fallback"), "D:/workspace");
});

test("pauses an active coding lane and persists a resumable run state", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-pause-"));
  let releasePrompt: ((outcome: AgentOutcome) => void) | undefined;
  let markPromptStarted: (() => void) | undefined;
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  const promptResult = new Promise<AgentOutcome>((resolve) => { releasePrompt = resolve; });
  let aborts = 0;
  const lane: AgentLanePort = {
    async prompt() { markPromptStarted?.(); return await promptResult; },
    async abort() {
      aborts += 1;
      releasePrompt?.({ text: "partial", stopReason: "aborted", usage: zeroUsage() });
    },
    async compact() {},
    async isIdle() { return false; },
    async close() {},
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async () => lane);
    const runId = "CHAT-PAUSE-001";
    await data.createConversation({ runId, title: "pause test", workspacePath: root });
    const events: ChatStreamEvent[] = [];
    const chat = data.chat(runId, "inspect the workspace", (event) => events.push(event), undefined, undefined, root);
    await promptStarted;
    const paused = await data.pause(runId);
    await chat;

    assert.equal(aborts, 1);
    assert.equal(paused.state, "paused");
    assert.equal((await data.getRun(runId)).snapshot.status, "PAUSED");
    assert.deepEqual(events.filter((event) => event.type === "stopping" || event.type === "paused").map((event) => event.type), ["stopping", "paused"]);
    assert.equal(events.some((event) => event.type === "done" || event.type === "error"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:repeated-tool-failure-chat-done] streams a breaker termination as a normal assistant reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-breaker-"));
  const message = "ProofBlade repeated tool failure. Change the approach before continuing.";
  const lane: AgentLanePort = {
    async prompt() {
      return {
        text: message,
        stopReason: "error",
        errorMessage: message,
        termination: "repeated_tool_failure",
        usage: zeroUsage(),
      };
    },
    async abort() {},
    async compact() {},
    async isIdle() { return true; },
    async close() {},
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async () => lane);
    const runId = "CHAT-BREAKER-001";
    await data.createConversation({ runId, title: "breaker test", workspacePath: root });
    const events: ChatStreamEvent[] = [];
    await data.chat(runId, "inspect the workspace", (event) => events.push(event), undefined, undefined, root);

    assert.equal(events.some((event) => event.type === "error"), false);
    const done = events.find((event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done");
    assert.equal(done?.text, message);
    assert.equal(done?.stopReason, "stop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:no-progress-chat-done] streams a convergence stop as a normal assistant reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-no-progress-"));
  const message = "Repeated exploration produced no new information.";
  const lane: AgentLanePort = {
    async prompt() { return { text: message, stopReason: "stop", termination: "no_progress", usage: zeroUsage() }; },
    async abort() {},
    async compact() {},
    async isIdle() { return true; },
    async close() {},
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async () => lane);
    const runId = "CHAT-NO-PROGRESS-001";
    await data.createConversation({ runId, title: "convergence test", workspacePath: root });
    const events: ChatStreamEvent[] = [];
    await data.chat(runId, "continue", (event) => events.push(event), undefined, undefined, root);
    assert.equal(events.some((event) => event.type === "error"), false);
    const done = events.find((event): event is Extract<ChatStreamEvent, { type: "done" }> => event.type === "done");
    assert.equal(done?.text, message);
    assert.equal(done?.stopReason, "stop");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists a solve run before returning so an immediate pause aborts its solver lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-solve-pause-"));
  let releaseFactory!: () => void;
  const factoryReady = new Promise<void>((resolve) => { releaseFactory = resolve; });
  let markFactoryEntered!: () => void;
  const factoryEntered = new Promise<void>((resolve) => { markFactoryEntered = resolve; });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let prompts = 0;
  let aborts = 0;
  const lane: AgentLanePort = {
    async prompt() {
      prompts += 1;
      return { text: "unexpected", stopReason: "stop", usage: zeroUsage() };
    },
    async abort() { aborts += 1; },
    async compact() {},
    async isIdle() { return true; },
    async close() { resolveClosed(); },
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), undefined, async () => {
      markFactoryEntered();
      await factoryReady;
      return lane;
    });
    const runId = "SOLVE-PAUSE-001";
    const started = await data.startSolve({ runId, fixtureId: "web-source-1", mode: "auto", maxTurns: 1 });
    assert.equal(started.state, "running");
    await factoryEntered;
    const paused = await data.pause(runId);
    assert.equal(paused.state, "paused");
    assert.equal((await data.getRun(runId)).snapshot.status, "PAUSED");
    await assert.rejects(
      data.startSolve({ runId, fixtureId: "web-source-1", mode: "auto", maxTurns: 1 }),
      /Run is already active/,
    );
    releaseFactory();
    await closed;
    assert.equal(aborts, 1);
    assert.equal(prompts, 0);
    assert.equal((await data.getRun(runId)).snapshot.status, "PAUSED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:shutdown-awaits-active-runs] [contract:solver-abort-exactly-once] GUI close aborts each Solver once and awaits it", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-solve-close-"));
  let releasePrompt!: () => void;
  let closeFinished!: () => void;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  const closed = new Promise<void>((resolve) => { closeFinished = resolve; });
  let aborts = 0;
  const lane: AgentLanePort = {
    async prompt() {
      markPromptStarted();
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
      return { text: "aborted", stopReason: "aborted", usage: zeroUsage() };
    },
    async abort() { aborts += 1; releasePrompt(); },
    async compact() {},
    async isIdle() { return false; },
    async close() { closeFinished(); },
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), undefined, async () => lane);
    const runId = "SOLVE-CLOSE-001";
    await data.startSolve({ runId, fixtureId: "web-source-1", mode: "auto", maxTurns: 1 });
    await promptStarted;
    const closing = data.close();
    releasePrompt();
    await closing;
    await closed;
    assert.equal(aborts, 1);
    await assert.rejects(data.startSolve({ runId: "SOLVE-CLOSE-NEW", fixtureId: "web-source-1", mode: "auto" }), /GUI is shutting down/);
  } finally {
    releasePrompt?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI close reports Lane abort failures as AggregateError", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-gui-abort-failure-"));
  let releasePrompt!: () => void;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  const lane: AgentLanePort = {
    async prompt() {
      markPromptStarted();
      await new Promise<void>((resolve) => { releasePrompt = resolve; });
      return { text: "aborted", stopReason: "aborted", usage: zeroUsage() };
    },
    async abort() {
      releasePrompt?.();
      throw new Error("injected lane abort failure");
    },
    async compact() {},
    async isIdle() { return false; },
    async close() {},
  };
  try {
    const data = new DebugDataService(root, config, join(root, "proofblade.config.json"), async () => lane);
    const runId = "CHAT-ABORT-FAILURE-001";
    await data.createConversation({ runId, title: "abort failure", workspacePath: root });
    const chat = data.chat(runId, "inspect", () => undefined, undefined, undefined, root);
    await promptStarted;
    await assert.rejects(data.close(), (error: unknown) => error instanceof AggregateError && error.errors.some((item) => String(item).includes("injected lane abort failure")));
    await chat;
  } finally {
    releasePrompt?.();
    await rm(root, { recursive: true, force: true });
  }
});

const config: ProofBladeConfig = {
  schemaVersion: 1,
  runtime: { piVersion: "0.83.0" },
  storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
  modelProfiles: {
    executor: {
      provider: "test",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      modelDiscoveryPath: "/models",
      apiKeyEnv: "TEST_API_KEY",
      contextWindow: 4096,
      maxTokens: 512,
      requestTimeoutMs: 1000,
      maxRetries: 0,
      input: ["text"],
    },
  },
};

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
