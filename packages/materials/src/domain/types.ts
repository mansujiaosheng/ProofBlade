import type { ArtifactAtom, EffectAtom, MessageAtom, ReplayPolicyAtom, SequencedEventAtom } from "@proofblade/atoms";

export type Lane = "main" | "planner" | "executor" | "verifier";

export type ExecutionMode = "auto" | "assist";

export type Phase =
  | "intake"
  | "reconnaissance"
  | "hypothesis"
  | "experiment"
  | "verification"
  | "report";

export type RunStatus =
  | "CREATED"
  | "READY"
  | "RUNNING"
  | "PAUSED"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "EXHAUSTED"
  | "CANCELLED"
  | "NEED_HUMAN";

export type PrimaryFailureCategory =
  | "model_no_tool_call"
  | "bad_tool_args"
  | "tool_timeout"
  | "tool_schema_mismatch"
  | "context_overflow"
  | "context_amnesia"
  | "wrong_hypothesis"
  | "verification_missing"
  | "permission_or_environment"
  | "budget_exhausted"
  | "effect_outcome_unknown"
  | "environment_drift"
  | "prompt_injection_followed"
  | "duplicate_submission"
  | "verifier_disagreement";

export interface RunVersionSnapshot {
  schemaVersion: 1;
  runtimeVersion: string;
  piVersion: string;
  nodeVersion: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  promptVersion: string;
  promptHash: string;
  contextCompilerVersion: string;
  toolContractVersion: string;
  toolContractHash: string;
  routerPolicyVersion: string;
  skillCatalogHash: string;
  skills: Array<{ name: string; contentHash: string }>;
  mcpCatalogHash: string;
  mcpServers: Array<{ name: string; configHash: string; disabled: boolean }>;
  hash: string;
}

export type TargetKind = "unknown" | "web" | "reverse" | "pwn" | "crypto" | "misc" | "mixed";

export interface TaskContract {
  schema_version: 1;
  task_id: string;
  mode: "ctf_solve" | "vulnerability_discovery" | "coding_assistant";
  target_kind: TargetKind;
  target: string;
  objective: string;
  inputs: Array<{ path: string; sha256: string; read_only: boolean }>;
  success_criteria: string[];
  verification: {
    kind: "platform_submission" | "hidden_scorer" | "reproduction";
    command?: string;
    required_reproductions: number;
  };
  scope: {
    allowed_hosts: string[];
    allowed_ports: number[];
    external_network: boolean;
    allowed_workspace: string;
  };
  pause_policy: string[];
  constraints: {
    deadline_ms: number;
    max_cost_usd: number;
    max_tool_calls: number;
    max_submissions: number;
  };
}

export interface Evidence {
  id: string;
  kind: "observation" | "reproduction" | "source" | "negative";
  name?: string;
  summary: string;
  tags?: string[];
  dependsOn?: string[];
  source: { tool?: string; effectId?: string; artifactId?: string; artifactIds?: string[]; generation?: number };
  confidence: number;
  supports: string[];
  refutes: string[];
  createdSeq: number;
}

export interface Observation {
  id: string;
  summary: string;
  source: { operation: string; effectId: string; artifactId: string; generation: number };
  candidateKinds: string[];
  createdSeq: number;
}

export interface Fact {
  id: string;
  statement: string;
  status: "PROPOSED" | "CONFIRMED" | "REJECTED";
  evidenceIds: string[];
  createdSeq: number;
}

export interface Hypothesis {
  id: string;
  statement: string;
  status: "OPEN" | "CONFIRMED" | "REJECTED";
  evidenceIds: string[];
  createdSeq: number;
}

export type ReasoningNodeKind = "artifact" | "observation" | "evidence" | "hypothesis" | "inference" | "claim" | "reproduction" | "result";

export type ReasoningNodeStatus = "OPEN" | "SUPPORTED" | "CONTESTED" | "REFUTED" | "CONFIRMED";

export interface ReasoningNode {
  id: string;
  kind: ReasoningNodeKind;
  name: string;
  summary: string;
  tags: string[];
  status: ReasoningNodeStatus;
  explanation: string;
  reference?: {
    kind: "artifact" | "observation" | "evidence" | "fact" | "hypothesis" | "completion";
    id: string;
  };
  generation: number;
  explainedBy: "harness" | "agent" | "curator" | "user";
  createdSeq: number;
  updatedSeq: number;
}

export type ReasoningEdgeRelation = "derived_from" | "supports" | "refutes" | "depends_on" | "adopts" | "reproduces";

export interface ReasoningEdge {
  id: string;
  from: string;
  to: string;
  relation: ReasoningEdgeRelation;
  explanation: string;
  confidence: number;
  generation: number;
  createdSeq: number;
}

