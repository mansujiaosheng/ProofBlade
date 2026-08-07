# 更新日志

> 此文件由 `project-status.json` 生成，请勿直接编辑。
> 状态更新时间：2026-08-07T23:55:00+08:00

## 索引

| 更新 | 时间 | 关联计划 | 分支 | 提交 |
| --- | --- | --- | --- | --- |
| UPDATE-20260807-008 | 2026-08-07T23:55:00+08:00 | PLAN-110 | feat/intent-scheduler | 本条记录所在提交 |
| UPDATE-20260807-007 | 2026-08-07T23:08:26.1335151+08:00 | PLAN-130 | codex/gui-shutdown-v2 | 本条记录所在提交 |
| UPDATE-20260807-006 | 2026-08-07T22:44:53.9883278+08:00 | PLAN-130 | codex/gui-shutdown-v2 | 本条记录所在提交 |
| UPDATE-20260807-005 | 2026-08-07T22:17:05.6261580+08:00 | PLAN-130 | codex/gui-shutdown-v2 | 本条记录所在提交 |
| UPDATE-20260807-004 | 2026-08-07T20:17:19+08:00 | PLAN-130 | codex/gui-shutdown-v2 | 本条记录所在提交 |
| UPDATE-20260807-003 | 2026-08-07T19:55:00+08:00 | PLAN-001 | codex/ci-regression-gates | 本条记录所在提交 |
| UPDATE-20260807-002 | 2026-08-07T18:37:33+08:00 | PLAN-002 | codex/component-audit-ledger | 本条记录所在提交 |
| UPDATE-20260807-001 | 2026-08-07T18:09:45+08:00 | PLAN-001 | codex/component-audit-ledger | a468b14 |

## UPDATE-20260807-008

时间：2026-08-07T23:55:00+08:00

摘要：实现 Intent 调度器和评分系统，支持多维度评分、硬过滤和资源认领。

### 变更

- 实现 8 维度 Intent 评分公式（信息增益、成功率、证据相关性、新颖性、成本、风险、重复度、依赖深度）
- 实现 6 条硬过滤规则（依赖满足、资源可用、预算检查、证据需求、尝试次数、版本兼容）
- 实现 6 个触发条件（新 Fact、Intent 归零、连续失败、预算过半、新 Hint、Verifier 否决）
- 集成 scheduler_intent 命令类型实现持久化
- 完善资源认领机制，支持多资源事务和失败回滚
- 新增 CLI 命令（intents list/score/graph/claim）用于调试和可视化
- 修复 LeaseManager API 适配和类型冲突
- 补齐 CLI list/score/graph/claim 端到端集成测试并纳入 verify
- 移除临时计划文件并统一 CLI 可测试输出边界
- 消除 Windows WSL Shell 依赖和临时目录 EBUSY 清理竞态

### 验证

- [x] Intent scorer 单元测试通过
- [x] Intent filter 硬过滤规则测试通过
- [x] Intent scheduler 资源认领和回滚测试通过
- [x] CLI 命令功能验证
- [x] npm run test:cli-intents
- [x] Intent replay 回归测试
- [x] npm run verify

## UPDATE-20260807-007

时间：2026-08-07T23:08:26.1335151+08:00

摘要：统一暂停状态到所有 Run 终态的原子转换策略。

### 变更

- ControlStore 统一拒绝 PAUSED 状态下的 finish、fail 和 exhaust
- Reducer 拒绝所有 PAUSED 到终态的事件重放
- Loop 在迟到的 exhaust 被拒绝后重新读取并返回 PAUSED
- 新增 contract:pause-before-exhaust 和暂停终态策略测试

### 验证

- [x] contract:pause-before-exhaust
- [x] paused runs reject every terminal command until explicitly resumed
- [x] npm run check:change-contracts
- [x] npm run verify

## UPDATE-20260807-006

时间：2026-08-07T22:44:53.9883278+08:00

摘要：原子阻止暂停状态被最终成功提交覆盖。

### 变更

- ControlStore 在单写者命令校验内拒绝 PAUSED 状态的成功 finish
- Reducer 重放拒绝 PAUSED 到 SUCCEEDED 的非法状态转换
- 新增 contract:pause-before-finish 精确竞态回归测试

### 验证

- [x] contract:pause-before-finish
- [x] npm run check:change-contracts
- [x] npm run verify

## UPDATE-20260807-005

时间：2026-08-07T22:17:05.6261580+08:00

摘要：修复 Verifier 执行期间暂停后仍完成成功的问题。

### 变更

- Verifier 将 AbortSignal 传递到每次 fixture_score Effect，并在 Effect 和结果提交边界检查运行状态
- 验证返回、report 和 finish 前增加 fail-closed 检查，暂停运行保持 PAUSED
- phase_started 事件不再隐式恢复 PAUSED，新增暂停阶段转换回归测试

### 验证

- [x] contract:pause-during-verifier
- [x] phase transitions do not implicitly resume a paused run
- [x] npm run typecheck --workspace=@proofblade/gui
- [x] npm run typecheck --workspace=@proofblade/materials

## UPDATE-20260807-004

时间：2026-08-07T20:17:19+08:00

摘要：修复 GUI 关闭故障路径、Solver 单次中止和模型调用边界竞态。

### 变更

- 服务清理失败时仍关闭 HTTP Server 和 Vite，并统一汇总关闭错误
- Planner 返回、模型返回和验证入口重新检查 AbortSignal
- Chat Lane 直接中止，Solver Lane 统一只通过对应 AbortController 中止
- 恢复未受影响组件审计台账，只对真实受影响组件递增一次

### 验证

- [x] GUI shutdown failure and Solver abort contract tests
- [x] npm run check:components -- --base e2d2164
- [x] npm run check:change-contracts -- --base e2d2164
- [x] npm run verify

## UPDATE-20260807-003

时间：2026-08-07T19:55:00+08:00

摘要：把 PR 审查发现的虚假审计计数和生命周期竞态转为 CI 差异门禁。

### 变更

- 禁止源码未变化时修改 qualityAudit，并限制受影响组件每个 PR 只增加一次审计计数
- 组件文本哈希统一 LF，同时保持二进制内容逐字节哈希
- 增加 GUI Shutdown、Solver Abort、Sandbox Cleanup 和审计脚本的高风险变更契约
- 增加五个 CI 门禁自测并接入 npm run verify 与 GitHub Actions

### 验证

- [x] npm run test:ci-gates
- [x] npm run check:change-contracts
- [x] npm run verify

## UPDATE-20260807-002

时间：2026-08-07T18:37:33+08:00

摘要：增加统一的项目计划、更新日志、完成报告和维护报告。

### 变更

- 增加 project-status.json 单一数据源
- 增加四份确定性生成的中文项目报表
- 维护报告自动读取全部 COMPONENT.md 审计元数据
- 增加报表一致性、引用完整性和变更日志 CI 门禁

### 验证

- [x] npm run reports:project
- [x] npm run check:project-reports
- [x] npm run verify

## UPDATE-20260807-001

时间：2026-08-07T18:09:45+08:00

摘要：增加组件质量审计台账并修复 Fixture 求解立即暂停竞态。

### 变更

- 为 25 个组件增加 BUG、安全审计次数、时间、结果和源码指纹
- 增加审计记录器、重复检查跳过和批量原子写入
- 修复 startSolve 返回前 Run 未持久化的问题
- 修复暂停运行被改写为 EXHAUSTED 和暂停期间重复启动的问题

### 验证

- [x] npm run verify
- [x] 87 tests passed
- [x] 18/18 deterministic fixture evaluations passed
- [x] npm audit: 0 vulnerabilities
