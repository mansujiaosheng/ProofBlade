import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentHarness, JsonlSessionRepo, NodeExecutionEnv, type AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ControlStore } from "../src/control/control-store.js";
import type { TaskContract } from "../src/domain/types.js";
import { attachCodingTurnGuards, attachRepeatedToolFailureBreaker, finalizeCodingTurn, projectCodingAssistantText, type CodingTurnTermination } from "../src/runtime/coding-turn-projection.js";
import { NoProgressToolBreaker, RepeatedToolFailureBreaker, noProgressToolMessage, repeatedToolFailureMessage } from "../src/runtime/tool-repeat-breaker.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

const failed = (input: Record<string, unknown>, text = "tool rejected the arguments") => ({
  toolName: "evidence",
  input,
  isError: true,
  content: [{ type: "text", text }],
});

test("[contract:evidence-repeat-breaker] repeated tool failures terminate after a bounded number of identical calls", () => {
  const breaker = new RepeatedToolFailureBreaker(3);
  assert.equal(breaker.observe(failed({ operation: "inspect_forest", maxChars: 12000 })).terminate, false);
  assert.equal(breaker.observe(failed({ operation: "inspect_forest", maxChars: 12000 })).terminate, false);
  const decision = breaker.observe(failed({ operation: "inspect_forest", maxChars: 12000 }));
  assert.equal(decision.count, 3);
  assert.equal(decision.terminate, true);
  assert.match(repeatedToolFailureMessage("evidence", decision.count), /infinite loop/);
});

test("successful or different tool calls reset the repeated failure sequence", () => {
  const breaker = new RepeatedToolFailureBreaker(3);
  breaker.observe(failed({ operation: "inspect_forest" }));
  breaker.observe(failed({ operation: "inspect_tree", treeId: "TREE-1" }));
  assert.equal(breaker.observe(failed({ operation: "inspect_forest" })).count, 1);
  assert.equal(breaker.observe({ toolName: "evidence", input: { operation: "record" }, isError: false, content: [{ type: "text", text: "ok" }] }).count, 0);
  assert.equal(breaker.observe(failed({ operation: "inspect_forest" })).count, 1);
});

test("[contract:no-progress-breaker] repeated successful observations stop without constraining productive mutations", () => {
  const breaker = new NoProgressToolBreaker(3);
  const repeatedRead = {
    toolName: "read",
    input: { path: "firmware.asm", offset: 100, limit: 80 },
    isError: false,
    content: [{ type: "text", text: "same disassembly with a new artifact id" }],
    details: { artifactId: "A-volatile", artifactHash: "content-hash" },
  };
  assert.equal(breaker.observe(repeatedRead).terminate, false);
  assert.equal(breaker.observe({ ...repeatedRead, details: { artifactId: "A-other", artifactHash: "content-hash" } }).terminate, false);
  const decision = breaker.observe(repeatedRead);
  assert.equal(decision.count, 3);
  assert.equal(decision.terminate, true);
  assert.match(noProgressToolMessage("read", decision.count), /no new information/i);

  breaker.reset();
  breaker.observe(repeatedRead);
  breaker.observe({ toolName: "evidence", input: { operation: "record" }, isError: false, content: [{ type: "text", text: "recorded" }], details: {} });
  assert.equal(breaker.observe(repeatedRead).count, 1);
  breaker.observe({ toolName: "write", input: { path: "solve.py", content: "print('new')" }, isError: false, content: [{ type: "text", text: "ok" }], details: {} });
  assert.equal(breaker.observe(repeatedRead).count, 1);
});

test("no-progress comparison uses stable bash artifact hashes and ignores unrelated observations", () => {
  const breaker = new NoProgressToolBreaker(3);
  const bash = (hash: string) => ({
    toolName: "bash",
    input: { command: "objdump -d firmware.bin" },
    isError: false,
    content: [{ type: "text", text: `[ProofBlade artifact A-${Math.random()}; use this id with the evidence tool]` }],
    details: { outputRewrite: { artifactId: "volatile", artifactHash: hash } },
  });
  breaker.observe(bash("hash-1"));
  assert.equal(breaker.observe(bash("hash-2")).count, 1);
  assert.equal(breaker.observe(bash("hash-1")).count, 2);
  assert.equal(breaker.observe({ toolName: "mcp_call", input: { operation: "call" }, isError: false, content: [{ type: "text", text: "ok" }], details: {} }).count, 0);
});

