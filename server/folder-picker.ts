import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { VaultError } from './errors.js';

export type FolderPicker = (initialDirectory: string, signal: AbortSignal) => Promise<string | null>;

const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$owner = New-Object System.Windows.Forms.Form
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
  $owner.Text = 'Password Vault - Choose Folder'
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Opacity = 0
  $owner.StartPosition = 'CenterScreen'
  $dialog.Description = '选择密码库的存储文件夹'
  $dialog.ShowNewFolderButton = $true
  $dialog.SelectedPath = $env:VAULT_PICKER_INITIAL_DIRECTORY
  $owner.Show()
  $owner.Activate()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write((ConvertTo-Json -Compress -InputObject @{ directory = $dialog.SelectedPath }))
  } else {
    [Console]::Write('{"directory":null}')
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}
`;

export const pickFolder: FolderPicker = (initialDirectory, signal) => {
  if (process.platform !== 'win32') {
    return Promise.reject(new VaultError(501, 'PICKER_UNSUPPORTED', '原生文件夹选择目前仅支持 Windows。'));
  }
  if (signal.aborted) return Promise.reject(new VaultError(409, 'PICKER_CANCELLED', '文件夹选择已取消。'));
  return new Promise((resolve, reject) => {
    execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, VAULT_PICKER_INITIAL_DIRECTORY: initialDirectory },
        signal,
        timeout: 120000,
        maxBuffer: 64 * 1024,
      }, (error, stdout) => {
        if (error) {
          reject(new VaultError(signal.aborted ? 409 : 503, signal.aborted ? 'PICKER_CANCELLED' : 'PICKER_FAILED',
            signal.aborted ? '文件夹选择已取消。' : '无法完成文件夹选择，可能已超时或系统窗口无法打开，请重试。'));
          return;
        }
        try {
          const result: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
          if (typeof result !== 'object' || result === null || !('directory' in result)
            || (result.directory !== null && typeof result.directory !== 'string')) throw new Error('Invalid picker result');
          resolve(result.directory);
        } catch {
          reject(new VaultError(503, 'PICKER_FAILED', '未能读取所选文件夹，请重新选择。'));
        }
      });
  });
};
