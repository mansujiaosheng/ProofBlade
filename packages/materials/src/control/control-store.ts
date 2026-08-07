import type {
  Evidence,
  Fact,
  HarnessEvent,
  Hypothesis,
  IntentLegacy,
  Lane,
  Phase,
  ReplayPolicy,
  RunSnapshot,
  TaskContract,
  Observation,
  CompletionProposal,
  CheckpointRef,
  JobRecord,
  HandoffRecord,
  PrimaryFailureCategory,
  RunVersionSnapshot,
  ArtifactSemanticMetadata,
  ReasoningEdge,
  ReasoningNode,
  ReasoningTree,
} from "../domain/types.js";
import type { Intent } from "../domain/intent.js";
import { validateReasoningEdge, validateReasoningNode, validateReasoningTree } from "../domain/reasoning.js";
import { canonicalJson, id, isTerminal, sha256 } from "../domain/utils.js";
import { handoffKnowledgeVersion } from "../domain/handoff.js";
import { JsonlControlStore, makeEvent } from "../storage/jsonl-store.js";
import { reduce } from "./reducer.js";
import { KeyedOperationQueue } from "@proofblade/atoms";
import { assertPhaseTransition } from "./phase-machine.js";

export type DomainCommand =
  | { type: "start_phase"; phase: Phase; lane?: Lane }
  | { type: "finish_phase"; phase: Phase; lane?: Lane }
  | { type: "fixture_reset"; generation: number; lane?: Lane }
  | { type: "pause"; reason: string; lane?: Lane }
  | { type: "resume"; lane?: Lane }
  | { type: "finish"; verified: boolean; evidenceIds: string[]; reason: string; failureCategory?: PrimaryFailureCategory; lane?: Lane }
  | { type: "fail"; reason: string; category: PrimaryFailureCategory; lane?: Lane }
  | { type: "exhaust"; reason: string; lane?: Lane }
  | { type: "fact"; fact: Omit<Fact, "createdSeq">; lane?: Lane }
  | { type: "observation"; observation: Omit<Observation, "createdSeq">; lane?: Lane }
  | { type: "evidence"; evidence: Omit<Evidence, "createdSeq">; lane?: Lane }
  | { type: "reasoning_node"; node: Omit<ReasoningNode, "createdSeq" | "updatedSeq">; lane?: Lane }
  | { type: "reasoning_edge"; edge: Omit<ReasoningEdge, "createdSeq">; lane?: Lane }
  | { type: "reasoning_tree"; tree: Omit<ReasoningTree, "createdSeq" | "updatedSeq">; lane?: Lane }
  | { type: "hypothesis"; hypothesis: Omit<Hypothesis, "createdSeq">; lane?: Lane }
  | { type: "intent"; intent: Omit<IntentLegacy, "createdSeq">; lane?: Lane }
  | { type: "scheduler_intent"; intent: Intent; lane?: Lane }
  | { type: "completion_proposed"; completion: Omit<CompletionProposal, "createdSeq" | "status" | "evidenceIds">; lane?: Lane }
  | { type: "completion_verified"; completionId: string; accepted: boolean; evidenceIds: string[]; lane?: Lane }
  | { type: "artifact"; artifact: RunSnapshot["artifacts"][string]; lane?: Lane }
  | { type: "artifact_annotation"; artifactId: string; semantic: Omit<ArtifactSemanticMetadata, "updatedSeq">; lane?: Lane }
  | { type: "effect_proposed"; effect: Omit<RunSnapshot["effects"][string], "createdSeq">; lane?: Lane }
  | { type: "effect_started"; effectId: string; lane?: Lane }
  | { type: "effect_finished"; effectId: string; outcome: "success" | "error" | "timeout" | "unknown"; artifactId?: string; externalId?: string; durationMs?: number; outputBytes?: number; exitCode?: number | null; errorSignature?: string; lane?: Lane }
  | { type: "effect_reconciled"; effectId: string; outcome: "success" | "error" | "timeout" | "unknown"; lane?: Lane }
  | { type: "lease_acquired"; lease: RunSnapshot["leases"][string]; lane?: Lane }
  | { type: "lease_heartbeat"; resourceKey: string; ownerLane: Lane; generation: number; heartbeatAt: string; expiresAt: string; lane?: Lane }
  | { type: "lease_released"; resourceKey: string; ownerLane?: Lane; generation?: number; lane?: Lane }
  | { type: "checkpoint"; checkpoint: Omit<CheckpointRef, "createdSeq">; lane?: Lane }
  | { type: "job_queued"; job: Omit<JobRecord, "createdSeq">; lane?: Lane }
  | { type: "job_started"; jobId: string; startedAt?: string; lane?: Lane }
  | { type: "job_finished"; jobId: string; status: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "UNKNOWN"; outcome: "success" | "error" | "timeout" | "unknown"; effectId?: string; artifactId?: string; externalId?: string; error?: string; outputTier?: "small" | "medium" | "large"; finishedAt?: string; lane?: Lane }
  | { type: "job_cancelled"; jobId: string; reason: string; finishedAt?: string; lane?: Lane }
  | { type: "job_reconciled"; jobId: string; reason: string; lane?: Lane }
  | { type: "handoff_proposed"; handoff: Omit<HandoffRecord, "createdSeq">; lane?: Lane }
  | { type: "handoff_accepted"; handoffId: string; lane?: Lane }
  | { type: "handoff_superseded"; handoffId: string; reason: string; lane?: Lane }
  | { type: "handoff_rejected"; handoffId: string; reason: string; lane?: Lane }
  | { type: "context_recovery"; checkpointId: string; lane?: Lane };

