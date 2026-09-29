## 分层归属

| 层 | 内容 | 位置 | 入库 |
| --- | --- | --- | --- |
| 指令目录 | 不可关闭、仓库级、profile 级 instruction modules | `instructions/` | ✅ |
| Profile 目录 | 跨 harness 的中立组合声明 | `profiles/` | ✅ |
| Skill 内容 | 自有 skill 与第三方安装产物 | `skills/<name>/` | 自有 ✅；第三方 ❌ |
| 依赖声明 | 第三方 skill 与 adapter 依赖版本 | `.skill-lock.json`、`scripts/pinned-versions.json` | ✅ |
| 适配层 | 编译后的厂商配置与厂商私有资产 | `adapters/<name>/` | ✅ |
| 运行产物 | npm/git 安装目录、状态、凭据、会话 | 各 harness 原生目录 | ❌ |
| 投影层 | harness 原生路径上的入口 | 各 harness 原生目录 | ❌，必须指向仓库 |

**一个 harness 一个 adapter。** 厂商特有字段只能出现在 `adapters/<name>/` 或 Profile 的 `adapters.<name>` 中；中立 instruction 和自有 skill 不出现厂商概念。

### 写入方

- `instructions/` 与 `profiles/` 是源码；`AGENTS.md` 和生成的 adapter profile 禁止手改，由 composer 生成。
- `skills` CLI 是共享 `~/.agents/skills` 中第三方 skill 的唯一安装器；自有 skill 由 git 管理。
- 声明过且固定版本的 adapter 可以生成自己的 harness 私有运行资源，但不得写入 `~/.agents/skills`，并必须由 `verify` 精确检查。
- Harness 管理由独立控制平面 `harness` / `/harness` 完成，不受工作 Profile 的工具权限约束；不得用 Pi 私有 `profile-config` 修改 adapter 生成物。
- 第三方内容不 vendor 入库；安装是整目录替换，不是合并。
