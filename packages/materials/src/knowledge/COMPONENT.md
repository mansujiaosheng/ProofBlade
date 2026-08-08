# Knowledge Observer

```json component-metadata
{
  "id": "materials-knowledge",
  "name": "Knowledge Observer",
  "version": "0.6.2",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-09T05:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-09T05:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-09T05:00:00.000Z",
    "sourceHash": "fa4e3ce465a602e4ce462b3bfe89e4fdd0e894e695de199810c91eb5f75b618e",
    "result": "passed"
  }
}
```

## 职责

把不可信目标输出转换为有来源的 Observation/Evidence，并通过共享 DAG、推理树和森林索引为 Fact、Hypothesis 与 completion grounding 提供确定性依据。

## 入口与边界

- `observer.ts` 负责观察归一化与证据锚定。
- `evidence-graph.ts` 为 Coding lane 提供 Artifact 标注、Evidence 归纳、带类型边的共享 DAG、Reasoning Tree 整理、Forest 摘要和局部树检查。
- `evidence-curation-gate.ts` 追踪未审阅的 `read/bash` 产物；软检查点提示整理，硬检查点阻止继续侦察，直至 Agent 将产物提升为 Evidence 或明确标记为已审阅的普通/调试输出。
- 模型只能提出知识命令；Reducer 决定知识状态。
- 原始大输出留在 Artifact，Knowledge 只保存可检索索引与引用。

## 开发规则与验证

所有目标内容保持不可信标签和来源。Routine Tool 输出默认只是 intermediate/debug Artifact；只有具备名称、摘要、标签和来源引用的发现才提升为 Evidence。Evidence Curator 通过固定代理命名、解释、连边和组织树；主 Agent 默认读取 Forest 摘要，需要溯源时才展开局部树。底层图允许节点被多树采用，GUI 的树形结构只是投影。

证据整理门只统计 Harness 生成且仍未被 Agent 审阅的唯一内容哈希；重复输出不能重复占用预算，任一副本经 `record/annotate` 审阅后同哈希副本一并清账。阈值变化必须覆盖软提示、硬阻断、去重、`record` 清账和 `annotate` 清账测试，禁止通过自动批量提升来伪造高 Evidence 数量。

Forest 索引保留完整 orphan 总数，但只投影最近 24 个 orphan 的稳定 ID、类型、名称和摘要；即使当前没有 Tree，只要存在 orphan 知识，也必须向下一回合提供有界的方向记忆。

Fact/Hypothesis 等权威语句保持完整；投影到 Reasoning Node/Tree 的展示名称独立限制为 160 字符。长 claim 不得让 `recordEvidence` 在 Evidence/Fact 已落盘后因展示标题校验而失败。

```powershell
npm run test:materials
```
