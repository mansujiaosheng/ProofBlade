#!/usr/bin/env node
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  contextText,
  CapabilityRegistry,
  CheckpointService,
  createServices,
  demoTask,
  fixtureTask,
  JsonlControlStore,
  loadConfig,
  listFixtureProfiles,
  PiAgentLane,
  PiSolverLane,
  PlannerCoordinator,
  ProofBladeToolRuntime,
  ProofBladeSkillRegistry,
  McpProjectRegistry,
  listBundledCapabilities,
  projectionHash,
  runDemo,
  SingleAgentCtfLoop,
  snapshotContext,
  FixtureEvaluationRunner,
  RunTelemetry,
  RunRecoveryService,
} from "@proofblade/materials";

const root = resolve(process.cwd());

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const configPath = option(rawArgs, "--config") ?? "proofblade.config.json";
  const args = withoutOption(rawArgs, "--config");
  const [command = "help", arg, ...rest] = args;
  const config = await loadConfig(root, configPath);
  const services = createServices(root, config);
  switch (command) {
    case "init": {
      const runId = required(arg, "task id");
      const snapshot = await services.control.createRun(runId, demoTask(runId, root, config));
      print({ runId, status: snapshot.status, phase: snapshot.phase });
      break;
    }
    case "run": {
      if (arg !== "demo") throw new Error("The first fixture profile is named 'demo'");
      const runId = option(rest, "--run-id") ?? rest.find((value) => !value.startsWith("--")) ?? `DEMO-${Date.now()}`;
      const outcome = await runDemo(root, runId, config);
      print(outcome);
      break;
    }
    case "fixtures": {
      print(listFixtureProfiles().map((profile) => ({ id: profile.id, targetKind: profile.targetKind, description: profile.description })));
      break;
    }
    case "eval": {
      const evalArgs = arg === undefined ? rest : [arg, ...rest];
      const evalPositionals = positional(evalArgs, ["--attempts", "--max-turns", "--run-prefix", "--prefix"]);
      const attempts = parsePositiveOption(evalArgs, "--attempts") ?? parsePositiveValue(evalPositionals[0], "attempts");
      const maxTurns = parsePositiveOption(evalArgs, "--max-turns") ?? parsePositiveValue(evalPositionals[1], "max-turns");
      const runPrefix = option(evalArgs, "--run-prefix") ?? option(evalArgs, "--prefix") ?? evalPositionals[2];
      const summary = await new FixtureEvaluationRunner(root, config).run({ attempts, maxTurns, runPrefix });
      print(summary);
      if (evalArgs.includes("--enforce-gate") && !summary.gate.passed) process.exitCode = 1;
      break;
    }
    case "capabilities": {
      const mcp = McpProjectRegistry.load(root);
      const registry = new CapabilityRegistry([...listBundledCapabilities(), ...mcp.capabilityManifests()]);
      print({ catalogHash: registry.catalogHash(), capabilities: registry.list() });
      break;
    }
    case "mcp": {
      const action = arg ?? "list";
      const mcp = McpProjectRegistry.load(root);
      if (action === "list") {
        print({ catalogHash: mcp.catalogHash(), servers: mcp.summaries() });
        break;
      }
      const runId = required(rest[0], "run id");
      const serverName = required(rest[1], "MCP server name");
      const summary = mcp.summaries().find((item) => item.name === serverName && !item.disabled);
      if (!summary) throw new Error(`Unknown enabled MCP server: ${serverName}`);
      const runtime = await toolRuntime(runId, services);
      try {
        if (action === "describe") print(await runtime.invokeCapability({ capabilityId: summary.capabilityId, operation: "describe", input: {} }));
        else if (action === "call") {
          const tool = required(rest[2], "MCP tool name");
          const toolArgs = rest[3] === undefined ? {} : parseObject(rest[3], "MCP tool arguments");
          print(await runtime.invokeCapability({ capabilityId: summary.capabilityId, operation: "call", input: { tool, arguments: toolArgs } }));
        } else throw new Error("mcp action must be list, describe, or call");
      } finally {
        await runtime.close();
      }
      break;
    }
    case "skills": {
      const registry = await ProofBladeSkillRegistry.load(root);
      const action = arg ?? "list";
      if (action === "list") print({ catalogHash: registry.catalogHash(), skills: registry.list(), diagnostics: registry.diagnostics });
      else if (action === "show") print(registry.loadForModel(required(rest[0], "skill name"), rest[1] === undefined ? undefined : Number(rest[1])));
      else throw new Error("skills action must be list or show");
      break;
    }
    case "solve": {
      const profileId = required(arg, "fixture profile id");
      const positionals = positional(rest, ["--run-id", "--mode", "--max-turns"]);
      const runId = option(rest, "--run-id") ?? positionals[0] ?? `PB-${profileId}-${Date.now()}`;
      const modeValue = option(rest, "--mode") ?? positionals[1] ?? "assist";
      if (modeValue !== "auto" && modeValue !== "assist") throw new Error("--mode must be auto or assist");
      const maxTurnsValue = option(rest, "--max-turns") ?? positionals[2];
      const maxTurns = maxTurnsValue === undefined ? undefined : Number(maxTurnsValue);
      if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) throw new Error("--max-turns must be a positive integer");
      const loop = new SingleAgentCtfLoop(root, config, services);
      print(await loop.run({ runId, task: fixtureTask(runId, profileId, root, config), mode: modeValue, maxTurns }));
      break;
    }
    case "show": {
      const snapshot = await services.control.snapshot(required(arg, "run id"));
      print({ runId: snapshot.runId, status: snapshot.status, phase: snapshot.phase, generation: snapshot.generation, lastSeq: snapshot.lastSeq, facts: Object.keys(snapshot.facts).length, observations: Object.keys(snapshot.observations).length, evidence: Object.keys(snapshot.evidence).length, completions: Object.keys(snapshot.completions).length, effects: Object.keys(snapshot.effects).length, artifacts: Object.keys(snapshot.artifacts).length, checkpoints: Object.keys(snapshot.checkpoints).length, jobs: Object.keys(snapshot.jobs).length, handoffs: Object.keys(snapshot.handoffs).length, contextOverflowRecoveries: snapshot.contextOverflowRecoveries, failureCategory: snapshot.failureCategory, versionSnapshotHash: snapshot.versionSnapshot?.hash, projectionHash: snapshot.projectionHash });
      break;
    }
    case "timeline": {
      const events = await services.control.events(required(arg, "run id"));
      for (const event of events) console.log(`${String(event.seq).padStart(4)} ${event.ts} ${event.lane.padEnd(8)} ${event.type}`);
      break;
    }
    case "ledger": {
      const snapshot = await services.control.snapshot(required(arg, "run id"));
      print({ facts: Object.values(snapshot.facts), hypotheses: Object.values(snapshot.hypotheses), evidence: Object.values(snapshot.evidence), intents: Object.values(snapshot.intents) });
      break;
    }
    case "context": {
      const runId = required(arg, "run id");
      const snapshot = await services.control.snapshot(runId);
      const output = snapshotContext(snapshot, runId);
      console.log(contextText(output));
      console.log("\n--- manifest ---");
      print(output.manifest);
      break;
    }
    case "replay": {
      const runId = required(arg, "run id");
      const replayed = await services.control.replay(runId);
      const persisted = await new JsonlControlStore(services.runsRoot).loadProjection(runId);
      const replayHash = projectionHash(replayed);
      const persistedHash = persisted ? projectionHash(persisted) : undefined;
      print({ runId, eventCount: replayed.lastSeq, replayHash, persistedHash, match: replayHash === persistedHash });
      break;
    }
    case "reconcile": {
      const runId = required(arg, "run id");
      const recovery = await new RunRecoveryService(services.control, services.journal, services.sandbox).recover(runId);
      print({
        runId,
        fixtureHealth: recovery.fixtureHealth,
        fixtureAction: recovery.fixtureAction,
        expiredLeases: recovery.expiredLeases.map((lease) => lease.resourceKey),
        reconciledEffects: recovery.reconciledEffects,
        reconciledJobs: recovery.reconciledJobs,
      });
      break;
    }
    case "cost": {
      print(await new RunTelemetry(services.control).report(required(arg, "run id")));
      break;
    }
    case "checkpoint": {
      const runId = required(arg, "run id");
      const reason = rest.join(" ").trim() || "manual";
      print(await new CheckpointService(services.control, services.artifacts).create(runId, reason));
      break;
    }
    case "compact": {
      const runId = required(arg, "run id");
      const runtime = await toolRuntime(runId, services);
      const lane = await PiSolverLane.create({ projectRoot: root, runId, runDir: join(services.runsRoot, runId), controlStore: services.control, artifactStore: services.artifacts, config, runtime });
      try {
        await lane.compact(rest.join(" ").trim() || "Manual ProofBlade compaction");
      } finally {
        await lane.close();
        await runtime.close();
      }
      const snapshot = await services.control.snapshot(runId);
      print({ runId, checkpoints: Object.values(snapshot.checkpoints) });
      break;
    }
    case "skill": {
      const runId = required(arg, "run id");
      const skillName = required(rest[0], "skill name");
      const runDir = join(services.runsRoot, runId);
      await access(runDir);
      const runtime = await toolRuntime(runId, services);
      const lane = await PiSolverLane.create({ projectRoot: root, runId, runDir, controlStore: services.control, artifactStore: services.artifacts, config, runtime });
      try {
        print(await lane.skill(skillName, rest.slice(1).join(" ").trim() || undefined));
      } finally {
        await lane.close();
        await runtime.close();
      }
      break;
    }
    case "history": {
      const runId = required(arg, "run id");
      const query = required(rest.join(" ").trim(), "history query");
      const runtime = await toolRuntime(runId, services);
      print(await runtime.searchHistory(query));
      break;
    }
    case "jobs": {
      const runId = required(arg, "run id");
      const runtime = await toolRuntime(runId, services);
      try {
        const action = rest[0] ?? "list";
        if (action === "list") print(await runtime.listJobs());
        else if (action === "recover") print(await runtime.recoverJobs());
        else if (action === "read") print(await runtime.readJobOutput(required(rest[1], "job id"), rest[2] === undefined ? undefined : Number(rest[2])));
        else if (action === "stop") print(await runtime.stopJob(required(rest[1], "job id"), rest.slice(2).join(" ") || undefined));
        else throw new Error("jobs action must be list, recover, read, or stop");
      } finally {
        await runtime.close();
      }
      break;
    }
    case "handoff": {
      const runId = required(arg, "run id");
      const action = rest[0] ?? "show";
      if (action === "show") print(Object.values((await services.control.snapshot(runId)).handoffs));
      else if (action === "prepare") print(await new PlannerCoordinator(services.control).prepare(runId));
      else throw new Error("handoff action must be show or prepare");
      break;
    }
    case "artifact": {
      const runId = required(arg, "run id");
      const artifactId = required(rest[0], "artifact id");
      const maxChars = rest[1] === undefined ? undefined : Number(rest[1]);
      const runtime = await toolRuntime(runId, services);
      print(await runtime.readArtifact(artifactId, maxChars));
      break;
    }
    case "fixture-build": {
      const runId = required(arg, "run id");
      const snapshot = await services.control.snapshot(runId);
      print(await services.sandbox.build(snapshot.task));
      break;
    }
    case "fixture-reset": {
      const runId = required(arg, "run id");
      const snapshot = await services.control.snapshot(runId);
      const fixture = await services.sandbox.build(snapshot.task);
      const generation = await services.sandbox.reset(fixture);
      await services.control.dispatch(runId, { type: "fixture_reset", generation });
      print({ runId, generation });
      break;
    }
    case "fixture-score": {
      const runId = required(arg, "run id");
      const candidate = required(rest[0], "candidate");
      const snapshot = await services.control.snapshot(runId);
      const fixture = await services.sandbox.build(snapshot.task);
      print(await services.sandbox.score(fixture, candidate));
      break;
    }
    case "agent": {
      const runId = required(arg, "run id");
      const prompt = rest.join(" ").trim() || "Summarize the current verified facts and evidence ids in JSON.";
      const runDir = join(services.runsRoot, runId);
      await access(runDir);
      const lane = await PiAgentLane.create({ runId, runDir, controlStore: services.control, config });
      try {
        const outcome = await lane.prompt(prompt);
        print(outcome);
      } finally {
        await lane.close();
      }
      break;
    }
    case "intents": {
      const { IntentScheduler, LeaseManager } = await import("@proofblade/materials");

      // 创建 LeaseManager 和 IntentScheduler
      const leaseManager = new LeaseManager(services.control);
      const scheduler = new IntentScheduler(
        services.control,
        leaseManager,
        {
          maxOpenIntents: 8,
          maxAttemptsPerIntent: 3,
        }
      );

      const { handleIntentsCommand } = await import("./commands/intents.js");
      // 传递 [subCommand, runId, ...rest] = [arg, ...rest]
      await handleIntentsCommand([arg, ...rest], scheduler, services.control);
      break;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(helpText());
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function withoutOption(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  return index < 0 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

function positional(args: string[], optionNames: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (optionNames.includes(args[index]!)) {
      index += 1;
      continue;
    }
    if (!args[index]!.startsWith("--")) values.push(args[index]!);
  }
  return values;
}

function parsePositiveOption(args: string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parsePositiveValue(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function helpText(): string {
  return [
    "ProofBlade / 证锋",
    "",
    "Commands:",
    "  init <run-id>",
    "  run demo [--run-id ID]",
    "  fixtures",
    "  eval [--attempts N] [--max-turns N] [--run-prefix ID] [--enforce-gate]",
    "  capabilities",
    "  mcp [list|describe|call] [run-id] [server] [tool] [json-arguments]",
    "  skills [list|show] [skill-name] [max-chars]",
    "  skill <run-id> <skill-name> [additional instructions]",
    "  solve <fixture-id> [--run-id ID] [--mode auto|assist] [--max-turns N]",
    "  show <run-id>",
    "  timeline <run-id>",
    "  ledger <run-id>",
    "  context <run-id>",
    "  replay <run-id>",
    "  reconcile <run-id>",
    "  cost <run-id>",
    "  checkpoint <run-id> [reason]",
    "  compact <run-id> [reason]",
    "  history <run-id> <query>",
    "  handoff <run-id> [show|prepare]",
    "  jobs <run-id> [list|recover|read|stop] [job-id] [max-chars]",
    "  artifact <run-id> <artifact-id> [max-chars]",
    "  fixture-build <run-id>",
    "  fixture-reset <run-id>",
    "  fixture-score <run-id> <candidate>",
    "  agent <run-id> [prompt]  Run a Pi AgentHarness turn through LM Studio",
    "  intents [list|score|graph|claim] <run-id>  Manage Intent scheduler",
    "  --config <path>           Select a project configuration file",
  ].join("\n");
}

async function toolRuntime(runId: string, services: ReturnType<typeof createServices>): Promise<ProofBladeToolRuntime> {
  const snapshot = await services.control.snapshot(runId);
  const fixture = await services.sandbox.build(snapshot.task);
  return new ProofBladeToolRuntime(runId, fixture, services.runsRoot, services.control, services.artifacts, services.journal, services.projectRoot);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
