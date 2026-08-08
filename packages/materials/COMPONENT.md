# Materials 物资层核心

```json component-metadata
{
  "id": "materials",
  "name": "Materials 物资层核心",
  "version": "0.12.12",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-09T05:00:00.000Z",
  "qualityAudit": {
    "bugAuditCount": 8,
    "securityAuditCount": 8,
    "lastBugAuditAt": "2026-08-09T05:00:00.000Z",
    "lastSecurityAuditAt": "2026-08-09T05:00:00.000Z",
    "sourceHash": "7bebbaf9a0430de6b679fce03684c72478eb6a7f94de28a9c4745fa430cc55d3",
    "result": "passed"
  }
}
```

## 职责

承载 ProofBlade 业务语义并组装领域组件。根级 `config.ts` 定义配置契约与加载规则，`index.ts` 是 CLI/GUI 可依赖的公开 API 面。

## 入口与依赖

- 公共入口：`src/index.ts`。
- 配置入口：`src/config.ts`。
- 向下依赖 Atoms、Molecules，以及固定版本的 Pi、MCP、TypeBox 和网络传输库。
- 应用层只能通过公开入口使用 Materials，避免深路径绑定内部实现。

## 开发规则

- 根目录只放跨领域装配和公共导出；具体行为进入最匹配的子组件。
- 新增导出时检查依赖漏斗，避免导出 GUI/CLI 类型。
- 配置字段必须有默认值、解析测试和密钥边界说明。
- Coding Agent 的 Skill/MCP 通过固定代理契约进入 Provider；会话启用集合必须在执行时再次校验。
- 嵌套分发型 MCP Tool 在 Effect 前解析真实内层 Tool，未知项默认拒绝，并按内层策略记录副作用、重放、资源和脱敏元数据。
- 显式 MCP 脱敏字段不受短值阈值限制；`secret` 调用结果保持 secret Artifact 分类，Solver/Coding 共用嵌套能力描述。
- 后台 Job 只持久化 Provider 安全参数副本；原始参数仅用于当前进程执行，脱敏参数不能跨进程自动重放。
- Coding Agent 的 `read`/`bash` 结果保存原始材料并返回稳定 Artifact 锚点；名称、摘要、标签、用途和关联关系进入可重放的语义投影，只有 Evidence/Fact 链上的内容才视为结论依据。
- 推理知识以共享 DAG 持久化，并按主题投影成可折叠的 Reasoning Tree；多棵树组成 Forest，同一 Artifact/Evidence 节点可以被重复采用但不得复制权威数据。
- 未审阅的侦察 Artifact 由 Evidence Curation Gate 按内容哈希去重后限流；软检查点要求整理，硬检查点停止继续 `read/bash`，但不自动把普通输出提升为 Evidence。任一同内容副本完成 `record/annotate` 后，其余副本不再重复占用整理预算。
- Context 维护采用单调 Tool Result 表示、目标预算裁剪和 idle-time 持久压缩；压缩后的 recent tail 必须受模型级预算约束，`length` 恢复必须有重试上限。
- Tool 断路器必须同时覆盖重复失败和无信息增益的成功观察。无进展判定只统计滚动窗口内内容哈希相同的 `read/bash` 或只读 Evidence 操作；文件、验证或知识图写入会清空窗口，同批写入不得因工具顺序被误停。恢复原因只能在 Harness 确认终止后进入 Agent 返回值和持久化 Assistant 消息，不能误标正常完成或向 GUI 返回空文本。
- Tool 输出改写由 `tools.outputRewrite` 选择 `builtin | rtk`；RTK 命令、失败策略、超时和原始输出上限都来自配置。
- 解题型 Coding 对话的最终候选必须经过 `verify_claim` 复现；失败样本要覆盖诱饵字符串、候选不一致和缺少复现三种情况。
- 确定性 baseline 默认执行六个 Fixture 各三次；子集可用于诊断，但合并门禁必须满足完整覆盖和全部证据、重放及泄漏检查，报告哈希必须包含执行预算和规范化 Fixture Catalog 内容哈希。

## 验证

```powershell
npm run test:materials
```
