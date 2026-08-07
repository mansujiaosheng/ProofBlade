/**
 * Intent 调度器单元测试
 */

import { describe, test, mock } from 'node:test';
import assert from 'node:assert';
import { IntentScheduler } from '../src/orchestration/intent-scheduler.js';
import { IntentScorer } from '../src/orchestration/intent-scorer.js';
import type { SchedulingContext, Intent } from '../src/domain/intent.js';

describe('IntentScheduler', () => {
  // Mock ControlStore
  const mockControlStore = {
    dispatch: mock.fn(async () => []),
    snapshot: mock.fn(async () => ({ schedulerIntents: {} })),
  } as any;

  // Mock LeaseManager
  const mockLeaseManager = {
    acquire: mock.fn(async () => ({ id: 'lease-123', resourceKey: 'test', expiresAt: new Date() })),
    isOccupied: mock.fn(() => false),
    release: mock.fn(async () => {}),
  } as any;

  test('shouldSchedule - 新增高价值 Fact 触发调度', () => {
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: ['F-001'],
      hypotheses: [],
      evidence: [],
      openIntents: 2,
      newHighValueFacts: 1,  // 触发条件
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: {
        tokens: 10000,
        costUsd: 1.0,
        timeMs: 300000,
      },
      occupiedResources: [],
    };

    assert.strictEqual(scheduler.shouldSchedule(context), true);
  });

  test('shouldSchedule - 达到最大并发数不触发', () => {
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager, { maxOpenIntents: 5 });

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: [],
      hypotheses: [],
      evidence: [],
      openIntents: 5,  // 已达上限
      newHighValueFacts: 1,
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: {
        tokens: 10000,
        costUsd: 1.0,
        timeMs: 300000,
      },
      occupiedResources: [],
    };

    assert.strictEqual(scheduler.shouldSchedule(context), false);
  });

  test('shouldSchedule - 多个触发条件同时满足', () => {
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'EXPERIMENT',
      knowledgeVersion: 2,
      currentGeneration: 1,
      facts: ['F-001', 'F-002'],
      hypotheses: ['H-001'],
      evidence: [],
      openIntents: 0,  // Intent 归零 - 触发条件 1
      newHighValueFacts: 0,
      consecutiveFailures: 3,  // 连续失败 - 触发条件 2
      phaseBudgetUsed: 0.6,  // 预算过半 - 触发条件 3
      newHints: [],
      verifierRejected: false,
      remainingBudget: {
        tokens: 5000,
        costUsd: 0.5,
        timeMs: 150000,
      },
      occupiedResources: [],
    };

    assert.strictEqual(scheduler.shouldSchedule(context), true);
  });

  test('getScoringWeights - 返回默认权重', () => {
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);
    const weights = scheduler.getScoringWeights();

    assert.strictEqual(weights.informationGain, 2.0);
    assert.strictEqual(weights.successProbability, 1.5);
    assert.strictEqual(weights.evidenceRelevance, 1.2);
    assert.strictEqual(weights.novelty, 0.8);
    assert.strictEqual(weights.cost, -1.0);
    assert.strictEqual(weights.environmentRisk, -1.2);
    assert.strictEqual(weights.duplicateSimilarity, -1.5);
    assert.strictEqual(weights.dependencyDepth, -0.8);
  });

  test('updateScoringWeights - 更新权重配置', () => {
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

    scheduler.updateScoringWeights({
      informationGain: 3.0,
      cost: -2.0,
    });

    const weights = scheduler.getScoringWeights();
    assert.strictEqual(weights.informationGain, 3.0);
    assert.strictEqual(weights.cost, -2.0);
    assert.strictEqual(weights.successProbability, 1.5); // 其他不变
  });
});

