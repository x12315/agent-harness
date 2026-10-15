# Harness Web

Node 标准库 HTTP 服务与原生 HTML/CSS/JS，不是聊天 UI。CLI `harness --catalog=<path> web` 或 Pi `/harness web` 启动；TUI 保留无服务兜底。

## 操作

本页编辑 Catalog 中的工作方案，不切换 Pi 当前会话；页面选中的方案不是已启用方案。保存后在可切换 Pi 会话中用 `/harness switch <id>`（或 `/harness` 菜单）重选，实际运行状态以 Pi 页脚及 `/profile status` 为准。TUI 是命令的交互入口，基础编辑不覆盖本页的全部配置功能。

配置方案列表顶部可选择“默认启动方案（Pi）”并保存；仅下次 `pi-h` / `harness pi` 自动选择，不切换当前会话或保存方案草稿。选普通模式可取消预选。偏好只在本机按 Catalog 保存，不随同步、不改模型默认值/认证/主题；原生 `pi`、Codex 和显式指定方案不受影响。删除默认方案后显示缺失提示，下次启动停止，请重新选择，不自动选其他权限方案。多页面冲突时刷新后重选。

配置方案列表可新建、复制、修改显示名称、删除；编辑页选择模型、thinking、instruction 详略、Skills 与权限，预览完整注入，保存前审阅差异。ID 稳定，改名称不改启动命令；换 ID 用复制后删除。复制源是已保存配置，不含草稿；至少保留一个方案。

Skills 目录与方案编辑页共用搜索、标签和已启用/未启用筛选，搜索匹配名称、标签和说明（多个词取交集）。目录先明确选择要配置的方案；点“飞书”标签即可找到全部 `lark-*`，再“全选当前结果”。全选/全不选只改当前结果，保留筛选外的选择；支持撤销上一步、草稿恢复和审阅保存，不安装/卸载或切换会话。清除筛选后才是对全部 Skills 操作。

Pi 是当前工作台的主要运行时。共享资源新增“Pi 工具与扩展”目录，支持按名称、说明、命令与工具搜索、分类、完整说明和各方案的草稿启用状态；可跳转到方案的相应设置。方案页显示工具参数、风险提示、扩展来源/版本、注册命令与工具。`harness-manager` 必选；选择扩展工具不会自动启用所属扩展，也不会突破工具 allowlist。

目录来自 Pi 公共注册 API、Engine/Catalog 资源和 `pi list` 返回的已安装包；未被任何方案启用的包也可见。Profile 必须使用准确的选择名，scoped 包保留完整名称，例如 `@calesennett/pi-codex-fast`。目录发现不是当前 Profile 已加载的证明；缺失来源保留原有声明，探针异常明确提示，保存仍按真实 diff 验收。资源/模型探针只有 RPC 状态查询，没有 prompt、工具执行或模型轮次；不会返回原始 settings、认证或参数默认值。元数据按服务生命周期缓存，安装/更新资源后重开服务。

Fast 扩展加载与速度设置分开：速度模式是本机/项目个性化，Profile 继承，命令 `/codex-fast` 切换当前 runtime 的设置；只有支持的 OpenAI 模型才添加 priority，DeepSeek 不适用。状态栏 Fast 不证明服务端接受了优先级。Profile 模型推荐也不覆盖 Pi 的显式模型/scope 选择；当前范围不含推荐模型时，Pi 可以选择范围内模型。

其他 agent 的现有模型和权限保留在高级折叠区，不扩展其配置或改变权限。

删除显示源码/生成物/入口、共享资源与会话影响，要求准确输入 ID；不关工作会话，不删认证、历史、共享指令或 Skills。成功显示临时快照路径并只清理该方案草稿。

## 安装与管理（人工审阅后委托 AI）

