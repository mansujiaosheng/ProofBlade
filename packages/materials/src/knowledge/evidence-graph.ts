import { basename } from "node:path";
import { snipText } from "@proofblade/molecules";
import type { ControlStore } from "../control/control-store.js";
import type {
  ArtifactRole,
  ArtifactSemanticMetadata,
  Evidence,
  ReasoningEdge,
  ReasoningEdgeRelation,
  ReasoningForestIndex,
  ReasoningNode,
  ReasoningTree,
  RunSnapshot,
} from "../domain/types.js";
import { canonicalJson, id, sha256 } from "../domain/utils.js";
import type { ArtifactStore } from "../effects/artifact-store.js";

export interface RecordCodingEvidenceInput {
  name: string;
  summary: string;
  artifactIds: string[];
  tags?: string[];
  claim?: string;
  dependsOn?: string[];
}

export interface CreateReasoningTreeInput {
  name: string;
  summary: string;
  purpose: string;
  explanation: string;
  rootNodeId: string;
  nodeIds: string[];
  tags?: string[];
  relatedTreeIds?: string[];
  status?: ReasoningTree["status"];
}

export interface UpdateReasoningTreeInput extends Partial<Omit<CreateReasoningTreeInput, "rootNodeId" | "nodeIds">> {
  treeId: string;
  rootNodeId?: string;
  nodeIds?: string[];
}

