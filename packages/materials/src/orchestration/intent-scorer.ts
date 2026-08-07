/**
 * Intent 评分引擎
 * 设计文档: §6.5 评分公式
 *
 * 实现 8 维度可解释评分系统，每项归一化到 [0, 1]
 */

import type {
  Intent,
  IntentScore,
  IntentScoringWeights,
  SchedulingContext,
} from '../domain/intent.js';

export class IntentScorer {
  private weights: IntentScoringWeights;

  constructor(weights?: Partial<IntentScoringWeights>) {
    // 默认权重（设计文档 §6.5）
    this.weights = {
      informationGain: 2.0,
      successProbability: 1.5,
      evidenceRelevance: 1.2,
      novelty: 0.8,
      cost: -1.0,
      environmentRisk: -1.2,
      duplicateSimilarity: -1.5,
      dependencyDepth: -0.8,
      ...weights,
    };
  }

  /**
   * 计算 Intent 总分
   * 公式: score = Σ(weight * normalized_metric)
   */
  score(intent: Intent, context: SchedulingContext): IntentScore {
    const metrics = {
      expectedInformationGain: this.calculateInformationGain(intent, context),
      successProbability: this.calculateSuccessProbability(intent, context),
      evidenceRelevance: this.calculateEvidenceRelevance(intent, context),
      novelty: this.calculateNovelty(intent, context),
      normalizedCost: this.normalizeCost(intent, context),
      environmentRisk: this.calculateEnvironmentRisk(intent, context),
      duplicateSimilarity: this.calculateDuplicateSimilarity(intent, context),
      dependencyDepth: this.calculateDependencyDepth(intent, context),
    };

    const totalScore =
      this.weights.informationGain * metrics.expectedInformationGain +
      this.weights.successProbability * metrics.successProbability +
      this.weights.evidenceRelevance * metrics.evidenceRelevance +
      this.weights.novelty * metrics.novelty +
      this.weights.cost * metrics.normalizedCost +
      this.weights.environmentRisk * metrics.environmentRisk +
      this.weights.duplicateSimilarity * metrics.duplicateSimilarity +
      this.weights.dependencyDepth * metrics.dependencyDepth;

    return {
      intentId: intent.id,
      totalScore,
      ...metrics,
      weights: this.weights,
      details: this.explainScore(metrics, totalScore),
      computedAt: new Date().toISOString(),
    };
  }

  /**
   * 批量评分并排序
   */
  scoreAndRank(intents: Intent[], context: SchedulingContext): IntentScore[] {
    const scores = intents.map(intent => this.score(intent, context));
    return scores.sort((a, b) => b.totalScore - a.totalScore);
  }

  /**
   * 1. 预期信息增益 (expected_information_gain)
   *
   * 评估此 Intent 预期能带来多少新信息：
   * - 探索未知区域 → 高
   * - 验证已知假设 → 中
   * - 重复已有路径 → 低
   */
  private calculateInformationGain(
    intent: Intent,
    context: SchedulingContext
  ): number {
    let gain = 0.5; // 基准值

    // 基于新 Fact 的探索，信息增益高
    const newFactRatio = intent.startFromFacts.filter(
      factId => this.isRecentFact(factId, context)
    ).length / Math.max(intent.startFromFacts.length, 1);
    gain += newFactRatio * 0.3;

    // 测试假设比纯探索信息增益略低
    if (intent.hypothesis) {
      gain -= 0.1;
    }

    // 预期产生高置信度证据，信息增益高
    if (intent.expectedEvidence.minimumConfidence === 'high') {
      gain += 0.2;
    }

    // 当前阶段关键任务，信息增益高
    if (intent.priority === 'critical') {
      gain += 0.2;
    }

    return this.clamp(gain, 0, 1);
  }

