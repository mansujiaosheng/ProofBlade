# Pi and Provider Runtime

```json component-metadata
{
  "id": "materials-runtime",
  "name": "Pi and Provider Runtime",
  "version": "0.10.8",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-09T05:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 6,
    "securityAuditCount": 6,
    "lastBugAuditAt": "2026-08-09T05:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-09T05:00:00.000Z",
    "sourceHash": "99209ea904854d44a78490fe79d3dd5698f62551862da18635da9b860c71eaa3",
    "result": "passed"
  }
}
```

## 职责

适配 Pi AgentHarness、Provider Profile、OpenAI-compatible 传输、Coding/Solver lane、系统提示和实际 Tool 装配。

## 入口与边界

- `coding-lane.ts` 驱动普通对话并在动态尾部注入隐藏 Forest 摘要；`solver-lane.ts` 驱动证据型任务。
- `pi-adapter.ts` 管理 Session；`lmstudio-provider.ts` 解析配置模型；`provider-transport.ts` 处理代理传输。
- `solver-tools.ts` 与 `coding-resources.ts` 装配最小 Tool/Skill/MCP 面；`evidence` 是证据图固定代理，`verify_claim` 是 Coding 结论复现门。
- Coding Provider 始终看到固定 `evidence`、`load_skill` 和 `mcp_call`；启用的 Skill/MCP 只改变运行时允许集合与短摘要，不展开动态 Tool Schema。
- Coding `bash` 通过 `OutputRewritePort` 包装；RTK 探测和执行复用同一个 Pi `ExecutionEnv`，并在 Session details 中记录 provider/version/hash/字节数/Artifact。
- Coding `read` 与 `bash` 都为文本结果注册语义化中间 Artifact，并在模型可见结果中返回稳定 `A-*` 锚点；`evidence record` 使用该锚点一次完成命名、提升、Evidence 与可选 Fact。
- Coding `read/bash` 接入 Evidence Curation Gate：4 个未审阅产物触发检查点，8 个触发硬门；Agent 必须 `record` 有价值发现或 `annotate` 已审阅的普通输出后才能继续侦察。

## 开发规则与验证

模型、URL、思考等级、缓存策略和 Provider 重试预算只能来自配置。OpenAI-compatible 429/408/409/5xx 由 Pi 的可中止退避处理；`maxRetries` 控制重试次数，`maxRetryDelayMs` 限制中转站 `Retry-After`，暂停时 AbortSignal 会打断等待。保持 System/Tool 前缀稳定，Provider 切换不进入底层组件。Pi 升级必须更新锁定快照与适配测试。

Coding Lane 的 context hook 按模型窗口扣除输出预算、System/Tool 固定开销和 Provider 安全余量，再构造单调 Provider 视图并记录 compaction 请求；真正的 `harness.compact()` 必须等当前 Agent 回合结束、Harness 恢复 idle 后执行。`length` 响应使用机械检查点压缩后自动续跑，最多两次，超过上限必须显式报错而非返回空答案。内部恢复提示保留在 Pi 调试轨迹中，但不冒充 GUI 用户消息。错误或人工暂停的回合不启动普通摘要请求。

重复 Tool 失败断路器通过 Pi `terminate` 停止单一工具批次；无进展断路器在单回合滚动窗口内比较只读工具参数和稳定 Artifact 内容哈希，第三次取回同一观察且没有文件、验证或知识图写入时停止。混合批次不满足 Pi 的全结果终止条件时，Runtime 必须在下一次 Provider 请求前停止；同批出现真实写入则取消顺序相关的无进展停止。只有 Harness 最终以空文本 `toolUse/error` 确认终止后，恢复提示才能投影到 `AgentOutcome` 和持久化的 `assistant_message`；正常完成的回合不得标记为断路器终止，模型已经生成的非空文本优先保留。

`evidence` 的 Artifact、Evidence、Graph、Tree 和 Forest 操作共用一个缓存稳定 Tool。Provider 可见 Schema 必须使用根级 `type: object` 和直接字符串枚举，以兼容严格的 OpenAI-compatible Function Calling 校验；每个 operation 的必需字段和互斥字段继续由确定性运行时分支校验。`inspect_forest` 用于方向回顾并返回有界的近期 orphan 名称与摘要，`inspect_tree` 用于局部溯源，`record/link/create_tree/update_tree` 由 Evidence Curator 整理知识。Forest 摘要在每个外部用户回合开始时刷新，作为隐藏动态消息插在本轮用户输入前，不进入 System/Tool 稳定前缀或会话持久历史。`load_skill` 和 `mcp_call` 每次执行都要校验当前对话的 enabled set。

Coding `mcp_call describe` 使用 MCP Registry 的统一服务器描述，除外层 Tool Schema 外也返回配置允许的嵌套 Tool 策略摘要。

CTF flag、挑战答案或恢复密钥等确定性结论必须由不含候选明文的命令从工作区输入复现。最终回答和复现候选不一致时，Runtime 把本轮投影为 `unverified`，不把字符串扫描结果当作确认。

输出改写不得改变 `bash` 的名称、描述、Schema 或 Tool 顺序。Solver Lane 的业务工具继续使用 Effect Journal/Capability Router，不叠加第二条 RTK 裁剪链。

```powershell
npm run test:materials
```
