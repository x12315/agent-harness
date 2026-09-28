# AGENTS.md

本仓库是一套**厂商中立的 agent harness 管理方案**：skill、指令与工具配置在这里
是唯一真相源，再通过 symlink 投影到各 harness 的原生位置。任何读取本文件的 agent
都按下面的规范管理这套 harness。

设计理由、目录结构、全部特殊操作流程见 `README.md`；本文件只写**必须遵守的规则**
与**该去读哪里**。本机特有的环境事实见 `README.md` 的「本机环境事实」。

## 分层归属（谁拥有什么）

| 层 | 内容 | 位置 | 入库 |
| --- | --- | --- | --- |
| 内容层 | 自有 skill、中立指令 | `AGENTS.md`、`skills/<name>/` | ✅ 全量源码 |
| 声明层 | 第三方依赖清单 | `.skill-lock.json` | ✅ 只入声明 |
| 产物层 | 第三方 skill 的内容 | `skills/<name>/`（同目录） | ❌ 由 CLI 安装 |
| 适配层 | 某个 harness 的私有资产 | `adapters/<name>/` | ✅ |
| 投影层 | harness 原生位置上的入口 | 各 harness 自己的目录 | ❌ 全是 symlink |

**一个 harness 一个目录。** 厂商特有的东西只能出现在 `adapters/<name>/`；`AGENTS.md`
与自有 skill 里不出现任何 harness 特有概念。

## 硬规则

1. **单写入方。** skill 的安装与更新只由 `skills` CLI 完成
   （`npx skills add / update / remove`），内容真相只由 git 完成。不要让任何图形
   管理器「拥有」`skills/`——它会与 CLI 争抢所有权，并把来源元数据降级。
2. **投影只能指向本仓库。** 禁止把 harness 原生位置链到上游安装目录（如 pi 的
   `examples/`）：升级时会断，且可能静默换成新版本内容。
3. **依赖产物不入库。** `skills/` 默认整体忽略，只逐条白名单放行自有 skill；
   `node_modules/` 同理。**新增自有 skill 必须在同一提交里加 `!/skills/<name>/`**，
   否则它会静默不被跟踪。
4. **先验证再动。** 收编或覆盖上游文件前逐文件比对（`diff -rq` / digest）；破坏性
   操作前留快照。安装是**整目录替换**，不是合并。
5. **厂商扩展字段进 `metadata:`。** `SKILL.md` 只用规范定义的六个顶层字段
   （`name` / `description` / `license` / `compatibility` / `metadata` /
   `allowed-tools`），否则其他实现不认。`name` 必须与所在目录同名。
6. **`description` 决定模型是否加载该 skill。** 必须同时写清「做什么」和「何时
   触发」；写成 "Helps with X" 会失效。

## 决策与授权

**权限墙升级给人，不当技术约束。** 候选方案的落选理由里出现「需要 sudo / root /
凭据 / 审批」时，把「要什么、给谁、影响什么」列成清单提交给人拍板，并同时给出零特权
的等价路径。外部授权缺口是人的决策点：**静默绕开**（把方案划掉）与**不问自取**
（自己提权）都不算。

**判据**：每条落选理由都能被独立复述，且其中没有未提交给人的授权缺口。

7. **工程与个性化的边界。** 跨机器一致的**工程声明**（如 pi 的 `packages`）入库；
   机器**偏好**（模型、provider、thinking、主题、开关）留本机实体文件，**不做整文件
   软链**——软链会让两台机器互相覆盖彼此的选择。`bootstrap` 负责合并，`verify` 强制这条
   边界。

## 动手前先读哪里

| 你要做的事 | 去处 |
| --- | --- |
| 新增/修改 skill、给新 harness 做适配、排查 skill 没被加载 | `skills/agent-harness/SKILL.md` |
| 任何涉及投影、对账、回滚、graft、第三方装/更新/删的操作 | `README.md` 的「特殊操作流程」（A–G） |
| 环境、已装 harness、路径、项目根等本机事实 | `README.md` 的「本机环境事实」 |
| 第三方依赖政策与「为什么不用 APM」 | `README.md` 的「第三方依赖的管理」 |
| pi 包声明的入库方式 | `README.md` 的「pi 包的声明」 |
| 检查、引导、对账、漂移、接入模板 | `README.md` 的「脚本」+ `scripts/` |
| 要给方案做取舍、或撞上权限/凭据缺口 | `README.md` 的「决策记录」（这类教训的存档） |

## 改动后必须过的验证

**一条命令**（引导 dry run → 对账 → 验收；退出码即结论）：

```bash
node scripts/harness.mjs all
```

下面两项是它的展开，手工复核时按同样标准：

1. **pi 侧发现正常**

   ```bash
   printf '{"id":"1","type":"get_commands"}\n' | pi --mode rpc
   ```

   要求：stderr 为空；`source=skill` 的每一条 `sourceInfo.baseDir` 都指向本仓库。
   注意输出里会夹杂 goal 扩展的 UI 事件行，按 `"command":"get_commands"` 取那一行。
   tool 是否注册要看 `session.getAllTools()`（`get_commands` 不含 tool）。

2. **投影没被实体化**：受管位置应始终是 symlink（有些工具会把它改写成实体文件）。

## 约定

- **回复语言：中文。** 代码、标识符、提交信息用英文；提交信息用 conventional
  commits。
- 改动前先读现有文件，不要凭猜测重写。
- 本仓库内容改动后，运行中的 agent 需 `/reload` 才生效。
- **不要假设工具存在**：先 `command -v` 探测，不要凭包管理器习惯猜。
- 代码风格跟随所在仓库的既有风格；改现状前先读相邻文件。
