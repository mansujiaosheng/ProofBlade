# Domain Contracts

```json component-metadata
{
  "id": "materials-domain",
  "name": "Domain Contracts",
  "version": "0.3.3",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T23:50:00+08:00",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-07T23:50:00+08:00",
    "lastSecurityAuditAt": "2026-08-07T23:50:00+08:00",
    "sourceHash": "7b4527507db246df76a9fc6f47a79d8a8155205526212dc9ea94906c7fdb28e1",
    "result": "passed"
  }
}
```

## 职责

定义 ProofBlade 的 Task、Run、Event、Fact、Evidence、Reasoning Node/Edge/Tree/Forest、带语义元数据的 Artifact、Effect、Job、Checkpoint、Telemetry 和 Planner handoff 等业务类型及规范化辅助函数。

## 入口与边界

- `types.ts` 是领域类型源；`handoff.ts` 处理结构化计划交接；`utils.ts` 提供领域级 ID/哈希封装。
- 可以扩展 Atoms/Molecules 类型，不反向修改底层来容纳业务字段。

## 开发规则与验证

新增字段先判断所属 durable domain。事件和持久结构变化要同步 Reducer、版本快照、GUI 投影、文档与兼容测试。

`JobRecord.argsRedacted` 表示持久化参数不是可执行原文。恢复流程不得把这类参数交给 Provider 重放。

Reasoning Tree 是共享 DAG 的可读投影，不是独立复制的数据结构。引用已有领域实体的节点复用其稳定 ID；只有中间推理节点使用独立 ID。

```powershell
npm run typecheck --workspace=@proofblade/materials
npm run test:materials
```
