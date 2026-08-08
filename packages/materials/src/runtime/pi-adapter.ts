import { join } from "node:path";
import {
  AgentHarness,
  createReadTool,
  JsonlSessionRepo,
  NodeExecutionEnv,
  type ExecutionToolContext,
} from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ControlStore } from "../control/control-store.js";
import type { Lane } from "../domain/types.js";
import { ContextCompiler, contextText } from "../context/compiler.js";
import type { ProofBladeConfig } from "../config.js";
import { createConfiguredModels, resolveModelProfile } from "./lmstudio-provider.js";
import { attachPiObservability } from "../observability/pi-events.js";
import type { ClaimVerificationProjection } from "../verification/claim-verification.js";

export interface AgentOutcome {
  text: string;
  stopReason: string;
  usage: AssistantMessage["usage"];
  errorMessage?: string;
  claimVerification?: ClaimVerificationProjection;
  termination?: "repeated_tool_failure" | "no_progress";
}

export interface AgentLanePort {
  prompt(text: string): Promise<AgentOutcome>;
  compact(reason: string): Promise<void>;
  abort(reason: string): Promise<void>;
  isIdle(): Promise<boolean>;
  close(): Promise<void>;
}

export class PiAgentLane implements AgentLanePort {
  private busy = false;

  private constructor(
    private readonly runId: string,
    private readonly lane: Lane,
    private readonly controlStore: ControlStore,
    private readonly harness: AgentHarness<ExecutionToolContext>,
  ) {}

  public static async create(options: {
    runId: string;
    lane?: Lane;
    runDir: string;
    controlStore: ControlStore;
    config: ProofBladeConfig;
  }): Promise<PiAgentLane> {
    const lane = options.lane ?? "executor";
    const env = new NodeExecutionEnv({ cwd: options.runDir });
    const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(options.runDir, "pi-sessions") });
    const sessionId = `${options.runId}-${lane}`;
    const known = await repo.list({ cwd: options.runDir });
    const metadata = known.find((item) => item.id === sessionId);
    const session = metadata
      ? await repo.open(metadata)
      : await repo.create({ id: sessionId, cwd: options.runDir, metadata: { runId: options.runId, lane } });
    const profile = await resolveModelProfile(options.config.modelProfiles.executor);
    const { models, model } = createConfiguredModels(profile);
    const snapshot = await options.controlStore.snapshot(options.runId);
    const compiled = new ContextCompiler().build({
      runId: options.runId,
      lane,
      phase: snapshot.phase,
      task: snapshot.task,
      snapshot,
      contextWindow: profile.contextWindow,
    });
    const readTool = createReadTool<ExecutionToolContext>();
    const harness = new AgentHarness<ExecutionToolContext>({
      session,
      models,
      model,
      tools: [readTool],
      activeToolNames: ["read"],
      toolContext: { env },
      thinkingLevel: profile.thinkingLevel ?? "off",
      systemPrompt: contextText(compiled),
      streamOptions: { timeoutMs: profile.requestTimeoutMs, maxRetries: profile.maxRetries, maxRetryDelayMs: profile.maxRetryDelayMs, cacheRetention: profile.cacheRetention },
    });
    attachPiObservability(harness, {
      runId: options.runId,
      lane,
      controlStore: options.controlStore,
      estimateContextTokens: async () => {
        const current = await options.controlStore.snapshot(options.runId);
        return new ContextCompiler().build({ runId: options.runId, lane, phase: current.phase, task: current.task, snapshot: current, contextWindow: profile.contextWindow }).estimatedTokens;
      },
    });
    return new PiAgentLane(options.runId, lane, options.controlStore, harness);
  }

  public async prompt(text: string): Promise<AgentOutcome> {
    this.busy = true;
    await this.controlStore.append(this.runId, [{
      schemaVersion: 1,
      lane: this.lane,
      correlationId: `${this.runId}:${this.lane}:turn`,
      actor: "orchestrator",
      type: "turn_started",
      payload: { promptHash: text.length },
    }]);
    try {
      const response = await this.harness.prompt(text);
      const output = response.content
        .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      await this.controlStore.append(this.runId, [
        {
          schemaVersion: 1,
          lane: this.lane,
          correlationId: `${this.runId}:${this.lane}:turn`,
          actor: "model",
          type: "assistant_message",
          payload: { text: output, stopReason: response.stopReason },
        },
      ]);
      return { text: output, stopReason: response.stopReason, usage: response.usage, errorMessage: response.errorMessage };
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
    await this.harness.waitForIdle();
  }
}