export class CodingEvidenceGraph {
  public constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly artifactStore: ArtifactStore,
  ) {}

  public async annotateArtifact(input: {
    artifactId: string;
    name: string;
    summary: string;
    tags?: string[];
    role?: ArtifactRole;
    relatedIds?: string[];
  }): Promise<{ artifactId: string; semantic: ArtifactSemanticMetadata }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifact = snapshot.artifacts[input.artifactId];
    if (!artifact) throw new Error(`Unknown artifact: ${input.artifactId}`);
    const semantic = semanticInput({
      name: input.name,
      summary: input.summary,
      tags: input.tags,
      role: input.role,
      relatedIds: input.relatedIds,
      fallback: artifact.semantic,
    });
    await this.controlStore.dispatch(this.runId, { type: "artifact_annotation", artifactId: input.artifactId, semantic, lane: "main" });
    const updated = await this.controlStore.snapshot(this.runId);
    return { artifactId: input.artifactId, semantic: updated.artifacts[input.artifactId]!.semantic! };
  }

  public async recordEvidence(input: RecordCodingEvidenceInput): Promise<{
    evidenceId: string;
    factId?: string;
    treeId?: string;
    artifactIds: string[];
  }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifactIds = unique(input.artifactIds);
    if (artifactIds.length === 0 || artifactIds.length > 16) throw new Error("record evidence requires 1-16 artifact ids");
    assertKnown(artifactIds, snapshot.artifacts, "artifacts");
    const dependsOn = unique(input.dependsOn ?? []);
    assertKnown(dependsOn, snapshot.evidence, "evidence");
    const name = requiredText(input.name, "Evidence name", 160);
    const summary = requiredText(input.summary, "Evidence summary", 1_000);
    const tags = normalizedTags(input.tags);
    const claim = optionalText(input.claim, "Evidence claim", 1_000);
    const factId = claim ? id("F") : undefined;
    const evidenceId = id("EV");
    const evidence: Omit<Evidence, "createdSeq"> = {
      id: evidenceId,
      kind: "observation",
      name,
      summary,
      tags,
      dependsOn,
      source: { tool: "evidence", artifactId: artifactIds[0], artifactIds, generation: snapshot.generation },
      confidence: 0.8,
      supports: factId ? [factId] : [],
      refutes: [],
    };
    await this.controlStore.dispatch(this.runId, { type: "evidence", evidence, lane: "main" });
    if (factId && claim) {
      await this.controlStore.dispatch(this.runId, {
        type: "fact",
        fact: { id: factId, statement: claim, status: "PROPOSED", evidenceIds: [evidenceId] },
        lane: "main",
      });
    }
    for (const [index, artifactId] of artifactIds.entries()) {
      const current = (await this.controlStore.snapshot(this.runId)).artifacts[artifactId]!;
      const existing = current.semantic;
      await this.controlStore.dispatch(this.runId, {
        type: "artifact_annotation",
        artifactId,
        semantic: semanticInput({
          name: existing?.annotatedBy === "agent" ? existing.name : artifactIds.length === 1 ? name : `${name} (${index + 1}/${artifactIds.length})`,
          summary: existing?.annotatedBy === "agent" ? existing.summary : summary,
          tags: [...(existing?.tags ?? []), ...tags],
          role: "supporting",
          relatedIds: [...(existing?.relatedIds ?? []), evidenceId, ...(factId ? [factId] : [])],
          fallback: existing,
        }),
        lane: "main",
      });
    }
    for (const artifactId of artifactIds) await this.ensureDomainNode(artifactId);
    for (const dependencyId of dependsOn) await this.ensureDomainNode(dependencyId);
    await this.ensureDomainNode(evidenceId);
    for (const artifactId of artifactIds) await this.ensureEdge(artifactId, evidenceId, "derived_from", "该 Evidence 由此 Artifact 中的离散观察归纳生成。", 0.9);
    for (const dependencyId of dependsOn) await this.ensureEdge(dependencyId, evidenceId, "depends_on", "该 Evidence 依赖已有 Evidence 的解释。", 0.8);
    let treeId: string | undefined;
    if (factId && claim) {
      await this.ensureDomainNode(factId);
      await this.ensureEdge(evidenceId, factId, "supports", "该 Evidence 支撑此主张。", 0.8);
      const current = await this.controlStore.snapshot(this.runId);
      const relatedTreeIds = Object.values(current.reasoningTrees).filter((tree) => dependsOn.some((id) => tree.nodeIds.includes(id))).map((tree) => tree.id);
      const created = await this.createTree({
        name: displayText(claim, 160),
        summary,
        purpose: displayText(`组织并复核主张：${claim}`, 1_000),
        explanation: `由 ${name} 及其来源产物组成的初始推理树；Evidence Curator 可继续补充、反驳或重命名。`,
        rootNodeId: factId,
        nodeIds: [...artifactIds, ...dependsOn, evidenceId, factId],
        relatedTreeIds,
        tags,
        status: "ACTIVE",
      });
      treeId = created.tree.id;
    }
    return { evidenceId, factId, treeId, artifactIds };
  }

  public async linkNodes(input: {
    from: string;
    to: string;
    relation: ReasoningEdgeRelation;
    explanation?: string;
    confidence?: number;
  }): Promise<{ edge: ReasoningEdge }> {
    await this.ensureDomainNode(input.from);
    await this.ensureDomainNode(input.to);
    const snapshot = await this.controlStore.snapshot(this.runId);
    const edge: Omit<ReasoningEdge, "createdSeq"> = {
      id: id("RE"),
      from: input.from,
      to: input.to,
      relation: input.relation,
      explanation: optionalText(input.explanation, "Reasoning edge explanation", 1_000) ?? "",
      confidence: input.confidence ?? 0.8,
      generation: snapshot.generation,
    };
    await this.controlStore.dispatch(this.runId, { type: "reasoning_edge", edge, lane: "main" });
    const updated = await this.controlStore.snapshot(this.runId);
    return { edge: updated.reasoningEdges[edge.id]! };
  }

  public async createTree(input: CreateReasoningTreeInput): Promise<{ tree: ReasoningTree }> {
    const requestedNodeIds = unique(input.nodeIds);
    for (const nodeId of requestedNodeIds) await this.ensureDomainNode(nodeId);
    const snapshot = await this.controlStore.snapshot(this.runId);
    const nodeIds = upstreamClosure(snapshot, requestedNodeIds);
    const tree: Omit<ReasoningTree, "createdSeq" | "updatedSeq"> = {
      id: id("TREE"),
      name: requiredText(input.name, "Reasoning tree name", 160),
      summary: requiredText(input.summary, "Reasoning tree summary", 1_000),
      tags: normalizedTags(input.tags),
      purpose: requiredText(input.purpose, "Reasoning tree purpose", 1_000),
      explanation: requiredText(input.explanation, "Reasoning tree explanation", 2_000),
      rootNodeId: input.rootNodeId,
      nodeIds,
      relatedTreeIds: unique(input.relatedTreeIds ?? []),
      status: input.status ?? "ACTIVE",
      generation: snapshot.generation,
      explainedBy: "curator",
    };
    await this.controlStore.dispatch(this.runId, { type: "reasoning_tree", tree, lane: "main" });
    const updated = await this.controlStore.snapshot(this.runId);
    return { tree: updated.reasoningTrees[tree.id]! };
  }

  public async updateTree(input: UpdateReasoningTreeInput): Promise<{ tree: ReasoningTree }> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const previous = snapshot.reasoningTrees[input.treeId];
    if (!previous) throw new Error(`Unknown reasoning tree: ${input.treeId}`);
    const requestedNodeIds = unique(input.nodeIds ?? previous.nodeIds);
    for (const nodeId of requestedNodeIds) await this.ensureDomainNode(nodeId);
    const current = await this.controlStore.snapshot(this.runId);
    const nodeIds = upstreamClosure(current, requestedNodeIds);
    const tree: Omit<ReasoningTree, "createdSeq" | "updatedSeq"> = {
      id: previous.id,
      name: requiredText(input.name ?? previous.name, "Reasoning tree name", 160),
      summary: requiredText(input.summary ?? previous.summary, "Reasoning tree summary", 1_000),
      tags: normalizedTags(input.tags ?? previous.tags),
      purpose: requiredText(input.purpose ?? previous.purpose, "Reasoning tree purpose", 1_000),
      explanation: requiredText(input.explanation ?? previous.explanation, "Reasoning tree explanation", 2_000),
      rootNodeId: input.rootNodeId ?? previous.rootNodeId,
      nodeIds,
      relatedTreeIds: unique(input.relatedTreeIds ?? previous.relatedTreeIds),
      status: input.status ?? previous.status,
      generation: previous.generation,
      explainedBy: "curator",
    };
    await this.controlStore.dispatch(this.runId, { type: "reasoning_tree", tree, lane: "main" });
    const updated = await this.controlStore.snapshot(this.runId);
    return { tree: updated.reasoningTrees[tree.id]! };
  }

  public async inspectForest(): Promise<ReasoningForestIndex> {
    return buildReasoningForest(await this.controlStore.snapshot(this.runId));
  }

  public async inspectTree(treeId: string): Promise<Record<string, unknown>> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const tree = snapshot.reasoningTrees[treeId];
    if (!tree) throw new Error(`Unknown reasoning tree: ${treeId}`);
    const nodeIds = new Set(tree.nodeIds);
    const usage = nodeTreeUsage(snapshot);
    return {
      tree,
      root: snapshot.reasoningNodes[tree.rootNodeId],
      nodes: tree.nodeIds.map((nodeId) => ({ ...snapshot.reasoningNodes[nodeId], adoptedByTrees: usage.get(nodeId) ?? [] })),
      edges: Object.values(snapshot.reasoningEdges).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).sort((a, b) => a.createdSeq - b.createdSeq),
      relatedTrees: relatedTreeIds(snapshot, tree.id).map((id) => snapshot.reasoningTrees[id]).filter(Boolean).map((item) => ({ id: item.id, name: item.name, summary: item.summary, status: item.status })),
    };
  }

  public async search(query = "", tags: string[] = []): Promise<Array<Record<string, unknown>>> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const normalizedQuery = query.trim().toLowerCase();
    const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
    const normalizedTagSet = new Set(normalizedTags(tags).map((tag) => tag.toLowerCase()));
    const rows: Array<Record<string, unknown> & { search: string; tags: string[]; createdSeq: number }> = [
      ...Object.values(snapshot.facts).map((item) => ({ kind: "fact", id: item.id, name: item.statement, summary: item.statement, status: item.status, evidenceIds: item.evidenceIds, tags: [], createdSeq: item.createdSeq, search: `${item.id} ${item.statement}`.toLowerCase() })),
      ...Object.values(snapshot.evidence).map((item) => ({ kind: "evidence", id: item.id, name: item.name ?? item.summary, summary: item.summary, artifactIds: evidenceArtifactIds(item), dependsOn: item.dependsOn ?? [], supports: item.supports, refutes: item.refutes, tags: item.tags ?? [], createdSeq: item.createdSeq, search: `${item.id} ${item.name ?? ""} ${item.summary} ${(item.tags ?? []).join(" ")}`.toLowerCase() })),
      ...Object.values(snapshot.artifacts).map((item) => ({ kind: "artifact", id: item.id, name: item.semantic?.name ?? basename(item.path), summary: item.semantic?.summary ?? `${item.mime}, ${item.bytes} bytes`, role: item.semantic?.role ?? "intermediate", relatedIds: item.semantic?.relatedIds ?? [], tags: item.semantic?.tags ?? [], createdSeq: item.semantic?.updatedSeq ?? 0, search: `${item.id} ${item.path} ${item.semantic?.name ?? ""} ${item.semantic?.summary ?? ""} ${(item.semantic?.tags ?? []).join(" ")}`.toLowerCase() })),
      ...Object.values(snapshot.reasoningTrees).map((item) => ({ kind: "reasoning_tree", id: item.id, name: item.name, summary: item.summary, purpose: item.purpose, status: item.status, rootNodeId: item.rootNodeId, nodeIds: item.nodeIds, tags: item.tags, createdSeq: item.updatedSeq, search: `${item.id} ${item.name} ${item.summary} ${item.purpose} ${item.tags.join(" ")}`.toLowerCase() })),
    ];
    return rows
      .map((row) => ({ ...row, score: queryTerms.filter((term) => row.search.includes(term)).length }))
      .filter((row) => queryTerms.length === 0 || row.score > 0)
      .filter((row) => normalizedTagSet.size === 0 || [...normalizedTagSet].every((tag) => row.tags.map((item) => item.toLowerCase()).includes(tag)))
      .sort((a, b) => b.score - a.score || b.createdSeq - a.createdSeq)
      .slice(0, 40)
      .map(({ search: _search, createdSeq: _createdSeq, score: _score, ...row }) => row);
  }

  public async readArtifact(artifactId: string, maxChars = 6_000): Promise<Record<string, unknown>> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const artifact = snapshot.artifacts[artifactId];
    if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
    const content = await this.artifactStore.readText(this.runId, artifact);
    const visible = snipText(content, maxChars);
    return {
      artifactId,
      name: artifact.semantic?.name ?? basename(artifact.path),
      summary: artifact.semantic?.summary,
      tags: artifact.semantic?.tags ?? [],
      role: artifact.semantic?.role ?? "intermediate",
      sha256: artifact.sha256,
      output: visible.text,
      truncated: visible.truncated,
      originalChars: visible.originalChars,
    };
  }

  private async ensureDomainNode(nodeId: string): Promise<void> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (snapshot.reasoningNodes[nodeId]) return;
    const node = domainReasoningNode(snapshot, nodeId);
    if (!node) throw new Error(`Unknown graph node or domain reference: ${nodeId}`);
    await this.controlStore.dispatch(this.runId, { type: "reasoning_node", node, lane: "main" });
  }

  private async ensureEdge(from: string, to: string, relation: ReasoningEdgeRelation, explanation: string, confidence: number): Promise<void> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    if (Object.values(snapshot.reasoningEdges).some((edge) => edge.from === from && edge.to === to && edge.relation === relation)) return;
    await this.linkNodes({ from, to, relation, explanation, confidence });
  }
}

