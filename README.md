# agent-harness

个人的、厂商中立的 Harness Control Plane + Catalog + Composer。用统一的 `harness` / `/harness` 入口管理 instruction、skill、profile、投影和健康状态，编译为 Pi、Codex 等 harness 的原生配置；第三方安装与运行仍委托给各自的官方工具。

## 为什么是这个形状

Agent Skills 规范（由 Linux Foundation 下的 Agentic AI Foundation 治理）
只定义了 skill 目录**内部**长什么样，没有规定它们**放在哪**。规范自己的
集成指南推荐客户端同时扫描 `<client>` 私有路径和 `.agents/` 中立路径：

| Scope   | 路径                       | 用途           |
| ------- | -------------------------- | -------------- |
| Project | `<project>/.agents/skills/` | 跨客户端互通   |
| User    | `~/.agents/skills/`         | 跨客户端互通   |

所以本仓库根目录就设在 `~/.agents/`，`skills/` 天然落在中立发现路径上——
遵循规范的 agent 零配置即可读到，不需要给每个工具做 symlink farm。

## 目录结构

```
~/.agents/
├── instructions/          # instruction modules：mandatory / repository / profile
├── profiles/              # 跨 harness 的中立 Profile 声明与 schema
├── skills/                # Agent Skills 发现路径；自有源码 + 第三方安装产物
├── AGENTS.md              # composer 生成的常驻兼容入口，禁止手改
├── bin/harness            # 人类管理入口，投影到 ~/.local/bin
├── .skill-lock.json       # 第三方 skill 声明，可复现
├── adapters/
│   ├── pi/                # Pi 私有资产 + 生成的 profile JSON
│   └── codex/             # Codex 私有指令 + 生成的 profile TOML
└── scripts/
    ├── compose.mjs        # 中立目录 → harness 原生配置
    ├── manage.mjs         # 控制面状态、编辑与启动
    ├── bootstrap.mjs      # 投影与本机 settings 合并
    └── harness.mjs        # 管理与底层操作的统一路由
```

分层原则：**目录负责收编，Profile 负责组合，adapter 负责翻译，官方工具负责安装。**
`instructions/`、`profiles/` 与自有 skill 不含厂商概念；厂商字段进入
`profiles[].adapters.<name>` 或 `adapters/<name>/`。

## Harness 管理与编排

管理面与工作 Profile 分离：`harness` 是 shell 入口，Pi 内的 `/harness` 是由人触发的扩展命令；两者不依赖 agent 当前是否有 read/write/bash tools。`ask`、`review`、`implement` 只定义工作会话能力，不能阻断管理面。

```bash
harness                         # 状态面板
harness profile list
harness profile edit review     # 编辑源码并自动 apply + verify
harness run pi ask
harness run codex implement
harness apply
harness doctor
```

`AGENTS.md` 不再是手写真相源，而是 instruction catalog 的编译结果：

- `instructions/mandatory/`：不可关闭的安全与授权底线。
- `instructions/repository/`：在本仓库内始终生效的结构、验证和约定。
- `instructions/profile/`：由 Profile 选择的只读、审查、实现、表达方式等行为模块。

`profiles/*.json` 同时选择 instruction modules、skills、推荐模型和 adapter 资源。
`compose.mjs` 生成 Pi/Codex 的原生配置；用
`harness profile show <name>` 查看声明层的完整组合。格式与已知上游差异见
[`profiles/README.md`](profiles/README.md)。

## 投影（symlink）

`~/.agents/` 是源，各 harness 的原生路径是投影：

| 源                                        | 投影                          | 原因                                   |
| ----------------------------------------- | ----------------------------- | -------------------------------------- |
| `bin/harness`                             | `~/.local/bin/harness`        | 独立于工作 Profile 的人类控制面入口    |
| `AGENTS.md`                               | `~/AGENTS.md`                 | 祖先目录发现，对所有 agent 通用        |
| `AGENTS.md`                               | `~/.pi/agent/AGENTS.md`       | pi 的全局指令只认 agent-dir 下这条路   |
| `adapters/pi/extensions/*.ts`             | `~/.pi/agent/extensions/*.ts` | pi 扩展是厂商私有机制（文件级软链）    |
| `adapters/pi/extensions/subagent/*.ts`    | `~/.pi/agent/extensions/subagent/*.ts` | 同上（子目录形式）           |
| `adapters/pi/prompts/*.md`                | `~/.pi/agent/prompts/*.md`    | pi 的 prompt 模板发现位                |
| `adapters/pi/agents/*.md`                 | `~/.pi/agent/agents/*.md`     | pi 的 subagent 定义发现位              |
| `adapters/pi/settings.json`                | —（**不是投影，是合并源**）    | `packages` 与 Pi 私有 skill 排除；`{{HOME}}` 由 bootstrap 展开 |
| `adapters/pi/profiles/`                    | `~/.pi-profile-switch/profiles` | 中立 Profile 编译成 Pi 原生目录；state/instances 仍留本机 |
| `adapters/codex/AGENTS.md`                 | `~/.codex/AGENTS.md`          | Codex 的个人指令层，顶部指针要求按需读取共享规则 |
| `adapters/codex/profiles/*.config.toml`    | `~/.codex/*.config.toml`      | Codex 原生 `-p/--profile` 配置 |
| `skills/`                                  | —（无需投影）                 | Pi 与 Codex 都原生扫描 `~/.agents/skills/` |

**投影铁律：投影只能指向本仓库。** 指向上游安装目录（如 pi 的 `examples/`）的
链接会在升级时断掉，或静默换成新版本内容——那等于把真相源搬到仓库之外。

若某个 harness 有自家的指令文件名，在 `adapters/<name>/` 下放一个**兼容入口
文件**，再把它投影到该 harness 的位置。两个已装 harness 的入口：

| harness | 入口 | 投影 |
| --- | --- | --- |
| pi | 无入口文件，直接投影 `AGENTS.md` | `~/.pi/agent/AGENTS.md` |
| Codex | `adapters/codex/AGENTS.md`（作者的个人指令层，非入口文件） | `~/.codex/AGENTS.md` |

**两者都不需要「兼容入口文件」**（即没有 `CLAUDE.md` 那种换名文件）：pi 与 Codex 都认
`AGENTS.md` 这个名字，而且都原生扫 `.agents/skills/`，所以技能也不需要投影。区别在指令层：

- **pi**：读共享 `AGENTS.md` 本身（`~/.pi/agent/AGENTS.md` 是它的投影）。
- **Codex**：只读 `$CODEX_HOME/AGENTS.md`。实测它**不读** `~/AGENTS.md`（祖先发现以
  git 仓库根为界，`~` 不在仓库里），也**不支持 `@` 导入**（插进去无报错但无效）。
  所以 `adapters/codex/AGENTS.md` 是作者的个人指令层，顶部放一段**指针**，要求改动本
  harness 前先读共享规范；指针的有效性有行为验证（见「残余风险」第 10 条）。

