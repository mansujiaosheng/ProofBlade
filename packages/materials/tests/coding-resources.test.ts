import assert from "node:assert/strict";
import test from "node:test";
import { NodeExecutionEnv, type AgentHarnessTool } from "@earendil-works/pi-agent-core/node";
import { canonicalJson, sha256 } from "@proofblade/atoms";
import type { McpProjectRegistry, McpServerSummary } from "../src/mcp/registry.js";
import {
  codingActiveToolNames,
  codingProviderToolContractSnapshot,
  createCodingTools,
  type CodingResourceContext,
} from "../src/runtime/coding-resources.js";
import type { ProofBladeSkillRegistry } from "../src/skills/registry.js";
import type { OutputRewritePort } from "@proofblade/molecules";
import { createServices, demoTask } from "../src/app/demo.js";
import type { ProofBladeConfig } from "../src/config.js";
import { CodingClaimVerifier, requiresClaimVerification } from "../src/verification/claim-verification.js";
import { CodingEvidenceGraph } from "../src/knowledge/evidence-graph.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

test("coding provider tools keep one stable Skill and MCP proxy contract", () => {
  const snapshot = codingProviderToolContractSnapshot();
  assert.deepEqual(snapshot.map((tool) => tool.name), ["read", "bash", "edit", "write", "verify_claim", "evidence", "load_skill", "mcp_call"]);
  assert.equal(sha256(canonicalJson(snapshot)), "add79e77d8d8222dd065a743787e2a5d218989f75941ab4b73238237a62840e6");
  assert.equal(snapshot.some((tool) => ["list_mcp_servers", "describe_mcp_server", "call_mcp_tool"].includes(tool.name)), false);

  const withoutResources = codingActiveToolNames({ tools: ["read", "bash"], skills: [], mcpServers: [] });
  const withResources = codingActiveToolNames({ tools: ["read", "bash"], skills: ["triage"], mcpServers: ["echo", "browser"] });
  assert.deepEqual(withoutResources, ["read", "bash", "verify_claim", "evidence", "load_skill", "mcp_call"]);
  assert.deepEqual(withResources, withoutResources);
});

