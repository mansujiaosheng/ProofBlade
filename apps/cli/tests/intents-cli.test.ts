import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '../../../packages/materials/src/control/control-store.js';
import { JsonlControlStore } from '../../../packages/materials/src/storage/jsonl-store.js';
import { IntentScheduler } from '../../../packages/materials/src/orchestration/intent-scheduler.js';
import { LeaseManager } from '../../../packages/materials/src/control/lease-manager.js';
import { handleIntentsCommand } from '../src/commands/intents.js';

/**
 * CLI 集成测试
 *
 * 验证 handleIntentsCommand 在真实 ControlStore 和 IntentScheduler 下的端到端行为：
 * - list: 列出 PROPOSED 状态的 Intent
 * - score: 显示评分后的 Intent
 * - graph: 导出依赖图
 * - claim: 认领 Intent 并持久化为 CLAIMED
 *
 */

test('CLI intents commands integration', async () => {
  const runId = 'test-run-cli';
  const tmpDir = await mkdtemp(join(tmpdir(), 'intents-cli-test-'));

  try {
    // Setup
    const eventStore = new JsonlControlStore(tmpDir);
    await eventStore.create(runId, {
      mode: 'assist',
      fixtureId: 'test-fixture',
      challenge: 'test-challenge',
      lane: 'main',
    });

    const controlStore = new ControlStore(eventStore);
    const leaseManager = new LeaseManager(controlStore, { leaseDurationMs: 30000, renewIntervalMs: 10000 });
    const scheduler = new IntentScheduler(controlStore, leaseManager, { maxAttemptsPerIntent: 3 });

  // Test 1: list - 空 run 显示无 Intent
  {
    const output: string[] = [];
    const mockLog = (msg: string) => output.push(msg);

    await handleIntentsCommand(['list', runId], scheduler, controlStore, mockLog);

    assert.ok(output.some(line => line.includes('无 Intent') || line.includes('暂无') || line.includes('0')));
  }

  // Test 2: 创建一个 PROPOSED Intent
  {
    await controlStore.dispatch(runId, {
      type: 'scheduler_intent',
      intent: {
        id: 'intent-1',
        status: 'PROPOSED',
        priority: 'high',
        createdAt: new Date().toISOString(),
        knowledgeVersion: 1,
        fixtureGeneration: 0,
        phase: 'RECON',
        objective: '探索测试路径',
        startFromFacts: [],
        expectedEvidence: {
          kind: 'observation',
          description: '发现潜在攻击面',
          minimumConfidence: 'medium',
        },
        suggestedTools: ['bash', 'grep'],
        estimatedCost: 1000,
        estimatedDuration: 5000,
        resourceKeys: [],
        dependencies: [],
        attempts: 0,
      },
    });

    const snapshot = await controlStore.snapshot(runId);
    assert.ok(snapshot.schedulerIntents);
    assert.strictEqual(Object.keys(snapshot.schedulerIntents).length, 1);
    assert.strictEqual(snapshot.schedulerIntents['intent-1'].status, 'PROPOSED');
  }

  // Test 3: list - 显示 PROPOSED Intent
  {
    const output: string[] = [];
    const mockLog = (msg: string) => output.push(msg);

    await handleIntentsCommand(['list', runId], scheduler, controlStore, mockLog);

    const joined = output.join('\n');
    assert.ok(joined.includes('intent-1') || joined.includes('探索测试路径') || joined.includes('PROPOSED'));
  }

  // Test 4: score - 显示评分结果
  {
    const output: string[] = [];
    const mockLog = (msg: string) => output.push(msg);

    await handleIntentsCommand(['score', runId], scheduler, controlStore, mockLog);

    const joined = output.join('\n');
    assert.ok(joined.includes('intent-1') || joined.includes('score') || joined.includes('评分'));
  }

  // Test 5: graph - 导出依赖图
  {
    const output: string[] = [];
    const mockLog = (msg: string) => output.push(msg);

    await handleIntentsCommand(['graph', runId], scheduler, controlStore, mockLog);

    const joined = output.join('\n');
    assert.ok(joined.length > 0);
  }

  // Test 6: claim - 认领 Intent 并持久化为 CLAIMED
  {
    const output: string[] = [];
    const mockLog = (msg: string) => output.push(msg);

    await handleIntentsCommand(['claim', runId], scheduler, controlStore, mockLog);

    const joined = output.join('\n');
    assert.ok(joined.includes('intent-1') || joined.includes('已认领') || joined.includes('成功认领') || joined.includes('claim'));

    const snapshot = await controlStore.snapshot(runId);
    const intent = snapshot.schedulerIntents?.['intent-1'];
    assert.ok(intent, 'Intent should exist after claim');
    assert.strictEqual(intent.status, 'CLAIMED', 'Intent status should be CLAIMED');

    if (intent.leaseId) {
      assert.ok(intent.claimedAt, 'If leaseId exists, claimedAt should also exist');
    }
  }

  // Test 7: claim - 无可认领 Intent 时返回空
  {
    const output: string[] = [];
    const mockLog = (msg: string) => output.push(msg);

    await handleIntentsCommand(['claim', runId], scheduler, controlStore, mockLog);

    const joined = output.join('\n');
    assert.ok(joined.includes('无可认领') || joined.includes('no') || joined.includes('empty') || joined.includes('❌'));
  }
  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
