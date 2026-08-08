import { AgentHarness } from "@earendil-works/pi-agent-core/node";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ControlStore } from "../control/control-store.js";
import type { CodingClaimVerifier } from "../verification/claim-verification.js";
import type { AgentOutcome } from "./pi-adapter.js";
import { NoProgressToolBreaker, RepeatedToolFailureBreaker, noProgressToolMessage, repeatedToolFailureMessage } from "./tool-repeat-breaker.js";

export type CodingTurnTerminationReason = "repeated_tool_failure" | "no_progress";

export interface CodingTurnTermination {
  message?: string;
  requested?: boolean;
  confirmed?: boolean;
  reason?: CodingTurnTerminationReason;
}

export function projectCodingAssistantText(output: string, termination: CodingTurnTermination): string {
  return output.trim().length > 0 ? output : termination.confirmed ? termination.message ?? output : output;
}

export function attachRepeatedToolFailureBreaker<TContext extends object | undefined>(
  harness: AgentHarness<TContext>,
  repeatBreaker: RepeatedToolFailureBreaker,
  termination: CodingTurnTermination,
): () => void {
  return attachCodingTurnGuards(harness, repeatBreaker, undefined, termination);
}

export function attachCodingTurnGuards<TContext extends object | undefined>(
  harness: AgentHarness<TContext>,
  repeatBreaker: RepeatedToolFailureBreaker,
  progressBreaker: NoProgressToolBreaker | undefined,
  termination: CodingTurnTermination,
): () => void {
  let batchOpen = false;
  let batchHasSuccess = false;
  const unsubscribeEvents = harness.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      batchOpen = event.message.content.some((item) => item.type === "toolCall");
      batchHasSuccess = false;
    }
    if (event.type === "turn_end" && batchOpen) {
      if (batchHasSuccess && !termination.requested) repeatBreaker.reset();
      batchOpen = false;
      batchHasSuccess = false;
    }
  });
  const unsubscribeResult = harness.on("tool_result", (event) => {
    if (!event.isError) {
      const observation = {
        toolName: event.toolName,
        input: event.input,
        isError: false,
        content: event.content.map((item) => item.type === "text" ? { type: item.type, text: item.text } : { type: item.type }),
        details: event.details,
      };
      if (progressBreaker?.isProgress(observation) && termination.reason === "no_progress") {
        delete termination.message;
        delete termination.reason;
        termination.requested = false;
      }
      const progress = progressBreaker?.observe(observation);
      if (progress?.terminate) {
        termination.message = noProgressToolMessage(event.toolName, progress.count);
        termination.reason = "no_progress";
        termination.requested = true;
        return {
          content: [{ type: "text" as const, text: termination.message }],
          details: { noProgress: true, toolName: event.toolName, count: progress.count, key: progress.key },
          isError: false,
          terminate: true,
        };
      }
      if (batchOpen) batchHasSuccess = true;
      else repeatBreaker.reset();
      return undefined;
    }
    const decision = repeatBreaker.observe({
      toolName: event.toolName,
      input: event.input,
      isError: event.isError,
      content: event.content.map((item) => item.type === "text" ? { type: item.type, text: item.text } : { type: item.type }),
    });
    if (!decision.terminate) return undefined;
    termination.message = repeatedToolFailureMessage(event.toolName, decision.count);
    termination.reason = "repeated_tool_failure";
    termination.requested = true;
    return {
      content: [{ type: "text" as const, text: termination.message }],
      details: { repeatedFailure: true, toolName: event.toolName, count: decision.count, key: decision.key },
      isError: true,
      terminate: true,
    };
  });
  const unsubscribeProvider = harness.on("before_provider_request", () => {
    if (!termination.requested) return undefined;
    throw new Error(termination.message ?? "ProofBlade stopped a non-converging tool loop.");
  });
  return () => {
    unsubscribeEvents();
    unsubscribeResult();
    unsubscribeProvider();
  };
}

export async function finalizeCodingTurn(options: {
  runId: string;
  controlStore: ControlStore;
  correlationId: string;
  userPrompt: string;
  response: AssistantMessage;
  recoveryCount: number;
  recoveryExhausted: boolean;
  termination: CodingTurnTermination;
  piEntryId?: string;
  claimVerifier: Pick<CodingClaimVerifier, "project">;
  maintainAfterTurn: () => Promise<void>;
}): Promise<AgentOutcome> {
  const rawOutput = options.response.content
    .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const confirmed = options.termination.requested === true
    && options.termination.reason !== undefined
    && rawOutput.trim().length === 0
    && (options.response.stopReason === "toolUse" || options.response.stopReason === "error");
  options.termination.confirmed = confirmed;
  const output = projectCodingAssistantText(rawOutput, options.termination);
  const stopReason = confirmed ? "stop" : options.response.stopReason;
  const errorMessage = confirmed
    ? undefined
    : options.recoveryExhausted
      ? `Context length recovery exhausted after ${options.recoveryCount} attempts.`
      : options.response.errorMessage;
  const claimVerification = options.claimVerifier.project(options.userPrompt, output);
  await options.controlStore.append(options.runId, [{
    schemaVersion: 1,
    lane: "main",
    correlationId: options.correlationId,
    actor: "model",
    type: "assistant_message",
    payload: {
      text: output,
      stopReason,
      claimVerification,
      contextRecoveryCount: options.recoveryCount,
      contextRecoveryExhausted: options.recoveryExhausted,
      piEntryId: options.piEntryId,
      termination: confirmed ? options.termination.reason : undefined,
      providerStopReason: confirmed ? options.response.stopReason : undefined,
    },
  }]);
  await options.maintainAfterTurn();
  return {
    text: output,
    stopReason,
    usage: options.response.usage,
    errorMessage,
    claimVerification,
    termination: confirmed ? options.termination.reason : undefined,
  };
}
