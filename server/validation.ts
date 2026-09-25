import type { AutoLockMinutes, EntryInput, VaultEntry, VaultSnapshot } from '../shared/types.js';
import { VaultError } from './errors.js';

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VaultError(400, 'INVALID_INPUT', '数据格式不正确。');
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new VaultError(400, 'INVALID_INPUT', `${label}长度应为 ${min}–${max} 个字符。`);
  }
  return value;
}

export function password(value: unknown, creating = false): string {
  return text(value, '主密码', 1024, creating ? 12 : 1);
}

export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new VaultError(400, 'INVALID_INPUT', '数据版本不正确，请重新载入。');
  }
  return value as number;
}

export function autoLockMinutes(value: unknown): AutoLockMinutes {
  if (value !== 1 && value !== 5 && value !== 15) {
    throw new VaultError(400, 'INVALID_INPUT', '自动锁定时间只能是 1、5 或 15 分钟。');
  }
  return value;
}

export function entryInput(value: unknown): EntryInput {
  const input = record(value);
  if (input.type !== 'account' && input.type !== 'server' && input.type !== 'api') {
    throw new VaultError(400, 'INVALID_INPUT', '请选择有效的凭据类型。');
  }
  const entry: EntryInput = {
    type: input.type,
    name: text(input.name, '名称', 120, 1).trim(),
    username: text(input.username, '用户名/标识', 512),
    address: text(input.address, '地址', 2048),
    port: text(input.port, '端口', 5),
    password: text(input.password, '密码', 16384),
    apiKey: text(input.apiKey, 'API Key/Token', 16384),
    secret: text(input.secret, 'Secret', 16384),
    notes: text(input.notes, '备注', 10000),
  };
  if (!entry.name) throw new VaultError(400, 'INVALID_INPUT', '请填写名称。');
  if (entry.type === 'api') {
    entry.password = '';
    entry.port = '';
    if (!entry.apiKey && !entry.secret) {
      throw new VaultError(400, 'INVALID_INPUT', 'API 凭据至少需要 API Key/Token 或 Secret。');
    }
  } else {
    entry.apiKey = '';
    entry.secret = '';
    if (!entry.username && !entry.password) {
      throw new VaultError(400, 'INVALID_INPUT', '至少需要填写用户名或密码。');
    }
    if (entry.type === 'account') entry.port = '';
  }
  if (entry.port && (!/^\d{1,5}$/.test(entry.port) || Number(entry.port) < 1 || Number(entry.port) > 65535)) {
    throw new VaultError(400, 'INVALID_INPUT', '端口应为 1–65535 的整数，或留空。');
  }
  return entry;
}

export function snapshot(value: unknown): VaultSnapshot {
  const data = record(value);
  if (!Array.isArray(data.entries) || data.entries.length > 10000) {
    throw new VaultError(400, 'INVALID_INPUT', '密码库条目格式不正确或数量超出限制。');
  }
  const ids = new Set<string>();
  const entries: VaultEntry[] = data.entries.map((raw: unknown) => {
    const item = record(raw);
    const id = text(item.id, '条目编号', 36, 36);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) || ids.has(id)) {
      throw new VaultError(400, 'INVALID_INPUT', '密码库条目编号不正确或重复。');
    }
    ids.add(id);
    const createdAt = text(item.createdAt, '创建时间', 32, 1);
    const updatedAt = text(item.updatedAt, '修改时间', 32, 1);
    if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) {
      throw new VaultError(400, 'INVALID_INPUT', '密码库时间格式不正确。');
    }
    return { ...entryInput(item), id, createdAt, updatedAt };
  });
  return {
    entries,
    settings: { autoLockMinutes: autoLockMinutes(record(data.settings).autoLockMinutes) },
    revision: revision(data.revision),
  };
}
