# Harness Web

Node 标准库 HTTP 服务与原生 HTML/CSS/JS，不是聊天 UI。CLI `harness --catalog=<path> web` 或 Pi `/harness web` 启动；TUI 保留无服务兜底。

## 操作

配置方案列表可新建、复制、修改显示名称、删除；编辑页选择模型、thinking、instruction 详略、Skills 与权限，预览完整注入，保存前审阅差异。ID 稳定，改名称不改启动命令；换 ID 用复制后删除。复制源是已保存配置，不含草稿；至少保留一个方案。

删除显示源码/生成物/入口、共享资源与会话影响，要求准确输入 ID；不关工作会话，不删认证、历史、共享指令或 Skills。成功显示临时快照路径并只清理该方案草稿。

## 服务与安全

只绑定 127.0.0.1；临时授权链接 303 跳转去 token；每端口 HttpOnly/SameSite cookie。Host/Origin/sec-fetch-site、JSON object/body 上限、CSP/COOP/no-referrer/nosniff/frame 限制及静态资源白名单保留。源码/父目录 symlink 拒绝，读写目标与执行/静态资源来源分开。

启动时选定 Catalog 和 Engine；HTTP 请求无法改它们。worker/页面/runtime 探针只来自 Engine，不执行 Catalog 控制脚本。异步 worker 允许验证期间继续读取。共享 Catalog/source 锁、SHA-256 CAS、0600 快照、原子写、失败恢复与反向复验用于所有写入。并发外部写入不覆盖，不抢 stale lock。

模型目录只取 Pi 当前 session scope 或真实 registry 元数据；未知 thinking 能力不猜，不把 Profile 中的模型补回 scope。改变认证或 scope 后重开服务。保存依据服务端真实 diff 做增量检查，并显示范围/阶段耗时；完整 doctor 是独立“系统检查”入口。

关闭标签页不会停服务。点“关闭服务”或终端 Ctrl+C 后重新 `harness web`，旧标签关闭。默认随机端口；要跨重启恢复浏览器草稿，固定 `--port=8765`。草稿按仓库+origin，global/Profile 分开，Markdown 草稿只在当前编辑窗口。源码变更后扩展需 `/reload`。

## 验证

`node scripts/test-control-plane.mjs` 覆盖 HTTP、安全、写入、生命周期、失败恢复和 RPC/TUI。真正浏览器 QA 使用 synthetic fixture `scripts/tests/web-browser-fixture.mjs` 与 `scripts/tests/web-browser.sh`，不复制个人 Catalog 或认证。DOM/焦点/响应式/axe 结果不能冒充 WCAG 认证。

两仓协议见 `../docs/catalog-api.md`；完整 doctor 的并发行为与版本性能验收见 `../docs/performance.md`。VM 中 stub runtime 的耗时不是安装态性能，报告必须区分。
