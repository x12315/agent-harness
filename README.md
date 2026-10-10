# Harness Engine

厂商中立的 Harness 控制面与 Composer。维护 CLI、Web/TUI、adapter 代码、schema、验证与性能验收；个人指令、Skills、Profiles 和 adapter 配置属于独立的 Catalog 仓。

本仓库不包含作者的工作方案，不安装共享 Skills 的副本，不保存认证、会话或个性化状态。`package.json` 的 `private` 只禁止 npm 发布，不代表 Git 仓库私有。

## 使用

需要 Node.js 22+、Git；Pi/Codex 与第三方依赖由各自官方工具安装。真实 RPC/TUI 集成测试需要 Pi，图形浏览器测试另外需要 agent-browser。

```bash
# 现有 Catalog，或先将 examples/minimal 复制到一个新的、独立的目录。
# 首次尚未投影 harness 时，直接运行工具入口。
node scripts/harness.mjs --catalog=/path/to/catalog compose --apply
node scripts/harness.mjs --catalog=/path/to/catalog bootstrap --apply

harness status --json
harness --catalog=/path/to/catalog web
harness --catalog=/path/to/catalog doctor
```

未指定路径时使用 `HARNESS_CATALOG`，其次是兼容的 `HARNESS_REPO`，再从已激活的原生 AGENTS 投影定位 Catalog，最后回落到 `~/.agents`。`--catalog=<path>` 或 `--catalog-root <path>` 显式选择优先。`harness verify --catalog` 则是静态验收开关，不是位置参数。

克隆在任意目录都可使用，Engine 位置由自身模块的真实路径确定，不由 Catalog 声明。位置和 Git 状态见 `harness status --json` 的 `engine`、`catalog`、`engineGit`、`git`、`interfaceVersion`。

## 入口

| 命令 | 用途 |
| --- | --- |
| `pi-h` / `harness pi [Pi arguments]` | 启动可热切换的普通 Pi，进入后用 `/harness` 管理菜单选择方案 |
| `harness web` / Pi `/harness web` | 方案新建、复制、编辑、删除、预览与审阅 |
| Pi `/harness` | Pi 内管理主入口：当前方案切换、基础配置与维护；子命令仅作快捷方式 |
| `harness profile list\|show\|path <id>` | 查看 Catalog 声明 |
| `harness compose --apply` | 编译指令、Profiles 和 schema 副本 |
| `harness bootstrap --apply` | 更新精确归属的原生投影，合并工程设置而保留个性化 |
| `harness restore` | 打印官方安装命令；`--apply` 才安装 |
| `harness reconcile` | 第三方 lock 与磁盘对账 |
| `harness doctor` | 完整验收；限并发执行，支持 `--serial` 对照 |
| `harness verify --catalog` | 生成物与原生投影静态检查 |
| `harness verify --runtime=pi --profile=<id>` | 仅指定方案、指定 adapter 的实际运行时 |
| `harness secrets` | 两仓源码扫描；支持 `--scan-root=<repo>`、`--staged`、`--history` |
| `harness benchmark` | 完整 doctor 多轮性能验收与版本比较 |

Pi/Codex 仍拥有自己的运行进程与交互循环。通过 `pi-profile <id>` 或 `codex -p <id>` 选择完整工作组合；`harness run` 是脚本化别名。人工控制面不注册为模型工具，也不受 Profile 工作工具权限约束。子 Agent 工具只能取父子 allowlist 的交集。

**以什么为准：** Catalog 源码是配置的唯一来源；当前会话启用什么，以 Pi 实际运行时为准（页脚与 `/profile status`），不是编辑器中选中的方案。Pi 内统一以裸 `/harness` 管理菜单为主入口，`/harness <操作>` 只作对应菜单项的快捷方式。菜单、帮助和补全来自同一份操作定义，所有菜单项与快捷命令都经同一个执行入口；菜单不另行判断切换权限。菜单切换与 `/harness switch <id>` 共用实现，发起切换后退出管理面，避免旧菜单跨运行时重载继续工作；取消选择则返回菜单。Web 是完整配置工作台，TUI 仅提供词条、Skills、推荐模型的基础编辑及维护；工具/扩展配置、方案新建/复制/删除使用 `/harness web`。保存配置不会自动切换正在运行的会话，需重选方案或 `/reload`。

### 在项目目录启动 Pi

完成 compose、bootstrap 与依赖恢复后，将 `~/.local/bin` 加入 PATH：

```bash
cd /path/to/project
pi-h                         # 等价于 harness pi
# Pi 内：/harness → 切换当前工作方案
# 快捷方式：/harness switch medium
# 需要重新进入普通模式时，退出后再次运行 pi-h
pi-h --model provider/model --thinking high
pi-h --continue              # 原生 Pi 的会话续接参数
```

入口显式启动上游内置 `default`，不恢复上次保存的方案，也不把 default 写成最后选择；它保留本机普通资源、模型默认值、scope 和主题，不强迫先选方案。启动后页脚显示「普通模式 · 未选择工作方案」，输入框上方提示用 `/harness` 管理菜单选择；选定工作方案后提示消失，页脚显示已启用的方案。`default` 是上游普通资源模式的内部名称，不是 Catalog 的默认工作方案。之后的资源准备、热切换、reload、会话和 Agent 循环由固定版本的 `pi-profile-switch` 与原生 Pi 执行。人工 `/harness` 被显式加载一次，即使使用 `--no-extensions` 关闭自动发现也保留管理入口。

