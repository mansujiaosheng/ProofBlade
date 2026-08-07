# ProofBlade CLI

```json component-metadata
{
  "id": "cli",
  "name": "ProofBlade CLI",
  "version": "0.2.2",
  "createdAt": "2026-08-05T22:49:12+08:00",
  "updatedAt": "2026-08-07T23:59:00+08:00",
  "qualityAudit": {
    "bugAuditCount": 2,
    "securityAuditCount": 2,
    "lastBugAuditAt": "2026-08-07T23:59:00+08:00",
    "lastSecurityAuditAt": "2026-08-07T23:59:00+08:00",
    "sourceHash": "b73f86eca23ebc2449d9a1a2a4319095780c43ae2afe814666c77334e9a83e5e",
    "result": "passed"
  }
}
```

## 职责

把命令行参数转换为 Materials 公共服务调用，输出适合脚本和人工调试的结果。它是交付层，不拥有新的 Run 状态或业务规则。

## 入口与依赖

- 可执行入口：`src/main.ts`。
- 唯一 ProofBlade 依赖：`@proofblade/materials`。
- 命令清单记录在根 README；稳定 JSON 输出应同步契约文档。

## 开发规则

- 参数校验、退出码和错误文本留在 CLI；状态转换留在 Materials。
- 新命令优先调用现有公开服务，缺少能力时先在正确的 Materials 组件补齐。
- 不从 GUI 或 Materials 内部深路径导入。
- `eval` 始终输出机器可读报告；只有传入 `--enforce-gate` 时，失败的 baseline 门禁才设置非零退出码。

## 验证

```powershell
npm run typecheck --workspace=@proofblade/cli
npm run eval
```