只有碰到不认 `AGENTS.md` 这个名字的 harness，才需要 `adapters/<name>/` 下的兼容
入口。那时有个坑：**`@` 导入按文件的真实路径解析，不是按投影路径**，所以入口文件
被软链出去之后，里面的相对路径必须按**仓库内位置**写。（历史上
`adapters/claude-code/` 就因为把 `@../../AGENTS.md` 写成 `@../AGENTS.md` 而失效过；
Claude Code 已于 2026-09-28 移出本项目。）

## 第三方 skill

**管理完全借助第三方的 `skills` CLI**（钉在 1.7.0，见 `pinned-versions.json`）。
本仓库不自建包格式、不自建 registry、不 vendor 内容；只把来源与 digest 记进
`.skill-lock.json`，产物等同 `node_modules`，不入库。

官方安装渠道就是本仓库的 `install`：它读 lock、按来源分组、调 `skills` CLI 复原。

```bash
node scripts/harness.mjs install     # 新机器首次安装并创建 harness 命令
harness restore                      # 只复原（默认只打印命令）
npx skills add <source>              # 手动加一个，会更新 lock
npx skills list
```

`restore.mjs` 存在的原因：CLI **没有全局的「按 lock 安装」命令**（它的
`experimental_install` 只读项目级 `skills-lock.json`），所以由脚本把 lock 按来源
分组、每组发一条 `skills add`。

### 当前来源（14 组）

| 来源 | 技能 |
| --- | --- |
| 飞书 well-known 端点 | `lark-*`（28 个；`sourceType: well-known`，无 `skillFolderHash`） |
| `obra/superpowers` | brainstorming, executing-plans, finishing-a-development-branch, subagent-driven-development, using-git-worktrees, using-superpowers, writing-plans |
| `github/awesome-copilot` | documentation-writer, git-commit, make-repo-contribution |
| `stablyai/orca` | computer-use, orca-cli, orchestration |
| `mattpocock/skills` | grilling, writing-for-agents |
| `vercel-labs/skills` | find-skills |
| `vercel-labs/agent-browser` | agent-browser |
| `anthropics/skills` | frontend-design |
| `softaworks/agent-toolkit` | session-handoff |
| `nextlevelbuilder/ui-ux-pro-max-skill` | ui-ux-pro-max |
| `op7418/Humanizer-zh` | humanizer-zh |
| `ceorkm/macos-design-skill` | macos-design |
| `ancoleman/ai-design-components` | implementing-drag-drop |
| `DietrichGebert/ponytail` | ponytail |

装到哪里由 `restore.mjs` 的 `-a zed` 决定：`zed` 是 CLI 里的 **universal agent**，
指到它才会让文件落进规范存储 `~/.agents/skills/`（pi 与 Codex 原生读这里），而不是
某个 harness 的私有目录。**没装的 harness 会被 CLI 自动跳过**（实测 zed 未装，没有
创建任何目录）。

### 不要建到 pi 私有路径

`~/.pi/agent/skills/` 不应该有指向 `~/.agents/skills/` 的软链。pi 原生扫描中立
路径，两边并存会让 `verify` 把这些技能判为「来自仓库之外」而失败。历史上那里
曾有一套 28 个 lark 软链（早于本仓库存在），已删除。

## 新增自有 skill

```bash
mkdir -p ~/.agents/skills/<name>
$EDITOR ~/.agents/skills/<name>/SKILL.md
```

写完**必须在 `.gitignore` 加一行** `!/skills/<name>/`，否则不会被跟踪。

`SKILL.md` 只用规范定义的六个字段，保证跨 harness 可读：

`name`（必填，小写+连字符，需与目录同名）、`description`（必填，≤1024 字符，
要写清「做什么」和「何时用」）、`license`、`compatibility`、`metadata`、
`allowed-tools`。

厂商特有字段（如 pi 的 `disable-model-invocation`）不要直接写在顶层——其他
实现不认。放 `metadata:` 里。

## 特殊操作流程

下面每个流程都有坑，单独记下来。

### A. 新机器恢复

```bash
git clone <this-repo> ~/.agents
cd ~/.agents
node scripts/harness.mjs install   # 官方一条命令：投影 + 复原 + 对账 + 验收
```

`install` 是**官方安装入口**，依次做五件事，退出码即结论：

1. `compose` —— 检查 instruction/Profile 生成物没有漂移
2. `bootstrap --apply` —— 写受管投影、合并本机 settings
3. `restore --apply` —— 委托 `skills` CLI 与 npm 恢复声明依赖
4. `reconcile` —— skill 声明与实装差异必须已登记
5. `verify` —— 两个 harness、profile runtime、adapter 契约、投影与仓库卫生

只查不改、或只跑其中一步，也随时可以：

```bash
harness doctor                       # 只对账 + 验收，不写任何东西
harness restore --apply              # 只复原第三方技能
```

第三方生命周期全部委托给官方工具：共享 skill 用固定版本的 `skills` CLI，Pi Profile
运行时用固定版本的 npm 包 `pi-profile-switch`。本仓库不自建 registry，也不接管它们的
安装目录；`restore` 只把已入库声明翻译成对应安装命令。**`skills/` 不需要任何投影**。

注意 `restore` 存在的原因是：`skills` CLI **没有全局的「按 lock 安装」命令**——它的
`experimental_install` 只读项目级 `skills-lock.json`。所以这项工作由本仓库的脚本补上。

### B. 投影的建立与拆除

源永远是 `~/.agents/`，投影指向 harness 原生位置。三条规则：

1. **不投影 `skills/`**。往 `~/.pi/agent/skills/` 里放指向 `~/.agents/skills/` 的
   软链是反向冗余：pi 按**解析后的真实路径**去重，所以它能工作（实测数量不变、
   无警告），但多一份要维护的副本。
2. **禁止反向链**（项目 → 全局）。早期 `~/.agents/skills/ielts-writing` 直接软链
   到 `~/Desktop/ielts_writing_helper/.agents/skills/`，使全局技能依赖某个项目的
   存在。技能属于项目就留在项目；要全局可用，就把它作为**自有 skill** 收进
   `skills/` 并加白名单。
3. **`AGENTS.md` 的两条投影会各注入一次**：pi 按 symlink 路径去重（不是
   realpath），所以 cwd 在 `~` 下时同一份指令进提示词两次（约 803B）。保留两条是
   因为 cwd 在 `~` 之外时只有 agent-dir 那条生效。
4. **本机 settings 不投影。** `adapters/pi/settings.json` 只是工程键合并源；
   `~/.pi/agent/settings.json` 必须是实体文件。模型、provider、主题等普通偏好留本机，
   Profile 推荐模型则在中立 Profile 中单独声明。