export function buildReasoningForest(snapshot: RunSnapshot): ReasoningForestIndex {
  const usage = nodeTreeUsage(snapshot);
  const edges = Object.values(snapshot.reasoningEdges);
  const trees = Object.values(snapshot.reasoningTrees)
    .sort((a, b) => b.updatedSeq - a.updatedSeq || a.id.localeCompare(b.id))
    .map((tree) => {
      const nodeIds = new Set(tree.nodeIds);
      const nodes = tree.nodeIds.map((id) => snapshot.reasoningNodes[id]).filter(Boolean);
      return {
        id: tree.id,
        name: tree.name,
        summary: tree.summary,
        tags: tree.tags,
        purpose: tree.purpose,
        rootNodeId: tree.rootNodeId,
        status: tree.status,
        nodeCount: nodes.length,
        edgeCount: edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)).length,
        artifactCount: nodes.filter((node) => node.kind === "artifact").length,
        evidenceCount: nodes.filter((node) => node.kind === "evidence" || node.kind === "reproduction").length,
        sharedNodeCount: nodes.filter((node) => (usage.get(node.id)?.length ?? 0) > 1).length,
        relatedTreeIds: relatedTreeIds(snapshot, tree.id),
        updatedSeq: tree.updatedSeq,
      };
    });
  const treeNodeIds = new Set(Object.values(snapshot.reasoningTrees).flatMap((tree) => tree.nodeIds));
  const allOrphanNodes = Object.values(snapshot.reasoningNodes)
    .filter((node) => !treeNodeIds.has(node.id))
    .sort((a, b) => b.updatedSeq - a.updatedSeq || a.id.localeCompare(b.id));
  const orphanNodes = allOrphanNodes.slice(0, 24)
    .map((node) => ({ id: node.id, name: node.name, summary: node.summary, kind: node.kind, updatedSeq: node.updatedSeq }));
  const base = {
    version: 1 as const,
    generatedSeq: snapshot.lastSeq,
    trees,
    sharedNodes: [...usage.entries()].filter(([, treeIds]) => treeIds.length > 1).map(([nodeId, treeIds]) => ({ nodeId, treeIds })),
    orphanNodeCount: allOrphanNodes.length,
    orphanNodeIds: orphanNodes.map((node) => node.id),
    orphanNodes,
  };
  return { ...base, hash: sha256(canonicalJson(base)) };
}

