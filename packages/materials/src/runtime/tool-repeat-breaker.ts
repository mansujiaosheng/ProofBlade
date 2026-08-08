import { canonicalJson, sha256 } from "../domain/utils.js";

export interface ToolFailureObservation {
  toolName: string;
  input: Record<string, unknown>;
  isError: boolean;
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

export interface ToolFailureDecision {
  count: number;
  terminate: boolean;
  key: string;
}

/** Stops a lane when the model repeats an identical failing tool call. */
export class RepeatedToolFailureBreaker {
  private lastKey: string | undefined;
  private count = 0;

  public constructor(private readonly threshold = 3) {
    if (!Number.isInteger(threshold) || threshold < 2) throw new Error("Tool failure breaker threshold must be at least 2");
  }

  public observe(observation: ToolFailureObservation): ToolFailureDecision {
    if (!observation.isError) {
      this.reset();
      return { count: 0, terminate: false, key: "" };
    }
    const errorText = observation.content
      .map((item) => item.type === "text" ? item.text ?? "" : "[image]")
      .join("\n")
      .trim()
      .replace(/\s+/g, " ");
    const key = sha256(canonicalJson({
      toolName: observation.toolName,
      input: observation.input,
      error: errorText,
    }));
    this.count = this.lastKey === key ? this.count + 1 : 1;
    this.lastKey = key;
    return { count: this.count, terminate: this.count >= this.threshold, key };
  }

  public reset(): void {
    this.lastKey = undefined;
    this.count = 0;
  }
}

/** Stops read-only investigation loops that repeatedly recover identical information. */
export class NoProgressToolBreaker {
  private readonly recentKeys: string[] = [];
  private readonly counts = new Map<string, number>();

  public constructor(
    private readonly threshold = 3,
    private readonly windowSize = 12,
  ) {
    if (!Number.isInteger(threshold) || threshold < 2) throw new Error("No-progress breaker threshold must be at least 2");
    if (!Number.isInteger(windowSize) || windowSize < threshold) throw new Error("No-progress breaker window must cover the threshold");
  }

  public observe(observation: ToolFailureObservation): ToolFailureDecision {
    if (observation.isError) return { count: 0, terminate: false, key: "" };
    if (isProgressMutation(observation)) {
      this.reset();
      return { count: 0, terminate: false, key: "" };
    }
    const key = observationKey(observation);
    if (!key) return { count: 0, terminate: false, key: "" };
    this.recentKeys.push(key);
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    if (this.recentKeys.length > this.windowSize) {
      const expired = this.recentKeys.shift()!;
      const remaining = (this.counts.get(expired) ?? 1) - 1;
      if (remaining === 0) this.counts.delete(expired);
      else this.counts.set(expired, remaining);
    }
    const count = this.counts.get(key) ?? 0;
    return { count, terminate: count >= this.threshold, key };
  }

  public isProgress(observation: ToolFailureObservation): boolean {
    return !observation.isError && isProgressMutation(observation);
  }

  public reset(): void {
    this.recentKeys.length = 0;
    this.counts.clear();
  }
}

export function repeatedToolFailureMessage(toolName: string, count: number): string {
  return [
    `[ProofBlade repeated tool failure: ${toolName} failed identically ${count} times]`,
    "The current agent turn was stopped to prevent an infinite loop.",
    "Change the operation or arguments, then retry; for evidence curation use evidence record or evidence annotate to resolve pending artifacts.",
  ].join("\n");
}

export function noProgressToolMessage(toolName: string, count: number): string {
  return [
    `[ProofBlade no-progress guard: ${toolName} returned the same observation ${count} times without durable progress]`,
    "The current agent turn was stopped because repeated exploration produced no new information.",
    "Continue in a new turn with a different hypothesis, input range, tool, or analysis method; existing Artifacts and Evidence remain available.",
  ].join("\n");
}

function observationKey(observation: ToolFailureObservation): string | undefined {
  if (observation.toolName === "evidence") {
    const operation = observation.input.operation;
    if (!(["inspect_forest", "inspect_tree", "search", "read"] as unknown[]).includes(operation)) return undefined;
    return sha256(canonicalJson({ toolName: observation.toolName, input: observation.input }));
  }
  if (observation.toolName !== "read" && observation.toolName !== "bash") return undefined;
  const artifactHash = stableArtifactHash(observation.details);
  const output = artifactHash ?? observation.content
    .map((item) => item.type === "text" ? item.text ?? "" : "[image]")
    .join("\n")
    .replace(/\[ProofBlade artifact A-[^;\]]+;[^\]]+\]/g, "[ProofBlade artifact]")
    .replace(/\[ProofBlade evidence curation[\s\S]*$/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return sha256(canonicalJson({ toolName: observation.toolName, input: observation.input, output }));
}

function isProgressMutation(observation: ToolFailureObservation): boolean {
  if (["edit", "write", "verify_claim"].includes(observation.toolName)) return true;
  if (observation.toolName !== "evidence") return false;
  return (["annotate", "record", "link", "create_tree", "update_tree"] as unknown[]).includes(observation.input.operation);
}

function stableArtifactHash(details: unknown): string | undefined {
  if (!isRecord(details)) return undefined;
  if (typeof details.artifactHash === "string") return details.artifactHash;
  const outputRewrite = details.outputRewrite;
  return isRecord(outputRewrite) && typeof outputRewrite.artifactHash === "string" ? outputRewrite.artifactHash : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