### C. lock 与磁盘对账

`.skill-lock.json`（应装）与 `skills/`（实装）是两份独立数据，必须能解释差异。
按 `sourceType` 做集合运算，输出三类：**已声明未安装**、**已安装未声明**、**一致**。

本机实测（2026-09-28）：

| 类别 | 数量 | 明细 |
| --- | --- | --- |
| lock 声明 | 52 | github 24 + well-known 28 |
| 磁盘实装 | 55 | 已声明 52（28 个 `lark-*` + 24 个 github）+ 未登记 0 + 自有 3 |
| 已声明未安装 | 0 | — |
| 已安装未声明 | 0 | — |

收编记录（2026-09-28）：原本 9 个无来源技能全部处理完：

- **归为第三方（7 个）**：`implementing-drag-drop` → `ancoleman/ai-design-components`
  （收编前逐字节比对：19 文件 / 0 差异）；`executing-plans`、
  `subagent-driven-development` → `obra/superpowers`；`grilling` →
  `mattpocock/skills`；`ui-ux-pro-max` → `nextlevelbuilder/ui-ux-pro-max-skill`；
  `ielts-speaking` → `yanzhanlin/ielts-claude-skills`；`macos-design` →
  `ceorkm/macos-design-skill`。
- **归为自有（2 个）**：`book-translation`、`self-explanatory-code` 是作者自制，
  已加 `.gitignore` 白名单转为自有技能。

未登记技能只有两条出路：**补来源**（重装或手工补 lock 条目）或**判为自有**
（加白名单）。拖着不处理，它们既不可复现也不入库。

### D. 第三方 skill 的装 / 更新 / 删

```bash
npx skills add <source>      # 安装，自动更新 lockfile
npx skills list              # 看清单
npx skills update            # 更新——唯一允许的更新执行者
npx skills remove <name>     # 删除；不要用交互式全选
```

**不要用 `skills remove` 的交互式全选清理**：`skills list` 会把自有 skill
（`agent-harness`）也列进去（标为 `Source: local`），全选会连它一起删。

#### `well-known` 源（`lark-*`）的收编

飞书的「官方安装方法」就是一个标准 well-known 发现端点，**不需要飞书的下载器**：
`https://open.feishu.cn/lark-cli/skills/regular/.well-known/agent-skills/index.json`
（RFC 8615；`$schema: schemas.agentskills.io/discovery/0.2.0`；每个技能是
`type: archive` + `url: ./<name>.tar.gz` + `digest: sha256:…`）。
`skills` CLI 内置了 provider（`src/providers/wellknown.ts`），lock 里的
`sourceBaseUrl` / `wellKnownDigest` 就是它写的。收编命令：

```bash
npx --yes skills@latest add "https://open.feishu.cn/lark-cli/skills/regular" \
    -g -s '*' -a zed -y
```

四个坑，不知道就会装错位置：

1. **必须带一个 universal agent（`-a zed`）** 才能让文件落进规范存储
   `~/.agents/skills/`。`src/agents.ts` 里 `globalSkillsDir` 指向
   `~/.agents/skills` 的只有 `dexto`、`kimi-code-cli`、`loaf`、`sarvam-code`、
   `warp`、`zed`——它们是“读中立路径”的 agent。只传某个具体 harness 的私有 agent
   时，**base 会变成那个 harness 的私有目录**，文件复制到那里，`~/.agents/skills/`
   一个都没有，pi 与 Codex 也就看不到。正确输出里应出现 `universal: Zed`。
2. **不要用 `--all` / `-a '*'`**。CLI 把 pi 也当目标
   （`globalSkillsDir: ~/.pi/agent/skills`，且通过 `~/.pi/agent` 存在性自动探测），
   全局安装会在那里重建一整套软链农场——正是 B 里拆掉的旧模型。必须显式列 agent。
3. **`-a` 是空格分隔多值**（多个 agent 写成 `-a zed warp`），不是逗号。本仓库只需
   `zed` 一个。
4. **`--json` 对 well-known 源不支持**（会直接报错退出，什么都没装）。

`well-known` 源只能由 `skills` CLI 安装——任何只认 git 的管理器都表达不了它们。
这是「为什么不用 APM」的第一条，也是图形管理器不能接管安装的根本原因。

#### 收编未登记技能（把磁盘上的“野”技能接回 lock）

源用 `https://skills.sh/api/search?q=<name>` 解析（返回 `owner/repo/skill`）：

```bash
npx --yes skills@latest add <owner/repo> -s <skill> -g -a zed -y
```

**警告：安装是整目录替换，不是合并。** 本地独有的文件会消失。执行前先留快照：

```bash
tar czf /tmp/agents-before-absorb-$(date +%Y%m%d-%H%M%S).tar.gz -C ~ .agents
```

若能从上游取到同名技能，**装之前先逐文件比对**——一致才说明本地无改动，收编无损：

```bash
gh api "repos/<owner>/<repo>/git/trees/main?recursive=1" \
  --jq '.tree[] | select(.path|startswith("skills/<name>/")) | .path'
# 逐文件取回后用 diff -rq 比对
```

实测（2026-09-28 收编 6 个）：全部 6 个的 `SKILL.md` 都与磁盘旧版不同（旧版较旧，
上游文件更多，如 `scripts/`、`catalog-summary.json`），其中 `ielts-speaking` 的
`rubrics/` 与 `skill-references/` 两个本地独有目录**被删掉了**——要从快照里取回来
才能合并。若本地有改动，先比对再决定装不装。

对照的是：后来收编的 `implementing-drag-drop` 因先验证过“与上游逐字节一致”
（19 文件 / 0 差异），收编完全无损。**先验证再装**比事后从快照掘回来省事得多。

### E. 验证改动是否生效

`pi --mode rpc` 可以无模型调用地列出已注册的命令，用来确认 skill / extension
是否被正确发现：

```bash
printf '{"id":"1","type":"get_commands"}\n' | pi --mode rpc
```

验收标准（三条都要满足）：

1. stderr 为空——有重名或格式错误会在这里报警告
2. `source=skill` 的每一条 `sourceInfo.baseDir` 都指向 `~/.agents`
3. 预期的 extension 都在（本机：`handoff`、`bookmark`、`webui`、`goal` ×16、`llama`）

本机实测（2026-09-28，收编 24 个 github 技能后）：81 个命令 =
skill 55 + extension 23 + prompt 3，stderr 为空，**55 个 skill 的 `baseDir`
全部指向 `~/.agents`**。

注：`extension 23` 里有 16 条来自 pi 包 `npm:pi-goal-x`、1 条来自
`npm:pi-web-ui`——那些是 pi 安装包的产物，在 `~/.pi/agent/npm/` 下，不在仓库里。