“安装与管理”是只读任务入口，不是浏览器安装器。可填写本地绝对路径或 `~/`、无凭据的 HTTPS Git 地址或 npm 包规格、版本、资源名称和期望安装位置；不会联网、读取待安装源码、下载或执行。填写期望目录不代表官方工具支持，agent 必须先核验并报告真实位置，不支持时暂停。

现有资源可核验或审阅移除，展示已保存方案引用（不含浏览器草稿/当前加载状态）。区分只取消配置引用与卸载受管副本；个人源码、本地引用、自带资源和未知来源不能按副本删除，必选管理入口不能移除。同包卸载提示其他扩展、Skills、提示词、主题和依赖影响，不能只按单个扩展名判断。

任务可查看、选择文本或复制给具备所需工具权限的 agent。复制不授权实施：先静态核验来源、精确版本、位置、脚本风险、逐文件影响与恢复计划，再等待本对话的明确批准。第三方 Skills 使用 Engine 固定版本的官方 skills CLI，Pi 包使用官方包命令，自有源码由 Git 管理。计划文字不是沙盒或执行保障；不自动开放工具、不自行提权，不把地址拼成 shell，不执行 curl|sh，不删除原始源码、认证、会话和本机个性化。源码和已上传 Git 不是信任证明；本地未推送修复不能被远端旧版本替代。

来源命名表示管理方式而非作者身份：Harness 自带随工具更新，个人源码保留原文件，Git/npm 安装由 Pi 管理，本地引用不复制源码；需核验的来源不提供删除承诺。详情提供复制位置、打开无凭据 Git 仓库、跳转安装/移除审阅的真实动作。

## 配置仓同步

“同步配置”只面向服务启动时选定的独立 Catalog。来源显示真实仓库链接，页面按配置方案、指令、工程设置、自有资源与安装包列出新增/更新/移除条目及数量，不把 Git 文件当作安装问题。路径、remote/分支设置、完整提交、文件清单和快照路径默认折叠在技术详情中；仓库、分支、候选与差异链接仍可直接使用，不硬编码个人仓库地址。本机来源不编造网页链接。

主按钮“同步配置”在未登记时显式登记当前选中的已有 remote（优先 origin）和分支（默认 main），随后强制手动检查最新候选。接受无凭据 HTTPS 或本机绝对 Git 来源，不接受 SSH、内嵌凭据或命令；修改登记仍使用原表单与 hash CAS。若只有无需安装的配置变化，直接调用 `operation: sync`；自有 Skill / 个人 Pi 扩展代码变化必须先通过条目审阅弹窗，使用来源差异核验代码后确认。摘要不是代码审阅，也不是信任证明。浏览器未保存草稿或来源冲突会阻止同步，不会自动保存、放弃或覆盖。

`sync` 在共享 Catalog 锁内重新核对登记 hash、本地 HEAD、已审阅候选、安装声明与缺失资源，然后禁用 hooks/fsmonitor 快进源码，依次执行受信任 Engine 的 `compose --apply`、`bootstrap --apply`、`verify --catalog`。bootstrap 仅合并工程设置并保留本机个性化。脏源码、未跟踪文件、分叉/回退、来源变化、stale CAS、实际适用的过滤器、探测失败、被忽略文件碰撞或锁冲突时停止（未使用的全局 LFS 声明不阻断），不 stash/reset/覆盖/推送。Git 总预算 60 秒、单命令最多 30 秒；配置应用总预算 120 秒、子阶段最多 60 秒。无效或旧 symlink 原生设置先拒绝，旧投影需在同步前保留个性化并转换；有 export-ignore/export-subst 的快照先拒绝。生成物与投影在实际写入处复核状态和父目录，阶段日志与 guard 清单权限 0600，仅在本机，不回传原生设置内容。远端树必须符合 Catalog 路径边界/API v1，无 symlink/submodule、疑似凭据或过大文件。旧 `operation: apply` 仍仅同步源码，供高级调用方显式使用；本页不把它当作配置应用。