describe('IntentScorer', () => {
  test('score - 计算总分', () => {
    const scorer = new IntentScorer();

    const intent: Intent = {
      id: 'I-001',
      status: 'PROPOSED',
      priority: 'high',
      createdAt: new Date().toISOString(),
      knowledgeVersion: 1,
      fixtureGeneration: 1,
      phase: 'RECON',
      objective: '探索新路径',
      startFromFacts: ['F-001'],
      expectedEvidence: {
        kind: 'observation',
        description: '新观察',
        minimumConfidence: 'medium',
      },
      suggestedTools: ['run_command'],
      estimatedCost: 500,
      estimatedDuration: 30000,
      resourceKeys: ['workspace:read'],
      dependencies: [],
      attempts: 0,
    };

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: ['F-001'],
      hypotheses: [],
      evidence: [],
      openIntents: 2,
      newHighValueFacts: 1,
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: {
        tokens: 10000,
        costUsd: 1.0,
        timeMs: 300000,
      },
      occupiedResources: [],
    };

    const score = scorer.score(intent, context);

    assert.strictEqual(score.intentId, 'I-001');
    assert.ok(typeof score.totalScore === 'number');
    assert.ok(score.expectedInformationGain >= 0 && score.expectedInformationGain <= 1);
    assert.ok(score.successProbability >= 0 && score.successProbability <= 1);
    assert.ok(score.details.includes('总分'));
  });

  test('scoreAndRank - 排序返回最高分在前', () => {
    const scorer = new IntentScorer();

    const intents: Intent[] = [
      {
        id: 'I-001',
        status: 'PROPOSED',
        priority: 'low',
        createdAt: new Date().toISOString(),
        knowledgeVersion: 1,
        fixtureGeneration: 1,
        phase: 'RECON',
        objective: 'Intent 1',
        startFromFacts: ['F-001'],
        expectedEvidence: {
          kind: 'observation',
          description: 'Test',
          minimumConfidence: 'medium',
        },
        suggestedTools: [],
        estimatedCost: 1000,
        estimatedDuration: 30000,
        resourceKeys: [],
        dependencies: [],
        attempts: 2,
      },
      {
        id: 'I-002',
        status: 'PROPOSED',
        priority: 'critical',
        createdAt: new Date().toISOString(),
        knowledgeVersion: 1,
        fixtureGeneration: 1,
        phase: 'RECON',
        objective: 'Intent 2',
        startFromFacts: ['F-002'],
        expectedEvidence: {
          kind: 'observation',
          description: 'Test',
          minimumConfidence: 'high',
        },
        suggestedTools: [],
        estimatedCost: 200,
        estimatedDuration: 10000,
        resourceKeys: [],
        dependencies: [],
        attempts: 0,
      },
      {
        id: 'I-003',
        status: 'PROPOSED',
        priority: 'high',
        createdAt: new Date().toISOString(),
        knowledgeVersion: 1,
        fixtureGeneration: 1,
        phase: 'RECON',
        objective: 'Intent 3',
        startFromFacts: ['F-003'],
        expectedEvidence: {
          kind: 'observation',
          description: 'Test',
          minimumConfidence: 'medium',
        },
        suggestedTools: [],
        estimatedCost: 500,
        estimatedDuration: 20000,
        resourceKeys: [],
        dependencies: [],
        attempts: 1,
      },
    ];

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: ['F-001', 'F-002', 'F-003'],
      hypotheses: [],
      evidence: [],
      openIntents: 0,
      newHighValueFacts: 0,
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
      occupiedResources: [],
    };

    const ranked = scorer.scoreAndRank(intents, context);

    assert.strictEqual(ranked.length, 3);
    // 第一个应该是最高分
    assert.ok(ranked[0].totalScore >= ranked[1].totalScore);
    assert.ok(ranked[1].totalScore >= ranked[2].totalScore);
  });
});

