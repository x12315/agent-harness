# Harness Profiles

`profiles/*.json` 是跨 harness 的组合声明。它们只引用已经收编的 instruction modules 与 skills，并把厂商差异关进 `adapters.<name>`；不复制或安装资源。

## 数据流

```text
instructions/ + profiles/
          │
          ▼
 scripts/compose.mjs
    ├── AGENTS.md
    ├── adapters/pi/profiles/*.json
    └── adapters/codex/profiles/*.config.toml
```

前三者是源码；后三者是受控生成物。生成物提交到 git，方便新机器在安装 composer 依赖前就能被 harness 读取，但禁止手改。

## Profile 字段

- `instructions`：`instructions/profile/` 下的模块 ID。不可关闭与仓库级模块由 composer 自动加入 `AGENTS.md`，不在这里重复。
- `skills`：必须显式声明。`[]` 表示无共享 catalog skill，`["*"]` 表示全部已声明 skill，其他名称/glob 表示白名单。Pi 0.11.0 的包私有 `profile-config` 仍会常驻，见下方上游边界。
- `adapters.pi`：Pi 的推荐模型与 tools/extensions/MCP 选择。`harness-manager` 必须在每个 Profile 中显式保留；implement 显式列出仓库自有和已声明 package 的扩展集，本机私有 UI 扩展不进入共享声明。
- `adapters.codex`：Codex 的推荐模型与 sandbox/approval 选择。

模型映射刻意留在 adapter 内：中立层只表达共同的 instructions/skills，不能假设两个 harness 使用同一 provider ID。命令行和会话显式选择仍可覆盖推荐模型。

Profile 名不能是 `default`：这是 `pi-profile-switch` 的内置全量模式。

## 场景预设

Profile 不是简单的读写等级，而是“任务场景 × 模型能力”的起点：

| Profile | 场景 | 默认 Skills / 策略 |
| --- | --- | --- |
| `ask` | 快速问答与本地浏览 | 零 Skills，只读工具，标准模型指导 |
| `research` | 空间探索、网页和知识库调研 | 浏览器及核心知识检索 Skills，Pi 不开放 edit/write，远端操作受 retrieval-only instruction 约束 |
| `review` | 证据化代码审查 | 代码质量 Skills，只读，较深推理 |
| `coding` | 日常编码 | Git 工作流、计划执行、可读性和最小实现 Skills，可写工作区 |
| `implement` | 需要完整 catalog 的复杂任务 | 全部 Skills 和已声明扩展；作为全量逃生口，不是日常默认 |

`profile/model-weak` 会要求小步行动、显式约束和逐项验证；`profile/model-standard` 保留适量计划与验收；强模型模式不增加额外指导。模型能力与具体 provider/model ID 分开配置，不从名称猜测能力。

`research` 为调用浏览器和检索 CLI 保留 Pi `bash`，因此不是操作系统级只读沙箱；Codex 的文件沙箱也不约束远端 API。`profile/research` 明确禁止表单提交、发消息、上传以及本地/远端状态修改。需要执行这些动作时切换到 writable 场景。

## 管理与运行

管理面不属于任何工作 Profile，也不受它的 tools/sandbox 权限约束。日常配置在 Pi 中使用 `/harness configure <name>`：

- “模型能力指导”选择弱、标准或强；
- “Skills 开关”按分类显示全部 catalog skill，并支持即时搜索；
- “执行权限”同步设置只读/调研/实现行为指令、Pi 内置 tools、extension 能力集与 Codex sandbox/approval，避免权限和行为互相矛盾；
- “推荐模型”分别设置 Pi provider/model 与 Codex model；
- 保存后自动 compose、投影并运行 doctor，任一步失败都会恢复并复验原配置；新会话立即采用新配置，正在使用同名 Profile 的会话需 `/profile reload`。

```bash
harness                              # 状态与下一步
harness profile list
harness profile show research
harness apply
harness doctor
```

Pi 的 `tools` 是实时工具严格 allowlist；只读、调研和编码预设因此只选择不会绕过该边界的 extension，全量模式才加载 goal、webui 与 subagent。doctor 会核对实际 extension 来源，并拒绝未声明来源或 allowlist 外的活动工具。`harness profile edit <name>` 与 `/harness edit <name>` 仅作为高级 JSON/排错入口。暂不增加 WebUI：现有规模用 Pi 原生搜索、选择器和表单即可完成，且不会引入常驻服务或第二套状态同步。

Pi 内的 `/harness` 是人类触发的 extension command，不向模型注册 tool。工作会话通过控制面启动：

```bash
harness run pi research
harness run codex coding
```

Pi 会话中仍可用 `/profile use review` 热切换；`pi-profile` 只是 `harness run pi` 背后的 runtime engine。Codex 仍由原生 `-p` 实现，但用户无需记住 adapter 命令。

## 上游边界

- `pi-profile-switch` 只负责 Pi 的解析、热切换、runtime overlay 与冲突报告；版本声明在 `scripts/pinned-versions.json`，由 `restore` 委托 npm 安装。
- 0.11.0 会生成 `~/.pi/agent/skills/profile-config/SKILL.md`。它只会编辑 Pi 原生 profile，不能作为本仓库的跨平台配置入口，因此 composer 不声明它，bootstrap 也用展开后的精确 `-path` 从普通 Pi 排除它。但上游 launcher 会把它强制带进所有 Pi Profile，当前无法由 Profile 收窄；用户管理入口是 `/harness`，扩展命令会在 skill 展开前被处理，不经过模型。已向上游提交 opt-out 请求 [VincentFF/pi-profile-switch#64](https://github.com/VincentFF/pi-profile-switch/issues/64)。该私有产物仍由 `verify` 与固定版本模板逐字比对。
- 0.11.0 实现中，省略 `skills` 会收窄为零（与文档声称的“不收窄”不同），所以中立 schema 强制显式声明，全部技能用 `["*"]`。省略 `extensions` 同样不会保留普通用户扩展，因此 implement 也显式声明共享扩展集；runtime canary 会验证管理、收藏、handoff、goal 与 webui 命令仍在。
- 当前 Codex 实现要求 `skills.config.path` 指向具体 `SKILL.md`，而不是文档所说的 skill 文件夹；生成器使用可跨机器展开的 `~/.agents/skills/<name>/SKILL.md`。

## 为什么暂不拆新项目

中立 schema 与 composer 目前只有这个仓库一个使用方。代码保持无第三方依赖、输入输出边界清楚；等出现第二个独立仓库或第三个 harness adapter，再把 `compose.mjs` 与 schema 抽成单独项目。在此之前拆仓库只会增加版本协调，不会增加复用。