安装声明新增/更新/移除或资源缺失会在源码快进、生成与投影之前阻断轻量同步。页面与弹窗显示具体 Skill / Pi 包名称、来源、声明版本和修复项，弹窗的“同步配置”禁用。“复制安装处理任务”包含**全部**配置、安装变化与缺失项，只生成只读任务，不下载、不安装、不卸载，也不表示授权或已完成。任务要求先核验固定版本官方 skills CLI 与官方 Pi 安装器、精确候选、开发引用及全部引用影响，展示具体计划等待人工批准；实施前用独立暂存目录/隔离 HOME、仓外 0600 快照与锁/CAS，写入前重新核对已批准候选和本地状态。工具不支持暂存、未知归属、凭据/权限墙或本地改动冲突时停止，不替换开发源码、不绕过审批、不把认证/会话入库。

GET / 检查返回的 `summary` 包含语义 `entries`、`installationChanges`、`counts`、`requiresInstallation` 和 `missingInstallations`（repair）；`application` 仅对应当前 HEAD。同步结果分别显示源码、配置应用、静态验收与会话状态，并列出 generate/project/verify 的成功或失败、返回码和耗时。失败可能已经 `synced: true` 但 `configurationApplied: false`：此时明确显示“源码已同步，但配置应用失败”，保留源码与配置快照及恢复提示，不冒充完整成功，不自动 reset 或重试覆盖。Git 快进不是多文件原子事务；登记和恢复记录位于本机 `~/.local/state/harness/catalog-sync/`，不入库。

成功只代表配置生成/投影与 `catalog-static` 静态检查（`full: false`），不代表完整 doctor、依赖完整性或实际运行时已验证。本功能不更新 Engine、不执行候选代码或 hooks、不安装资源、不自动重载会话；已有投影可能直接读取新源码，运行中的 Pi 需人工 `/reload` 或重新选择 Profile。

“仅检查更新”不应用配置。自动检查默认关闭，开启后只在页面打开且可见时启动/恢复并每 15 分钟检查一次，服务端同样节流；发现更新可弹出语义条目审阅，稍后处理后同一标签页同一候选不反复打断。后台自动检查永远不调用 sync/apply，没有后台守护进程，也不静默应用。

## 应用新版本检测

同步页的“应用新版本”独立检查服务选定 Engine 的 `origin/main`，顶部提示与“配置仓有更新”分开。应用仓库、远端分支、候选提交、更新差异与发布记录提供真实可点击链接；配置同步页显示当前来源的仓库链接，折叠登记表显示不同所选 remote 对应的链接，已登记状态与同步确认弹窗提供候选和差异入口。链接来自当前登记来源，不硬编码个人 Catalog，也不自动访问网页。GitHub 才生成其专用审阅链接；本机来源无网页链接，其他 HTTPS 来源仅打开原仓库。未检查、候选相同或提交不完整时不显示差异链接；本地未推送提交在远端网页可能不存在。当前版本和远端版本同时显示 package 版本号与 Git 提交；Git 提交决定先后，版本号相同也可能有更新。只在本地提交是远端候选祖先时提示新版本；本地领先、历史分叉、浅克隆无法判断或检查失败各自明确显示，不建议强制升级或降级。

“检查应用新版本”、Pi `/harness` 菜单同名操作（快捷命令 `/harness updates`）或 `harness updates --check [--json]` 显式联网。普通 `harness updates` 和 GET 状态只读离线缓存。自动检查默认关闭；开启偏好后仅在页面打开且可见时检查，服务端重读 opt-in，对成功和失败都节流 15 分钟；其他页面关闭后，旧页面的自动请求也不再联网。无后台守护进程。失败不清除最近成功时间，也不把旧候选当成刚获取的结果；来源变化立即使旧缓存失效。