export class ControlStore {
  private readonly operations = new KeyedOperationQueue();

  public constructor(
    private readonly eventStore: JsonlControlStore,
    private readonly versionProvider?: () => Promise<RunVersionSnapshot>,
  ) {}

  public async createRun(runId: string, task: TaskContract): Promise<RunSnapshot> {
    return await this.operations.run(runId, async () => {
      await this.eventStore.persistTask(runId, task);
      const snapshot = await this.eventStore.create(runId, task, await this.versionProvider?.());
      await this.eventStore.saveProjection(snapshot);
      return snapshot;
    });
  }

  public async snapshot(runId: string): Promise<RunSnapshot> {
    return await this.eventStore.replay(runId);
  }

  public async replay(runId: string): Promise<RunSnapshot> {
    return await this.eventStore.replay(runId);
  }

  public async events(runId: string): Promise<HarnessEvent[]> {
    return await this.eventStore.events(runId);
  }

  public async dispatch(runId: string, command: DomainCommand): Promise<HarnessEvent[]> {
    return await this.operations.run(runId, async () => {
      const before = await this.snapshot(runId);
      validateCommand(before, command);
      const lane = command.lane ?? "main";
      const seq = before.lastSeq + 1;
      const event = makeEvent(runId, seq, eventType(command), commandActor(command), lane, payloadFor(command, seq));
      const events = [event];
      const after = reduce(before, event);
      await this.eventStore.append(events);
      await this.eventStore.saveProjection(after);
      return events;
    });
  }

  public async append(runId: string, events: Array<Omit<HarnessEvent, "seq" | "id" | "streamId" | "runId" | "ts">>): Promise<void> {
    await this.operations.run(runId, async () => {
      const snapshot = await this.snapshot(runId);
      const materialized = events.map((event, index) => makeEvent(
        runId,
        snapshot.lastSeq + index + 1,
        event.type,
        event.actor,
        event.lane,
        event.payload,
        event.correlationId,
      ));
      let validated = snapshot;
      for (const event of materialized) validated = reduce(validated, event);
      await this.eventStore.append(materialized);
      await this.eventStore.saveProjection(validated);
    });
  }

  public async runHash(runId: string): Promise<string> {
    const snapshot = await this.replay(runId);
    return sha256(canonicalJson(snapshot));
  }
}