describe('IntentScheduler - 持久化', () => {
  test('生成和认领 Intent 都会持久化', async () => {
    const dispatchMock = mock.fn(async () => []);
    const mockControlStore = {
      dispatch: dispatchMock,
      snapshot: mock.fn(async () => ({ schedulerIntents: {} })),
    } as any;

    const mockLeaseManager = {
      acquire: mock.fn(async () => ({ id: 'lease-123', resourceKey: 'test', expiresAt: new Date() })),
      release: mock.fn(async () => {}),
    } as any;

    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: ['F-001'],
      hypotheses: [],
      evidence: [],
      openIntents: 0,
      newHighValueFacts: 1,  // 触发生成
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
      occupiedResources: [],
    };

    await scheduler.schedule(context);

    // 验证 dispatch 被调用（生成时持久化 PROPOSED + 认领时持久化 CLAIMED）
    assert.ok(dispatchMock.mock.calls.length >= 2);

    // 验证所有调用都是 scheduler_intent 类型
    for (const call of dispatchMock.mock.calls) {
      assert.strictEqual(call.arguments[0], 'RUN-001');
      assert.strictEqual(call.arguments[1].type, 'scheduler_intent');
    }
  });

  test('认领 Intent 后持久化 CLAIMED 状态', async () => {
    const dispatchMock = mock.fn(async () => []);
    const mockControlStore = {
      dispatch: dispatchMock,
      snapshot: mock.fn(async () => ({ schedulerIntents: {} })),
    } as any;

    const mockLeaseManager = {
      acquire: mock.fn(async () => ({ id: 'lease-123', resourceKey: 'workspace:read', expiresAt: new Date() })),
      release: mock.fn(async () => {}),
    } as any;

    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

    const context: SchedulingContext = {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: ['F-001'],
      hypotheses: [],
      evidence: [],
      openIntents: 0,
      newHighValueFacts: 1,
      consecutiveFailures: 0,
      phaseBudgetUsed: 0.3,
      newHints: [],
      verifierRejected: false,
      remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
      occupiedResources: [],
    };

    const claimedIntent = await scheduler.schedule(context);

    // 验证返回了认领的 Intent
    assert.ok(claimedIntent);
    assert.strictEqual(claimedIntent.status, 'CLAIMED');
    assert.ok(claimedIntent.claimedAt);

    // 验证 dispatch 被调用至少两次（生成 + 认领）
    assert.ok(dispatchMock.mock.calls.length >= 2);

    // 验证最后一次调用是认领
    const lastCall = dispatchMock.mock.calls[dispatchMock.mock.calls.length - 1];
    assert.strictEqual(lastCall.arguments[1].type, 'scheduler_intent');
    assert.strictEqual(lastCall.arguments[1].intent.status, 'CLAIMED');
  });

  test('completeIntent 持久化 COMPLETED 状态', async () => {
    const intentId = 'intent-test-123';
    const dispatchMock = mock.fn(async () => []);
    const mockControlStore = {
      dispatch: dispatchMock,
      snapshot: mock.fn(async () => ({
        schedulerIntents: {
          [intentId]: {
            id: intentId,
            status: 'CLAIMED',
            priority: 'high',
            createdAt: new Date().toISOString(),
            knowledgeVersion: 1,
            fixtureGeneration: 1,
            phase: 'RECON',
            objective: 'Test',
            startFromFacts: [],
            expectedEvidence: { kind: 'observation', description: 'Test', minimumConfidence: 'medium' },
            suggestedTools: [],
            estimatedCost: 500,
            estimatedDuration: 30000,
            resourceKeys: [],
            dependencies: [],
            attempts: 0,
          }
        }
      })),
    } as any;

    const mockLeaseManager = {} as any;
    const scheduler = new IntentScheduler(mockControlStore, mockLeaseManager);

    await scheduler.completeIntent('RUN-001', intentId, {
      producedFacts: ['F-NEW-001'],
      producedEvidence: ['E-NEW-001'],
    });

    // 验证 dispatch 被调用
    assert.strictEqual(dispatchMock.mock.calls.length, 1);
    const call = dispatchMock.mock.calls[0];
    assert.strictEqual(call.arguments[0], 'RUN-001');
    assert.strictEqual(call.arguments[1].type, 'scheduler_intent');
    assert.strictEqual(call.arguments[1].intent.status, 'COMPLETED');
    assert.ok(call.arguments[1].intent.completedAt);
    assert.deepStrictEqual(call.arguments[1].intent.producedFacts, ['F-NEW-001']);
  });
});