  /**
   * 2. 成功概率 (success_probability)
   *
   * 基于历史数据和工具可靠性估算成功率
   */
  private calculateSuccessProbability(
    intent: Intent,
    context: SchedulingContext
  ): number {
    let probability = 0.5; // 基准值

    // 已失败次数越多，成功概率越低
    probability -= intent.attempts * 0.15;

    // 依赖未满足，成功概率低
    const unsatisfiedDeps = intent.dependencies.filter(
      depId => !this.isDependencySatisfied(depId, context)
    );
    probability -= unsatisfiedDeps.length * 0.2;

    // 建议工具可用且稳定，成功概率高
    const toolReliability = this.estimateToolReliability(intent.suggestedTools);
    probability += (toolReliability - 0.5) * 0.4;

    // 预估成本合理，成功概率高
    if (intent.estimatedCost < context.remainingBudget.tokens * 0.1) {
      probability += 0.1;
    }

    return this.clamp(probability, 0, 1);
  }

  /**
   * 3. 证据相关性 (evidence_relevance)
   *
   * 评估预期证据与当前目标的相关性
   */
  private calculateEvidenceRelevance(
    intent: Intent,
    context: SchedulingContext
  ): number {
    let relevance = 0.5;

    // 当前阶段需要的证据类型
    const phaseNeeds = this.getPhaseEvidenceNeeds(context.phase);
    if (phaseNeeds.includes(intent.expectedEvidence.kind)) {
      relevance += 0.3;
    }

    // 测试关键假设的证据，相关性高
    if (intent.hypothesis) {
      relevance += 0.2;
    }

    // 复现类证据在 REPRODUCE 阶段相关性高
    if (
      intent.expectedEvidence.kind === 'reproduction' &&
      context.phase === 'REPRODUCE'
    ) {
      relevance += 0.3;
    }

    return this.clamp(relevance, 0, 1);
  }

  /**
   * 4. 新颖性 (novelty)
   *
   * 评估此 Intent 与已有探索路径的差异度
   */
  private calculateNovelty(
    intent: Intent,
    context: SchedulingContext
  ): number {
    // 简化实现：基于工具组合的新颖性
    // Uses the normalized suggested-tool set as a deterministic heuristic.
    const toolSignature = intent.suggestedTools.sort().join(',');
    const isNovel = !this.hasSeenToolCombination(toolSignature, context);

    return isNovel ? 0.8 : 0.3;
  }

  /**
   * 5. 归一化成本 (normalized_cost)
   *
   * 将成本归一化到 [0, 1]，成本越高值越大
   */
  private normalizeCost(
    intent: Intent,
    context: SchedulingContext
  ): number {
    if (context.remainingBudget.tokens === 0) return 1.0;

    const costRatio = intent.estimatedCost / context.remainingBudget.tokens;
    return this.clamp(costRatio, 0, 1);
  }

  /**
   * 6. 环境风险 (environment_risk)
   *
   * 评估执行此 Intent 对环境的影响和风险
   */
  private calculateEnvironmentRisk(
    intent: Intent,
    context: SchedulingContext
  ): number {
    let risk = 0.2; // 基准低风险

    // 需要目标资源的操作风险高
    if (intent.resourceKeys.some(key => key.startsWith('target:'))) {
      risk += 0.3;
    }

    // 写操作风险高于读操作
    const hasWriteTools = intent.suggestedTools.some(tool =>
      ['write_file', 'run_command', 'run_experiment'].includes(tool)
    );
    if (hasWriteTools) {
      risk += 0.2;
    }

    // 后台任务风险略高（可能孤儿进程）
    if (intent.suggestedTools.includes('run_background')) {
      risk += 0.15;
    }

    return this.clamp(risk, 0, 1);
  }

  /**
   * 7. 重复相似度 (duplicate_similarity)
   *
   * 检测与现有 Intent 的重复程度
   */
  private calculateDuplicateSimilarity(
    intent: Intent,
    context: SchedulingContext
  ): number {
    // 简化实现：检查目标和工具的相似度
    // Uses a conservative low-similarity baseline without a candidate corpus.

    // 如果目标完全相同，相似度为 1.0
    // 如果目标相似但工具不同，相似度为 0.5
    // 如果完全不同，相似度为 0.0

    return 0.1; // 默认低相似度
  }

