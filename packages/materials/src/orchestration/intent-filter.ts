/**
 * Intent 硬过滤器
 * 设计文档: §6.5 硬过滤规则
 *
 * 在评分前进行硬过滤，满足以下条件的 Intent 不进入候选集：
 * - 依赖未满足
 * - Lease 被占用
 * - 预算不足
 * - 已被同代环境证据否决
 */

import type { Intent, SchedulingContext } from '../domain/intent.js';
import type { LeaseManager } from '../control/lease-manager.js';

export class IntentFilter {
  constructor(
    private leaseManager: LeaseManager,
    private config: { maxAttemptsPerIntent: number }
  ) {}

  /**
   * 硬过滤 Intent 列表
   *
   * 返回通过所有过滤规则的 Intent
   */
  filter(intents: Intent[], context: SchedulingContext): Intent[] {
    return intents.filter(intent => {
      // 规则 1: 检查依赖
      if (!this.checkDependencies(intent, context)) {
        return false;
      }

      // 规则 2: 检查资源 Lease
      if (!this.checkResourceAvailability(intent, context)) {
        return false;
      }

      // 规则 3: 检查预算
      if (!this.checkBudget(intent, context)) {
        return false;
      }

      // 规则 4: 检查环境证据否决
      if (this.isRejectedByEvidence(intent, context)) {
        return false;
      }

      // 规则 5: 检查最大尝试次数
      if (this.exceedsMaxAttempts(intent)) {
        return false;
      }

      // 规则 6: 检查 Intent 是否过期
      if (this.isStale(intent, context)) {
        return false;
      }

      return true;
    });
  }

  /**
   * 规则 1: 依赖检查
   *
   * 所有依赖的 Intent 必须已完成
   */
  private checkDependencies(
    intent: Intent,
    context: SchedulingContext
  ): boolean {
    if (intent.dependencies.length === 0) {
      return true;
    }

    // 检查是否所有依赖都已完成
    const completed = context.completedIntentIds ?? new Set();
    return intent.dependencies.every(depId => completed.has(depId));
  }

  /**
   * 规则 2: 资源可用性检查
   *
   * 所有需要的资源必须未被占用
   */
  private checkResourceAvailability(
    intent: Intent,
    context: SchedulingContext
  ): boolean {
    if (intent.resourceKeys.length === 0) {
      return true;
    }

    // 检查是否有资源被占用
    for (const resourceKey of intent.resourceKeys) {
      if (context.occupiedResources.includes(resourceKey)) {
        return false;
      }
    }

    return true;
  }

  /**
   * 规则 3: 预算检查
   *
   * Intent 的预估成本不能超过剩余预算
   */
  private checkBudget(
    intent: Intent,
    context: SchedulingContext
  ): boolean {
    // Token 预算检查
    if (intent.estimatedCost > context.remainingBudget.tokens) {
      return false;
    }

    // 时间预算检查
    if (intent.estimatedDuration > context.remainingBudget.timeMs) {
      return false;
    }

    // 成本预算检查（假设 1000 tokens = $0.001）
    const estimatedCostUsd = intent.estimatedCost / 1000000;
    if (estimatedCostUsd > context.remainingBudget.costUsd) {
      return false;
    }

    return true;
  }

  /**
   * 规则 4: 环境证据否决检查
   *
   * 如果同代环境中已有证据否定此 Intent 的假设，则过滤掉
   */
  private isRejectedByEvidence(
    intent: Intent,
    context: SchedulingContext
  ): boolean {
    // 如果 Intent 不测试假设，则不适用此规则
    if (!intent.hypothesis) {
      return false;
    }

    // 检查假设是否已被证据反驳
    const refuted = context.refutedHypotheses ?? new Set();
    return refuted.has(intent.hypothesis);
  }

  /**
   * 规则 5: 最大尝试次数检查
   *
   * Intent 尝试次数不能超过配置上限
   */
  private exceedsMaxAttempts(intent: Intent): boolean {
    return intent.attempts >= this.config.maxAttemptsPerIntent;
  }

  /**
   * 规则 6: 过期检查
   *
   * Intent 的知识版本必须接近当前版本。
   * 允许最多落后 1 个版本，因为 Intent 写入本身会增加 lastSeq。
   */
  private isStale(intent: Intent, context: SchedulingContext): boolean {
    // 允许 Intent 的知识版本等于当前版本或最多落后 1
    // 这是因为写入 scheduler_intent 命令会递增 lastSeq
    const versionDiff = context.knowledgeVersion - intent.knowledgeVersion;
    return versionDiff > 1;
  }

  /**
   * 获取过滤统计信息（用于调试）
   */
  getFilterStats(
    intents: Intent[],
    context: SchedulingContext
  ): FilterStats {
    const stats: FilterStats = {
      total: intents.length,
      passed: 0,
      failedDependencies: 0,
      failedResources: 0,
      failedBudget: 0,
      failedEvidence: 0,
      failedAttempts: 0,
      stale: 0,
    };

    for (const intent of intents) {
      let failed = false;

      if (!this.checkDependencies(intent, context)) {
        stats.failedDependencies++;
        failed = true;
      }
      if (!this.checkResourceAvailability(intent, context)) {
        stats.failedResources++;
        failed = true;
      }
      if (!this.checkBudget(intent, context)) {
        stats.failedBudget++;
        failed = true;
      }
      if (this.isRejectedByEvidence(intent, context)) {
        stats.failedEvidence++;
        failed = true;
      }
      if (this.exceedsMaxAttempts(intent)) {
        stats.failedAttempts++;
        failed = true;
      }
      if (this.isStale(intent, context)) {
        stats.stale++;
        failed = true;
      }

      if (!failed) {
        stats.passed++;
      }
    }

    return stats;
  }
}

export interface FilterStats {
  total: number;
  passed: number;
  failedDependencies: number;
  failedResources: number;
  failedBudget: number;
  failedEvidence: number;
  failedAttempts: number;
  stale: number;
}