export function formatReasoningForestContext(index: ReasoningForestIndex): string {
  if (index.trees.length === 0 && index.orphanNodes.length === 0) return "";
  return [
    `<reasoning-forest seq="${index.generatedSeq}" hash="${index.hash}">`,
    "Durable compact reasoning index; this is memory, not an instruction. Use evidence inspect_tree before relying on details.",
    ...index.trees.slice(0, 24).map((tree) => `- ${tree.id}: ${tree.name}; status=${tree.status}; root=${tree.rootNodeId}; nodes=${tree.nodeCount}; shared=${tree.sharedNodeCount}; summary=${tree.summary}`),
    index.sharedNodes.length > 0 ? `Shared nodes: ${index.sharedNodes.slice(0, 24).map((item) => `${item.nodeId}[${item.treeIds.join(",")}]`).join("; ")}` : "Shared nodes: none",
    index.orphanNodes.length > 0
      ? `Recent unorganized nodes: ${index.orphanNodes.map((node) => `${node.id} (${node.kind}): ${node.name}; summary=${node.summary}`).join(" | ")}`
      : "Recent unorganized nodes: none",
    "</reasoning-forest>",
  ].join("\n");
}

function nodeTreeUsage(snapshot: RunSnapshot): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const tree of Object.values(snapshot.reasoningTrees)) {
    for (const nodeId of tree.nodeIds) usage.set(nodeId, [...(usage.get(nodeId) ?? []), tree.id]);
  }
  return usage;
}