function eventType(command: DomainCommand): HarnessEvent["type"] {
  switch (command.type) {
    case "start_phase": return "phase_started";
    case "finish_phase": return "phase_finished";
    case "fixture_reset": return "fixture_reset";
    case "pause": return "run_paused";
    case "resume": return "run_resumed";
    case "finish": return "run_finished";
    case "fail": return "run_failed";
    case "exhaust": return "run_finished";
    case "fact": return "fact_added";
    case "observation": return "observation_added";
    case "evidence": return "evidence_added";
    case "reasoning_node": return "reasoning_node_upserted";
    case "reasoning_edge": return "reasoning_edge_added";
    case "reasoning_tree": return "reasoning_tree_upserted";
    case "hypothesis": return "hypothesis_added";
    case "intent": return "intent_changed";
    case "scheduler_intent": return "scheduler_intent_changed";
    case "completion_proposed": return "completion_proposed";
    case "completion_verified": return "completion_verified";
    case "artifact": return "artifact_registered";
    case "artifact_annotation": return "artifact_annotated";
    case "effect_proposed": return "effect_proposed";
    case "effect_started": return "effect_started";
    case "effect_finished": return "effect_finished";
    case "effect_reconciled": return "effect_reconciled";
    case "lease_acquired": return "lease_acquired";
    case "lease_heartbeat": return "lease_heartbeat";
    case "lease_released": return "lease_released";
    case "checkpoint": return "checkpoint_created";
    case "job_queued": return "job_queued";
    case "job_started": return "job_started";
    case "job_finished": return "job_finished";
    case "job_cancelled": return "job_cancelled";
    case "job_reconciled": return "job_reconciled";
    case "handoff_proposed": return "handoff_proposed";
    case "handoff_accepted": return "handoff_accepted";
    case "handoff_superseded": return "handoff_superseded";
    case "handoff_rejected": return "handoff_rejected";
    case "context_recovery": return "context_overflow_recovered";
  }
}

function commandActor(command: DomainCommand): HarnessEvent["actor"] {
  return command.type === "effect_finished" || command.type === "effect_started" ? "tool" : "orchestrator";
}

function payloadFor(command: DomainCommand, seq: number): Record<string, unknown> {
  switch (command.type) {
    case "start_phase": return { phase: command.phase };
    case "finish_phase": return { phase: command.phase };
    case "fixture_reset": return { generation: command.generation };
    case "pause": return { reason: command.reason };
    case "resume": return {};
    case "finish": return { status: command.verified ? "SUCCEEDED" : "FAILED", verified: command.verified, evidenceIds: command.evidenceIds, reason: command.reason, failureCategory: command.verified ? undefined : command.failureCategory ?? "verification_missing" };
    case "fail": return { reason: command.reason, failureCategory: command.category };
    case "exhaust": return { status: "EXHAUSTED", verified: false, evidenceIds: [], reason: command.reason, failureCategory: "budget_exhausted" };
    case "fact": return { fact: { ...command.fact, createdSeq: seq } };
    case "observation": return { observation: { ...command.observation, createdSeq: seq } };
    case "evidence": return { evidence: { ...command.evidence, createdSeq: seq } };
    case "reasoning_node": return { node: command.node };
    case "reasoning_edge": return { edge: command.edge };
    case "reasoning_tree": return { tree: command.tree };
    case "hypothesis": return { hypothesis: { ...command.hypothesis, createdSeq: seq } };
    case "intent": return { intent: { ...command.intent, createdSeq: seq } };
    case "scheduler_intent": return { intent: command.intent };
    case "completion_proposed": return { completion: { ...command.completion, status: "PROPOSED", evidenceIds: [], createdSeq: seq } };
    case "completion_verified": return { completionId: command.completionId, accepted: command.accepted, evidenceIds: command.evidenceIds };
    case "artifact": return {
      artifact: command.artifact.semantic
        ? { ...command.artifact, semantic: { ...command.artifact.semantic, updatedSeq: seq } }
        : command.artifact,
    };
    case "artifact_annotation": return { artifactId: command.artifactId, semantic: { ...command.semantic, updatedSeq: seq } };
    case "effect_proposed": return { effect: { ...command.effect, createdSeq: seq } };
    case "effect_started": return { effectId: command.effectId };
    case "effect_finished": return { effectId: command.effectId, outcome: command.outcome, artifactId: command.artifactId, externalId: command.externalId, durationMs: command.durationMs, outputBytes: command.outputBytes, exitCode: command.exitCode, errorSignature: command.errorSignature };
    case "effect_reconciled": return { effectId: command.effectId, outcome: command.outcome };
    case "lease_acquired": return { lease: command.lease };
    case "lease_heartbeat": return { resourceKey: command.resourceKey, ownerLane: command.ownerLane, generation: command.generation, heartbeatAt: command.heartbeatAt, expiresAt: command.expiresAt };
    case "lease_released": return { resourceKey: command.resourceKey };
    case "checkpoint": return { checkpoint: { ...command.checkpoint, createdSeq: seq } };
    case "job_queued": return { job: { ...command.job, createdSeq: seq } };
    case "job_started": return { jobId: command.jobId, startedAt: command.startedAt ?? new Date().toISOString() };
    case "job_finished": return { jobId: command.jobId, status: command.status, outcome: command.outcome, effectId: command.effectId, artifactId: command.artifactId, externalId: command.externalId, error: command.error, outputTier: command.outputTier, finishedAt: command.finishedAt ?? new Date().toISOString() };
    case "job_cancelled": return { jobId: command.jobId, reason: command.reason, finishedAt: command.finishedAt ?? new Date().toISOString() };
    case "job_reconciled": return { jobId: command.jobId, reason: command.reason };
    case "handoff_proposed": return { handoff: { ...command.handoff, createdSeq: seq } };
    case "handoff_accepted": return { handoffId: command.handoffId };
    case "handoff_superseded": return { handoffId: command.handoffId, reason: command.reason };
    case "handoff_rejected": return { handoffId: command.handoffId, reason: command.reason };
    case "context_recovery": return { checkpointId: command.checkpointId };
  }
}

