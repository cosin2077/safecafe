# Safecafe 交互式发布向导设计

## 目标

新增一个 `pnpm release` 交互式向导，将生产发布流程集中到一个入口：发布前检查、Web 构建、Filebase/IPFS 发布、Cloudflare Pages 部署、人工 ENS 更新以及最终线上验证。

脚本不得持有 ENS 私钥、不得发送 ENS 交易、不得自动提交 Git 改动。用户必须手动更新 `safe-staking.eth` 的 `contenthash`，脚本负责清晰提示并持续验证直到链上值匹配。

## 实现方式

- 新增独立 TypeScript 编排器 `scripts/release.ts`，通过 `tsx` 执行。
- 复用现有 `scripts/publish-ipfs.mjs --skip-build`，不复制 Filebase 上传和 release record 生成逻辑。
- 使用 Node.js 内置 `readline/promises` 实现交互，不引入新的提示库。
- 使用 ANSI 颜色和统一日志函数展示阶段、成功、警告、失败、耗时及待人工操作状态。
- 发布采用单次线性流程，不保存可恢复会话；中断后从干净工作区重新运行，避免恢复状态与实际构建产物不一致。

## 发布流程

1. 要求 Git 工作区干净，比较根 `package.json` 与最新 IPFS release record 的版本。若两者相同，默认准备下一个 patch 版本，同步 safe-lite package 与前端/CLI 版本常量后立即退出，不执行任何发布操作。
2. 用户审查并手动提交版本变更后再次运行 `pnpm release`；已高于线上版本时才继续发布。
3. 检查 Node、pnpm、Git、Wrangler 和当前工作目录，并展示 branch、commit、Cloudflare 项目名和 ENS 名称。
4. 检查 Filebase 必需变量是否存在，但不输出变量值。
5. 运行 `pnpm check` 和生产发布测试。完整模式执行 Agent、integration 和 system 检查；`--quick` 只执行 `pnpm check`。
6. 生成一次用于发布的 Web 构建。完整模式复用 system 检查前生成的构建，`--quick` 单独执行 `pnpm build:web`。
7. 对同一个 `dist/` 执行 `node scripts/publish-ipfs.mjs --skip-build`。
8. 从 `dist/release-record.json` 读取 CID，校验 commit、`dirty: false` 和发布记录结构。
9. 通过至少两个网关验证 `index.html` 与 `release-manifest.json` 可访问。
10. 使用 `wrangler pages deploy dist --project-name <project>` 部署同一份构建。
11. 展示 `ipfs://<CID>` 和 ENS 管理入口，等待用户手动更新 `safe-staking.eth`。
12. 用户按 Enter 后，直接从 Ethereum 主网 ENS resolver 读取 `contenthash`。未匹配时展示当前 CID 与目标 CID，并按固定间隔继续检查。
13. ENS 匹配后验证 `safe-staking.eth.limo`、Cloudflare 发布地址和 release record，输出最终摘要。

## 交互与参数

- 默认命令：`pnpm release`。
- `--yes`：跳过初始发布确认，但不能跳过人工 ENS 更新。
- `--quick`：只运行 `pnpm check`，省略完整发布测试；默认执行完整发布检查。
- `--bump=patch|minor|major`：当前版本已发布时要准备的版本类型，默认为 `patch`。
- `--poll-interval=<秒>`：配置 ENS 检查间隔，默认 15 秒，最小 5 秒。
- `Ctrl+C` 可安全退出；后续从干净工作区重新运行完整发布流程。

## 中断处理

发布流程不提供阶段恢复。中断后重新运行会重新执行检查、构建、IPFS 上传和 Cloudflare 部署，确保 Cloudflare 与 ENS/IPFS 来自同一份当前构建产物。

## ENS 验证

- ENS 名称固定为 `safe-staking.eth`。
- 通过项目已有的 Ethereum Mainnet RPC 策略读取 resolver 和 `contenthash`。
- 仅接受 IPFS namespace，并将其解码为 CID 后与目标 CID比较。
- RPC 临时失败不终止等待流程；显示错误并继续下一轮。
- 用户只能通过 `Ctrl+C` 取消持续检查。

## 错误处理

- 前置检查、测试、构建、IPFS 上传或 Cloudflare 部署失败时立即停止。
- 任意阶段失败后停止；修复原因并从干净工作区重新运行完整流程。
- 日志不得打印 Filebase token、secret 或其他 `.env` 密钥。
- 每个失败输出当前阶段和简短原因。

## 验证

- 为参数解析、CID 比较、secret 同步计划和日志脱敏增加针对性测试。
- 使用子进程注入或 dry-run fixture 验证步骤顺序，不执行真实上传和部署。
- 运行 Biome、TypeScript 检查和发布向导测试。
- 不在自动测试中更新 ENS、上传 IPFS 或部署 Cloudflare。

## 文档

- 在 `package.json` 增加 `release` 和发布向导测试命令。
- 更新 `CLOUDFLARE.md`，将 `pnpm release` 作为推荐生产发布入口，同时保留底层命令供故障恢复。
