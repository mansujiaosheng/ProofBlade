import type { HarnessEvent, RunSnapshot, RunStatus, TaskContract } from "../domain/types.js";
import { canonicalJson, sha256 } from "../domain/utils.js";
import { validateReasoningEdge, validateReasoningNode, validateReasoningTree } from "../domain/reasoning.js";

export function createInitialSnapshot(runId: string, task: TaskContract): RunSnapshot {
  return {
    runId,
    task,
    status: "CREATED",
    phase: "intake",
    generation: 0,
    lastSeq: 0,
    facts: {},
    observations: {},
    evidence: {},
    reasoningNodes: {},
    reasoningEdges: {},
    reasoningTrees: {},
    hypotheses: {},
    intents: {},
    schedulerIntents: {},
    completions: {},
    checkpoints: {},
    jobs: {},
    handoffs: {},
    contextOverflowRecoveries: 0,
    artifacts: {},
    effects: {},
    leases: {},
    activeLanes: [],
  };
}

const terminal: RunStatus[] = ["SUCCEEDED", "FAILED", "EXHAUSTED", "CANCELLED", "NEED_HUMAN"];

export function reduce(snapshot: RunSnapshot, event: HarnessEvent): RunSnapshot {
  if (event.seq !== snapshot.lastSeq + 1) {
    throw new Error(`Event sequence gap for ${event.runId}: expected ${snapshot.lastSeq + 1}, got ${event.seq}`);
  }
  const next = structuredClone(snapshot);
  next.lastSeq = event.seq;
  const p = event.payload ?? {};

  switch (event.type) {
    case "run_started":
      next.status = "READY";
      next.startedAt = event.ts;
      next.generation = Number(p.generation ?? 0);
      next.versionSnapshot = p.versionSnapshot as RunSnapshot["versionSnapshot"];
      break;
    case "phase_started":
      next.phase = p.phase as RunSnapshot["phase"];
      if (next.status !== "PAUSED") {
        if (next.phase === "verification") next.status = "VERIFYING";
        else if (next.status === "READY" || next.status === "VERIFYING") next.status = "RUNNING";
      }
      break;
    case "phase_finished":
      if (p.phase) next.phase = p.phase as RunSnapshot["phase"];
      break;
    case "fixture_reset":
      next.generation = Number(p.generation);
      if (!Number.isInteger(next.generation) || next.generation < 1) throw new Error("fixture_reset requires a positive generation");
      break;
    case "run_paused":
      ensureNotTerminal(next.status);
      next.status = "PAUSED";
      break;
    case "run_resumed":
      if (next.status !== "PAUSED") throw new Error(`Cannot resume run in ${next.status}`);
      next.status = "RUNNING";
      break;
    case "run_finished": {
      const status = p.status as RunStatus;
      if (!terminal.includes(status)) throw new Error(`Invalid terminal status: ${String(status)}`);
      if (next.status === "PAUSED") throw new Error(`Cannot transition a paused run to ${status}; resume it first`);
      if (status === "SUCCEEDED" && (p.verified !== true || !Array.isArray(p.evidenceIds) || p.evidenceIds.length === 0)) {
        throw new Error("A successful run requires verifier approval and evidence");
      }
      ensureNotTerminal(next.status);
      next.status = status;
      next.finishedAt = event.ts;
      next.terminalReason = typeof p.reason === "string" ? p.reason : undefined;
      next.failureCategory = status === "SUCCEEDED" ? undefined : p.failureCategory as RunSnapshot["failureCategory"];
      break;
    }
    case "run_failed":
      if (next.status === "PAUSED") throw new Error("Cannot transition a paused run to FAILED; resume it first");
      ensureNotTerminal(next.status);
      next.status = "FAILED";
      next.terminalReason = typeof p.reason === "string" ? p.reason : "run_failed";
      next.failureCategory = p.failureCategory as RunSnapshot["failureCategory"];
      break;
    case "fact_added": {
      const fact = p.fact as RunSnapshot["facts"][string];
      if (!fact?.id) throw new Error("fact_added requires fact");
      next.facts[fact.id] = fact;
      break;
    }
    case "observation_added": {
      const observation = p.observation as RunSnapshot["observations"][string];
      if (!observation?.id) throw new Error("observation_added requires observation");
      next.observations[observation.id] = observation;
      break;
    }
    case "evidence_added": {
      const evidence = p.evidence as RunSnapshot["evidence"][string];
      if (!evidence?.id) throw new Error("evidence_added requires evidence");
      next.evidence[evidence.id] = evidence;
      break;
    }
    case "reasoning_node_upserted": {
      const value = p.node as Omit<RunSnapshot["reasoningNodes"][string], "createdSeq" | "updatedSeq">;
      if (!value?.id) throw new Error("reasoning_node_upserted requires node");
      validateReasoningNode(next, value);
      const previous = next.reasoningNodes[value.id];
      next.reasoningNodes[value.id] = {
        ...value,
        createdSeq: previous?.createdSeq ?? event.seq,
        updatedSeq: event.seq,
      };
      break;
    }
    case "reasoning_edge_added": {
      const value = p.edge as Omit<RunSnapshot["reasoningEdges"][string], "createdSeq">;
      if (!value?.id) throw new Error("reasoning_edge_added requires edge");
      validateReasoningEdge(next, value);
      next.reasoningEdges[value.id] = { ...value, createdSeq: event.seq };
      break;
    }
    case "reasoning_tree_upserted": {
      const value = p.tree as Omit<RunSnapshot["reasoningTrees"][string], "createdSeq" | "updatedSeq">;
      if (!value?.id) throw new Error("reasoning_tree_upserted requires tree");
      validateReasoningTree(next, value);
      const previous = next.reasoningTrees[value.id];
      next.reasoningTrees[value.id] = {
        ...value,
        createdSeq: previous?.createdSeq ?? event.seq,
        updatedSeq: event.seq,
      };
      break;
    }
    case "hypothesis_added": {
      const hypothesis = p.hypothesis as RunSnapshot["hypotheses"][string];
      if (!hypothesis?.id) throw new Error("hypothesis_added requires hypothesis");
      next.hypotheses[hypothesis.id] = hypothesis;
      break;
    }
    case "intent_changed": {
      const intent = p.intent as RunSnapshot["intents"][string];
      if (!intent?.id) throw new Error("intent_changed requires intent");
      next.intents[intent.id] = intent;
      break;
    }
    case "scheduler_intent_changed": {
      const intent = p.intent as RunSnapshot["schedulerIntents"][string];
      if (!intent?.id) throw new Error("scheduler_intent_changed requires intent");
      next.schedulerIntents[intent.id] = intent;
      break;
    }
    case "artifact_registered": {
      const artifact = p.artifact as RunSnapshot["artifacts"][string];
      if (!artifact?.id) throw new Error("artifact_registered requires artifact");
      next.artifacts[artifact.id] = artifact;
      break;
    }
    case "artifact_annotated": {
      const artifact = next.artifacts[String(p.artifactId)];
      if (!artifact) throw new Error(`Unknown artifact ${String(p.artifactId)}`);
      const semantic = p.semantic as RunSnapshot["artifacts"][string]["semantic"];
      if (!semantic?.name) throw new Error("artifact_annotated requires semantic metadata");
      artifact.semantic = semantic;
      break;
    }
    case "effect_proposed": {
      const effect = p.effect as RunSnapshot["effects"][string];
      if (!effect?.id) throw new Error("effect_proposed requires effect");
      next.effects[effect.id] = effect;
      break;
    }
    case "effect_started": {
      const effect = getEffect(next, String(p.effectId));
      effect.status = "STARTED";
      break;
    }
    case "effect_finished": {
      const effect = getEffect(next, String(p.effectId));
      effect.status = "FINISHED";
      effect.outcome = p.outcome as typeof effect.outcome;
      effect.artifactId = typeof p.artifactId === "string" ? p.artifactId : effect.artifactId;
      effect.externalId = typeof p.externalId === "string" ? p.externalId : effect.externalId;
      effect.durationMs = typeof p.durationMs === "number" ? p.durationMs : effect.durationMs;
      effect.outputBytes = typeof p.outputBytes === "number" ? p.outputBytes : effect.outputBytes;
      effect.exitCode = typeof p.exitCode === "number" || p.exitCode === null ? p.exitCode : effect.exitCode;
      effect.errorSignature = typeof p.errorSignature === "string" ? p.errorSignature : effect.errorSignature;
      break;
    }
    case "effect_reconciled": {
      const effect = getEffect(next, String(p.effectId));
      effect.status = p.outcome === "unknown" ? "UNKNOWN" : "RECONCILED";
      effect.outcome = p.outcome as typeof effect.outcome;
      break;
    }
    case "lease_acquired": {
      const lease = p.lease as RunSnapshot["leases"][string];
      if (!lease?.resourceKey) throw new Error("lease_acquired requires lease");
      if (next.leases[lease.resourceKey]) throw new Error(`Resource already leased: ${lease.resourceKey}`);
      next.leases[lease.resourceKey] = lease;
      break;
    }
    case "lease_heartbeat": {
      const resourceKey = String(p.resourceKey);
      const lease = next.leases[resourceKey];
      if (!lease) throw new Error(`Unknown lease: ${resourceKey}`);
      if (p.ownerLane !== lease.ownerLane || Number(p.generation) !== lease.generation) throw new Error(`Lease ownership mismatch: ${resourceKey}`);
      lease.heartbeatAt = String(p.heartbeatAt);
      lease.expiresAt = String(p.expiresAt);
      break;
    }
    case "lease_released":
      delete next.leases[String(p.resourceKey)];
      break;
    case "completion_proposed": {
      const completion = p.completion as RunSnapshot["completions"][string];
      if (!completion?.id) throw new Error("completion_proposed requires completion");
      next.completions[completion.id] = completion;
      break;
    }
    case "completion_verified": {
      const completion = next.completions[String(p.completionId)];
      if (!completion) throw new Error(`Unknown completion ${String(p.completionId)}`);
      completion.status = p.accepted === true ? "ACCEPTED" : "REJECTED";
      completion.evidenceIds = Array.isArray(p.evidenceIds) ? p.evidenceIds.map(String) : [];
      break;
    }
    case "checkpoint_created": {
      const checkpoint = p.checkpoint as RunSnapshot["checkpoints"][string];
      if (!checkpoint?.id) throw new Error("checkpoint_created requires checkpoint");
      next.checkpoints[checkpoint.id] = checkpoint;
      break;
    }
    case "job_queued": {
      const job = p.job as RunSnapshot["jobs"][string];
      if (!job?.id) throw new Error("job_queued requires job");
      next.jobs[job.id] = job;
      break;
    }
    case "job_started": {
      const job = getJob(next, String(p.jobId));
      if (job.status !== "QUEUED" && job.status !== "RUNNING") throw new Error(`Cannot start job in ${job.status}`);
      job.status = "RUNNING";
      job.startedAt = typeof p.startedAt === "string" ? p.startedAt : job.startedAt;
      break;
    }
    case "job_finished": {
      const job = getJob(next, String(p.jobId));
      if (job.status === "CANCELLED") break;
      const status = p.status as typeof job.status;
      if (!["SUCCEEDED", "FAILED", "TIMED_OUT", "UNKNOWN"].includes(status)) throw new Error(`Invalid job terminal status: ${String(status)}`);
      job.status = status;
      job.finishedAt = typeof p.finishedAt === "string" ? p.finishedAt : job.finishedAt;
      job.effectId = typeof p.effectId === "string" ? p.effectId : job.effectId;
      job.artifactId = typeof p.artifactId === "string" ? p.artifactId : job.artifactId;
      job.externalId = typeof p.externalId === "string" ? p.externalId : job.externalId;
      job.outcome = p.outcome as typeof job.outcome;
      job.error = typeof p.error === "string" ? p.error : job.error;
      job.outputTier = p.outputTier as typeof job.outputTier;
      break;
    }
    case "job_cancelled": {
      const job = getJob(next, String(p.jobId));
      if (job.status === "SUCCEEDED" || job.status === "FAILED" || job.status === "TIMED_OUT") break;
      job.status = "CANCELLED";
      job.finishedAt = typeof p.finishedAt === "string" ? p.finishedAt : job.finishedAt;
      job.error = typeof p.reason === "string" ? p.reason : job.error;
      break;
    }
    case "job_reconciled": {
      const job = getJob(next, String(p.jobId));
      job.status = "UNKNOWN";
      job.outcome = "unknown";
      job.error = typeof p.reason === "string" ? p.reason : job.error;
      break;
    }
    case "handoff_proposed": {
      const handoff = p.handoff as RunSnapshot["handoffs"][string];
      if (!handoff?.id) throw new Error("handoff_proposed requires handoff");
      if (handoff.status !== "PROPOSED") throw new Error("handoff_proposed requires PROPOSED status");
      next.handoffs[handoff.id] = handoff;
      break;
    }
    case "handoff_accepted": {
      const handoff = getHandoff(next, String(p.handoffId));
      if (handoff.status !== "PROPOSED" && handoff.status !== "ACCEPTED") throw new Error(`Cannot accept handoff in ${handoff.status}`);
      handoff.status = "ACCEPTED";
      handoff.acceptedSeq = event.seq;
      break;
    }
    case "handoff_superseded": {
      const handoff = getHandoff(next, String(p.handoffId));
      if (handoff.status === "SUPERSEDED" || handoff.status === "REJECTED") break;
      handoff.status = "SUPERSEDED";
      handoff.reason = typeof p.reason === "string" ? p.reason : handoff.reason;
      break;
    }
    case "handoff_rejected": {
      const handoff = getHandoff(next, String(p.handoffId));
      if (handoff.status === "SUPERSEDED" || handoff.status === "REJECTED") break;
      handoff.status = "REJECTED";
      handoff.reason = typeof p.reason === "string" ? p.reason : handoff.reason;
      break;
    }
    case "context_overflow_recovered":
      next.contextOverflowRecoveries += 1;
      break;
    case "turn_started":
    case "assistant_message":
    case "provider_request_started":
    case "provider_response_received":
    case "tool_call_recorded":
    case "tool_result_recorded":
    case "compaction_recorded":
    case "model_usage":
      break;
    default:
      throw new Error(`Unhandled event ${(event as HarnessEvent).type}`);
  }
  next.projectionHash = projectionHash(next);
  return next;
}

function ensureNotTerminal(status: RunStatus): void {
  if (terminal.includes(status)) throw new Error(`Run is already terminal: ${status}`);
}

function getEffect(snapshot: RunSnapshot, effectId: string) {
  const effect = snapshot.effects[effectId];
  if (!effect) throw new Error(`Unknown effect ${effectId}`);
  return effect;
}

function getJob(snapshot: RunSnapshot, jobId: string) {
  const job = snapshot.jobs[jobId];
  if (!job) throw new Error(`Unknown job ${jobId}`);
  return job;
}

function getHandoff(snapshot: RunSnapshot, handoffId: string) {
  const handoff = snapshot.handoffs[handoffId];
  if (!handoff) throw new Error(`Unknown handoff ${handoffId}`);
  return handoff;
}

export function projectionHash(snapshot: RunSnapshot): string {
  const { projectionHash: _ignored, ...withoutHash } = snapshot;
  return sha256(canonicalJson(withoutHash));
}