function validateCommand(snapshot: RunSnapshot, command: DomainCommand): void {
  if (snapshot.status === "PAUSED" && (command.type === "finish" || command.type === "fail" || command.type === "exhaust")) {
    throw new Error(`Cannot ${command.type} a paused run; resume it first`);
  }
  if (command.type === "lease_released" && (command.ownerLane !== undefined || command.generation !== undefined)) {
    const lease = snapshot.leases[command.resourceKey];
    if (!lease) return;
    if (command.ownerLane !== lease.ownerLane || command.generation !== lease.generation) {
      throw new Error(`Lease ownership mismatch: ${command.resourceKey}`);
    }
  }
  if (command.type === "artifact_annotation") {
    if (!snapshot.artifacts[command.artifactId]) throw new Error(`Unknown artifact ${command.artifactId}`);
    validateArtifactSemantic(snapshot, command.semantic);
  }
  if (command.type === "artifact" && command.artifact.semantic) validateArtifactSemantic(snapshot, command.artifact.semantic);
  if (command.type === "reasoning_node") validateReasoningNode(snapshot, command.node);
  if (command.type === "reasoning_edge") validateReasoningEdge(snapshot, command.edge);
  if (command.type === "reasoning_tree") validateReasoningTree(snapshot, command.tree);
  if (command.type === "job_queued" && snapshot.status !== "CREATED" && ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"].includes(snapshot.status)) {
    throw new Error(`Cannot queue a job for terminal run ${snapshot.status}`);
  }
  if (command.type === "job_started" || command.type === "job_finished" || command.type === "job_cancelled" || command.type === "job_reconciled") {
    const jobId = command.jobId;
    const job = snapshot.jobs[jobId];
    if (!job) throw new Error(`Unknown job ${jobId}`);
    if (command.type === "job_started" && job.status !== "QUEUED" && job.status !== "RUNNING") throw new Error(`Cannot start job in ${job.status}`);
    if (command.type === "job_finished" && job.status === "CANCELLED") return;
    if (command.type === "job_cancelled" && ["SUCCEEDED", "FAILED", "TIMED_OUT", "UNKNOWN"].includes(job.status)) throw new Error(`Cannot cancel job in ${job.status}`);
  }
  if (command.type === "handoff_proposed") {
    if (isTerminal(snapshot.status)) throw new Error(`Cannot propose a handoff for terminal run ${snapshot.status}`);
    if (command.lane !== "planner") throw new Error("Handoff proposals are restricted to the planner lane");
    if (command.handoff.sourceLane !== "planner" || command.handoff.targetLane !== "executor") throw new Error("Handoff lanes are fixed to planner -> executor");
    if (command.handoff.runId !== snapshot.runId || command.handoff.taskId !== snapshot.task.task_id) throw new Error("Handoff task identity mismatch");
    if (snapshot.handoffs[command.handoff.id]) throw new Error(`Handoff already exists: ${command.handoff.id}`);
  }
  if (command.type === "handoff_accepted" || command.type === "handoff_superseded" || command.type === "handoff_rejected") {
    const handoff = snapshot.handoffs[command.handoffId];
    if (!handoff) throw new Error(`Unknown handoff ${command.handoffId}`);
    if (command.type === "handoff_accepted") {
      if (isTerminal(snapshot.status)) throw new Error(`Cannot accept a handoff for terminal run ${snapshot.status}`);
      if (command.lane !== "executor") throw new Error("Handoff acceptance is restricted to the executor lane");
      if (handoff.status !== "PROPOSED" && handoff.status !== "ACCEPTED") throw new Error(`Cannot accept handoff in ${handoff.status}`);
      if (handoff.knowledgeVersion !== handoffKnowledgeVersion(snapshot)) throw new Error(`Handoff is stale: ${handoff.id}`);
    }
    if (command.type === "handoff_superseded" && handoff.status === "REJECTED") throw new Error("A rejected handoff cannot be superseded");
  }
  if (command.type === "start_phase") assertPhaseTransition(snapshot, command.phase);
  if (command.type === "completion_verified" && command.lane !== "verifier") {
    throw new Error("Completion verification is restricted to the verifier lane");
  }
  if (command.type === "fact" && command.fact.status === "CONFIRMED" && command.lane !== "verifier") {
    throw new Error("Confirmed facts are restricted to the verifier lane");
  }
  if (command.type !== "finish" || !command.verified) return;
  if (command.lane !== "verifier") throw new Error("A successful run can only be committed by the verifier lane");
  const completion = Object.values(snapshot.completions).find((item) => item.status === "ACCEPTED");
  if (!completion) throw new Error("A successful run requires an accepted completion proposal");
  const evidence = command.evidenceIds.map((id) => snapshot.evidence[id]);
  if (evidence.some((item) => !item)) throw new Error("A successful run references unknown evidence");
  if (!evidence.some((item) => item?.kind === "reproduction")) throw new Error("A successful run requires reproduction evidence");
  if (command.evidenceIds.length < snapshot.task.verification.required_reproductions) {
    throw new Error(`A successful run requires ${snapshot.task.verification.required_reproductions} evidence records`);
  }
  if (!command.evidenceIds.every((id) => completion.evidenceIds.includes(id))) {
    throw new Error("Completion verification does not cover every final evidence id");
  }
}