Pi 参数（含 `--`、提示词、stdin/stdio、退出码和 SIGINT/SIGTERM）直接透传。`harness --catalog=/path pi ...` 的 Catalog 选择必须在 `pi` 前；`pi-h` 使用环境或已激活的 Catalog。投影或版本不符时停止，不自动 bootstrap、安装或改用户设置。已有 `PI_CODING_AGENT_DIR` 时拒绝嵌套启动，请从外部终端运行或在会话内热切换。直接指定方案仍用 `pi-profile <id>` / `harness run pi <id>`；`pi-h medium` 是 Pi 提示词，不是方案参数。

此入口用于会话启动；安装、认证、配置等管理命令仍使用原生 `pi`。上游会从任意位置（包括 `--` 后的提示词和参数值）提取 `--approve` / `-a` / `--no-approve` / `-na`；新入口明确拒绝这四个独立参数，避免把文本变成审批，不改写或模拟用户的信任决策。有此需求请明确使用原生 `pi`。

原生 `pi` 完全保留；`pi -h` 仍是帮助，`pi harness` 不被劫持成子命令。已经打开的普通 Pi 不会被自动重启或接管；下次从新入口启动即可。

**上游边界：** 普通模式要求原生 settings 排除 `profile-config`（模板已声明）；命名方案仍被 `pi-profile-switch@0.11.0` 强制加入该 Skill，新入口未解决此限制。不要用它改 adapter 生成物，配置仍走 `/harness`。上游从零工具方案 `/profile use default` 未恢复普通基础工具；因此 `/harness switch` 只支持 Catalog 工作方案，重新进入普通模式用新的 `pi-h` 会话。显式 `--extension` / `--skill` 按 Pi 原生规则添加资源；工具 allowlist 不等于系统级沙箱。

## 边界与契约

[Catalog API v1](docs/catalog-api.md) 是两仓唯一的结构契约：固定的数据布局、版本握手、CLI/HTTP 输入输出和原生投影归属。工具不会执行 Catalog 的控制面脚本，也不反向 import Catalog 源码。明确声明的自有 Skills、个人扩展、角色和提示词属于用户资源，不是工具控制面的实现。

内置扩展源自 `adapters/pi/extensions/`；用户可在 Catalog 的对应位置增加不重名的扩展。重名拒绝投影，不静默覆盖。schema 真相源在 `schemas/`，Catalog 内副本由 composer 生成。

同一个 Engine 可以读写多份 Catalog，各自有锁、CAS 和草稿；同一 HOME 的原生投影只能激活一份 Catalog，切换须显式 bootstrap，不能默默合并。隔离测试使用独立 HOME。

日常 Web/TUI 保存依据真实 diff 选择检查：元数据只检查编译/投影；adapter 字段只检查目标运行时；共享正文按具体 detail 消费者检查；生命周期操作更新投影。锁、CAS、0600 快照、原子写与反向复验保留。外部写入时停止恢复，不覆盖，也不抢 stale lock。

## 开发与发布

先读相邻实现。代码、标识符与提交信息用英文，conventional commits；开发在独立分支，合并主分支由人决定。源码修改后运行：

```bash
node scripts/test-control-plane.mjs
node --test scripts/tests/doctor-benchmark.test.mjs
harness doctor
git diff --check
```

快速控制面回路包括纯状态、独立 Catalog 接口、HTTP/事务、启动参数/信号、真实启动热切换 RPC、人工管理 RPC 和真实 TUI。夹具是 synthetic，不复制个人清单或认证。完整 doctor 另验实际安装、发现、adapter 契约、工具边界、依赖与投影；`--json` 不会跳过任何 gate。未安装的 harness 有显式 skip，不能据此声称其运行时验证过。

发布版本或修改检查执行路径时，遵循 [性能回归验收](docs/performance.md)：至少各三轮、保留覆盖与两仓源码身份、按显式预算比较历史报告，无法比较或实测时记录原因。功能验收与性能指标一起留档。

Web 的“配置仓同步”可登记当前 Catalog 的 Git remote/分支，开启可见页面的自动检查与更新弹窗；确认后仅快进配置仓，脏仓/分叉不覆盖，不更新工具或安装依赖。配置应用另行审阅；详见 [web/README.md](web/README.md)。运行中的 Pi 扩展改动需要 `/reload` 或重开会话；旧 Web 服务需关闭后重启。机器个性化、认证和运行目录不因代码仓升级而被纳管。

## 历史拆分

原单仓历史保留，未重写或 force-push。当前目录树只含 Engine；历史版本仍可见旧混合布局。Engine 与个人 Catalog 均公开维护；公开 Engine 会同时公开保留的原混合历史，公开前已复查完整历史的凭据风险。Catalog 在 `x12315/harness-catalog` 使用独立新历史，不混入工具历史；它不是工具的依赖或默认配置模板。升级时不要从历史目录恢复私人清单到 Engine 根目录。

## 许可证

本仓库采用 [MIT License](LICENSE)。Pi 派生代码保留上游版权与许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。运行时依赖、第三方 Skills 和外部服务仍遵循各自条款。
