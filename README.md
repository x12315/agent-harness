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
| `harness web` / Pi `/harness web` | 方案新建、复制、编辑、删除、预览与审阅 |
| Pi `/harness` | 无服务的人工 TUI 管理 |
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

快速控制面回路包括纯状态、独立 Catalog 接口、HTTP/事务、RPC 和真实 TUI。夹具是 synthetic，不复制个人清单或认证。完整 doctor 另验实际安装、发现、adapter 契约、工具边界、依赖与投影；`--json` 不会跳过任何 gate。未安装的 harness 有显式 skip，不能据此声称其运行时验证过。

发布版本或修改检查执行路径时，遵循 [性能回归验收](docs/performance.md)：至少各三轮、保留覆盖与两仓源码身份、按显式预算比较历史报告，无法比较或实测时记录原因。功能验收与性能指标一起留档。

Web 细节见 [web/README.md](web/README.md)。运行中的 Pi 扩展改动需要 `/reload` 或重开会话；旧 Web 服务需关闭后重启。机器个性化、认证和运行目录不因代码仓升级而被纳管。

## 历史拆分

原单仓历史保留，未重写或 force-push。当前目录树只含 Engine；历史版本仍可见旧混合布局。Engine 与个人 Catalog 均公开维护；公开 Engine 会同时公开保留的原混合历史，公开前已复查完整历史的凭据风险。Catalog 在 `x12315/harness-catalog` 使用独立新历史，不混入工具历史；它不是工具的依赖或默认配置模板。升级时不要从历史目录恢复私人清单到 Engine 根目录。

## 许可证

本仓库采用 [MIT License](LICENSE)。Pi 派生代码保留上游版权与许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。运行时依赖、第三方 Skills 和外部服务仍遵循各自条款。