function validateArtifactSemantic(snapshot: RunSnapshot, semantic: Omit<ArtifactSemanticMetadata, "updatedSeq"> | ArtifactSemanticMetadata): void {
  if (!semantic.name.trim() || semantic.name.length > 160) throw new Error("Artifact name must contain 1-160 characters");
  if (!semantic.summary.trim() || semantic.summary.length > 1_000) throw new Error("Artifact summary must contain 1-1000 characters");
  if (semantic.tags.length > 16 || semantic.tags.some((tag) => !tag.trim() || tag.length > 40)) throw new Error("Artifact tags must contain at most 16 values of 1-40 characters");
  if (!(["supporting", "intermediate", "debug", "result"] as string[]).includes(semantic.role)) throw new Error(`Unknown artifact role: ${String(semantic.role)}`);
  if (!(["harness", "agent", "user"] as string[]).includes(semantic.annotatedBy)) throw new Error(`Unknown artifact annotator: ${String(semantic.annotatedBy)}`);
  if (semantic.relatedIds.length > 32) throw new Error("Artifact related ids must contain at most 32 values");
  const known = new Set([
    ...Object.keys(snapshot.artifacts),
    ...Object.keys(snapshot.evidence),
    ...Object.keys(snapshot.facts),
    ...Object.keys(snapshot.hypotheses),
    ...Object.keys(snapshot.completions),
    ...Object.keys(snapshot.observations),
    ...Object.keys(snapshot.reasoningNodes),
    ...Object.keys(snapshot.reasoningTrees),
  ]);
  const missing = semantic.relatedIds.filter((id) => !known.has(id));
  if (missing.length > 0) throw new Error(`Unknown related ids: ${missing.join(", ")}`);
}

export function createEffectInput(runId: string, operation: string, args: Record<string, unknown>, replayPolicy: ReplayPolicy, generation: number): { effectId: string; idempotencyKey: string } {
  const normalizedArgs = canonicalJson(args);
  return { effectId: id("EF"), idempotencyKey: sha256(`${runId}:${operation}:${normalizedArgs}:${generation}:${replayPolicy}`) };
}
