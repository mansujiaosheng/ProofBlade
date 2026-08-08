# ProofBlade GUI

```json component-metadata
{
  "id": "gui",
  "name": "ProofBlade GUI",
  "version": "0.7.7",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-09T05:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 7,
    "securityAuditCount": 7,
    "lastBugAuditAt": "2026-08-09T05:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-09T05:00:00.000Z",
    "sourceHash": "a95a5b06f983d90c5852e1fc10d9e8f8d81d912cb2f3bde792ffc1e7528a3290",
    "result": "passed"
  }
}
```

## 职责

提供真实模型对话、工作目录选择、Provider 配置、会话文件夹、能力开关、Run 观测和 Tool 调试界面。Node server 是 Materials 的应用适配器，浏览器只保存展示状态和临时脚本结果。

## 入口与依赖

- 服务入口：`src/server.ts`；浏览器入口：`src/main.tsx`；主界面：`src/App.tsx`。
- 数据投影：`debug-data.ts`；Tool 可读投影：`tool-presentation.ts`；目录适配：`directory-browser.ts`；本地配置：`provider-settings.ts`、`workspace-settings.ts`。
- 依赖 Materials 公共 API、React 和 Lucide，不创建第三套 durable state。

## 开发规则

- API 响应只暴露 `hasApiKey`，不回传 Key。
- SSE 临时消息在 turn 完成后由 Pi Session 持久数据替换。
- Runtime 的 `repeated_tool_failure` 与 `no_progress` 都属于可恢复的正常终止；SSE 必须发送可见 `done`，历史投影只能用持久化 Pi entry ID 覆盖对应的空 Assistant ToolUse/Error 消息。
- Coding Lane 为上下文恢复生成的内部续跑提示只出现在原始调试轨迹，不投影成用户对话气泡。
- 对话运行时发送按钮切换为暂停按钮；`POST /api/runs/:runId/pause` 必须中止当前 Pi Lane、持久化 `PAUSED` 并经 SSE 回报 `stopping/paused`。下一次发送通过 Control Store 的 `resume` 继续原 Session。
- Fixture 求解必须在 `startSolve` 返回前创建 durable Run；Solver lane 建成后登记到同一运行控制表，确保立即点击暂停时不会出现 `Run not found`，也不会在后台继续调用模型。
- 运行中状态以服务端 `active` 投影为准，页面切换或组件重挂载不得恢复为可发送状态；暂停确认前按钮保持可见并禁用重复暂停。
- 模型标签和右侧配置必须显示当前对话下一轮使用的 Provider/Model/Thinking；最近一条响应的模型仅作为历史元数据，不得覆盖当前选择。
- 缓存展示同时给出本次离散缓存块和会话累计读取、未命中、请求数、输入侧命中率；`cacheWrite` 不进入缓存命中率分母。
- 会话工作目录必须经过服务端绝对路径、存在性和目录类型校验，再传给 `PiCodingLane`。
- 新控件必须覆盖运行中、空数据、错误和窄屏状态；Tool 原始 JSON 仍从 durable domain 投影，可读卡片不得替代原始记录。
- 最终结论的 `verified/unverified` 状态来自 durable `assistant_message` 事件；已验证状态必须显示 Evidence 引用，缺少复现时必须给出醒目的未验证提示。
- “证据与结果”顶层展示可折叠的推理森林摘要；每棵树显示名称、结论、用途、状态、节点/关系/共享计数，展开后查看根节点、来源、类型边、AI 解释和关联树。共享节点显示被哪些树采用；旧对话保留 Fact → Evidence → Artifact 兼容视图。
- `evidence` Tool 的 Forest/Tree/Link 操作必须显示中文动作名和对象 ID，原始 JSON 继续作为调试层保留。
- 旧 Session 没有验证元数据时，只读投影可根据解题请求与非 ToolUse 最终消息补充 `unverified`；该兼容逻辑不得补造 Evidence 或改写原始消息。
- GUI Shutdown 先拒绝新 Chat/Solve/Conversation，并中止、等待全部活动任务；服务、HTTP Server 和 Vite 的清理必须全部执行，最后统一报告失败。

## 验证

```powershell
npm run test --workspace=@proofblade/gui
npm run build --workspace=@proofblade/gui
```