function relatedTreeIds(snapshot: RunSnapshot, treeId: string): string[] {
  const tree = snapshot.reasoningTrees[treeId];
  if (!tree) return [];
  return unique([
    ...tree.relatedTreeIds,
    ...Object.values(snapshot.reasoningTrees).filter((item) => item.relatedTreeIds.includes(treeId)).map((item) => item.id),
  ]);
}

function upstreamClosure(snapshot: RunSnapshot, requestedNodeIds: string[]): string[] {
  const included = new Set(requestedNodeIds);
  const pending = [...requestedNodeIds];
  while (pending.length > 0) {
    const target = pending.pop()!;
    for (const edge of Object.values(snapshot.reasoningEdges)) {
      if (edge.to !== target || included.has(edge.from)) continue;
      included.add(edge.from);
      pending.push(edge.from);
    }
  }
  return [...included];
}

function domainReasoningNode(snapshot: RunSnapshot, nodeId: string): Omit<ReasoningNode, "createdSeq" | "updatedSeq"> | undefined {
  const artifact = snapshot.artifacts[nodeId];
  if (artifact) return {
    id: artifact.id,
    kind: "artifact",
    name: displayText(artifact.semantic?.name ?? basename(artifact.path), 160),
    summary: artifact.semantic?.summary ?? `${artifact.mime}, ${artifact.bytes} bytes`,
    tags: artifact.semantic?.tags ?? [],
    status: artifact.semantic?.role === "result" ? "CONFIRMED" : "OPEN",
    explanation: artifact.semantic?.summary ?? "由 Tool 产生并归档的离散观察来源。",
    reference: { kind: "artifact", id: artifact.id },
    generation: snapshot.generation,
    explainedBy: artifact.semantic?.annotatedBy === "agent" ? "agent" : "harness",
  };
  const evidence = snapshot.evidence[nodeId];
  if (evidence) return {
    id: evidence.id,
    kind: evidence.kind === "reproduction" ? "reproduction" : "evidence",
    name: displayText(evidence.name ?? evidence.summary, 160),
    summary: evidence.summary,
    tags: evidence.tags ?? [],
    status: evidence.refutes.length > 0 ? "CONTESTED" : "SUPPORTED",
    explanation: "由一个或多个来源观察归纳并保留稳定引用。",
    reference: { kind: "evidence", id: evidence.id },
    generation: evidence.source.generation ?? snapshot.generation,
    explainedBy: "curator",
  };
  const fact = snapshot.facts[nodeId];
  if (fact) return {
    id: fact.id,
    kind: "claim",
    name: displayText(fact.statement, 160),
    summary: fact.statement,
    tags: [],
    status: fact.status === "CONFIRMED" ? "CONFIRMED" : fact.status === "REJECTED" ? "REFUTED" : "OPEN",
    explanation: "由关联 Evidence 支撑或反驳的可验证主张。",
    reference: { kind: "fact", id: fact.id },
    generation: snapshot.generation,
    explainedBy: "curator",
  };
  const observation = snapshot.observations[nodeId];
  if (observation) return { id: observation.id, kind: "observation", name: displayText(observation.summary, 160), summary: observation.summary, tags: observation.candidateKinds, status: "OPEN", explanation: "由 Tool 输出直接提取的离散观察。", reference: { kind: "observation", id: observation.id }, generation: observation.source.generation, explainedBy: "harness" };
  const hypothesis = snapshot.hypotheses[nodeId];
  if (hypothesis) return { id: hypothesis.id, kind: "hypothesis", name: displayText(hypothesis.statement, 160), summary: hypothesis.statement, tags: [], status: hypothesis.status === "CONFIRMED" ? "CONFIRMED" : hypothesis.status === "REJECTED" ? "REFUTED" : "OPEN", explanation: "等待证据检验的推理方向。", reference: { kind: "hypothesis", id: hypothesis.id }, generation: snapshot.generation, explainedBy: "curator" };
  const completion = snapshot.completions[nodeId];
  if (completion) return { id: completion.id, kind: "result", name: `结果 ${completion.id}`, summary: `候选哈希 ${completion.candidateHash}`, tags: ["result"], status: completion.status === "ACCEPTED" ? "CONFIRMED" : completion.status === "REJECTED" ? "REFUTED" : "OPEN", explanation: "由复现证据验证的最终结果候选。", reference: { kind: "completion", id: completion.id }, generation: snapshot.generation, explainedBy: "harness" };
  return undefined;
}

