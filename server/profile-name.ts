import { VaultError } from './errors.js';
import { windowsSegmentProblem } from './storage-location.js';

export const MAX_PROFILES = 16;

// Profile names double as directory names, so they must survive every host OS this vault may move to.
export function profileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new VaultError(400, 'INVALID_PROFILE_NAME', '请填写身份档名称。');
  const name = raw.trim();
  if (!name) throw new VaultError(400, 'INVALID_PROFILE_NAME', '身份档名称不能为空。');
  if ([...name].length > 32) throw new VaultError(400, 'INVALID_PROFILE_NAME', '身份档名称不能超过 32 个字符。');
  if (/[\x00-\x1f\x7f]/.test(name) || /[<>:"|?*\\/]/.test(name) || name.includes('..') || name === '.') {
    throw new VaultError(400, 'INVALID_PROFILE_NAME', '身份档名称不能包含路径分隔符、控制字符或 .. 。');
  }
  const problem = windowsSegmentProblem(name);
  if (problem) throw new VaultError(400, 'INVALID_PROFILE_NAME', `身份档${problem}`);
  return name.normalize('NFC');
}

export function profileNameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}