test("a breaker message only fills an otherwise empty assistant response", () => {
  const termination = { message: "recover with different arguments", confirmed: true };
  assert.equal(projectCodingAssistantText("model explanation", termination), "model explanation");
  assert.equal(projectCodingAssistantText("", termination), termination.message);
  termination.confirmed = false;
  assert.equal(projectCodingAssistantText("", termination), "");
});

test("[contract:repeated-tool-failure-visible] real Harness termination produces and persists a visible assistant reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-repeat-visible-"));
  const env = new NodeExecutionEnv({ cwd: root });
  try {
    const runId = "REPEAT-VISIBLE-001";
    const controlStore = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await controlStore.createRun(runId, task(runId, root));
    const sessionRepo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await sessionRepo.create({ id: `${runId}-chat`, cwd: root, metadata: { runId, lane: "main" } });
    const faux = fauxProvider({ provider: `faux-${runId}` });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([1, 2, 3].map((index) => fauxAssistantMessage(
      fauxToolCall("evidence", { operation: "inspect_forest", maxChars: 256 }, { id: `call-${index}` }),
      { stopReason: "toolUse" },
    )));
    const evidenceTool: AgentHarnessTool<undefined> = {
      name: "evidence",
      label: "evidence",
      description: "Always fails for the repeated failure integration test.",
      parameters: Type.Object({
        operation: Type.String(),
        maxChars: Type.Number(),
      }),
      async execute() {
        throw new Error("fixture evidence failure");
      },
    };
    const harness = new AgentHarness({
      session,
      models,
      model: faux.getModel(),
      tools: [evidenceTool],
      activeToolNames: ["evidence"],
      systemPrompt: "Exercise the evidence tool.",
    });
    const breaker = new RepeatedToolFailureBreaker(3);
    const termination: CodingTurnTermination = {};
    attachRepeatedToolFailureBreaker(harness, breaker, termination);

    const response = await harness.prompt("Inspect the evidence forest.");
    const assistantEntries = (await session.getBranch()).filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    const piEntryId = assistantEntries[assistantEntries.length - 1]?.id;
    assert.ok(piEntryId);
    const outcome = await finalizeCodingTurn({
      runId,
      controlStore,
      correlationId: `${runId}:main:chat-turn`,
      userPrompt: "Inspect the evidence forest.",
      response,
      recoveryCount: 0,
      recoveryExhausted: false,
      termination,
      piEntryId,
      claimVerifier: { project: () => ({ required: false, status: "not_required" }) },
      maintainAfterTurn: async () => undefined,
    });

    assert.equal(response.stopReason, "toolUse");
    assert.deepEqual(response.content.map((item) => item.type), ["toolCall"]);
    assert.match(outcome.text, /current agent turn was stopped/i);
    const assistantEvent = (await controlStore.events(runId)).findLast((event) => event.type === "assistant_message");
    assert.equal(assistantEvent?.payload?.text, outcome.text);
    assert.equal(assistantEvent?.payload?.termination, "repeated_tool_failure");
    assert.equal(assistantEvent?.payload?.piEntryId, piEntryId);
  } finally {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:repeated-tool-failure-mixed-batch] a successful sibling cannot bypass the breaker", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-repeat-mixed-"));
  const env = new NodeExecutionEnv({ cwd: root });
  try {
    const runId = "REPEAT-MIXED-001";
    const controlStore = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await controlStore.createRun(runId, task(runId, root));
    const sessionRepo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await sessionRepo.create({ id: `${runId}-chat`, cwd: root, metadata: { runId, lane: "main" } });
    const faux = fauxProvider({ provider: `faux-${runId}` });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("evidence", { operation: "inspect_forest", maxChars: 256 }, { id: "fail-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("evidence", { operation: "inspect_forest", maxChars: 256 }, { id: "fail-2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("evidence", { operation: "inspect_forest", maxChars: 256 }, { id: "fail-3" }),
        fauxToolCall("probe", { value: "sibling" }, { id: "success-1" }),
      ], { stopReason: "toolUse" }),
    ]);
    const evidenceTool: AgentHarnessTool<undefined> = {
      name: "evidence",
      label: "evidence",
      description: "Always fails for the mixed batch test.",
      parameters: Type.Object({ operation: Type.String(), maxChars: Type.Number() }),
      async execute() { throw new Error("fixture evidence failure"); },
    };
    const successTool: AgentHarnessTool<undefined> = {
      name: "probe",
      label: "probe",
      description: "Succeeds for the mixed batch test.",
      parameters: Type.Object({ value: Type.String() }),
      async execute() { return { content: [{ type: "text" as const, text: "sibling succeeded" }] }; },
    };
    const harness = new AgentHarness({
      session,
      models,
      model: faux.getModel(),
      tools: [evidenceTool, successTool],
      activeToolNames: ["evidence", "probe"],
      systemPrompt: "Exercise repeated tool failures.",
    });
    const breaker = new RepeatedToolFailureBreaker(3);
    const termination: CodingTurnTermination = {};
    attachRepeatedToolFailureBreaker(harness, breaker, termination);

    const response = await harness.prompt("Inspect the evidence forest.");
    const assistantEntries = (await session.getBranch()).filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    const piEntryId = assistantEntries[assistantEntries.length - 1]?.id;
    assert.ok(piEntryId);
    const outcome = await finalizeCodingTurn({
      runId,
      controlStore,
      correlationId: `${runId}:main:chat-turn`,
      userPrompt: "Inspect the evidence forest.",
      response,
      recoveryCount: 0,
      recoveryExhausted: false,
      termination,
      piEntryId,
      claimVerifier: { project: () => ({ required: false, status: "not_required" }) },
      maintainAfterTurn: async () => undefined,
    });

    assert.equal(faux.state.callCount, 3);
    assert.equal(response.stopReason, "error");
    assert.equal(termination.confirmed, true);
    assert.match(outcome.text, /current agent turn was stopped/i);
    assert.equal(outcome.stopReason, "stop");
    assert.equal(outcome.errorMessage, undefined);
    assert.equal(outcome.termination, "repeated_tool_failure");
    const assistantEvent = (await controlStore.events(runId)).findLast((event) => event.type === "assistant_message");
    assert.equal(assistantEvent?.payload?.termination, "repeated_tool_failure");
    assert.equal(assistantEvent?.payload?.piEntryId, piEntryId);
    assert.equal(assistantEvent?.payload?.stopReason, "stop");
    assert.equal(assistantEvent?.payload?.providerStopReason, "error");
  } finally {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("[contract:no-progress-visible] real Harness stops repeated successful observations with a normal visible reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-no-progress-visible-"));
  const env = new NodeExecutionEnv({ cwd: root });
  try {
    const runId = "NO-PROGRESS-VISIBLE-001";
    const controlStore = new ControlStore(new JsonlControlStore(join(root, "runs")));
    await controlStore.createRun(runId, task(runId, root));
    const sessionRepo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await sessionRepo.create({ id: `${runId}-chat`, cwd: root, metadata: { runId, lane: "main" } });
    const faux = fauxProvider({ provider: `faux-${runId}` });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([1, 2, 3].map((index) => fauxAssistantMessage(
      fauxToolCall("read", { path: "firmware.asm", offset: 100, limit: 80 }, { id: `read-${index}` }),
      { stopReason: "toolUse" },
    )));
    const readTool: AgentHarnessTool<undefined> = {
      name: "read",
      label: "read",
      description: "Returns an unchanged artifact for the convergence test.",
      parameters: Type.Object({ path: Type.String(), offset: Type.Number(), limit: Type.Number() }),
      async execute(_id, params) {
        return {
          content: [{ type: "text" as const, text: `unchanged ${String((params as { path: string }).path)}` }],
          details: { artifactId: "A-changing-id", artifactHash: "stable-content-hash" },
        };
      },
    };
    const harness = new AgentHarness({
      session,
      models,
      model: faux.getModel(),
      tools: [readTool],
      activeToolNames: ["read"],
      systemPrompt: "Read the same range repeatedly.",
    });
    const termination: CodingTurnTermination = {};
    attachCodingTurnGuards(harness, new RepeatedToolFailureBreaker(3), new NoProgressToolBreaker(3), termination);

    const response = await harness.prompt("Continue the investigation.");
    const assistantEntries = (await session.getBranch()).filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    const outcome = await finalizeCodingTurn({
      runId,
      controlStore,
      correlationId: `${runId}:main:chat-turn`,
      userPrompt: "Continue the investigation.",
      response,
      recoveryCount: 0,
      recoveryExhausted: false,
      termination,
      piEntryId: assistantEntries.at(-1)?.id,
      claimVerifier: { project: () => ({ required: false, status: "not_required" }) },
      maintainAfterTurn: async () => undefined,
    });

    assert.equal(faux.state.callCount, 3);
    assert.equal(outcome.stopReason, "stop");
    assert.equal(outcome.errorMessage, undefined);
    assert.equal(outcome.termination, "no_progress");
    assert.match(outcome.text, /no new information/i);
    const assistantEvent = (await controlStore.events(runId)).findLast((event) => event.type === "assistant_message");
    assert.equal(assistantEvent?.payload?.termination, "no_progress");
  } finally {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("a durable mutation in the same batch cancels an order-dependent no-progress stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-no-progress-mixed-"));
  const env = new NodeExecutionEnv({ cwd: root });
  try {
    const faux = fauxProvider({ provider: "faux-no-progress-mixed" });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "same" }, { id: "read-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("read", { path: "same" }, { id: "read-2" }), { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("read", { path: "same" }, { id: "read-3" }),
        fauxToolCall("write", { path: "solve.py", content: "new analysis" }, { id: "write-1" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("continued after durable progress"),
    ]);
    const stableRead: AgentHarnessTool<undefined> = {
      name: "read", label: "read", description: "stable read", parameters: Type.Object({ path: Type.String() }),
      async execute() { return { content: [{ type: "text" as const, text: "same" }], details: { artifactHash: "same-hash" } }; },
    };
    const write: AgentHarnessTool<undefined> = {
      name: "write", label: "write", description: "durable write", parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() { return { content: [{ type: "text" as const, text: "written" }] }; },
    };
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "pi-sessions") });
    const session = await repo.create({ id: "no-progress-mixed", cwd: root });
    const harness = new AgentHarness({ session, models, model: faux.getModel(), tools: [stableRead, write], activeToolNames: ["read", "write"], systemPrompt: "test" });
    const termination: CodingTurnTermination = {};
    attachCodingTurnGuards(harness, new RepeatedToolFailureBreaker(), new NoProgressToolBreaker(), termination);
    const response = await harness.prompt("continue");
    assert.equal(faux.state.callCount, 4);
    assert.equal(response.stopReason, "stop");
    assert.equal(response.content.find((item) => item.type === "text")?.text, "continued after durable progress");
    assert.equal(termination.requested, false);
    assert.equal(termination.reason, undefined);
  } finally {
    await env.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

function task(runId: string, root: string): TaskContract {
  return {
    schema_version: 1,
    task_id: runId,
    mode: "coding_assistant",
    target_kind: "unknown",
    target: root,
    objective: "Repeated tool failure projection test",
    inputs: [],
    success_criteria: [],
    verification: { kind: "reproduction", required_reproductions: 0 },
    scope: { allowed_hosts: ["*"], allowed_ports: [], external_network: false, allowed_workspace: root },
    pause_policy: [],
    constraints: { deadline_ms: 10_000, max_cost_usd: 0, max_tool_calls: 10, max_submissions: 0 },
  };
}
