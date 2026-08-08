import { dirname, join } from "node:path";
import {
  AgentHarness,
  createCustomMessage,
  JsonlSessionRepo,
  NodeExecutionEnv,
  type AgentMessage,
  type AgentHarnessEvent,
} from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolveOutputRewriteConfig, type ProofBladeConfig } from "../config.js";
import type { ControlStore } from "../control/control-store.js";
import { prepareContextMaintenance } from "../context/maintenance-coordinator.js";
import { isRealUserTask, latestExternalUserMessage } from "../context/user-task-anchor.js";
import { CheckpointService } from "../context/checkpoint.js";
import { DurableCompactionCoordinator } from "../context/durable-compaction.js";
import { estimateTokens } from "../domain/utils.js";
import { attachPiObservability } from "../observability/pi-events.js";
import { McpProjectRegistry } from "../mcp/registry.js";
import { ProofBladeSkillRegistry } from "../skills/registry.js";
import { ArtifactStore } from "../effects/artifact-store.js";
import { CodingEvidenceGraph, formatReasoningForestContext } from "../knowledge/evidence-graph.js";
import { EvidenceCurationGate } from "../knowledge/evidence-curation-gate.js";
import { createExecutionEnvRtkProcessRunner, createOutputRewritePort } from "../tools/output-rewrite.js";
import { CodingClaimVerifier } from "../verification/claim-verification.js";
import { codingActiveToolNames, createCodingTools, type CodingResourceContext } from "./coding-resources.js";
import { createConfiguredModels, resolveModelProfile } from "./lmstudio-provider.js";
import type { AgentLanePort, AgentOutcome } from "./pi-adapter.js";
import { promptWithContextLengthRecovery } from "./context-length-recovery.js";
import { attachCodingTurnGuards, finalizeCodingTurn, type CodingTurnTermination } from "./coding-turn-projection.js";
import { NoProgressToolBreaker, RepeatedToolFailureBreaker } from "./tool-repeat-breaker.js";

const CODING_SYSTEM_PROMPT = `You are ProofBlade (证锋), a coding agent working with the user in their current project workspace.

Respond naturally to ordinary conversation. Use workspace tools only when the user's request benefits from inspecting, running, or editing project files. Explain completed work concisely and preserve the user's existing changes.

Ordinary conversation has no implicit challenge fixture or scorer. Read and bash results include a ProofBlade artifact anchor. When workspace inspection produces a materially useful finding, use that stable A-* id with evidence record to give the artifact a human-readable name, concise summary, tags, Evidence, and an optional proposed claim. Record already labels and promotes its artifacts, so do not annotate them first. Use annotate only for reviewed routine/debug output that should not become Evidence. Record only findings that advance or refute a hypothesis. Evidence curation checkpoints report unreviewed artifacts; resolve a required checkpoint with record or annotate before continuing read/bash exploration. Use evidence inspect_forest for orientation, inspect_tree for local provenance, and search/read to recover related findings instead of guessing ids. Reuse shared graph nodes in multiple reasoning trees; label each tree with a concise name, summary, purpose, and explanation.

When the user asks for a CTF flag, challenge answer, recovered secret, or another deterministic result from workspace evidence, inspect the real inputs and test decoy hypotheses against file structures and control flow. Before reporting a final candidate as confirmed, call verify_claim with the exact candidate and a deterministic command that derives and prints it without embedding the candidate literal. Link the supporting evidence ids used by the reproduction. Treat strings output alone as an observation, not verification. If reproduction is still missing, state that the conclusion is unverified and name the missing check.`;

export class PiCodingLane implements AgentLanePort {
  private busy = false;

