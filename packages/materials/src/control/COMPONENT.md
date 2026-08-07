# Control Store and Reducer

```json component-metadata
{
  "id": "materials-control",
  "name": "Control Store and Reducer",
  "version": "0.3.3",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T23:50:00+08:00",
  "qualityAudit": {
    "bugAuditCount": 3,
    "securityAuditCount": 3,
    "lastBugAuditAt": "2026-08-07T23:50:00+08:00",
    "lastSecurityAuditAt": "2026-08-07T23:50:00+08:00",
    "sourceHash": "aba409da25c3eda1a1f0157397636a4d28536239a97929aab5229d87fccd59aa",
    "result": "passed"
  }
}
```

## 职责

维护 Run 的只追加事件、单写者序列、投影、阶段机和租约。Reducer 是 RunSnapshot 的唯一派生入口，也是业务完成状态的权威控制平面。

## 入口与边界

- `control-store.ts` 负责 append、snapshot 与 replay。
- `reducer.ts` 应用事件；`phase-machine.ts` 校验阶段转换；`lease-manager.ts` 处理所有权。
- 不直接执行外部 Effect，不保存 Provider 消息正文。

## 开发规则与验证

事件必须可重放、序号连续、Schema 可迁移。状态变化只能通过事件进入 Reducer；Artifact 语义更新使用 `artifact_annotated`，不得改写历史原文或在 Reducer 中修改事件对象。Reasoning Graph 写入使用 node upsert、不可变 edge add 和 tree upsert；必须拒绝未知引用、重复边、环、断开的树和跨 generation 关系。新增事件要覆盖并发、重放哈希和旧数据读取。

- `PAUSED` 状态下的 `finish`、`fail`、`exhaust` 必须在 ControlStore 单写者临界区内统一拒绝，Reducer 重放执行相同策略；只有显式 `resume` 可以解除暂停。

```powershell
npm run test:materials
```
