import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlStore } from "../src/control/control-store.js";
import type { TaskContract } from "../src/domain/types.js";
import { ArtifactStore } from "../src/effects/artifact-store.js";
import { EvidenceCurationGate } from "../src/knowledge/evidence-curation-gate.js";
import { CodingEvidenceGraph } from "../src/knowledge/evidence-graph.js";
import { JsonlControlStore } from "../src/storage/jsonl-store.js";

test("evidence curation gate checkpoints exploration and clears reviewed artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofblade-curation-"));
  try {
    const control = new ControlStore(new JsonlControlStore(join(root, "runs")));
    const runId = "CURATION-001";
    await control.createRun(runId, task(runId, root));
    const artifacts = new ArtifactStore(join(root, "runs"), control);
    const graph = new CodingEvidenceGraph(runId, control, artifacts);
    const gate = new EvidenceCurationGate(runId, control);
    const ids: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const artifact = await artifacts.putText(runId, `observation ${index}`, {
        filename: `read-${index}.txt`,
        mime: "text/plain",
        sensitivity: "public",
        semantic: {
          name: `读取结果 ${index}`,
          summary: `尚未整理的离散观察 ${index}`,
          tags: ["read", "file-content"],
          role: "intermediate",
          relatedIds: [],
          annotatedBy: "harness",
        },
      });
      ids.push(artifact.id);
      const status = await gate.inspect();
      if (index < 3) assert.equal(status.stage, "clear");
      if (index >= 3 && index < 7) assert.equal(status.stage, "checkpoint");
    }
    assert.equal((await gate.inspect()).stage, "required");
    await assert.rejects(gate.assertInvestigationAllowed(), /Further read\/bash calls are paused/);

    await graph.recordEvidence({
      name: "有效发现",
      summary: "第一个离散观察能够支撑当前方向。",
      artifactIds: [ids[0]!],
      claim: "当前方向具有可验证依据。",
    });
    assert.equal((await gate.inspect()).pendingCount, 7);
    await gate.assertInvestigationAllowed();

    await graph.annotateArtifact({
      artifactId: ids[1]!,
      name: "普通目录输出",
      summary: "已审阅，对当前假设没有证据价值。",
      role: "debug",
      tags: ["read", "reviewed-routine"],
    });
    const reviewed = await gate.inspect();
    assert.equal(reviewed.pendingCount, 6);
    assert.equal(reviewed.pendingArtifacts.some((item) => item.id === ids[1]), false);

    await artifacts.putText(runId, "observation 1", {
      filename: "read-duplicate.txt",
      mime: "text/plain",
      sensitivity: "public",
      semantic: {
        name: "重复读取结果",
        summary: "与已经审阅的输出内容相同。",
        tags: ["read", "file-content"],
        role: "intermediate",
        relatedIds: [],
        annotatedBy: "harness",
      },
    });
    assert.equal((await gate.inspect()).pendingCount, 6);
  } finally {
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
    objective: "curation test",
    inputs: [],
    success_criteria: [],
    verification: { kind: "reproduction", required_reproductions: 0 },
    scope: { allowed_hosts: ["*"], allowed_ports: [], external_network: false, allowed_workspace: root },
    pause_policy: [],
    constraints: { deadline_ms: 10_000, max_cost_usd: 1, max_tool_calls: 20, max_submissions: 0 },
  };
}
