## 改动后的硬验收

仓库内容改动后必须执行：

```bash
harness doctor
```

它必须同时验证：生成物无漂移、依赖声明与磁盘一致、无密钥、Pi/Codex 发现正常、adapter 契约未破坏、投影仍是指向仓库的 symlink、Profile 引用可解析。退出码就是结论。
