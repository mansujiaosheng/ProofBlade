/**
 * Intent 硬过滤器单元测试
 */

import { describe, test, mock } from 'node:test';
import assert from 'node:assert';
import { IntentFilter } from '../src/orchestration/intent-filter.js';
import type { Intent, SchedulingContext } from '../src/domain/intent.js';

describe('IntentFilter', () => {
  const mockLeaseManager = {} as any;
  const config = { maxAttemptsPerIntent: 3 };

  function createTestIntent(overrides: Partial<Intent> = {}): Intent {
    return {
      id: 'intent-test-001',
      status: 'PROPOSED',
      priority: 'high',
      createdAt: new Date().toISOString(),
      knowledgeVersion: 1,
      fixtureGeneration: 1,
      phase: 'RECON',
      objective: 'Test intent',
      startFromFacts: [],
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
      ...overrides,
    };
  }

  function createTestContext(overrides: Partial<SchedulingContext> = {}): SchedulingContext {
    return {
      runId: 'RUN-001',
      phase: 'RECON',
      knowledgeVersion: 1,
      currentGeneration: 1,
      facts: [],
      hypotheses: [],
      evidence: [],
      openIntents: 0,
      newHighValueFacts: 0,
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
      ...overrides,
    };
  }

  test('checkDependencies - 无依赖的 Intent 通过过滤', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({ dependencies: [] });
    const context = createTestContext();

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].id, intent.id);
  });

  test('checkDependencies - 依赖已完成的 Intent 通过过滤', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({ dependencies: ['intent-dep-001', 'intent-dep-002'] });
    const context = createTestContext({
      completedIntentIds: new Set(['intent-dep-001', 'intent-dep-002', 'intent-dep-003']),
    });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 1);
  });

  test('checkDependencies - 依赖未完成的 Intent 被过滤', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({ dependencies: ['intent-dep-001', 'intent-dep-002'] });
    const context = createTestContext({
      completedIntentIds: new Set(['intent-dep-001']), // 只完成了一个
    });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 0, 'Intent with unmet dependencies should be filtered');
  });

  test('checkResourceAvailability - 资源未被占用时通过', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({ resourceKeys: ['workspace:read', 'target:read'] });
    const context = createTestContext({
      occupiedResources: ['other:resource'],
    });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 1);
  });

  test('checkResourceAvailability - 资源被占用时过滤', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({ resourceKeys: ['workspace:read', 'target:read'] });
    const context = createTestContext({
      occupiedResources: ['workspace:read', 'other:resource'],
    });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 0, 'Intent with occupied resources should be filtered');
  });

  test('checkBudget - 预算充足时通过', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({
      estimatedCost: 500,
      estimatedDuration: 30000,
    });
    const context = createTestContext({
      remainingBudget: {
        tokens: 10000,
        costUsd: 1.0,
        timeMs: 300000,
      },
    });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 1);
  });

  test('checkBudget - token 预算不足时过滤', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({
      estimatedCost: 500,
      estimatedDuration: 30000,
    });
    const context = createTestContext({
      remainingBudget: {
        tokens: 100, // 不足
        costUsd: 1.0,
        timeMs: 300000,
      },
    });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 0, 'Intent exceeding token budget should be filtered');
  });

  test('checkBudget - 时间预算不足时过滤', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({
      estimatedCost: 500,
      estimatedDuration: 30000,
    });
    const context = createTestContext({
      remainingBudget: {
        tokens: 10000,
        costUsd: 1.0,
        timeMs: 10000, // 不足
      },
    });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 0, 'Intent exceeding time budget should be filtered');
  });

  test('isRejectedByEvidence - 无假设的 Intent 通过', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({ hypothesis: undefined });
    const context = createTestContext();

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 1);
  });

  test('isRejectedByEvidence - 假设未被反驳时通过', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({ hypothesis: 'H-001' });
    const context = createTestContext({
      refutedHypotheses: new Set(['H-002', 'H-003']),
    });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 1);
  });

  test('isRejectedByEvidence - 假设被反驳时过滤', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({ hypothesis: 'H-001' });
    const context = createTestContext({
      refutedHypotheses: new Set(['H-001', 'H-002']),
    });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 0, 'Intent with refuted hypothesis should be filtered');
  });

  test('isRejectedByEvidence - 仅同代证据应被考虑', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({
      hypothesis: 'H-001',
      fixtureGeneration: 2, // Intent 在第 2 代
    });
    const context = createTestContext({
      currentGeneration: 2,
      // refutedHypotheses 应该只包含第 2 代的证据反驳
      // 如果 H-001 只在第 1 代被反驳，它不应该出现在这里
      refutedHypotheses: new Set(['H-002']), // H-001 不在当前代被反驳
    });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 1, 'Intent should pass if hypothesis not refuted in current generation');
  });

  test('exceedsMaxAttempts - 尝试次数未达上限时通过', () => {
    const filter = new IntentFilter(mockLeaseManager, { maxAttemptsPerIntent: 3 });
    const intent = createTestIntent({ attempts: 2 });
    const context = createTestContext();

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 1);
  });

  test('exceedsMaxAttempts - 尝试次数达到上限时过滤', () => {
    const filter = new IntentFilter(mockLeaseManager, { maxAttemptsPerIntent: 3 });
    const intent = createTestIntent({ attempts: 3 });
    const context = createTestContext();

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 0, 'Intent exceeding max attempts should be filtered');
  });

  test('exceedsMaxAttempts - 使用配置的上限值', () => {
    const filter = new IntentFilter(mockLeaseManager, { maxAttemptsPerIntent: 5 });
    const intent = createTestIntent({ attempts: 4 });
    const context = createTestContext();

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 1, 'Should use configured max attempts');
  });

  test('isStale - 知识版本匹配时通过', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({ knowledgeVersion: 5 });
    const context = createTestContext({ knowledgeVersion: 5 });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 1);
  });

  test('isStale - 知识版本过期时过滤', () => {
    const filter = new IntentFilter(mockLeaseManager, config);
    const intent = createTestIntent({ knowledgeVersion: 3 });
    const context = createTestContext({ knowledgeVersion: 5 });

    const result = filter.filter([intent], context);

    assert.strictEqual(result.length, 0, 'Intent with stale knowledge version should be filtered');
  });

  test('filter - 多个规则组合测试', () => {
    const filter = new IntentFilter(mockLeaseManager, { maxAttemptsPerIntent: 3 });

    const intents: Intent[] = [
      createTestIntent({ id: 'intent-1', attempts: 0 }), // 通过
      createTestIntent({ id: 'intent-2', attempts: 3 }), // 过滤：超过尝试次数
      createTestIntent({ id: 'intent-3', knowledgeVersion: 1 }), // 通过：版本匹配
      createTestIntent({ id: 'intent-4', knowledgeVersion: 2 }), // 通过：允许比当前版本新
      createTestIntent({ id: 'intent-5', knowledgeVersion: -1 }), // 过滤：过期（差距 > 1）
      createTestIntent({ id: 'intent-6', estimatedCost: 100000 }), // 过滤：预算不足
    ];

    const context = createTestContext({
      knowledgeVersion: 1,
      remainingBudget: {
        tokens: 10000,
        costUsd: 1.0,
        timeMs: 300000,
      },
    });

    const result = filter.filter(intents, context);

    assert.strictEqual(result.length, 3);
    assert.ok(result.some(i => i.id === 'intent-1'));
    assert.ok(result.some(i => i.id === 'intent-3'));
    assert.ok(result.some(i => i.id === 'intent-4'));
  });
});