function semanticInput(input: {
  name: string;
  summary: string;
  tags?: string[];
  role?: ArtifactRole;
  relatedIds?: string[];
  fallback?: ArtifactSemanticMetadata;
}): Omit<ArtifactSemanticMetadata, "updatedSeq"> {
  return {
    name: requiredText(input.name, "Artifact name", 160),
    summary: requiredText(input.summary, "Artifact summary", 1_000),
    tags: normalizedTags(input.tags ?? input.fallback?.tags),
    role: input.role ?? input.fallback?.role ?? "intermediate",
    relatedIds: unique(input.relatedIds ?? input.fallback?.relatedIds ?? []).slice(0, 32),
    annotatedBy: "agent",
  };
}

function displayText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3))}...`;
}

function evidenceArtifactIds(evidence: Evidence): string[] {
  return unique([...(evidence.source.artifactIds ?? []), ...(evidence.source.artifactId ? [evidence.source.artifactId] : [])]);
}

function assertKnown(ids: string[], values: Record<string, unknown>, label: string): void {
  const missing = ids.filter((id) => !values[id]);
  if (missing.length > 0) throw new Error(`Unknown ${label}: ${missing.join(", ")}`);
}

function requiredText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${label} must contain 1-${maxLength} characters`);
  return normalized;
}

function optionalText(value: string | undefined, label: string, maxLength: number): string | undefined {
  if (value === undefined || !value.trim()) return undefined;
  return requiredText(value, label, maxLength);
}

function normalizedTags(values: string[] | undefined): string[] {
  const tags = unique((values ?? []).map((value) => value.trim()).filter(Boolean));
  if (tags.length > 16 || tags.some((tag) => tag.length > 40)) throw new Error("Tags must contain at most 16 values of 1-40 characters");
  return tags;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