只接受 Engine 现有 origin 的无凭据 HTTPS 或本机绝对 Git 来源，固定检查 main；SSH、缺失 origin 或 URL 重写需在终端人工核验。获取到独立 `refs/harness/engine-updates/`，不改变 HEAD、分支、工作树、origin 跟踪分支、Catalog、原生设置或认证；禁用 hooks/fsmonitor、askpass、交互认证及凭据 helper；工作树检查遇自定义过滤器时只提示人工核验，不执行过滤器或子模块状态探针。不执行远端代码。检查总预算 60 秒，单命令最多 30 秒；不返回原始诊断。偏好与检查记录权限 0600、锁/CAS，在本机 `~/.local/state/harness/engine-updates/`，不入 Git。

本功能仅检测，不自动升级、安装、生成配置或重启。脏 Engine 仍可检查并提示先自行处理修改。审阅候选后再在终端更新 Engine，旧 Web 服务需重开，Pi 扩展需 `/reload`；应用版本成功获取不等于依赖或配置已经就绪。

## 服务与安全

只绑定 127.0.0.1；临时授权链接 303 跳转去 token；每端口 HttpOnly/SameSite cookie。Host/Origin/sec-fetch-site、JSON object/body 上限、CSP/COOP/no-referrer/nosniff/frame 限制及静态资源白名单保留。源码/父目录 symlink 拒绝，读写目标与执行/静态资源来源分开。

启动时选定 Catalog 和 Engine；HTTP 请求无法改它们。worker/页面/runtime 探针只来自 Engine，不执行 Catalog 控制脚本。异步 worker 允许验证期间继续读取。配置编辑使用共享 Catalog/source 锁、SHA-256 CAS、0600 快照、原子写、失败恢复与反向复验；Git 同步的快进/恢复边界见上节，不宣称跨文件原子更新。并发外部写入不覆盖，不抢 stale lock。

模型目录只取 Pi 当前 session scope 或真实 registry 元数据；未知 thinking 能力不猜，不把 Profile 中的模型补回 scope。改变认证或 scope 后重开服务。保存依据服务端真实 diff 做增量检查，并显示范围/阶段耗时；完整 doctor 是独立“系统检查”入口。

关闭标签页不会停服务。点“关闭服务”或终端 Ctrl+C 后重新 `harness web`，旧标签关闭。默认随机端口；要跨重启恢复浏览器草稿，固定 `--port=8765`。草稿按仓库+origin，global/Profile 分开，Markdown 草稿只在当前编辑窗口。源码变更后扩展需 `/reload`。

## 验证

`node scripts/test-control-plane.mjs` 覆盖 HTTP、安全、写入、生命周期、失败恢复和 RPC/TUI。真正浏览器 QA 使用 synthetic fixture `scripts/tests/web-browser-fixture.mjs` 与 `scripts/tests/web-browser.sh`；同步另用 `scripts/tests/catalog-sync-browser-fixture.mjs` 与 `scripts/tests/catalog-sync-browser.sh`，不复制个人 Catalog 或认证。应用版本检测使用 `scripts/tests/engine-updates-browser-fixture.mjs` 与 `scripts/tests/engine-updates-browser.sh`，覆盖默认离线、独立提示、偏好持久化、失败旧结果和重试。默认启动方案使用 `scripts/tests/startup-profile-browser-fixture.mjs` 与 `scripts/tests/startup-profile-browser.sh`，覆盖本机持久化、保留其他草稿、多页面 CAS 冲突、缺失提示和普通模式重置；真实启动、菜单/命令及当前会话不变另由 Pi launcher RPC 验证。Skills 批量选择使用 `scripts/tests/skill-selection-browser-fixture.mjs` 与 `scripts/tests/skill-selection-browser.sh`，覆盖标签搜索、明确目标方案、筛选内全选/全不选、保留其他选择、撤销、草稿恢复和显式保存。DOM/焦点/响应式/axe 结果不能冒充 WCAG 认证。

两仓协议见 `../docs/catalog-api.md`；完整 doctor 的并发行为与版本性能验收见 `../docs/performance.md`。VM 中 stub runtime 的耗时不是安装态性能，报告必须区分。
