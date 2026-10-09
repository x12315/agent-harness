# 性能回归验收

完整 doctor 耗时是版本迭代的考察特征。发布或修改检查执行路径后，运行真实多轮测试并归档；测量器的较重隔离测试独立运行，不让日常 doctor 递归启动真实性能测量。

## 运行

```bash
harness benchmark --runs=3 --out=/tmp/harness-perf-v1
harness benchmark --runs=3 --out=/tmp/harness-perf-v2 \
  --baseline=/tmp/harness-perf-v1/report.json \
  --max-regression-percent=20 --max-median-ms=8000
node --test scripts/tests/doctor-benchmark.test.mjs
```

目录必须是两个仓之外的新目录，拒绝覆盖。20%/8000ms 是示例预算，须针对固定验收机器明确选择；没有隐含的机器相关 SLA。需要指定数据源时在命令上加 `--catalog=<path>`。

## 指标与采样

`doctor.wall-clock` 是新 Node 进程执行完整 `doctor --json` 的墙钟耗时，含 CLI 启动与全部 gate，不含环境采集、报告写盘或浏览器刷新。保存事务耗时是另一指标。

每种模式 3–30 次，默认 3 次；每轮交替谁先运行。全部重新检查，无通过缓存，没有专门预热，也不宣称机器冷启动。记录样本数、最小值、中位数、最大值；小样本不冒充 P95。应在机器空闲、相同安装与 Catalog 工作量下运行，出现退化先复测。

报告 `schemaVersion: 2` 包含匿名机器身份、OS/CPU/内存、Node/Pi/Codex/Profile runtime 版本、Catalog 工作量、Catalog 与 Engine 各自的 Git revision/dirty 状态、来源与源码 SHA-256、每次退出码、verifier 各项耗时/状态、模式统计及基线比较。独立样本日志权限 0600，凭据形状的输出行替换为脱敏标记，不复制认证。报告和日志不入库。

拆分前的 schemaVersion 1 只有单仓身份，不接受为新基线；保留旧证据，实测建立 v2 基线。历史参考：2026-10-09 单仓同机同覆盖各三轮，串行 16.364s → 并行 5.650s（约 -65%）；这不是跨机器门槛。

## 失败与可比性

- 同机/宿主版本、方案配置、Skills/词条数量、检查名及 skip 状态须匹配。两仓的源码/commit 可跨版本变化；环境或工作量/覆盖不同标为不可比并退出 1。
- 测量持有 Catalog 写锁，Web/TUI 暂不能保存；逐轮检查两仓源码。外部编辑、检查失败或超时停止测量，保留失败报告与日志，不把失败计入成功统计。
- `--max-regression-percent` 必须提供成功基线，限制并行中位数的增幅；`--max-median-ms` 限制并行中位数。超过预算退出 1，参数/运行错误退出 2。
- 没有预算时报告数据供审阅；新增检查或宿主升级需审阅后建新基线，不能通过删检查或改预算掩盖退化。

## 发布留档

保留报告、每次日志、两仓被测源码身份及功能验收证据。版本记录填写并行中位耗时、范围、基线变化、覆盖、skip 和不可比原因。VM 中的 stub runtime、测量器单测都不是安装态性能证据；无法在真实环境测量就明确写出缺口。