  private constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly harness: AgentHarness<CodingResourceContext>,
    private readonly env: NodeExecutionEnv,
    private readonly closeTransport: () => Promise<void>,
    private readonly mcp: McpProjectRegistry,
    private readonly claimVerifier: CodingClaimVerifier,
    private readonly maintenance: { compactRequested: boolean },
    private readonly repeatBreaker: RepeatedToolFailureBreaker,
    private readonly progressBreaker: NoProgressToolBreaker,
    private readonly termination: CodingTurnTermination,
    private readonly refreshForestContext: () => Promise<void>,
    private readonly latestAssistantEntryId: () => Promise<string | undefined>,
  ) {}

  public static async create(options: {
    runId: string;
    projectRoot: string;
    runDir: string;
    controlStore: ControlStore;
    config: ProofBladeConfig;
    capabilities?: { enabledTools?: string[]; enabledSkills?: string[]; enabledMcpServers?: string[] };
    onEvent?: (event: AgentHarnessEvent) => void | Promise<void>;
  }): Promise<PiCodingLane> {
    const env = new NodeExecutionEnv({ cwd: options.projectRoot });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(options.runDir, "pi-sessions") });
    const sessionId = `${options.runId}-chat`;
    const known = await repo.list({ cwd: options.projectRoot });
    const metadata = known.find((item) => item.id === sessionId);
    const session = metadata
      ? await repo.open(metadata)
      : await repo.create({
        id: sessionId,
        cwd: options.projectRoot,
        metadata: { runId: options.runId, lane: "main", purpose: "chat" },
      });
    const profile = await resolveModelProfile(options.config.modelProfiles.executor);
    const { models, model, closeTransport } = createConfiguredModels(profile);
    const skills = await ProofBladeSkillRegistry.load(options.projectRoot);
    const mcp = McpProjectRegistry.load(options.projectRoot);
    const enabledTools = options.capabilities?.enabledTools ?? ["read", "bash", "edit", "write"];
    const enabledSkills = new Set(options.capabilities?.enabledSkills ?? skills.list().map((skill) => skill.name));
    const enabledMcpServers = new Set(options.capabilities?.enabledMcpServers ?? mcp.summaries().filter((server) => !server.disabled).map((server) => server.name));
    const resources = skills.piSkills().filter((skill) => enabledSkills.has(skill.name));
    const tools = createCodingTools();
    const activeToolNames = codingActiveToolNames({ tools: enabledTools, skills: [...enabledSkills], mcpServers: [...enabledMcpServers] });
    const artifactStore = new ArtifactStore(dirname(options.runDir), options.controlStore);
    const checkpointService = new CheckpointService(options.controlStore, artifactStore);
    const compactionCoordinator = new DurableCompactionCoordinator(checkpointService);
    const claimVerifier = new CodingClaimVerifier(options.runId, options.controlStore, artifactStore);
    const evidenceGraph = new CodingEvidenceGraph(options.runId, options.controlStore, artifactStore);
    const evidenceCurationGate = new EvidenceCurationGate(options.runId, options.controlStore);
    const forestContext = { value: formatReasoningForestContext(await evidenceGraph.inspectForest()) };
    const outputRewrite = createOutputRewritePort(resolveOutputRewriteConfig(options.config), options.runDir, createExecutionEnvRtkProcessRunner(env));
    const toolContext: CodingResourceContext = {
      env,
      skills,
      mcp,
      enabledSkills,
      enabledMcpServers,
      claimVerifier,
      evidenceGraph,
      evidenceCurationGate,
      outputRewrite: { port: outputRewrite, artifactStore, runId: options.runId },
    };
    const stableSystemPrompt = codingSystemPrompt(resources, mcp.summaries().filter((server) => enabledMcpServers.has(server.name) && !server.disabled));
    const repeatBreaker = new RepeatedToolFailureBreaker();
    const progressBreaker = new NoProgressToolBreaker();
    const termination: CodingTurnTermination = {};
    const harness = new AgentHarness<CodingResourceContext>({
      session,
      models,
      model,
      tools,
      activeToolNames,
      resources: { skills: resources },
      toolContext,
      thinkingLevel: profile.thinkingLevel ?? "off",
      systemPrompt: () => stableSystemPrompt,
      streamOptions: { timeoutMs: profile.requestTimeoutMs, maxRetries: profile.maxRetries, maxRetryDelayMs: profile.maxRetryDelayMs, cacheRetention: profile.cacheRetention },
    });
    attachCodingTurnGuards(harness, repeatBreaker, progressBreaker, termination);
    const maintenance = { compactRequested: false };
    const activeTools = tools.filter((tool) => activeToolNames.includes(tool.name));
    const fixedContextTokens = estimateTokens(stableSystemPrompt) + estimateTokens(JSON.stringify(activeTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))));
    const providerSafetyTokens = Math.min(8_192, Math.max(1_024, Math.floor(profile.contextWindow * 0.1)));
    const contextBudget = Math.max(256, profile.contextWindow - profile.maxTokens - fixedContextTokens - providerSafetyTokens);
    const targetMessageBudget = Math.max(256, Math.floor(contextBudget * 0.5));
    harness.on("context", ({ messages }) => {
      const prepared = prepareContextMaintenance({ messages: injectReasoningForestContext(messages, forestContext.value), availableTokens: contextBudget, messageBudget: targetMessageBudget });
      if (prepared.nextAction === "compact") maintenance.compactRequested = true;
      return { messages: prepared.messages };
    });
    harness.on("session_before_compact", async ({ preparation }) => ({
      compaction: await compactionCoordinator.provide(options.runId, preparation, undefined, {
        maxContextTokens: contextBudget,
        taskAnchor: await latestExternalUserMessageFromSession(session),
      }),
    }));
    attachPiObservability(harness, {
      runId: options.runId,
      lane: "main",
      controlStore: options.controlStore,
    });
    if (options.onEvent) harness.subscribe(options.onEvent);
    return new PiCodingLane(
      options.runId,
      options.controlStore,
      harness,
      env,
      closeTransport,
      mcp,
      claimVerifier,
      maintenance,
      repeatBreaker,
      progressBreaker,
      termination,
      async () => { forestContext.value = formatReasoningForestContext(await evidenceGraph.inspectForest()); },
      async () => {
        const branch = await session.getBranch();
        for (let index = branch.length - 1; index >= 0; index -= 1) {
          const entry = branch[index]!;
          if (entry.type === "message" && entry.message.role === "assistant") return entry.id;
        }
        return undefined;
      },
    );
  }

  public async prompt(text: string): Promise<AgentOutcome> {
    this.repeatBreaker.reset();
    this.progressBreaker.reset();
    delete this.termination.message;
    delete this.termination.reason;
    this.termination.requested = false;
    this.termination.confirmed = false;
    await this.refreshForestContext();
    this.busy = true;
    const correlationId = `${this.runId}:main:chat-turn`;
    await this.controlStore.append(this.runId, [{
      schemaVersion: 1,
      lane: "main",
      correlationId,
      actor: "orchestrator",
      type: "turn_started",
      payload: { promptLength: text.length },
    }]);
    try {
      const recovered = await promptWithContextLengthRecovery({
        prompt: async (prompt) => await this.harness.prompt(prompt),
        compact: async (reason) => {
          await this.harness.compact(reason);
          this.maintenance.compactRequested = false;
        },
      }, text);
      const response = recovered.response;
      return await finalizeCodingTurn({
        runId: this.runId,
        controlStore: this.controlStore,
        correlationId,
        userPrompt: text,
        response,
        recoveryCount: recovered.recoveryCount,
        recoveryExhausted: recovered.exhausted,
        termination: this.termination,
        piEntryId: await this.latestAssistantEntryId(),
        claimVerifier: this.claimVerifier,
        maintainAfterTurn: async () => await this.maintainAfterTurn(response),
      });
    } finally {
      this.busy = false;
    }
  }

  public async abort(_reason: string): Promise<void> {
    await this.harness.abort();
  }

  public async compact(reason: string): Promise<void> {
    await this.harness.compact(reason);
  }

  public async isIdle(): Promise<boolean> {
    return !this.busy;
  }

  public async close(): Promise<void> {
    try {
      await this.harness.waitForIdle();
    } finally {
      try {
        await this.env.cleanup();
      } finally {
        try {
          await this.closeTransport();
        } finally {
          await this.mcp.close();
        }
      }
    }
  }

  private async maintainAfterTurn(response: AssistantMessage): Promise<void> {
    if (!this.maintenance.compactRequested) return;
    this.maintenance.compactRequested = false;
    if (response.stopReason === "error" || response.stopReason === "aborted") return;
    try {
      await this.harness.compact("Compact stale exploration while preserving the latest complete tool exchange, Evidence and Artifact ids, reasoning forest roots, open hypotheses, rejected routes, and the next action.");
    } catch {
      // The append-only Pi transcript and Control Store remain the recovery source.
    }
  }
}

