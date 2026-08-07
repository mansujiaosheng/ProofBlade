# 项目计划

> 此文件由 `project-status.json` 生成，请勿直接编辑。
> 状态更新时间：2026-08-07T23:55:00+08:00

## 概览

- 计划总数：8
- 进行中：0
- 待开始：5
- 受阻：1
- 已完成：2

## 当前计划

| ID | 优先级 | 里程碑 | 状态 | 进度 | 负责人 | 最近更新 |
| --- | --- | --- | --- | ---: | --- | --- |
| PLAN-100 | P0 | Milestone 4 | 待开始 | 0% | unassigned | 2026-08-07T18:37:33+08:00 |
| PLAN-110 | P0 | Milestone 2 debt | 待开始 | 0% | unassigned | 2026-08-07T18:37:33+08:00 |
| PLAN-120 | P0 | Milestone 4 | 待开始 | 0% | unassigned | 2026-08-07T18:37:33+08:00 |
| PLAN-130 | P0 | Milestone 1 debt | 待开始 | 0% | unassigned | 2026-08-07T18:37:33+08:00 |
| PLAN-200 | P1 | Milestone 6 | 待开始 | 0% | unassigned | 2026-08-07T18:37:33+08:00 |
| PLAN-210 | P1 | Milestone 5 | 受阻 | 15% | unassigned | 2026-08-07T18:37:33+08:00 |

## PLAN-100 二进制 Artifact 与 Reverse 能力包

目标：让 Solver 能对真实 ELF/PE 等二进制执行可审计、可复现的静态分析。

依赖：无

### 交付物

- 二进制流与范围读取 Artifact API
- 格式、架构、区段、符号、字符串、反汇编和 XRef Capability
- Capability 输出到 Artifact、Evidence 和推理森林的确定性映射
- 至少三道真实二进制变体 Fixture

### 验收条件

- [ ] 核心 Tool Schema 保持稳定
- [ ] 所有完整原始输出均有内容哈希和可读取 Artifact
- [ ] 重置环境后分析结论可以独立复现

## PLAN-110 结构化 Phase Gate 与运行护栏

目标：阻止 Agent 在阶段产物不足、重复探索或缺少证据时提前得出确定结论。

依赖：无

### 交付物

- Model Target、Plan 和 Reproduce 阶段
- 每阶段结构化进入与退出门
- repeat breaker、no-progress、failure signature 和 phase deadline
- Intent 去重、环境漂移和无证据 claim 降级

### 验收条件

- [ ] 模型文本不能绕过阶段门
- [ ] 重复 Tool/参数/结果达到阈值后被机械短路
- [ ] 验证失败会携带原因返回可证伪假设阶段

## PLAN-120 统一预算与 Provider 调度器

目标：统一控制 Provider 并发、429 重试、Token、费用、阶段时间和提交次数。

依赖：无

### 交付物

- Provider/模型级并发槽和等待队列
- 带抖动的 Retry-After 退避与累计重试预算
- 请求前 Token、成本、Tool、阶段和提交预算检查
- GUI 与 telemetry 的等待、限流和预算状态

### 验收条件

- [ ] 同一 Provider 不超过配置的 pending 请求数
- [ ] 预算耗尽产生明确终态和失败分类
- [ ] 429 重试不会形成并发重试风暴

## PLAN-130 真实 Sandbox 与清理生命周期

目标：隔离 Tool Runner、目标 Fixture、Verifier 与 Host，并保证 Run 收尾无孤儿资源。

依赖：无

### 交付物

- 容器或 Windows Job Object Sandbox adapter
- 工作区、网络、CPU、内存、进程和输出硬限制
- 进程组终止、Fixture destroy 和后台 janitor
- Solver 与 Verifier 的独立可写目录

### 验收条件

- [ ] 目标进程无法读取 Host 配置和 Provider Key
- [ ] 超时会终止完整进程组
- [ ] Run 结束后不存在非保留 Job、Lease、进程或容器

## PLAN-200 Protocol Replay、Tool Replay 与 Shadow 评测

目标：把真实 Provider 和 Tool 轨迹转为可比较、可旁路验证的回归数据。

依赖：PLAN-100, PLAN-110, PLAN-120, PLAN-130

### 交付物

- Protocol Replay
- Tool Replay
- Shadow 路由和上下文策略
- 20 道以上变体与 holdout Fixture

### 验收条件

- [ ] 同一录制轨迹重放产生相同 projection hash
- [ ] Shadow 计算不影响主 Run
- [ ] 策略比较报告包含成功率、成本、缓存和错误提交率

## PLAN-210 Planner 与 Executor 双模型会话

目标：在结构化 Handoff 边界后增加独立 Planner Session，并用评测证明收益。

依赖：PLAN-100, PLAN-110, PLAN-120, PLAN-130, PLAN-200

### 交付物

- planner/executor 独立模型配置与 Pi Session
- 确定性路由、fallback 和 fail-closed 审批边界
- 重复 Intent 和并行浪费指标

### 验收条件

- [ ] 至少 20 道题每题三次与单 Agent 配对比较
- [ ] 成功率、成本或 p95 延迟至少一项稳定改善
- [ ] 其他指标不突破预算

## 已完成计划

| ID | 计划 | 完成度 | 最近更新 |
| --- | --- | ---: | --- |
| PLAN-001 | 组件质量审计台账 | 100% | 2026-08-07T19:55:00+08:00 |
| PLAN-002 | 项目计划与维护报表 | 100% | 2026-08-07T18:37:33+08:00 |
