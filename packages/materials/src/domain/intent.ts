/**
 * Intent 数据模型
 * 设计文档: §6.5, §9.1
 */

export type IntentStatus =
  | 'PROPOSED'      // 已提议，等待调度
  | 'CLAIMED'       // 已认领，执行中
  | 'COMPLETED'     // 已完成
  | 'FAILED'        // 执行失败
  | 'CANCELLED'     // 已取消
  | 'STALE';        // 过期（知识版本变化）

export type IntentPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Intent - 探索意图
 *
 * 从已有 Fact 出发，提出下一步探索方向，预期产生新的 Evidence/Fact
 */
export interface Intent {
  id: string;
  status: IntentStatus;
  priority: IntentPriority;

  // 来源与版本
  createdAt: string;
  knowledgeVersion: number;
  fixtureGeneration: number;
  phase: string;

  // 意图内容
  objective: string;                    // 探索目标
  hypothesis?: string;                  // 待测试的假设 ID
  startFromFacts: string[];             // 基于哪些 Fact
  expectedEvidence: ExpectedEvidence;   // 预期产生的证据类型

  // 执行计划
  suggestedTools: string[];             // 建议使用的工具
  estimatedCost: number;                // 预估成本（tokens）
  estimatedDuration: number;            // 预估时间（ms）
  resourceKeys: string[];               // 需要的资源（用于 lease）
  dependencies: string[];               // 依赖的其他 Intent ID

  // 执行状态
  claimedBy?: string;                   // Worker ID
  claimedAt?: string;
  leaseId?: string;
  attempts: number;                     // 尝试次数
  lastError?: string;

  // 结果
  producedObservations?: string[];
  producedEvidence?: string[];
  producedFacts?: string[];
  completedAt?: string;
}

export interface ExpectedEvidence {
  kind: 'observation' | 'reproduction' | 'comparison' | 'negative';
  description: string;
  minimumConfidence: 'low' | 'medium' | 'high';
}

/**
 * Intent 评分维度
 * 设计文档: §6.5 评分公式
 */
export interface IntentScore {
  intentId: string;
  totalScore: number;

  // 8 个评分维度（归一化到 [0, 1]）
  expectedInformationGain: number;      // 预期信息增益
  successProbability: number;           // 成功概率
  evidenceRelevance: number;            // 证据相关性
  novelty: number;                      // 新颖性
  normalizedCost: number;               // 归一化成本
  environmentRisk: number;              // 环境风险
  duplicateSimilarity: number;          // 重复相似度
  dependencyDepth: number;              // 依赖深度

  // 权重配置
  weights: IntentScoringWeights;

  // 计算细节
  details: string;
  computedAt: string;
}

export interface IntentScoringWeights {
  informationGain: number;      // 默认 2.0
  successProbability: number;   // 默认 1.5
  evidenceRelevance: number;    // 默认 1.2
  novelty: number;              // 默认 0.8
  cost: number;                 // 默认 -1.0
  environmentRisk: number;      // 默认 -1.2
  duplicateSimilarity: number;  // 默认 -1.5
  dependencyDepth: number;      // 默认 -0.8
}

/**
 * 调度上下文
 * 设计文档: §6.5 触发条件
 */
export interface SchedulingContext {
  runId: string;
  phase: string;
  knowledgeVersion: number;
  currentGeneration: number;

  // 知识图状态
  facts: string[];
  hypotheses: string[];
  evidence: string[];
  openIntents: number;

  // 触发条件
  newHighValueFacts: number;
  consecutiveFailures: number;
  phaseBudgetUsed: number;          // 0.0 - 1.0
  newHints: string[];
  verifierRejected: boolean;

  // 预算限制
  remainingBudget: {
    tokens: number;
    costUsd: number;
    timeMs: number;
  };

  // 资源状态
  occupiedResources: string[];

  // 硬过滤所需状态（可选）
  completedIntentIds?: Set<string>;   // 已完成的 Intent ID 集合
  refutedHypotheses?: Set<string>;    // 被证据反驳的假设 ID 集合
}

/**
 * Intent 生成请求
 */
export interface IntentGenerationRequest {
  context: SchedulingContext;
  maxIntents: number;
  focusArea?: 'exploration' | 'exploitation' | 'verification';
}

/**
 * Intent 生成结果
 */
export interface IntentGenerationResult {
  intents: Intent[];
  reasoning: string;
  knowledgeVersionUsed: number;
  generatedAt: string;
}