命令数取决于实际装了什么，**不要拿固定数字当验收标准**——用“skill 的 `baseDir`
全部指向 `~/.agents`”和“stderr 为空”这两条。

### F. 回滚

改动 `~/.agents` 前先留三份素材：

```bash
tar czf /tmp/agents-backup-$(date +%Y%m%d-%H%M%S).tar.gz -C ~ .agents
cp ~/.agents/.skill-lock.json /tmp/lock-before.json
find ~/.agents/skills -maxdepth 1 -type l -exec ls -la {} \; > /tmp/links-before.txt
```

框架文件可以用 `git reset --hard` 回退，但**第三方技能不在 git 里**——只能靠
tar 快照或重新 `npx skills add`。

### G. 绕过 clone 的 git 流程（graft）

当 `github.com:443` 不可达而 `api.github.com` 正常时（实测过：`github.com` 超时、
`api.github.com` 200），用 API 取 tarball 落地，再 graft 到远端历史：

```bash
gh api repos/<owner>/<repo>/tarball/main > /tmp/repo.tar.gz
tar xzf /tmp/repo.tar.gz -C /tmp/stage
cp -R /tmp/stage/*/. ~/.agents/
cd ~/.agents && git init -b main && git remote add origin <url>
git add -A && git commit -m "<本地提交>"
git fetch origin && git reset --soft origin/main   # HEAD 换到远端历史，工作区/暂存区不动
git diff --cached --stat origin/main                # 核对将要提交的差异
git commit -m "<合并提交>"                           # 生成 origin/main 的子提交
git push -u origin main
```

`git reset --soft` 是关键：它把远端 HEAD 变成父节点，避免产生一条无共同祖先的
历史（直接 push 会被拒或被迫 `--force`）。

**注意**：`git push` 前确认提交身份是对的。本机**没有**全局 `user.name` /
`user.email`，本仓库带一条 repo-local 覆盖（`montana <2398925789@qq.com>`）。

## 脚本（scripts/）

所有检查都在这里：纯 Node 内置模块，零第三方依赖，默认只读，重复执行安全。

```bash
harness                              # 快速状态面板
harness profile list|show|edit ...   # Profile 管理
harness run pi|codex <profile>       # 启动工作会话
harness apply                        # compose + 投影 + 对账 + 验收
harness doctor                       # 只读总验收
harness bootstrap|restore|reconcile|drift|verify|secrets [--json]
```

新机器在投影尚不存在前执行一次 `node scripts/harness.mjs install`；之后只需记住 `harness`。底层命令仍保留，供自动化和排错使用。

| 脚本 | 做什么 | 网络 |
| --- | --- | --- |
| `manage.mjs` | 输出有效 catalog 状态，提供 profile 编辑与 harness 启动动作 | ❌ |
| `control-plane-canary.mjs` | 在 ask Profile 中执行 `/harness status`，断言零 agent/model turn | ❌ |
| `compose.mjs` | 验证中立 instruction/Profile，生成 `AGENTS.md`、Pi JSON 与 Codex TOML；默认只查，`--apply` 才写；`inspect` 输出声明组合 | ❌ |
| `bootstrap.mjs` | 按 `managedLinks()` 投影管理入口、生成物与 adapter，并合并工程 settings；冲突只报错，绝不删除实体内容 | ❌ |
| `restore.mjs` | 委托固定版本的 `skills` CLI 与 npm 恢复声明资源；默认只打印计划，`--apply` 才执行 | ✅ |
| `reconcile.mjs` | skill 声明 vs 实装，未登记差异即失败 | ❌ |
| `drift.mjs` | 比对 well-known digest 与上游索引 | ✅ |
| `verify.mjs` | composition、Pi/Codex、adapter 契约、投影、Profile runtime、仓库卫生与 settings 边界 | 本机探针 |
| `secret-scan.mjs` | 扫受控文件、暂存差异或完整历史；只打印掩码 | ❌ |

退出码：`0` 通过 / `1` 有未登记的差异或检查失败 / `2` 用法或仓库状态错误。
`verify` 里 harness 没装的检查项**跳过而不失败**（仓库在只装一个 harness 的机器上也要能用）。

`scripts/pinned-versions.json` 只钉**被 restore 委托的依赖工具**：`skillsCli` 与
`piProfileSwitch`。Pi/Codex 宿主版本仍现场观测，不把某次命令输出手抄成约束；Pi adapter
对内部导出符号的依赖由 `adapter contract` 探针守住。

**可选：把生成漂移、对账和密钥扫描挂成 pre-commit**：

```bash
git config core.hooksPath scripts/git-hooks   # 取消：git config --unset core.hooksPath
```

### 凭据不入库

硬规则：任何 key / token / 密码都不进受控文件，也不进 `adapters/`。两种可行做法：

- **macOS 钥匙串**（推荐，本机 `ssh_mcp` 就是这么做的）：启动包装脚本用
  `security find-generic-password -a <user> -s <service> -w` 取值，只导出到环境变量；
  脚本 700、不进仓库。
- **环境变量**：配置里只写变量名，值由 shell 或系统提供。

`secret-scan.mjs` 覆盖常见形态（OpenAI/Anthropic、Tavily、GitHub、Google、xAI、AWS、
Slack、HuggingFace、私钥块），外加「字段名像凭据且值是长字面量」的启发式。
pre-commit 跑 `--staged`；`harness.mjs all` 跑受控文件全量。它**只打印掩码**，
避免自己变成泄露点。

### 接入新 harness 的模板

1. 查它是否原生读 `.agents/skills/`——是则技能零适配。
2. 查它的全局指令文件名。pi 与 Codex 都直接读 `AGENTS.md`；碰到读别的名字的
   （如 `CLAUDE.md`、`GEMINI.md`）则在 `adapters/<name>/` 放兼容入口，再投影过去。
3. 厂商私有资产（extensions / prompts / agents 之类）放 `adapters/<name>/`，原位置留软链。
4. 在 `scripts/lib/repo.mjs` 的 `managedLinks()` 加一行，投影表也加一行。
5. 跑 `harness doctor`。
## 收藏（bookmark）

让 pi 里某一次回答既留在原会话里，又能被外部笔记跳转。标签写在原 session
的 `label` 条目里（历史零改动、不分叉），链接写在 HTML 快照 + markdown 索引里。

```
/bookmark [标签]     给最后一条 assistant 回答打标签，导出快照，复制链接
/bookmarks          刷新快照并复制本会话所有书签链接
/goto [标签|entryId] 跳转到本会话内的书签（省略则列出）
/unbookmark [标签]   清掉标签（省略则清最后一个）
```

快照链接是只读的，要回到活会话用 `/goto`：它只能解析当前在 pi 里打开的
会话，找不到时会翻 `PI_BOOKMARKS_DIR` 下的索引，把可能所属会话的
`pi --session <path>` 命令列出来。

