# Intent 调度器配置

本文档说明如何配置和使用 Intent 调度器。

## 配置文件

在 `proofblade.config.json` 中添加 `intentScheduler` 配置：

```json
{
  "intentScheduler": {
    "maxOpenIntents": 8,
    "maxAttemptsPerIntent": 3,
    "scoringWeights": {
      "informationGain": 2.0,
      "successProbability": 1.5,
      "evidenceRelevance": 1.2,
      "novelty": 0.8,
      "cost": -1.0,
      "environmentRisk": -1.2,
      "duplicateSimilarity": -1.5,
      "dependencyDepth": -0.8
    }
  }
}
```

## 配置项说明

### maxOpenIntents
- **类型**: `number`
- **默认值**: `8`
- **说明**: 最大并发 Intent 数量。达到此上限后，调度器将暂停生成新 Intent。

### maxAttemptsPerIntent
- **类型**: `number`
- **默认值**: `3`
- **说明**: 每个 Intent 的最大尝试次数。超过此次数的 Intent 将被过滤掉。

### scoringWeights
Intent 评分的 8 个维度权重：

#### informationGain (默认: 2.0)
预期信息增益的权重。值越高，越倾向于探索能带来新信息的路径。

#### successProbability (默认: 1.5)
成功概率的权重。值越高，越倾向于选择可靠的路径。

#### evidenceRelevance (默认: 1.2)
证据相关性的权重。值越高，越倾向于产生当前阶段需要的证据。

#### novelty (默认: 0.8)
新颖性的权重。值越高，越倾向于尝试未探索过的方法。

#### cost (默认: -1.0)
成本的权重（负数表示惩罚）。绝对值越大，越倾向于避免高成本路径。

#### environmentRisk (默认: -1.2)
环境风险的权重（负数表示惩罚）。绝对值越大，越倾向于避免破坏性操作。

#### duplicateSimilarity (默认: -1.5)
重复相似度的权重（负数表示惩罚）。绝对值越大，越倾向于避免重复探索。

#### dependencyDepth (默认: -0.8)
依赖深度的权重（负数表示惩罚）。绝对值越大，越倾向于避免复杂的依赖链。

## 调整建议

### 场景 1: 快速探索（成本优先）
```json
{
  "scoringWeights": {
    "informationGain": 3.0,
    "novelty": 1.5,
    "cost": -2.0,
    "duplicateSimilarity": -2.0
  }
}
```

### 场景 2: 稳定验证（可靠性优先）
```json
{
  "scoringWeights": {
    "successProbability": 3.0,
    "evidenceRelevance": 2.0,
    "environmentRisk": -2.0,
    "cost": -0.5
  }
}
```

### 场景 3: 预算受限（低成本优先）
```json
{
  "scoringWeights": {
    "cost": -3.0,
    "environmentRisk": -2.0,
    "successProbability": 2.0
  }
}
```

### 场景 4: 创新突破（新颖性优先）
```json
{
  "scoringWeights": {
    "novelty": 2.5,
    "informationGain": 2.0,
    "duplicateSimilarity": -3.0
  }
}
```

## 触发条件

Intent 调度器在以下任一条件满足时触发：

1. ✅ **新增高价值 Fact** (`newHighValueFacts > 0`)
2. ✅ **Intent 归零** (`openIntents === 0`)
3. ✅ **连续失败** (`consecutiveFailures >= 2`)
4. ✅ **阶段预算过半** (`phaseBudgetUsed > 0.5`)
5. ✅ **Hint 到达** (`newHints.length > 0`)
6. ✅ **Verifier 推翻结论** (`verifierRejected === true`)

## 硬过滤规则

以下 Intent 将被硬过滤，不参与评分：

1. ❌ 依赖未满足
2. ❌ 所需资源被占用
3. ❌ 预算不足（tokens/cost/time）
4. ❌ 被同代环境证据否决
5. ❌ 尝试次数超过上限
6. ❌ 知识版本过期

## CLI 使用

### 查看 Intent 列表
```powershell
proofblade intents list RUN-001
```

### 查看评分详情
```powershell
proofblade intents score RUN-001
```

### 导出 Intent 图
```powershell
# Mermaid 格式
proofblade intents graph RUN-001 mermaid > intent-graph.mmd

# JSON 格式
proofblade intents graph RUN-001 json > intent-graph.json
```

### 测试认领
```powershell
proofblade intents claim RUN-001
```

## 调试技巧

### 1. 查看为什么没有触发调度
```typescript
const snapshot = await controlStore.snapshot(runId);
console.log('当前阶段:', snapshot.phase);
console.log('持久化 Intent:', Object.values(snapshot.schedulerIntents));
```

### 2. 查看过滤统计
```typescript
const filter = new IntentFilter(leaseManager, { maxAttemptsPerIntent: 3 });
const stats = filter.getFilterStats(intents, context);

console.log('过滤统计:');
console.log(`  总数: ${stats.total}`);
console.log(`  通过: ${stats.passed}`);
console.log(`  依赖失败: ${stats.failedDependencies}`);
console.log(`  资源占用: ${stats.failedResources}`);
console.log(`  预算不足: ${stats.failedBudget}`);
console.log(`  证据否决: ${stats.failedEvidence}`);
console.log(`  尝试超限: ${stats.failedAttempts}`);
console.log(`  版本过期: ${stats.stale}`);
```

### 3. 比较不同权重配置
```powershell
# 使用默认权重
proofblade solve web-source-1 WEB-001 auto 2

# 使用自定义权重
# 修改 proofblade.config.json 中的 scoringWeights
proofblade solve web-source-1 WEB-002 auto 2

# 对比成本和成功率
proofblade cost WEB-001
proofblade cost WEB-002
```

## 性能考虑

### Intent 数量控制
- **建议**: `maxOpenIntents` 设置为 5-10
- **原因**: 过多并发 Intent 会增加资源竞争和调度开销

### 评分计算成本
- **单次评分**: ~1ms
- **批量评分 100 个**: ~100ms
- **优化**: 评分结果可缓存（知识版本不变时）

### Lease 性能
- **tryAcquire**: O(1) - 使用 Map 查找
- **release**: O(1)
- **建议**: 及时释放不再使用的 Lease

## 常见问题

### Q: 为什么 Intent 一直不被调度？
A: 检查：
1. 是否满足触发条件（使用上面的调试技巧）
2. 是否被硬过滤（查看过滤统计）
3. 评分是否过低（查看评分详情）
4. 资源是否被占用（检查 Lease 状态）

### Q: 如何提高探索的多样性？
A: 增加 `novelty` 权重，降低 `duplicateSimilarity` 权重（增加绝对值）：
```json
{
  "novelty": 1.5,
  "duplicateSimilarity": -2.5
}
```

### Q: 如何降低成本？
A: 增加 `cost` 权重的绝对值，同时提高 `successProbability` 权重：
```json
{
  "cost": -2.0,
  "successProbability": 2.0
}
```

### Q: Intent 生成策略可以自定义吗？
A: 可以。编辑 `packages/materials/src/orchestration/intent-scheduler.ts` 中的生成方法：
- `createExplorationIntent`
- `createVerificationIntent`
- `createAlternativeIntent`
- `createHintBasedIntent`

## 参考文档

- 设计文档: `pi-ctf-agent-harness-design.md` §6.5
- 数据模型: `packages/materials/src/domain/intent.ts`
- 评分实现: `packages/materials/src/orchestration/intent-scorer.ts`
- 过滤实现: `packages/materials/src/orchestration/intent-filter.ts`
