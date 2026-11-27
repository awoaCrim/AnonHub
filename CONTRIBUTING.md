# 参与开发

## 准备

- Node.js 24；包管理只用仓库固定的 Yarn 4（没有全局 `yarn` 时用 `node .yarn/releases/yarn-4.12.0.cjs`），不要用 npm 或 pnpm 改依赖。
- `yarn install` 会装好 Git 钩子：提交前自动运行 `oxlint --fix` 和 `oxfmt`。

## 提交前

```bash
yarn lint
yarn fmt:check
yarn conventions --check
yarn check-types
yarn test
python3 -m unittest discover -s scripts/tests -v
```

CI 跑的就是这些。改了 `packages/agent-runtime`、`packages/contracts` 或 `core` 后，先构建这个包（`yarn turbo run build --filter=<包名>`），依赖它的包才会用到新代码。

## 约定

- 代码风格由工具决定：oxfmt（行宽 160、双引号、分号、尾逗号、排序导入）和 oxlint（禁止 `any`）。
- 新的公开行为要同时更新类型、配置 schema、提示词、历史投影和回归测试。
- 插件之间不互相导入源码，只通过 Core 的公开服务协作。
- 不提交生成的产物（`dist/`、`lib/`、`.turbo/`、`node_modules/`）。
- 提交信息用 `<类型>(<范围>): <概要>`，例如 `fix(roleplay): 机器人改角色卡后本轮回复不再被拦截`。类型取 `feat`、`fix`、`refactor`、`perf`、`test`、`docs`、`style`、`chore`、`ci`。

## Pull Request

- 一个 PR 只做一件事；说明改了什么、为什么，以及怎么验证的。
- 界面改动附上截图。
- 合并前 CI 必须通过。