export interface ReasoningTree {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  purpose: string;
  explanation: string;
  rootNodeId: string;
  nodeIds: string[];
  relatedTreeIds: string[];
  status: "ACTIVE" | "SUPPORTED" | "CONTESTED" | "ARCHIVED";
  generation: number;
  explainedBy: "agent" | "curator" | "user";
  createdSeq: number;
  updatedSeq: number;
}

export interface ReasoningForestTreeSummary {
  id: string;
  name: string;
  summary: string;
  tags: string[];
  purpose: string;
  rootNodeId: string;
  status: ReasoningTree["status"];
  nodeCount: number;
  edgeCount: number;
  artifactCount: number;
  evidenceCount: number;
  sharedNodeCount: number;
  relatedTreeIds: string[];
  updatedSeq: number;
}

export interface ReasoningForestIndex {
  version: 1;
  generatedSeq: number;
  trees: ReasoningForestTreeSummary[];
  sharedNodes: Array<{ nodeId: string; treeIds: string[] }>;
  orphanNodeCount: number;
  orphanNodeIds: string[];
  orphanNodes: Array<{ id: string; name: string; summary: string; kind: ReasoningNodeKind; updatedSeq: number }>;
  hash: string;
}

export interface Intent {
  id: string;
  title: string;
  description: string;
  phase: Phase;
  status: "OPEN" | "CLAIMED" | "DONE" | "REJECTED";
  priority: number;
  ownerLane?: Lane;
  createdSeq: number;
}

export interface CompletionProposal {
  id: string;
  candidateHash: string;
  artifactId: string;
  status: "PROPOSED" | "ACCEPTED" | "REJECTED";
  evidenceIds: string[];
  createdSeq: number;
}

export interface CheckpointRef {
  id: string;
  artifactId: string;
  snapshotSeq: number;
  reason: string;
  contextManifestHash?: string;
  createdSeq: number;
}

export type JobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED" | "UNKNOWN";

export interface JobRecord {
  id: string;
  capabilityId: string;
  operation: string;
  args: Record<string, unknown>;
  argsRedacted?: boolean;
  replayPolicy: ReplayPolicy;
  status: JobStatus;
  lane: Lane;
  generation: number;
  timeoutMs?: number;
  createdSeq: number;
  startedAt?: string;
  finishedAt?: string;
  effectId?: string;
  artifactId?: string;
  externalId?: string;
  outcome?: "success" | "error" | "timeout" | "unknown";
  error?: string;
  outputTier?: "small" | "medium" | "large";
}

export type HandoffStatus = "PROPOSED" | "ACCEPTED" | "SUPERSEDED" | "REJECTED";

export interface HandoffAction {
  id: string;
  title: string;
  description: string;
  expectedEvidence: string[];
  resourceKeys: string[];
  estimatedToolCalls: number;
}

export interface HandoffRecord {
  id: string;
  schemaVersion: 1;
  runId: string;
  taskId: string;
  sourceLane: "planner";
  targetLane: "executor";
  knowledgeVersion: string;
  phase: Phase;
  objective: string;
  confirmedFacts: Array<{ id: string; summary: string; evidenceIds: string[] }>;
  hypotheses: Array<{ id: string; statement: string; evidenceIds: string[] }>;
  rejectedHypotheses: Array<{ id: string; statement: string; evidenceIds: string[] }>;
  nextActions: HandoffAction[];
  budget: { remainingMs: number; remainingToolCalls: number };
  requiredArtifacts: string[];
  prohibitedRepeats: string[];
  expectedOutputSchema: string;
  status: HandoffStatus;
  createdSeq: number;
  acceptedSeq?: number;
  reason?: string;
  hash: string;
}

export type ReplayPolicy = ReplayPolicyAtom;

export type ArtifactRole = "supporting" | "intermediate" | "debug" | "result";

export interface ArtifactSemanticMetadata {
  name: string;
  summary: string;
  tags: string[];
  role: ArtifactRole;
  relatedIds: string[];
  annotatedBy: "harness" | "agent" | "user";
  updatedSeq: number;
}

export interface ArtifactRef extends ArtifactAtom {
  id: string;
  sensitivity: "public" | "secret" | "flag_candidate";
  sourceEffectId?: string;
  truncated?: boolean;
  semantic?: ArtifactSemanticMetadata;
}

export interface Effect extends EffectAtom<ReplayPolicy> {
  id: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  status: "PROPOSED" | "STARTED" | "FINISHED" | "UNKNOWN" | "RECONCILED";
  outcome?: "success" | "error" | "timeout" | "unknown";
  artifactId?: string;
  externalId?: string;
  durationMs?: number;
  outputBytes?: number;
  exitCode?: number | null;
  errorSignature?: string;
  createdSeq: number;
}