输出目录默认 `~/.pi/agent/bookmarks/`，每个会话一份 `<session>.html`（快照，
每次命令重生成）和 `<session>.md`（索引，含 session 路径、`pi --session`
命令、以及每条书签的 entryId）。可用环境变量覆盖：

- `PI_BOOKMARKS_DIR`：输出目录
- `PI_BOOKMARKS_BASE_URL`：用 http(s) 基址替换 `file://`，便于在别处托管

`scripts/pi-labels.py` 是不依赖 TUI 的等价实现（适合 cron / 批量导出）。

## 第三方依赖的管理

三种东西要分开，混了就会出问题：

| 类别 | 例子 | 管理机制 | 入库？ |
| --- | --- | --- | --- |
| 第三方 skill | `skills/lark-*/` | `skills` CLI，锁定在 `.skill-lock.json` | ❌ 不 vendor |
| skill 依赖清单 | `.skill-lock.json` | 归 git 管 | ✅ |
| pi 包 | `~/.pi/agent/npm/pi-goal-x` | `pi install`，声明写在 `adapters/pi/settings.json` | ❌ 不 vendor |
| 自有 skill | `skills/agent-harness/` | 直接写 | ✅ |

原则与 `node_modules` / `package-lock.json` 相同：**依赖产物不入库，声明入库。**
这样仓库只有几百行，换机器靠 lockfile 复现。

### 为什么不用 APM

Microsoft APM 是这个领域功能最全的管理器（skills / prompts / agents / hooks /
plugins / MCP / LSP 一起管，有 lockfile、policy、audit，覆盖 copilot / claude /
cursor / codex / gemini / windsurf / kiro / opencode / grok-build）。
但对本仓库它**不适用**：

1. **装不了现有的第三方集。** 28 个 lark skill 全部是 `sourceType: well-known`
   （`https://open.feishu.cn/lark-cli/skills/regular/.well-known/agent-skills/*.tar.gz`）。
   APM 的源类型只有 git repo / 本地路径 / bundle / marketplace / registry，
   其 CLI 参考中 `well-known` 出现 0 次。换过去等于丢掉这 28 个 skill。
2. **会撞目录。** APM 默认把 skill 部署到 `.agents/skills/`（传
   `--legacy-skill-paths` 才用各家私有路径），与 `skills` CLI 的安装目标完全
   相同。两个管理器写同一个目录，谁都不是权威。

结论：**`skills` CLI 是当前唯一选择**，不是因为它最好，而是因为它是唯一能复现
现有第三方集的。pi 不在 APM 的 target 列表里（可用 `--target agent-skills` 间接
覆盖），但这不是决定因素。

### 如果将来要迁到 APM

先确认要装的第三方源都能被 APM 表达，再把自有 skill 移出 `skills/`（见下），
避免两个管理器争抢 `.agents/skills/` 的所有权。

### 只读检测：`skills-manager` CLI 与 APP 能否联动

`skills-manager`（Rust 桌面 APP + 自带 CLI）是这个领域唯一按「git 库 + DB 外置
且可由技能文件重建」设计的工具，但它的**联动条件与本仓库相撞**。

能联动的部分：CLI 与 APP 共享同一套 SQLite DB、中心库和 sync engine；APP 启动
时会把匹配版本的 CLI 发布到 `~/.skills-manager/bin/skills-manager-cli`，所以
agent 用到的就是 APP 的版本。

冲突在于 `--skills-root` 会**连 base 一起重定向**（`src-tauri/src/bin/skills-manager-cli.rs`）：

```rust
if let Some(skills_root) = &cli.skills_root {
    let base = central_repo::external_base_dir(skills_root);  // ~/.skills-manager/external/<name>-<hash>
    central_repo::set_runtime_base_dir_override(Some(base));
    central_repo::set_runtime_skills_dir_override(Some(skills_root.clone()));
}
```

于是它的 DB 落在那个 external 命名空间里，**与 APP 的库彻底隔离**——这正是它
「external checkout 保持干净」的实现方式，也意味着这个模式**不与 APP 联动**。

想要联动，只能让 APP 的 repo path 指向 `~/.agents`（`repo set-path`）、CLI 不带
`--skills-root`。代价是三件事：

1. `~/.agents/` 根下会多出 6 个状态文件：`skills-manager.db`、`scenarios/`、
   `cache/`、`logs/`、`.skills-manager.lock`、`git-askpass.sh`（必须 gitignore）
2. APP 成为该目录的**第二个写入方**，重演「为什么不用 APM」第 2 条
3. APP 的 git 功能会在 `~/.agents/skills/` 里 `git init`（**嵌套仓库**），因此
   Backup 页与 `git` 子命令必须完全不用

结论：**只读检测用 CLI + `--skills-root ~/.agents/skills`**——零污染、不与 APP
联动、也不需要装 APP。**要 APP 可视化，就必须接受它拥有这个目录**，与 `skills`
CLI 争抢所有权。两者不可兼得。

### 共享目录的固有风险

`~/.agents/skills/` 既是**多个管理器的部署目标**，又是本仓库的源目录，即
「构建产物落在源码树里」。`.gitignore` 的白名单机制就是为这个设计的。注意
`skills list` 会把 `agent-harness` 也列进它的清单（标为 `Source: local`），
所以不要用 `skills remove` 的交互式全选来清理——会误删自有 skill。

## pi 包的声明