async function latestExternalUserMessageFromSession(session: { getBranch(): Promise<Array<{ type: string; message?: AgentMessage }>> }): Promise<Extract<AgentMessage, { role: "user" }> | undefined> {
  const branch = await session.getBranch();
  return latestExternalUserMessage(branch.flatMap((entry) => entry?.type === "message" && entry.message ? [entry.message] : []));
}

export function injectReasoningForestContext(messages: AgentMessage[], forestContext: string): AgentMessage[] {
  if (!forestContext) return messages;
  const output = [...messages];
  let latestUserIndex = -1;
  for (let index = output.length - 1; index >= 0; index -= 1) {
    if (isRealUserTask(output[index])) { latestUserIndex = index; break; }
  }
  const insertionIndex = latestUserIndex >= 0 ? latestUserIndex : output.length;
  output.splice(insertionIndex, 0, createCustomMessage(
    "proofblade_reasoning_forest",
    forestContext,
    false,
    { durable: true, projection: "forest-index" },
    new Date(0).toISOString(),
  ));
  return output;
}

function codingSystemPrompt(skills: Array<{ name: string; description: string }>, mcpServers: Array<{ name: string; description: string }>): string {
  const resources = [
    skills.length > 0 ? `\nEnabled Skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}\nUse load_skill to load a Skill only when it is relevant.` : "",
    mcpServers.length > 0 ? `\nEnabled MCP servers:\n${mcpServers.map((server) => `- ${server.name}: ${server.description}`).join("\n")}\nUse mcp_call with operation=describe before operation=call.` : "",
  ].join("");
  return `${CODING_SYSTEM_PROMPT}${resources}`;
}
