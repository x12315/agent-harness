## 仓库硬规则

1. 投影只能指向本仓库，禁止链到上游安装目录；上游升级不能静默替换我们的内容。
2. `skills/` 默认整体忽略，只逐条白名单放行自有 skill；新增自有 skill 必须同步添加 `!/skills/<name>/`。
3. `SKILL.md` 只使用规范顶层字段：`name`、`description`、`license`、`compatibility`、`metadata`、`allowed-tools`；厂商字段进入 `metadata:`。
4. skill 的 `name` 必须与目录同名；`description` 必须同时写清“做什么”和“何时触发”。
5. 不在生成文件中修补问题；修改其来源后重新 compose。
6. Profile 推荐的模型/provider/thinking 属于工程声明；用户临时选择、普通 harness 默认值、主题和 UI 状态仍属本机个性化。命令行或会话显式选择优先于 Profile 推荐值。