[pi packages](https://pi.dev/packages) 的声明曾经不在本仓库里。现已按
「声明入库，产物不入库」收编：

| 层 | 路径 | 入库 |
| --- | --- | --- |
| 声明 | `adapters/pi/settings.json`（投影到 `~/.pi/agent/settings.json`） | ✅ |
| 产物 | `~/.pi/agent/npm/`、`~/.pi/agent/git/` | ❌ |

本机当前声明（2026-09-28）：

```json
"packages": ["npm:pi-web-ui", "npm:pi-goal-x"]
```

整个 `settings.json` 一起入库，而不是只抽 `packages` 数组：pi 只认这一个文件，
拆成「声明片段 + 手工合并」反而多一道易漏的同步工序。代价是 `theme`、`defaultModel`
和每次升级 pi 都会变的 `lastChangelogVersion` 也进了 git——看作「本机 pi 配置的
完整快照」，就不算噪声。

换机器：先按 A 建好软链，再按 `packages` 数组逐条 `pi install`。

## 决策记录

### 2026-09-28 · 权限墙曾被当成技术约束，选型被宿主现状绑架

- **事实**：给 alpha 选实验沙盒引擎时，`sudo` 需要密码这一条被当成硬约束，把 Incus、
  bhatti、E2B runtime、libvirt 系统实例一并从候选里划掉，最后选中的方案其首要优点
  是「不需要 sudo」。当时没有把「我需要 sudo」这件事提交给人。
- **代价**：选型被宿主权限现状绑架，而不是被需求绑架。被划掉的方案里就有后来真正
  采用的那条路：`systemd-vmspawn` 零特权即可起全 VM（`/dev/kvm` 与
  `/dev/vhost-vsock` 权限都是 666），测试用户不需要任何 root 等价能力。
- **结论**：权限、凭据、审批属**外部授权**，不是技术约束。撞上它们的动作是把缺口列
  成清单交给持有人拍板，同时给出零特权等价路径，由人决定方案去留。已升级为
  `AGENTS.md` 的「决策与授权」。
- **证据**：`~/Desktop/agent-harness-sandbox`（mkosi + systemd-vmspawn）。它的
  `docs/decisions.md` 是被否方案的完整记录，`docs/host-prereqs.md` 是零特权路径的
  前置条件。

### 2026-09-28 · 声明与实装对齐到零差异

- **`session-handoff` → 装上。** 源 `softaworks/agent-toolkit`，自带 python 脚本
  （`create_handoff.py` / `validate_handoff.py` 等），python3 本机可用，是自洽技能。
  它与 pi 的 `/handoff` 扩展是同一问题的两种解法、互不依赖：扩展产出提示词进剪贴板，
  技能产出落盘文档。
- **`ielts` → 删声明。** 它是 `ielts-speaking` 的父技能，而该家族已被作者弃用
  （`ielts-speaking` 已移除），磁盘上早已不存在，属历史幽灵声明。恢复方式：
  `npx --yes skills@1.7.0 add YANZHANLIN/ielts-claude-skills -s ielts -g -a zed claude-code -y`
- **`session-history` → 删声明。** 源 `rohitg00/agentmemory` 的 `skillPath` 在
  `plugin/skills/` 下，其 SKILL.md 第一句就调用 `memory_sessions` 工具，而该工具只随
  agentmemory 插件存在（本机未装）。单独安装等于装一个空壳，违反「声明即可用」。
  恢复方式：先装 agentmemory 插件，再
  `npx --yes skills@1.7.0 add rohitg00/agentmemory -s session-history -g -a zed claude-code -y`
- **`skills/.openclaude/` → 隔离。** 22 个目录的无主嵌套副本：既不是上层技能的镜像，
  也不是 OpenClaude 真目录 `~/.openclaude/skills` 的镜像（与后者有 80 处差异）。
  OpenClaude 读的是自己的目录，所以移走无影响。已移到
  `/tmp/agents-quarantine/openclaude-skills-nested-<ts>/`，全量快照见
  `/tmp/agents-before-task5-*.tar.gz`。

结果：`lock 52 = 磁盘 52 已声明 + 3 自有`，`scripts/expected-gaps.json` 清空，对账零差异。

### 2026-09-28 · Codex 指令层纳管（本机）

拉取到「Codex 一等公民」的设计后，本机 `bootstrap` 报了 `conflict` 且 `verify` 失败：
本机的 `~/.codex/AGENTS.md` **不是**共享 AGENTS.md 的投影，而是作者自己的 9.9KB
Codex 指令文件（12 节：语言偏好 / 配置与操作安全 / Git 与交付 / …），零仓库特征词。

结论：**把那份个人文件纳管**——内容作为 `adapters/codex/AGENTS.md` 入库，
`~/.codex/AGENTS.md` 改为指向它的软链。共享规范**不需要**并入或 `@` 导入：
Codex 自己内嵌的 spec 写着「the AGENTS.md file at the root of the repo and any
directories from the CWD up to the root are included」——即它会读祖先链上的
`AGENTS.md`，而 `~/AGENTS.md` 本来就是我们的投影。（这条是从 `codex` 二进制里
读出来的，不是靠模型探针。）

⚠️ **跨机注意**：`adapters/codex/AGENTS.md` 现在只有一份。另一台机器如果也有自己的
`~/.codex/AGENTS.md`，拉取后 `bootstrap` 会把它指向本仓库这份 → **先备份并合并**你
在两边的内容，否则会丢一份。

### 2026-09-28 · 宿主版本不钉，改用符号契约探针

- **起因**：`pinned-versions.json` 里 `piVerifiedWith` / `codexVerifiedWith` 两个「实测过的
  版本」，在实际机器上对不上（codex 实测 `0.154.0`），而「本机环境事实」那行写的又是
  pi 0.87.1 / Codex 0.157.1 / Claude Code 2.1.274——三个数全错。同一仓库里三处版本号
  互相矛盾。
- **判断**：这三样东西性质不同，不能一起钉。`skillsCli` 是**行为契约**（脚本真的执行它
  并对齐过其怪癖）→ 钉；`piVerifiedWith` 是**脆弱性标记**，但用版本号表示最弱（只提示
  不拦，且只覆盖 4 个耦合包里的 1 个）→ 换成探针；`codexVerifiedWith` 是**空 pin**
  （Codex 的检查是纯文件系统软链判断，与二进制版本无关）→ 删；README 里「已装版本」
  是**手抄缓存**（一条命令能查到的，留给环境）→ 删。
- **落地**：`pinned-versions.json` 只留 `skillsCli`；`verify` 把实测版本打在末尾
  （`observed live, not pinned`）；新增 `scripts/lib/adapter-contract.mjs`，读**已安装**包
  的声明文件，核对适配层 import 的每个值符号是否仍被导出（当前 16 个符号 / 4 个包），
  改名即失败并点出符号名。
- **代价**：探针是静态的——同名改签名看不见；`import type` 不纳入（转译时被擦除）。
  两条都写进了「残余风险」第 3 条。

## 项目级技能

规范允许项目自带技能，位置是 `<project>/.agents/skills/`（以及祖先目录，最多上溯到
git 仓库根）。策略：

1. **项目技能属于项目。** 它是与全局 `~/.agents/skills/` 平行的独立集合：不进全局
   lock，也不由全局的 `skills` CLI 管。
2. **禁止反向链。** 全局位置不得软链进项目——曾经有过
   `~/.agents/skills/ielts-writing -> ~/Desktop/ielts_writing_helper/.agents/skills/...`，
   那会让全局技能依赖某个项目的存在，项目一移走就断。
3. **要全局可用就收成自有技能**：把内容搬进 `skills/<name>/` 并加 `.gitignore`
   白名单，而不是留软链。
4. 本机现状：`rm-relay`、`ielts_writing_helper`、`Quickstart` 各带项目级技能，未纳入
   lock —— 这是设计如此，不是缺口。要摸清全盘：

   ```bash
   find ~ -maxdepth 6 -path '*/.agents/skills/*' -name SKILL.md | sed 's#/SKILL.md##'
   ```

## 残余风险

按「可验证到什么程度」如实记录，避免把「全绿」误读成「什么都验过」。

1. **两个 harness 的验证深度不同，别当成一样可信。** pi 是**行为验证**（`pi --mode
   rpc` 的 `get_commands` 实测技能发现与命令表）；Codex 目前只有**结构化**验证
   （`$CODEX_HOME/AGENTS.md` 是指向仓库的软链、首标题正确），**没有**跑
   `codex exec` 做行为验证。“Codex 读到了指令层”是推论，不是观测。gemini / cursor /
   opencode / zed 等连模板都未接入，`verify` 不覆盖。
2. **github 源的漂移没有自动检测。** `drift.mjs` 只逐个校验 `well-known` 源（当前
   28 条，比对上游 `index.json` 的 digest）。github 源的 `skillFolderHash` 目前没有
   校验路径，要验只能人工 `diff -rq` 与上游比对。
3. **升级断链风险（有意接受，能探但不全）。** `adapters/pi/` 下的 agent 定义、
   prompt 模板与扩展是从 pi 的 `examples/` vendor 进来的，不再跟随上游。`verify` 的
   `adapter contract` 探针核对适配层 import 的每个**值**符号是否仍被导出（当前 16 个
   符号 / 4 个包：`pi-coding-agent`、`pi-tui`、`pi-ai`、`typebox`），改名即失败并点出
   符号名。探针**看不见**的是：同名但签名或行为变了；`import type` 的符号（转译时被
   擦除，改坏不影响到运行）；以及任何静态检查都看不见的运行时行为。升级 pi 后仍值得
   人工复核一遍这两个 harness 的入口。
   Claude Code 已于 2026-09-28 移出本项目，所以它那条 `@` 导入按**真实路径**解析
   的隐式契约也不再有人验——将来若重新接入，它是第一个要重新实测的东西。
4. **`skills` CLI 的行为会漂移。** 脚本钉在 `skillsCli=1.7.0`，但该 CLI：对
   `well-known` 源不支持 `--json`；批量调用会瞬时失败（`restore` 已加 retry）；
   `experimental_install` 只认**项目级** `skills-lock.json`（所以本仓库才需要
   `restore.mjs`）。上游一变，pin 与脚本都要重新实测。
5. **凭据天然是每台机器各自的。** 新机器必须各自登录 pi 与 Codex；`verify` 对未
   登录/未就绪的 harness 只 `skip` 而不判失败。所以**看到全绿前请确认那几项是
   `pass` 而不是 `skip`**。
6. **项目级技能不在对账范围内。** `<project>/.agents/skills/` 由项目自负（见「项目级
   技能」）。本机有 3 个项目各带一份，属设计如此。
7. **`skills/` 是「构建产物落在源码树里」。** 隔离靠 `.gitignore` 白名单，忘加白名单
   会**静默**不入库（`AGENTS.md` 把它列为硬规则，但工具无法强制）。
8. **没有远端 CI 门禁。** pre-commit 是本机可选项，远端不检查，所以「提交即可信」
   依赖本地纪律。
9. **`drift` 与 `restore` 需要网络。** 本机对 `github.com:443` 曾多次抖动（演练中
   就遇到 `fetch` / `push` 超时），因此拉取与复原可能要重试。

10. **Codex 的共享规范靠「指针」而非自动注入，且行为验证依赖 `chatgpt.com` 可达。**
    Codex 只读 `$CODEX_HOME/AGENTS.md`，不读 `~/AGENTS.md`、不支持 `@` 导入（均为实测），
    所以共享规范通过该文件顶部的**指针**到达：要求改动本 harness 前先读
    `~/.agents/AGENTS.md` 与 `README.md` 的「特殊操作流程」。
    行为验证（2026-09-28 实测，20s 完成）：问「改动 `~/.agents` 前必须先读哪两个文件」，
    Codex 答出 `/Users/montana/.agents/AGENTS.md` 和 `README.md` ✓。
    注意这依赖模型**服从指针**，不是机制强制；而且 `codex exec` 还要
    `chatgpt.com/backend-api` 可达（本机曾不可达 → 卡在 `Reconnecting…`，根因是 Clash
    分流，见「已知情况」）。网络或模型行为变化时应重跑该探针。

### 2026-09-28 · 划定工程／个性化边界

`~/.pi/agent/settings.json` 之前是仓库文件的**整份软链**，于是「改本机模型」=「改仓库」，
两台机器互相覆盖：仓库里一度是另一台机器的 `qingxian-high` / `gpt-5.6-terra`，而本机
没有这个 provider，pi 只能回退（实测回退到 `openai-codex/gpt-5.5`）。

改为按边界拆开：普通 Pi settings 只共享工程键（`packages` 与 adapter 私有资源排除）；本机保留**实体**
`settings.json`，`bootstrap` 合并、`verify` 强制。本机个性化值按历史恢复为
`deepseek` / `deepseek-v4-flash`（见提交 `7082513`）。后续引入的 Profile 推荐模型是
**工作模式声明**，单独版本化在 `profiles/`；它不改写本机普通默认值，命令行/会话选择仍可覆盖。

⚠️ **另一台机器的后果**：它那里的 `~/.pi/agent/settings.json` 同样是软链，拉取后第一次
`install` 会把它转成实体文件（工程键来自仓库）。它原来的模型选择
（`qingxian-high`）会消失——因为该键已不属于工程层——需要在那边**重选一次模型**。

### 2026-09-29 · 从 manager 收窄为 Catalog + Composer

项目不再尝试拥有每个第三方安装器：`skills` CLI、npm、Pi/Codex runtime 继续各管自己的
生命周期；仓库只收编声明、组合 Profile、生成 adapter 并验证最终状态。`AGENTS.md` 也从
手写源改成 instruction catalog 的生成入口：mandatory/repository 模块常驻，profile 模块
随工作模式切换。

引入 `pi-profile-switch@0.11.0` 作为 Pi adapter 的运行时，不 fork。实测确认两个上游差异：
省略 `skills` 实际会得到零共享技能；Codex 的 skill override 实际要求具体 `SKILL.md`
路径。composer 用显式 skills 集和可移植 `~/.agents/.../SKILL.md` 路径消除歧义。上游还会
把 Pi 私有 `profile-config` 强制带入所有 Profile，无法收窄；本仓库以独立于模型和工作权限的 `harness` / `/harness` 控制面管理中立源码，并提交了上游 opt-out 请求
[VincentFF/pi-profile-switch#64](https://github.com/VincentFF/pi-profile-switch/issues/64)。

暂不拆独立新项目：中立 schema/编译器目前只有一个使用方；出现第二个仓库或第三个 adapter
后再提取，避免现在引入发布与版本协调成本。

### 2026-09-29 · 管理面与工作 Profile 分离

把 Profile 配置做成 skill 是错误边界：它会被模型意图路由抢占，还受 ask/review 的工具权限约束，导致“管理 harness”退化成“解释为什么不能写”。现在管理面改为 shell 的 `harness` 与 Pi 的 `/harness`；后者只注册人类 slash command，不注册模型 tool。Profile 只约束工作能力，`pi-profile-switch` 只做 Pi runtime，二者都不再充当管理入口。

## 已知情况

- **本机 `chatgpt.com` 不通，但 `api.openai.com` 通**（2026-09-28 实测）：DNS 被 Clash
  Verge 的 TUN/fake-IP 接管（系统、1.1.1.1、8.8.8.8 三个解析器都返回 `198.18.0.28`），
  `https://chatgpt.com/` 根路径 `http=000`，而 `https://api.openai.com/v1/models` 返回
  `401`（正常，只是没带 key）。Codex 走的是 `chatgpt.com/backend-api`（配置键
  `chatgpt_base_url`），所以 headless Codex 在这条路径上必然失败——**是分流规则问题，
  不是断网**。修法是让 `chatgpt.com` 与 `openai.com` 走同一策略组；修好后应补跑一次
  Codex 行为验证（见「残余风险」第 10 条）。
- **`~/.codex/config.toml` 会被 Codex 自己重写。** 实测光跑 `codex mcp list` 就把它
  规范化了：`startup_timeout_sec = 120` → `120.0`、删掉空的 `args = []`、重排 `env` 的
  键顺序。所以这个文件不适合手工精修，也**不适合像 pi 的 `settings.json` 那样整文件
  软链进仓库**——Codex 做的是整表重写，比 pi 的写穿透风险高得多。
- **不要用 `[mcp_servers.<name>] enabled = false` 去禁用插件提供的 MCP。** 该段缺
  transport 字段会让 Codex 直接
  `failed to load bootstrap configuration: invalid transport`，连 `codex mcp list`
  都跑不了（实测踩过）。要关插件自带的 MCP，用插件开关
  `[plugins."<plugin>@openai-bundled"] enabled = false`。
- **Codex 侧技能预算会被挤满。** 实测警告
  `Skill descriptions were shortened to fit the skills context budget`：技能装多了描述
  会被截断（仍可见，但描述变短）。可在 `[[skills.config]]` 里逐个禁用不用的
  （本机目前有 2 条禁用：`documentation-writer`、`humanizer-zh`）。

- **两个 harness 已接入为一等 agent**（2026-09-28）：pi、Codex。Codex 的接入最小
  ——它原生读 `AGENTS.md` 并原生扫 `.agents/skills/`；`$CODEX_HOME/AGENTS.md` 那条投影
  指到 `adapters/codex/AGENTS.md`（作者自己的长文指令层，已纳管入库），共享规范经祖先
  链的 `~/AGENTS.md` 叠加到它上面，既不要入口文件也不要技能软链。
- **Claude Code 已移出本项目**（2026-09-28）：入口文件、投影、`verify` 检查与
  `pinned-versions` 条目全部删除；`restore.mjs` 的 `-a claude-code` 也去掉（**保留
  `zed`**，它才是让文件落进 `~/.agents/skills/` 的那个）。本机 `~/.claude/CLAUDE.md`
  与 `~/.claude/skills/` 下的 24 条软链已清理。原因：它唯一的行为验证需要登录，未登录
  时只能 `skip`——与其留一个永远 `skip` 的检查，不如不要。重新接入照「接入新 harness
  的模板」走。
- **28 个 `lark-*` 已收编入库**（2026-09-28）：由 `skills` CLI 从飞书 well-known
  端点装入 `~/.agents/skills/`。早先 README 描述的
  「只存在于 lock、磁盘没有」已不成立。注：早先那句“31 个命令含 28 个 lark”与
  “`~/.pi/agent/skills/lark-*` 有 28 个软链”描述的是**另一台机器/另一时刻**的
  状态，本机按 B 的规则不建那套软链。
- **`~/.pi/agent/skills/` 不放共享 skill。** 历史上的 28 条 `lark-*` 软链已删除；Pi
  原生扫描中立路径。当前唯一允许的实体是固定版本 `pi-profile-switch` 自动同步的
  `profile-config`，它是声明过且由固定版本模板逐字比对守住的 Pi 私有生成产物。
- **`skills/.openclaude/` 已隔离**（2026-09-28）：那是 22 个目录的无主嵌套副本，
  已移到 `/tmp/agents-quarantine/`，详见「决策记录」。`skills/` 下现在只有 `.DS_Store`
  这类 OS 噪声（已 gitignore）。
- **git 身份来自全局配置**（`montana <2398925789@qq.com>`），仓库里没有
  repo-local 覆盖，与早先 README 的描述不同。
- **`~/.pi/agent/settings.json` 是本机实体文件**；`bootstrap` 只把仓库声明的
  `packages` 合并进去，不覆盖模型、provider、主题等本机普通偏好。
- **装了 `npm:pi-goal-x` 与 `npm:pi-web-ui`**（2026-09-28）：由 `pi install` 装入
  `~/.pi/agent/npm/`。它们属于「声明入库、产物不入库」里的产物，所以在
  `adapters/pi/settings.json` 里有声明，仓库里没有文件。收编 24 个 github 技能后
  引入 Profile runtime 前实测为 81 个命令（shared skill 55 + extension 23 + prompt 3）；
  现在新增由人触发的 `/harness` 扩展命令；上游私有 `profile-config` 文件仍由固定版本包生成并逐字校验，但 bootstrap 通过每台机器展开后的精确 `-path` 把它从普通 Pi 中排除。Profile runtime 因上游限制仍会看到它，但 `/harness` 在 skill 展开前处理管理请求。实测为 55 个共享 skill、82 个命令，stderr 为空，所有可见共享 skill 的 `baseDir` 都指向 `~/.agents`。

### 本机环境事实

> `AGENTS.md` 保持可移植（任何人 clone 都能照做），本机特有的东西只记在这里。

- 机器：macOS (Apple Silicon)，包管理用 Homebrew。
- 可用：`gh`、`npm`、`uv`、`git`、`python3`；`skills` CLI 通过 `npx skills@latest`
  调用（未全局安装）。
- 不可用（不要假设存在）：`pnpm`、`stow`、`chezmoi`。
- 默认 shell 为 zsh。
- 已装 harness：pi、Codex。Claude Code 仍在机器上（`/opt/homebrew/bin/claude`），
  但已移出本项目。**版本不在这里写**：它是现场能观测的事实，`pi --version` /
  `codex --version` 一查即得，`node scripts/harness.mjs verify` 也会把实测值打出来
  （写死在文档里只会变成陈数字）。
- 常用项目根目录：`~/Desktop/`、`~/Documents/`、`~/conductor/repos/`——这些下面有
  带项目级 `.agents/skills/` 的仓库（`rm-relay`、`ielts_writing_helper`、
  `Quickstart`），它们的技能目前不在 lock 里。