describe('IntentScheduler - replay 持久化', () => {
  test('Intent 认领后 replay 状态保持', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rm } = await import('node:fs/promises');

    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-replay-'));

    try {
      // 创建真实的 JsonlControlStore 和 ControlStore
      const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const scheduler = new IntentScheduler(controlStore, leaseManager, {
        maxOpenIntents: 8,
        maxAttemptsPerIntent: 3,
      });

      const runId = 'INTENT-REPLAY-001';

      // 创建 Run
      await controlStore.createRun(runId, {
        id: runId,
        kind: 'fixture_evaluation',
        targetKind: 'web',
        title: 'Intent replay test',
      } as any);

      // 构建触发调度的上下文
      const context: SchedulingContext = {
        runId,
        phase: 'reconnaissance',
        knowledgeVersion: 1,
        currentGeneration: 1,
        facts: ['F-001'],
        hypotheses: [],
        evidence: [],
        openIntents: 0,
        newHighValueFacts: 1, // 触发调度
        consecutiveFailures: 0,
        phaseBudgetUsed: 0.3,
        newHints: [],
        verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
        occupiedResources: [],
        completedIntentIds: new Set(),
        refutedHypotheses: new Set(),
      };

      // 调度并认领 Intent
      const claimedIntent = await scheduler.schedule(context);
      assert.ok(claimedIntent, 'Should claim an intent');
      assert.strictEqual(claimedIntent.status, 'CLAIMED');

      // 验证持久化到 JSONL
      const snapshot1 = await controlStore.snapshot(runId);
      assert.ok(snapshot1.schedulerIntents[claimedIntent.id], 'Intent should be persisted');
      assert.strictEqual(snapshot1.schedulerIntents[claimedIntent.id].status, 'CLAIMED');

      // 创建新的 ControlStore 实例模拟进程重启
      const controlStore2 = new ControlStore(events);

      // Replay
      const replayed = await controlStore2.replay(runId);

      // 验证 replay 后状态保持
      assert.ok(replayed.schedulerIntents[claimedIntent.id], 'Intent should exist after replay');
      assert.strictEqual(
        replayed.schedulerIntents[claimedIntent.id].status,
        'CLAIMED',
        'Intent status should remain CLAIMED after replay'
      );
      assert.strictEqual(
        replayed.schedulerIntents[claimedIntent.id].objective,
        claimedIntent.objective,
        'Intent objective should match after replay'
      );

      // 验证投影哈希一致性
      const { projectionHash } = await import('../src/control/reducer.js');
      const persisted = await events.loadProjection(runId);
      assert.strictEqual(
        projectionHash(replayed),
        projectionHash(persisted!),
        'Replay projection hash should match persisted projection'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Intent 完成后 replay 状态保持', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rm } = await import('node:fs/promises');

    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-complete-'));

    try {
      const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const scheduler = new IntentScheduler(controlStore, leaseManager);

      const runId = 'INTENT-COMPLETE-001';

      await controlStore.createRun(runId, {
        id: runId,
        kind: 'fixture_evaluation',
        targetKind: 'web',
        title: 'Intent complete test',
      } as any);

      const context: SchedulingContext = {
        runId,
        phase: 'reconnaissance',
        knowledgeVersion: 1,
        currentGeneration: 1,
        facts: ['F-001'],
        hypotheses: [],
        evidence: [],
        openIntents: 0,
        newHighValueFacts: 1,
        consecutiveFailures: 0,
        phaseBudgetUsed: 0.3,
        newHints: [],
        verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
        occupiedResources: [],
        completedIntentIds: new Set(),
        refutedHypotheses: new Set(),
      };

      const claimedIntent = await scheduler.schedule(context);
      assert.ok(claimedIntent);

      // 完成 Intent
      await scheduler.completeIntent(runId, claimedIntent.id, {
        producedFacts: ['F-NEW-001'],
        producedEvidence: ['E-NEW-001'],
      });

      // 验证完成状态持久化
      const snapshot = await controlStore.snapshot(runId);
      assert.strictEqual(snapshot.schedulerIntents[claimedIntent.id].status, 'COMPLETED');
      assert.ok(snapshot.schedulerIntents[claimedIntent.id].completedAt);

      // Replay
      const controlStore2 = new ControlStore(events);
      const replayed = await controlStore2.replay(runId);

      // 验证 replay 后状态
      assert.strictEqual(
        replayed.schedulerIntents[claimedIntent.id].status,
        'COMPLETED',
        'Intent should remain COMPLETED after replay'
      );
      assert.ok(
        replayed.schedulerIntents[claimedIntent.id].completedAt,
        'completedAt should be preserved'
      );
      assert.deepStrictEqual(
        replayed.schedulerIntents[claimedIntent.id].producedFacts,
        ['F-NEW-001'],
        'producedFacts should be preserved'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('schedule 能够认领已存在的 PROPOSED Intent', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rm } = await import('node:fs/promises');

    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-existing-'));

    try {
      const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const scheduler = new IntentScheduler(controlStore, leaseManager);

      const runId = 'INTENT-EXISTING-001';

      await controlStore.createRun(runId, {
        id: runId,
        kind: 'fixture_evaluation',
        targetKind: 'web',
        title: 'Existing intent test',
      } as any);

      // 手动创建一个 PROPOSED Intent
      const proposedIntent: Intent = {
        id: 'INTENT-MANUAL-001',
        status: 'PROPOSED',
        priority: 'high',
        createdAt: new Date().toISOString(),
        knowledgeVersion: 1,
        fixtureGeneration: 1,
        phase: 'reconnaissance',
        objective: 'Manually created intent',
        startFromFacts: ['F-001'],
        expectedEvidence: {
          kind: 'observation',
          description: 'Test evidence',
          minimumConfidence: 'medium',
        },
        suggestedTools: [],
        estimatedCost: 500,
        estimatedDuration: 30000,
        resourceKeys: [],
        dependencies: [],
        attempts: 0,
      };

      await controlStore.dispatch(runId, {
        type: 'scheduler_intent',
        intent: proposedIntent,
      });

      // 验证 PROPOSED Intent 已持久化
      const snapshot1 = await controlStore.snapshot(runId);
      assert.strictEqual(snapshot1.schedulerIntents[proposedIntent.id].status, 'PROPOSED');

      // 构建上下文（无新 Fact，但 openIntents === 0 应该触发）
      const context: SchedulingContext = {
        runId,
        phase: 'reconnaissance',
        knowledgeVersion: 1,
        currentGeneration: 1,
        facts: ['F-001'],
        hypotheses: [],
        evidence: [],
        openIntents: 0, // 触发条件：Intent 归零
        newHighValueFacts: 0, // 无新 Fact
        consecutiveFailures: 0,
        phaseBudgetUsed: 0.3,
        newHints: [],
        verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
        occupiedResources: [],
        completedIntentIds: new Set(),
        refutedHypotheses: new Set(),
      };

      // 调用 schedule，应该认领已存在的 PROPOSED Intent
      const claimedIntent = await scheduler.schedule(context);

      assert.ok(claimedIntent, 'Should claim the existing PROPOSED intent');
      assert.strictEqual(claimedIntent.id, proposedIntent.id);
      assert.strictEqual(claimedIntent.status, 'CLAIMED');

      // 验证状态更新
      const snapshot2 = await controlStore.snapshot(runId);
      assert.strictEqual(snapshot2.schedulerIntents[proposedIntent.id].status, 'CLAIMED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Intent 失败后 replay 状态保持', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { rm } = await import('node:fs/promises');

    const root = await mkdtemp(join(tmpdir(), 'proofblade-intent-failed-'));

    try {
      const { JsonlControlStore, ControlStore, LeaseManager } = await import('../src/index.js');
      const events = new JsonlControlStore(join(root, 'runs'));
      const controlStore = new ControlStore(events);
      const leaseManager = new LeaseManager(controlStore);
      const scheduler = new IntentScheduler(controlStore, leaseManager);

      const runId = 'INTENT-FAILED-001';

      await controlStore.createRun(runId, {
        id: runId,
        kind: 'fixture_evaluation',
        targetKind: 'web',
        title: 'Intent failed test',
      } as any);

      const context: SchedulingContext = {
        runId,
        phase: 'reconnaissance',
        knowledgeVersion: 1,
        currentGeneration: 1,
        facts: ['F-001'],
        hypotheses: [],
        evidence: [],
        openIntents: 0,
        newHighValueFacts: 1,
        consecutiveFailures: 0,
        phaseBudgetUsed: 0.3,
        newHints: [],
        verifierRejected: false,
        remainingBudget: { tokens: 10000, costUsd: 1.0, timeMs: 300000 },
        occupiedResources: [],
        completedIntentIds: new Set(),
        refutedHypotheses: new Set(),
      };

      const claimedIntent = await scheduler.schedule(context);
      assert.ok(claimedIntent);

      // 标记 Intent 失败
      await scheduler.failIntent(runId, claimedIntent.id, 'Test failure reason');

      // 验证失败状态持久化
      const snapshot = await controlStore.snapshot(runId);
      assert.strictEqual(snapshot.schedulerIntents[claimedIntent.id].status, 'FAILED');
      assert.strictEqual(snapshot.schedulerIntents[claimedIntent.id].lastError, 'Test failure reason');

      // Replay
      const controlStore2 = new ControlStore(events);
      const replayed = await controlStore2.replay(runId);

      // 验证 replay 后状态
      assert.strictEqual(
        replayed.schedulerIntents[claimedIntent.id].status,
        'FAILED',
        'Intent should remain FAILED after replay'
      );
      assert.strictEqual(
        replayed.schedulerIntents[claimedIntent.id].lastError,
        'Test failure reason',
        'lastError should be preserved'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
