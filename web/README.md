# Harness Web

Node 标准库 HTTP 服务与原生 HTML/CSS/JS，不是聊天 UI。CLI `harness --catalog=<path> web` 或 Pi `/harness web` 启动；TUI 保留无服务兜底。

## 操作

本页编辑 Catalog 中的工作方案，不切换 Pi 当前会话；页面选中的方案不是已启用方案。保存后在可切换 Pi 会话中用 `/harness switch <id>`（或 `/harness` 菜单）重选，实际运行状态以 Pi 页脚及 `/profile status` 为准。TUI 是命令的交互入口，基础编辑不覆盖本页的全部配置功能。

配置方案列表可新建、复制、修改显示名称、删除；编辑页选择模型、thinking、instruction 详略、Skills 与权限，预览完整注入，保存前审阅差异。ID 稳定，改名称不改启动命令；换 ID 用复制后删除。复制源是已保存配置，不含草稿；至少保留一个方案。

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

“配置仓同步”只面向服务启动时选定的独立 Catalog。先选择该仓已有的 Git remote 和分支，保存本机登记；接受无凭据 HTTPS 或本机绝对 Git 来源，不接受 SSH、内嵌凭据或命令。状态读取不联网；未开启自动检查时只在点击“检查远端更新”后 fetch。登记与 0600 同步前源码 tar 快照在 `~/.local/state/harness/catalog-sync/`，不入 Git、不复制原生认证/会话/设置。

启用自动检查后，只在页面打开且可见时启动/恢复检查并每 15 分钟检测一次，服务端同样节流。发现可快进的更新弹出提交与文件列表；稍后处理保留更新入口，同一标签页同一候选不反复打断，仍可主动审阅。没有后台守护进程，不静默自动应用。

“确认同步配置”固定登记 hash、本地 HEAD 与已检查的候选 commit，仅执行禁用 hooks/fsmonitor 的 Git 快进。与编辑器共用 Catalog 锁；脏仓、未跟踪文件、分叉/回退、来源变化、stale CAS、自定义过滤器、被忽略文件碰撞或锁冲突停止，不 stash/reset/强制覆盖/自动推送。总 Git 操作预算 60 秒、单命令最多 30 秒，诊断不返回原始 stdout/stderr。远端树必须符合 Catalog 路径边界/API v1，无 symlink/submodule、疑似凭据或过大文件；仓库不是信任证明。

同步不更新 Engine、不加载远端代码、不安装包、不自动 compose/bootstrap 或运行 doctor；现有投影可能直接读取新的 Catalog 内容，已运行会话不会自动重载。请审阅后在终端显式生成、投影并验收；bootstrap 会合并工程设置，缺依赖时先人工核验安装计划。Git 工作树快进不是多文件原子事务：异常保留原提交/分支/候选和源码快照供人工恢复，不自动 reset 覆盖外部改动。成功只表示源码同步完成，不是运行时已启用或完整验收通过。

## 服务与安全

只绑定 127.0.0.1；临时授权链接 303 跳转去 token；每端口 HttpOnly/SameSite cookie。Host/Origin/sec-fetch-site、JSON object/body 上限、CSP/COOP/no-referrer/nosniff/frame 限制及静态资源白名单保留。源码/父目录 symlink 拒绝，读写目标与执行/静态资源来源分开。

启动时选定 Catalog 和 Engine；HTTP 请求无法改它们。worker/页面/runtime 探针只来自 Engine，不执行 Catalog 控制脚本。异步 worker 允许验证期间继续读取。配置编辑使用共享 Catalog/source 锁、SHA-256 CAS、0600 快照、原子写、失败恢复与反向复验；Git 同步的快进/恢复边界见上节，不宣称跨文件原子更新。并发外部写入不覆盖，不抢 stale lock。

模型目录只取 Pi 当前 session scope 或真实 registry 元数据；未知 thinking 能力不猜，不把 Profile 中的模型补回 scope。改变认证或 scope 后重开服务。保存依据服务端真实 diff 做增量检查，并显示范围/阶段耗时；完整 doctor 是独立“系统检查”入口。

关闭标签页不会停服务。点“关闭服务”或终端 Ctrl+C 后重新 `harness web`，旧标签关闭。默认随机端口；要跨重启恢复浏览器草稿，固定 `--port=8765`。草稿按仓库+origin，global/Profile 分开，Markdown 草稿只在当前编辑窗口。源码变更后扩展需 `/reload`。

## 验证

`node scripts/test-control-plane.mjs` 覆盖 HTTP、安全、写入、生命周期、失败恢复和 RPC/TUI。真正浏览器 QA 使用 synthetic fixture `scripts/tests/web-browser-fixture.mjs` 与 `scripts/tests/web-browser.sh`；同步另用 `scripts/tests/catalog-sync-browser-fixture.mjs` 与 `scripts/tests/catalog-sync-browser.sh`，不复制个人 Catalog 或认证。DOM/焦点/响应式/axe 结果不能冒充 WCAG 认证。

两仓协议见 `../docs/catalog-api.md`；完整 doctor 的并发行为与版本性能验收见 `../docs/performance.md`。VM 中 stub runtime 的耗时不是安装态性能，报告必须区分。