export interface Lease {
  resourceKey: string;
  ownerLane: Lane;
  generation: number;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface RunSnapshot {
  runId: string;
  task: TaskContract;
  status: RunStatus;
  phase: Phase;
  generation: number;
  lastSeq: number;
  startedAt?: string;
  finishedAt?: string;
  facts: Record<string, Fact>;
  observations: Record<string, Observation>;
  evidence: Record<string, Evidence>;
  reasoningNodes: Record<string, ReasoningNode>;
  reasoningEdges: Record<string, ReasoningEdge>;
  reasoningTrees: Record<string, ReasoningTree>;
  hypotheses: Record<string, Hypothesis>;
  intents: Record<string, Intent>;
  completions: Record<string, CompletionProposal>;
  checkpoints: Record<string, CheckpointRef>;
  jobs: Record<string, JobRecord>;
  handoffs: Record<string, HandoffRecord>;
  contextOverflowRecoveries: number;
  artifacts: Record<string, ArtifactRef>;
  effects: Record<string, Effect>;
  leases: Record<string, Lease>;
  activeLanes: Lane[];
  terminalReason?: string;
  failureCategory?: PrimaryFailureCategory;
  versionSnapshot?: RunVersionSnapshot;
  projectionHash?: string;
}

export type EventType =
  | "run_started"
  | "phase_started"
  | "phase_finished"
  | "fixture_reset"
  | "turn_started"
  | "assistant_message"
  | "observation_added"
  | "effect_proposed"
  | "effect_started"
  | "effect_finished"
  | "effect_reconciled"
  | "fact_added"
  | "intent_changed"
  | "hypothesis_added"
  | "evidence_added"
  | "reasoning_node_upserted"
  | "reasoning_edge_added"
  | "reasoning_tree_upserted"
  | "artifact_registered"
  | "artifact_annotated"
  | "lease_acquired"
  | "lease_heartbeat"
  | "lease_released"
  | "checkpoint_created"
  | "job_queued"
  | "job_started"
  | "job_finished"
  | "job_cancelled"
  | "job_reconciled"
  | "handoff_proposed"
  | "handoff_accepted"
  | "handoff_superseded"
  | "handoff_rejected"
  | "context_overflow_recovered"
  | "completion_proposed"
  | "completion_verified"
  | "provider_request_started"
  | "provider_response_received"
  | "tool_call_recorded"
  | "tool_result_recorded"
  | "compaction_recorded"
  | "model_usage"
  | "run_paused"
  | "run_resumed"
  | "run_finished"
  | "run_failed";

export interface HarnessEvent extends SequencedEventAtom<
  EventType,
  Record<string, unknown>,
  Lane,
  "user" | "orchestrator" | "model" | "tool" | "sandbox"
> {
  schemaVersion: 1;
  runId: string;
}

export interface RawEffectResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  externalId?: string;
}

export interface EffectRequest extends EffectAtom<ReplayPolicy> {
  id: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ContextMessage extends MessageAtom<"system" | "user" | "assistant" | "tool", string> {}

export interface ContextManifest {
  version: 1;
  runId: string;
  lane: Lane;
  phase: Phase;
  compilerVersion: string;
  layerTokens: Record<"L0" | "L1" | "L2" | "L3" | "L4" | "L5", number>;
  factIds: string[];
  hypothesisIds: string[];
  observationIds: string[];
  evidenceIds: string[];
  reasoningTreeIds: string[];
  completionIds: string[];
  jobIds: string[];
  handoffIds: string[];
  artifactIds: string[];
  resources: RuntimeResourceSnapshot;
  memory: {
    standingInstructionHash: string;
    confirmedFactIds: string[];
    rejectedHypothesisIds: string[];
    recalledObservationIds: string[];
    recalledEvidenceIds: string[];
  };
  cache: {
    strategy: "stable-prefix";
    prefixHash: string;
    dynamicHash: string;
    prefixLayerIds: string[];
    dynamicLayerIds: string[];
    prefixTokens: number;
    dynamicTokens: number;
  };
  maintenance: {
    stage: "stable" | "notice" | "snip" | "prune" | "compact";
    ratio: number;
    shouldCompact: boolean;
    forceCompact: boolean;
  };
  dropped: Array<{ kind: string; id?: string; reason: string }>;
  budget: {
    contextWindow: number;
    outputBudget: number;
    safetyMargin: number;
    availableInput: number;
    estimatedInput: number;
    ratio: number;
    overBudget: boolean;
  };
  hash: string;
}

export interface RuntimeResourceSnapshot {
  version: 1;
  skillCatalogHash: string;
  skills: Array<{ name: string; description: string; contentHash: string }>;
  mcpCatalogHash: string;
  mcpServers: Array<{ name: string; description: string; configHash: string }>;
}

export interface ContextBuildInput {
  runId: string;
  lane: Lane;
  phase: Phase;
  task: TaskContract;
  snapshot: RunSnapshot;
  recentMessages?: ContextMessage[];
  contextWindow?: number;
  outputBudget?: number;
  safetyMargin?: number;
  resources?: RuntimeResourceSnapshot;
}

export interface ContextBuildOutput {
  messages: ContextMessage[];
  manifest: ContextManifest;
  estimatedTokens: number;
}