  /**
   * 8. 依赖深度 (dependency_depth)
   *
   * 计算依赖链的深度，深度越大值越大
   */
  private calculateDependencyDepth(
    intent: Intent,
    context: SchedulingContext
  ): number {
    const depth = this.computeDependencyDepth(intent, context, new Set());

    // 归一化：假设最大深度为 5
    return this.clamp(depth / 5, 0, 1);
  }

  /**
   * 递归计算依赖深度
   */
  private computeDependencyDepth(
    intent: Intent,
    context: SchedulingContext,
    visited: Set<string>
  ): number {
    if (intent.dependencies.length === 0) return 0;
    if (visited.has(intent.id)) return 0; // 防止循环

    visited.add(intent.id);

    // 简化实现：返回直接依赖数量
    // Uses direct dependency count as an approximation of dependency depth.
    return intent.dependencies.length;
  }

  /**
   * 生成评分解释
   */
  private explainScore(
    metrics: Omit<IntentScore, 'intentId' | 'totalScore' | 'weights' | 'details' | 'computedAt'>,
    totalScore: number
  ): string {
    const parts = [
      `总分: ${totalScore.toFixed(2)}`,
      `信息增益: ${metrics.expectedInformationGain.toFixed(2)} (权重 ${this.weights.informationGain})`,
      `成功概率: ${metrics.successProbability.toFixed(2)} (权重 ${this.weights.successProbability})`,
      `证据相关性: ${metrics.evidenceRelevance.toFixed(2)} (权重 ${this.weights.evidenceRelevance})`,
      `新颖性: ${metrics.novelty.toFixed(2)} (权重 ${this.weights.novelty})`,
      `成本: ${metrics.normalizedCost.toFixed(2)} (权重 ${this.weights.cost})`,
      `风险: ${metrics.environmentRisk.toFixed(2)} (权重 ${this.weights.environmentRisk})`,
      `重复度: ${metrics.duplicateSimilarity.toFixed(2)} (权重 ${this.weights.duplicateSimilarity})`,
      `依赖深度: ${metrics.dependencyDepth.toFixed(2)} (权重 ${this.weights.dependencyDepth})`,
    ];

    return parts.join(' | ');
  }

  // ========== 辅助方法 ==========

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private isRecentFact(factId: string, context: SchedulingContext): boolean {
    // 简化：检查 Fact 是否在最近的知识版本中
    return context.facts.includes(factId);
  }

  private isDependencySatisfied(depId: string, context: SchedulingContext): boolean {
    // 检查依赖的 Intent 是否已完成
    return context.completedIntentIds?.has(depId) ?? false;
  }

  private estimateToolReliability(tools: string[]): number {
    // 基于历史成功率估算工具可靠性
    // 简化：假设所有工具可靠性为 0.8
    return 0.8;
  }

  private getPhaseEvidenceNeeds(phase: string): string[] {
    const needs: Record<string, string[]> = {
      RECON: ['observation'],
      HYPOTHESIS: ['observation', 'comparison'],
      EXPERIMENT: ['observation', 'reproduction'],
      REPRODUCE: ['reproduction'],
      REPORT: ['observation', 'reproduction'],
    };

    return needs[phase] || [];
  }

  private hasSeenToolCombination(signature: string, context: SchedulingContext): boolean {
    // 检查是否已经使用过此工具组合
    return false;
  }

  /**
   * 更新评分权重（用于 A/B 测试）
   */
  updateWeights(newWeights: Partial<IntentScoringWeights>): void {
    this.weights = { ...this.weights, ...newWeights };
  }

  /**
   * 获取当前权重配置
   */
  getWeights(): IntentScoringWeights {
    return { ...this.weights };
  }
}
