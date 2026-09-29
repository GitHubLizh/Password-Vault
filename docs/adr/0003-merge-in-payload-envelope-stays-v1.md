# 冲突合流靠加密载荷内字段实现，信封继续 version 1

状态：2026-09-30 起移出本项目（见 ADR 0006）。其中"信封保持 version 1"这一半仍约束本仓库——`vault.pvlt` 格式不变。

多设备并发写入要求条目级合流（见 CONTEXT.md「条目级合流」），这需要条目稳定 ID 与修改时间戳。曾考虑把这些字段升为信封顶层认证字段（bump 到 version 2），但 ADR 0001 的约束仍然成立：`parseEnvelope` 白名单顶层字段且 salt 绑入 AAD，真迁移会波及所有既有 `vault.pvlt` 与用户手中等旧备份。我们决定：ID 与时间戳放进加密明文载荷内部，基准版本用密文哈希 + WebDAV ETag 在信封之外表达，信封保持 version 1。

## 后果

- 合流所需字段已在载荷中存在：`VaultEntry` 带 `id/createdAt/updatedAt`，`VaultSnapshot` 带 `revision`（`shared/types.ts`），载荷 schema 无需迁移。
- 真正缺的是**解锁基线**：当前 `session.vault` 随每次保存原地更新，合流需要额外保留解锁时刻的解密快照作三方对比的 base。
- 基准版本用密文 sha256（沿用 `vault.ts` 的 `fingerprint`）+ WebDAV ETag 表达，不存进信封。
- ADR 0001 的守卫原样保留，不放宽 `parseEnvelope`。
