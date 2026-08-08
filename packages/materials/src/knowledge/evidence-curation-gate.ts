import type { ControlStore } from "../control/control-store.js";
import type { ArtifactRef } from "../domain/types.js";

export interface EvidenceCurationStatus {
  stage: "clear" | "checkpoint" | "required";
  pendingCount: number;
  pendingArtifacts: Array<{ id: string; name: string; role: string }>;
}

export interface EvidenceCurationPolicy {
  checkpointArtifacts: number;
  requiredArtifacts: number;
  listedArtifacts: number;
}

const DEFAULT_POLICY: Readonly<EvidenceCurationPolicy> = {
  checkpointArtifacts: 4,
  requiredArtifacts: 8,
  listedArtifacts: 8,
};

/** Keeps exploratory Artifact production bounded without promoting routine output to Evidence. */
export class EvidenceCurationGate {
  public constructor(
    private readonly runId: string,
    private readonly controlStore: ControlStore,
    private readonly policy: EvidenceCurationPolicy = DEFAULT_POLICY,
  ) {
    if (policy.checkpointArtifacts < 1 || policy.requiredArtifacts <= policy.checkpointArtifacts || policy.listedArtifacts < 1) {
      throw new Error("Invalid evidence curation policy");
    }
  }

  public async inspect(): Promise<EvidenceCurationStatus> {
    const snapshot = await this.controlStore.snapshot(this.runId);
    const promoted = new Set(Object.values(snapshot.evidence).flatMap((evidence) => [
      ...(evidence.source.artifactIds ?? []),
      ...(evidence.source.artifactId ? [evidence.source.artifactId] : []),
    ]));
    const reviewedHashes = new Set(Object.values(snapshot.artifacts)
      .filter((artifact) => promoted.has(artifact.id) || artifact.semantic?.annotatedBy === "agent")
      .map((artifact) => artifact.sha256));
    const pendingHashes = new Set<string>();
    const pending = Object.values(snapshot.artifacts)
      .filter(isInvestigationArtifact)
      .filter((artifact) => !reviewedHashes.has(artifact.sha256) && artifact.semantic?.annotatedBy !== "agent")
      .sort((left, right) => (left.semantic?.updatedSeq ?? 0) - (right.semantic?.updatedSeq ?? 0))
      .filter((artifact) => {
        if (pendingHashes.has(artifact.sha256)) return false;
        pendingHashes.add(artifact.sha256);
        return true;
      });
    return {
      stage: pending.length >= this.policy.requiredArtifacts
        ? "required"
        : pending.length >= this.policy.checkpointArtifacts
          ? "checkpoint"
          : "clear",
      pendingCount: pending.length,
      pendingArtifacts: pending.slice(0, this.policy.listedArtifacts).map((artifact) => ({
        id: artifact.id,
        name: artifact.semantic?.name ?? artifact.path,
        role: artifact.semantic?.role ?? "intermediate",
      })),
    };
  }

  public async assertInvestigationAllowed(): Promise<void> {
    const status = await this.inspect();
    if (status.stage !== "required") return;
    throw new Error(this.format(status, true));
  }

  public async checkpointNotice(): Promise<string | undefined> {
    const status = await this.inspect();
    return status.stage === "clear" ? undefined : this.format(status, status.stage === "required");
  }

  private format(status: EvidenceCurationStatus, required: boolean): string {
    const artifacts = status.pendingArtifacts.map((artifact) => `${artifact.id} (${artifact.name})`).join(", ");
    return [
      `[ProofBlade evidence curation ${required ? "required" : "checkpoint"}: ${status.pendingCount} unreviewed investigation artifacts]`,
      `Review: ${artifacts || "use evidence search"}.`,
      "Use evidence record for findings that advance or refute a hypothesis. Use evidence annotate for reviewed routine/debug output that should stay outside Evidence.",
      required ? "Further read/bash calls are paused until at least one pending artifact is curated." : "Curate these artifacts before the exploration backlog reaches the hard limit.",
    ].join("\n");
  }
}

function isInvestigationArtifact(artifact: ArtifactRef): boolean {
  const tags = new Set(artifact.semantic?.tags ?? []);
  return tags.has("read") || tags.has("bash") || tags.has("command-output") || tags.has("file-content");
}
