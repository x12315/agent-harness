# Catalog API v1

## 版本握手

Catalog 根必须有 `harness.catalog.json`：

```json
{ "schemaVersion": 1 }
```

未知版本、缺失文件或额外字段拒绝编译/保存。manifest 不接受 Engine 路径、安装命令或可执行入口。位置由命令行/受信任的进程环境选择；Engine 定位来自自身源码。HTTP 请求不能选择另一个 Engine 或 Catalog。

`HARNESS_REPO` 是旧的位置别名，值仍只表示 Catalog；优先使用 `HARNESS_CATALOG`。没有显式选择时从已激活的原生 AGENTS symlink 识别 Catalog，最后回落 `~/.agents`；因此通过 bootstrap 激活的位置在重开 CLI/TUI 后仍匹配。`HARNESS_ENGINE_ENTRY` 仅是受信任的本机 TUI 测试/诊断入口覆盖，不是 Catalog 或 HTTP 字段。

## 数据布局与写入方

| Catalog 路径 | 契约 | 写入方 |
| --- | --- | --- |
| `instructions/{mandatory,repository,profile}/<id>{,.brief,.detailed}.md` | 三个完整替代文本；一层文件名 | 用户 |
| `instructions/selection.json` | 有序 `{id,detail}`；全部 mandatory 必须启用 | 用户 |
| `profiles/<id>.json` | schema 见 Engine `schemas/profile.schema.json`；名称与显示 label 分离 | 用户 |
| `skills/<name>/SKILL.md` | 自有 Skill 名与目录一致；第三方产物不入库 | 自有由 Git；第三方仅官方 skills CLI |
| `.skill-lock.json` | 第三方依赖声明 | 官方 skills CLI |
| `.gitignore` | 自有 Skill 白名单 `!/skills/<name>/` | 用户 |
| `expected-gaps.json` | 允许的依赖差异，必须有理由且已解决项须移除 | 用户 |
| `adapters/pi/settings.json` | 仅 packages/skills 为工程投影键，支持 `{{HOME}}` | 用户 |
| `adapters/pi/{agents,prompts,extensions}/` | 个人原生资源；扩展与 Engine 内置资源不能重名 | 用户 |
| `adapters/codex/AGENTS.md` | 个人原生附加说明；不能靠特定语言的指针短语保证共享规则 | 用户 |
| `AGENTS.md`、`adapters/*/profiles/`、`profiles/profile.schema.json` | 生成物，不手改 | composer |
| `scripts/git-hooks/pre-commit`（可选） | 仅委托已安装工具的 Git hook | Catalog 维护者 |

工具只写声明的生成路径和经用户确认的编辑源。Source/父目录 symlink 被拒绝；Profile schema 不是可编辑 Profile。源码配置不能把编辑目标或执行入口指向 Engine。

Pi 全局规则通过 Catalog AGENTS 投影发现；Codex 每个 Profile 的 `developer_instructions` 直接包含已选 global + Profile 规则，不依赖作者的中文标题或 home 目录指针。

## 命令与返回

使用 `harness --catalog=<path> <command>`。`status --json` 返回 `ok`、`engine`、`catalog`、`interfaceVersion: 1`、两仓 Git 状态、资源与投影统计。数据源与执行源始终不同：保存、检查、Web 静态文件、worker、runtime 探针来自 Engine，读写目标属于指定 Catalog。

`harness [--catalog=<path>] pi [Pi arguments]` 与 `pi-h` 启动可切换的普通 Pi。`pi` 后的参数是原生 Pi 输入，不再解析 Catalog 选择；新入口只接受已激活的匹配投影，不自动改 HOME 或声明。启动不保存默认方案选择，仍复用固定版本上游 runtime；详细行为与边界见 Engine README。

Web API（仅 loopback、临时授权、同源检查）：

- `GET /api/catalog`：资源、源码 SHA-256、模型 scope；不返回凭据。
- `POST /api/save-profile`、`/api/save-instructions`、`/api/save-instruction-text`：值 + 来源 hash CAS。
- `POST /api/create-profile`、`/api/delete-profile`：新建不覆盖；删除 hash CAS 且至少保留一项。
- `POST /api/doctor`：完整检查；保存本身只执行受影响项检查。
- `POST /api/shutdown`：停止服务，不影响工作会话。

保存返回 `ok`、阶段 logs/耗时和 `validation`（`full: false`）；失败含 status，正常回滚有 `rollbackVerified`，外部改动不覆盖。服务端重新规划影响范围，不接受客户端跳过检查。端口 cookie、Host/Origin/CSP、锁与恢复契约见 Web 文档。

## 投影归属

CLI（`harness`、`pi-h`）、内置扩展 → Engine 的精确文件；AGENTS、Profile、个人 agents/prompts/扩展 → Catalog 的精确源。doctor 校验真实路径与声明源相等，不只检查“某个仓库下”。实体冲突交给人，bootstrap 不覆盖实体；已受管 symlink 可修复，包括拆分后悬空的旧入口。

只激活一份 HOME 投影。多份 Catalog 的 API 保存互不写对方；需要同时验证原生启动时使用独立 HOME。认证、会话、npm 安装、主题、普通默认模型、最后选择均在原生目录，不属于任何仓。

## 升级契约

改变数据布局、允许字段或写入语义时，先增加版本与失败用例，不静默解释旧数据。独立目录测试必须覆盖：同一 Engine + 两份 Catalog、假控制脚本不执行、显式路径优先、版本错误拒绝、精确投影、保存隔离和回滚。模板位于 `examples/minimal`，与作者的个人仓无依赖关系。