test("coding claim verification rejects decoys and persists a matching reproduction", async () => {
  assert.equal(requiresClaimVerification("完成这道题，并得到flag"), true);
  assert.equal(requiresClaimVerification("分析这些文件", "结果是 flag{derived}"), true);
  assert.equal(requiresClaimVerification("修复 feature flag 的布尔判断"), false);
  assert.equal(requiresClaimVerification("你好"), false);

  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "coding-claim-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "CODING-CLAIM-TEST";
  await services.control.createRun(runId, demoTask(runId, dir, config));
  const candidate = "flag{3d02c696a47d9e524d37241e33098bd0}";
  await writeFile(join(dir, "decoy.txt"), "LCTF2026EV-ARM-GW-042\n", "utf8");
  await writeFile(join(dir, "protected.bin"), Buffer.from(candidate, "utf8").map((byte) => byte ^ 0x5a));
  await writeFile(join(dir, "solve.mjs"), "import { readFileSync } from 'node:fs';\nconst data = readFileSync('protected.bin');\nprocess.stdout.write(Buffer.from(data.map((byte) => byte ^ 0x5a)).toString('utf8'));\n", "utf8");
  const env = new NodeExecutionEnv({ cwd: dir });
  env.exec = async (command, options) => {
    assert.equal(command, "node solve.mjs");
    const { stdout, stderr } = await execFileAsync(process.execPath, ["solve.mjs"], { cwd: dir });
    options?.onStdout?.(stdout);
    options?.onStderr?.(stderr);
    return { ok: true, value: { stdout, stderr, exitCode: 0 } };
  };
  const verifier = new CodingClaimVerifier(runId, services.control, services.artifacts);
  const evidenceGraph = new CodingEvidenceGraph(runId, services.control, services.artifacts);
  const context = {
    env,
    skills: {},
    mcp: {},
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    claimVerifier: verifier,
    evidenceGraph,
  } as unknown as CodingResourceContext;
  try {
    const analysisArtifact = await services.artifacts.putText(runId, "EF01 offset=0xD4 length=0x26 nonce=fc99899b203e3fb7e7a36312", {
      filename: "ncal-ef01-analysis.txt",
      semantic: { name: "NCAL EF01 初步解析", summary: "从校准文件解析出的受保护 DID 记录。", tags: ["ncal", "ef01"], role: "intermediate", relatedIds: [], annotatedBy: "harness" },
    });
    const recorded = await executeTool("evidence", {
      operation: "record",
      name: "EF01 受保护记录",
      summary: "NCAL 中 EF01 位于 0xD4，长度为 0x26，并带 12 字节 nonce。",
      artifactIds: [analysisArtifact.id],
      tags: ["ncal", "ef01", "protected-record"],
      claim: "目标数据来自受保护的 EF01 记录，而不是 F190 VIN 字符串。",
    }, context);
    const evidenceId = String((recorded.details as Record<string, unknown>).evidenceId);
    const searched = await executeTool("evidence", { operation: "search", query: "EF01" }, context);
    assert.ok(((searched.details as { results: unknown[] }).results).length >= 2);
    const read = await executeTool("evidence", { operation: "read", artifactId: analysisArtifact.id }, context);
    assert.match(String((read.details as Record<string, unknown>).output), /offset=0xD4/);
    await assert.rejects(
      () => executeTool("evidence", { operation: "annotate", artifactId: analysisArtifact.id, name: "bad", summary: "bad", relatedIds: ["EV-MISSING"] }, context),
      /Unknown related ids/,
    );
    await assert.rejects(
      () => executeTool("verify_claim", { candidate, command: `echo ${candidate}` }, context),
      /embeds the candidate literal/,
    );
    const result = await executeTool("verify_claim", { candidate, command: "node solve.mjs", evidenceIds: [evidenceId] }, context);
    const details = result.details as Record<string, unknown>;
    assert.equal(details.verified, true);
    const snapshot = await services.control.snapshot(runId);
    assert.equal(Object.keys(snapshot.evidence).length, 2);
    assert.equal(Object.values(snapshot.evidence).filter((item) => item.kind === "reproduction" && item.dependsOn?.includes(evidenceId)).length, 1);
    assert.equal(Object.values(snapshot.completions).filter((item) => item.status === "ACCEPTED").length, 1);
    assert.equal(Object.values(snapshot.facts).filter((item) => item.status === "CONFIRMED").length, 1);
    assert.ok(snapshot.artifacts[String(details.artifactId)]);
    assert.equal(snapshot.artifacts[analysisArtifact.id]?.semantic?.name, "EF01 受保护记录");
    assert.equal(snapshot.artifacts[analysisArtifact.id]?.semantic?.role, "supporting");
    assert.ok(snapshot.artifacts[analysisArtifact.id]?.semantic?.relatedIds.includes(evidenceId));
    assert.equal(verifier.project("完成这道题，并得到flag", `最终结果：${candidate}`).status, "verified");
    assert.equal(verifier.project("完成这道题，并得到flag", "最终结果：LCTF2026EV-ARM-GW-042").status, "unverified");
  } finally {
    await env.cleanup();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("coding resource proxies enforce conversation enablement and route MCP lazily", async () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const summaries: McpServerSummary[] = [
    { name: "echo", capabilityId: "mcp.echo", description: "Echo service", disabled: false, status: "configured", configHash: "echo-hash" },
    { name: "browser", capabilityId: "mcp.browser", description: "Browser service", disabled: false, status: "configured", configHash: "browser-hash" },
  ];
  const mcp = {
    summaries: () => summaries,
    describeServer: async (server: string) => {
      calls.push({ kind: "describe", value: server });
      return {
        server,
        configHash: "echo-hash",
        tools: [{ name: "agent_call_tool", description: "Dispatch", inputSchema: { type: "object" }, readOnlyHint: false }],
        nestedTools: [{ name: "page_eval", readOnly: false, sideEffect: "network", replay: "forbidden-replay", sensitivity: "target" }],
      };
    },
    execute: async (capabilityId: string, operation: string, input: Record<string, unknown>) => {
      calls.push({ kind: "execute", value: { capabilityId, operation, input } });
      return { stdout: "called", stderr: "", exitCode: 0, durationMs: 1 };
    },
  } as unknown as McpProjectRegistry;
  const skills = {
    loadForModel: (name: string, maxChars?: number) => ({ name, maxChars, content: "loaded" }),
  } as unknown as ProofBladeSkillRegistry;
  const context = {
    skills,
    mcp,
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set(["echo"]),
  } as unknown as CodingResourceContext;

  const listed = await executeTool("mcp_call", { operation: "list" }, context);
  assert.deepEqual((listed.details as { servers: McpServerSummary[] }).servers.map((server) => server.name), ["echo"]);
  assert.deepEqual(calls, []);

  const described = await executeTool("mcp_call", { operation: "describe", server: "echo" }, context);
  assert.equal((described.details as { server: string }).server, "echo");
  assert.equal((described.details as { nestedTools: Array<{ name: string }> }).nestedTools[0]?.name, "page_eval");
  assert.deepEqual(calls, [{ kind: "describe", value: "echo" }]);
  await assert.rejects(() => executeTool("mcp_call", { operation: "describe", server: "browser" }, context), /not enabled/);
  await assert.rejects(() => executeTool("mcp_call", { operation: "list", server: "echo" }, context), /does not accept/);
  await assert.rejects(() => executeTool("mcp_call", { operation: "delete", server: "echo" }, context), /Unsupported MCP operation/);

  const called = await executeTool("mcp_call", { operation: "call", server: "echo", tool: "echo_text", arguments: { text: "hello" } }, context);
  assert.equal((called.details as { stdout: string }).stdout, "called");
  assert.deepEqual(calls.at(-1), { kind: "execute", value: { capabilityId: "mcp.echo", operation: "call", input: { tool: "echo_text", arguments: { text: "hello" } } } });

  await assert.rejects(() => executeTool("load_skill", { name: "triage" }, context), /not enabled/);
  context.enabledSkills.add("triage");
  const loaded = await executeTool("load_skill", { name: "triage", maxChars: 2_000 }, context);
  assert.deepEqual(loaded.details, { name: "triage", maxChars: 2_000, content: "loaded" });
});

test("coding bash archives raw output before returning RTK-compressed content", async () => {
  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "coding-rtk-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "RTK-CODING-TEST";
  await services.control.createRun(runId, demoTask(runId, dir, config));
  const commands: string[] = [];
  const env = {
    cwd: dir,
    async exec(command: string, options?: { env?: Record<string, string>; onStdout?: (chunk: string) => void }) {
      commands.push(command);
      assert.equal(options?.env?.RTK_TEE_DIR, "tee-dir");
      options?.onStdout?.("6 tests passed\n");
      return { ok: true as const, value: { stdout: "6 tests passed\n", stderr: "", exitCode: 0 } };
    },
  };
  const raw = "PASS verbose diagnostic\n".repeat(200);
  const port: OutputRewritePort = {
    async prepare(input) {
      return {
        requestedProvider: "rtk",
        provider: "rtk",
        providerVersion: "0.42.4",
        applied: true,
        command: "rtk test npm test",
        originalCommandHash: `original-${input.command.length}`,
        rewrittenCommandHash: "rewritten",
        executionEnv: { RTK_TEE_DIR: "tee-dir" },
      };
    },
    async finalize(ticket, visibleOutput) {
      return { ticket, rawOutput: raw, rawCapture: "rtk-tee", rawBytes: Buffer.byteLength(raw), visibleBytes: Buffer.byteLength(visibleOutput), rawTruncated: false };
    },
  };
  const context = {
    env,
    skills: {},
    mcp: {},
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    outputRewrite: { port, artifactStore: services.artifacts, runId },
  } as unknown as CodingResourceContext;
  try {
    const result = await executeTool("bash", { command: "npm test" }, context);
    assert.deepEqual(commands, ["rtk test npm test"]);
    const rewrite = (result.details as { outputRewrite: Record<string, unknown> }).outputRewrite;
    assert.equal(rewrite.provider, "rtk");
    assert.equal(rewrite.rawCapture, "rtk-tee");
    assert.ok(Number(rewrite.savedBytes) > 4_000);
    assert.ok(Number(rewrite.savingsRate) > 0.9);
    const artifactId = String(rewrite.artifactId);
    assert.match(result.content.map((item) => item.text ?? "").join("\n"), new RegExp(`ProofBlade artifact ${artifactId}`));
    const snapshot = await services.control.snapshot(runId);
    assert.ok(snapshot.artifacts[artifactId]);
    assert.equal(await services.artifacts.readText(runId, snapshot.artifacts[artifactId]!), raw);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("coding read creates a searchable source artifact for the evidence graph", async () => {
  const root = resolve(import.meta.dirname, "../../..", "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "coding-read-evidence-"));
  const config = {
    schemaVersion: 1,
    runtime: { piVersion: "0.83.0" },
    storage: { runsDir: "runs", fixturesDir: "fixtures/runtime" },
    modelProfiles: { executor: { thinkingLevel: "off" } },
  } as unknown as ProofBladeConfig;
  const services = createServices(dir, config);
  const runId = "READ-EVIDENCE-TEST";
  await services.control.createRun(runId, demoTask(runId, dir, config));
  await writeFile(join(dir, "source.txt"), "did=0xEF01\noffset=0xD4\nlength=0x26\n", "utf8");
  const evidenceGraph = new CodingEvidenceGraph(runId, services.control, services.artifacts);
  const context = {
    env: new NodeExecutionEnv({ cwd: dir }),
    skills: {},
    mcp: {},
    enabledSkills: new Set<string>(),
    enabledMcpServers: new Set<string>(),
    evidenceGraph,
    outputRewrite: { port: {} as OutputRewritePort, artifactStore: services.artifacts, runId },
  } as unknown as CodingResourceContext;
  try {
    const read = await executeTool("read", { path: "source.txt" }, context);
    const artifactId = String((read.details as Record<string, unknown>).artifactId);
    assert.match(read.content.map((item) => item.text ?? "").join("\n"), new RegExp(`ProofBlade artifact ${artifactId}`));
    const searched = await executeTool("evidence", { operation: "search", query: "source.txt DID protected" }, context);
    const results = (searched.details as { results: Array<{ id: string }> }).results;
    assert.ok(results.some((item) => item.id === artifactId));
    const recorded = await executeTool("evidence", { operation: "record", artifactIds: [artifactId], name: "EF01 DID 记录", summary: "source.txt 定义 EF01 的偏移和长度。", claim: "EF01 是受保护记录。" }, context);
    assert.match(String((recorded.details as Record<string, unknown>).evidenceId), /^EV-/);
    const artifact = (await services.control.snapshot(runId)).artifacts[artifactId]!;
    assert.equal(artifact.semantic?.name, "EF01 DID 记录");
    assert.equal(artifact.semantic?.role, "supporting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function executeTool(name: string, params: Record<string, unknown>, context: CodingResourceContext): Promise<{ content: Array<{ type: string; text?: string }>; details: unknown; isError: boolean }> {
  const tool = createCodingTools().find((candidate) => candidate.name === name);
  assert.ok(tool, `Missing coding tool: ${name}`);
  const result = await (tool as AgentHarnessTool<CodingResourceContext>).execute("test-call", params, new AbortController().signal, () => undefined, context);
  return result as { content: Array<{ type: string; text?: string }>; details: unknown; isError: boolean };
}
