import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AutoLockMinutes, EntryInput, EntryType, SessionResponse, VaultEntry, VaultResponse, VaultStatus } from '../shared/types';
import { api, ApiError } from './api';
import { EntryDetail, EntryEditor, ErrorMessage, Icon, RestoreDialog, StorageLocationDialog, typeNames } from './components';
import type { IconName } from './components';

type Category = 'all' | EntryType;
type EditorState = { entry?: VaultEntry; type: EntryType; revision: number; reloaded: boolean };
const sorted = (entries: VaultEntry[]) => [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name, 'zh-CN'));
const errorText = (error: unknown) => error instanceof Error ? error.message : '请求未完成，请重试。';

function Brand() {
  return <div className="brand"><span className="brand-mark"><Icon name="lock" size={23} /></span><div><strong>私密保管库<span className="brand-dot">.</span></strong><span className="brand-caption">LOCAL PASSWORD VAULT</span></div></div>;
}

function AuthForm({ exists, busy, onSubmit }: { exists: boolean; busy: boolean; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const submitted = password;
    setPassword('');
    setConfirmation('');
    setError('');
    if (!exists && submitted.length < 12) { setError('主密码至少需要 12 个字符，请重新输入。'); return; }
    if (!exists && submitted !== confirmation) { setError('两次输入的主密码不一致，请重新输入。'); return; }
    if (!exists && !accepted) { setError('请先确认已了解主密码无法找回。'); return; }
    onSubmit(submitted);
  };
  return <form onSubmit={submit} className="auth-form" autoComplete="off" aria-busy={busy}>
    <div className="form-field"><label htmlFor="master-password">{exists ? '主密码' : '设置主密码'}</label><div className="input-with-icon"><Icon name="lock" size={18} /><input id="master-password" type="password" autoComplete={exists ? 'off' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} placeholder={exists ? '输入主密码，打开你的保管库' : '至少 12 个字符，建议使用长口令'} minLength={exists ? undefined : 12} required disabled={busy} autoFocus /></div></div>
    {!exists && <><div className="form-field"><label htmlFor="master-confirm">确认主密码</label><input id="master-confirm" type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} placeholder="再次输入主密码" required minLength={12} disabled={busy} /></div><label className="checkbox-label"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} disabled={busy} /><span>我已牢记主密码，并了解<strong>忘记后无法找回</strong>，也无法解密备份。</span></label></>}
    {error && <ErrorMessage>{error}</ErrorMessage>}
    <button className="button primary auth-submit" type="submit" disabled={busy}>{busy ? '正在处理，请稍候…' : exists ? '解锁保管库' : '创建我的保管库'}{!busy && <Icon name="arrow" size={18} />}</button>
    <p className="auth-form-hint">{exists ? '刷新或关闭页面后，需要重新输入主密码。' : '密码只在本次会话中使用，不写入浏览器存储。'}</p>
  </form>;
}

export default function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [category, setCategory] = useState<Category>('all');
  const [view, setView] = useState<'vault' | 'settings'>('vault');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [lockPending, setLockPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [safetyPath, setSafetyPath] = useState('');
  const [settingChoice, setSettingChoice] = useState<AutoLockMinutes>(5);
  const [now, setNow] = useState(Date.now());
  const sessionRef = useRef<SessionResponse | null>(null);
  const epoch = useRef(0);
  const expiryVersion = useRef(0);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const migrationRef = useRef(false);
  const migrationVersion = useRef(0);
  const lastActivity = useRef(0);

  // Every logout and new session invalidates ALL earlier asynchronous work.
  const isCurrent = useCallback((version: number) => alive.current && version === epoch.current, []);
  const clearSensitive = useCallback((message: string) => {
    epoch.current += 1;
    expiryVersion.current += 1;
    sessionRef.current = null;
    busyRef.current = false;
    migrationRef.current = false;
    lastActivity.current = 0;
    setSession(null);
    setEditor(null);
    setRestoreOpen(false);
    setStorageOpen(false);
    setSearch('');
    setSelectedId(null);
    setMobileDetail(false);
    setCategory('all');
    setView('vault');
    setBusy(null);
    setAuthBusy(false);
    setLockPending(false);
    setStatusLoading(false);
    setError('');
    setConflict(false);
    setSafetyPath('');
    setNotice(message);
    setStatus(previous => previous ? { ...previous, unlocked: false, expiresAt: null, revision: null } : null);
    return epoch.current;
  }, []);
  const lock = useCallback((message = '密码库已锁定，输入主密码即可重新打开。', keepalive = false) => {
    const token = sessionRef.current?.token;
    const version = clearSensitive(token ? '本页敏感内容已清空，正在确认服务端锁定…' : message);
    if (!token) return;
    setLockPending(true);
    void api.lock(token, keepalive).then(() => {
      if (isCurrent(version)) { setLockPending(false); setNotice(message); }
    }).catch(cause => {
      if (!isCurrent(version)) return;
      setLockPending(false);
      setNotice(cause instanceof ApiError && cause.status === 401
        ? '本页内容已清空，原会话已失效。请重新解锁。'
        : '本页敏感内容已清空，但无法确认服务端锁定。请检查本地服务，连接恢复后重新解锁。');
    });
  }, [clearSensitive, isCurrent]);
  const isActive = useCallback((version: number) => {
    if (!isCurrent(version) || !sessionRef.current) return false;
    if (Date.now() >= sessionRef.current.expiresAt) {
      lock('因长时间未操作，密码库已自动锁定。未保存的草稿已丢弃。');
      return false;
    }
    return true;
  }, [isCurrent, lock]);
  const handleFailure = useCallback((cause: unknown, version: number) => {
    if (!isCurrent(version)) return true;
    if (cause instanceof ApiError && cause.status === 0) {
      if (sessionRef.current) lock('连接曾中断，本页内容已清空，服务端会话已锁定。请重新解锁。');
      else clearSensitive('连接失败，已清空本次输入与预览；无法确认服务端状态。请检查本地服务后重试。');
      return true;
    }
    if (cause instanceof ApiError && cause.status === 401 && sessionRef.current) {
      clearSensitive('会话已失效，本页敏感内容已清空。请重新解锁。');
      return true;
    }
    return false;
  }, [clearSensitive, isCurrent, lock]);
  const applyVault = useCallback((result: VaultResponse) => {
    const current = sessionRef.current;
    if (!current || result.vault.revision < current.vault.revision) return;
    expiryVersion.current += 1;
    const next = { ...current, ...result };
    sessionRef.current = next;
    setSession(next);
    setNow(Date.now());
    setStatus(previous => previous ? { ...previous, unlocked: true, expiresAt: result.expiresAt, revision: result.vault.revision, autoLockMinutes: result.vault.settings.autoLockMinutes } : previous);
  }, []);
  const installSession = useCallback((result: SessionResponse, version: number) => {
    if (!isCurrent(version)) { void api.lock(result.token).catch(() => undefined); return; }
    if (result.expiresAt <= Date.now()) {
      void api.lock(result.token).catch(() => undefined);
      clearSensitive('会话在响应到达前已过期，请重新解锁。');
      return;
    }
    epoch.current += 1;
    expiryVersion.current += 1;
    sessionRef.current = result;
    lastActivity.current = Date.now();
    busyRef.current = false;
    setSession(result);
    setStatus(previous => ({ exists: true, storagePath: previous?.storagePath ?? '', unlocked: true, autoLockMinutes: result.vault.settings.autoLockMinutes, expiresAt: result.expiresAt, revision: result.vault.revision }));
    setEditor(null);
    setRestoreOpen(false);
    setStorageOpen(false);
    setAuthBusy(false);
    setBusy(null);
    setLockPending(false);
    setSearch('');
    setCategory('all');
    setView('vault');
    setSelectedId(sorted(result.vault.entries)[0]?.id ?? null);
    setMobileDetail(false);
    setError('');
    setConflict(false);
    setNotice(result.safetyBackupPath ? '备份已恢复，当前库已替换。原密码库的安全副本已保存。' : '保管库已打开。你的秘密，只留在本次会话。');
    setSafetyPath(result.safetyBackupPath ?? '');
    setSettingChoice(result.vault.settings.autoLockMinutes);
    setNow(Date.now());
  }, [clearSensitive, isCurrent]);

  useEffect(() => {
    alive.current = true;
    const pagehide = () => lock('离开页面后会话已锁定，请重新解锁。', true);
    window.addEventListener('pagehide', pagehide);
    return () => {
      alive.current = false;
      epoch.current += 1;
      window.removeEventListener('pagehide', pagehide);
    };
  }, [lock]);

  useEffect(() => {
    let disposed = false;
    const version = epoch.current;
    setStatusLoading(true);
    void api.status().then(result => {
      if (!disposed && isCurrent(version)) { setStatus(result); setError(''); }
    }).catch(cause => {
      if (!disposed && isCurrent(version)) setError(errorText(cause));
    }).finally(() => {
      if (!disposed && isCurrent(version)) setStatusLoading(false);
    });
    return () => { disposed = true; };
  }, [isCurrent, statusAttempt]);

  const token = session?.token;
  useEffect(() => {
    if (!token) return;
    const version = epoch.current;
    let checking = false;
    let renewing = false;
    const updateExpiry = (expiresAt: number, expiryAtStart: number) => {
      if (!isActive(version) || expiryVersion.current !== expiryAtStart) return;
      const current = sessionRef.current;
      if (!current) return;
      if (expiresAt <= Date.now()) { lock('密码库会话已到期，请重新解锁。'); return; }
      expiryVersion.current += 1;
      const next = { ...current, expiresAt };
      sessionRef.current = next;
      setSession(next);
      setNow(Date.now());
    };
    const check = async () => {
      if (checking || migrationRef.current || !isActive(version)) return;
      checking = true;
      const expiryAtStart = expiryVersion.current;
      const migrationAtStart = migrationVersion.current;
      try {
        const result = await api.status(token);
        if (migrationRef.current || migrationVersion.current !== migrationAtStart || !isActive(version)) return;
        if (!result.unlocked) {
          clearSensitive('会话已到期或已在另一页面重新解锁，本页敏感内容已清空。');
          return;
        }
        setStatus(result);
        if (result.expiresAt !== null) updateExpiry(result.expiresAt, expiryAtStart);
      } catch (cause) {
        if (!migrationRef.current && migrationVersion.current === migrationAtStart && isCurrent(version) && !handleFailure(cause, version)) lock('无法核验会话状态，已锁定密码库。请稍后重新解锁。');
      } finally { checking = false; }
    };
    const activity = (event: Event) => {
      if (!event.isTrusted || migrationRef.current || !isActive(version) || renewing || Date.now() - lastActivity.current < 10_000) return;
      lastActivity.current = Date.now();
      renewing = true;
      const expiryAtStart = expiryVersion.current;
      const migrationAtStart = migrationVersion.current;
      void api.activity(token).then(result => {
        if (!migrationRef.current && migrationVersion.current === migrationAtStart) updateExpiry(result.expiresAt, expiryAtStart);
      }).catch(cause => {
        if (!migrationRef.current && migrationVersion.current === migrationAtStart && isCurrent(version) && !handleFailure(cause, version)) lock('无法续期会话，密码库已锁定。请重新解锁。');
      }).finally(() => { renewing = false; });
    };
    const tick = () => { if (isActive(version)) setNow(Date.now()); };
    const visible = () => { if (document.visibilityState === 'visible') { tick(); void check(); } };
    const countdown = window.setInterval(tick, 500);
    const polling = window.setInterval(() => void check(), 3000);
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    events.forEach(event => window.addEventListener(event, activity, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', visible);
    void check();
    return () => {
      window.clearInterval(countdown);
      window.clearInterval(polling);
      events.forEach(event => window.removeEventListener(event, activity, true));
      document.removeEventListener('visibilitychange', visible);
    };
  }, [token, clearSensitive, handleFailure, isActive, isCurrent, lock]);

  const authenticate = async (password: string) => {
    if (busyRef.current || lockPending || !status) return;
    const version = epoch.current;
    busyRef.current = true;
    setAuthBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await (status.exists ? api.unlock(password) : api.create(password));
      installSession(result, version);
    } catch (cause) {
      if (isCurrent(version)) {
        setError(errorText(cause));
        if (cause instanceof ApiError && cause.status === 409) setStatusAttempt(previous => previous + 1);
      }
    } finally {
      if (isCurrent(version)) { busyRef.current = false; setAuthBusy(false); }
    }
  };
  const runMutation = async (label: string, work: (current: SessionResponse) => Promise<VaultResponse>, done?: (result: VaultResponse) => void) => {
    const version = epoch.current;
    if (busyRef.current || !isActive(version) || !sessionRef.current) return;
    const current = sessionRef.current;
    busyRef.current = true;
    setBusy(label);
    setError('');
    setConflict(false);
    try {
      const result = await work(current);
      if (!isActive(version)) return;
      if (result.expiresAt <= Date.now()) { lock('会话响应已过期，密码库已锁定。请重新解锁。'); return; }
      applyVault(result);
      done?.(result);
    } catch (cause) {
      if (isActive(version) && !handleFailure(cause, version)) {
        setError(errorText(cause));
        setConflict(cause instanceof ApiError && cause.code === 'REVISION_CONFLICT');
      }
    } finally {
      if (isCurrent(version)) { busyRef.current = false; setBusy(null); }
    }
  };
  const reload = () => void runMutation('正在重新载入…', current => api.vault(current.token), result => {
    setEditor(previous => previous ? { ...previous, revision: result.vault.revision, reloaded: true } : null);
    if (!result.vault.entries.some(entry => entry.id === selectedId)) { setSelectedId(sorted(result.vault.entries)[0]?.id ?? null); setMobileDetail(false); }
    setNotice('已重新载入最新版本。未保存的编辑仍保留，请核对后再提交。');
  });
  const saveEntry = (input: EntryInput) => {
    if (!editor) return;
    const originalIds = new Set(sessionRef.current?.vault.entries.map(entry => entry.id));
    void runMutation('正在保存条目…', current => api.save(current.token, input, editor.revision, editor.entry?.id), result => {
      const saved = editor.entry?.id ?? result.vault.entries.find(entry => !originalIds.has(entry.id))?.id;
      setSelectedId(saved ?? null);
      setEditor(null);
      setCategory('all');
      setSearch('');
      setMobileDetail(true);
      setNotice('条目已保存。');
    });
  };
  const removeEntry = (entry: VaultEntry) => {
    if (!window.confirm(`确定删除「${entry.name}」？此操作不可撤销。`)) return;
    void runMutation('正在删除条目…', current => api.remove(current.token, entry.id, current.vault.revision), result => {
      setSelectedId(sorted(result.vault.entries)[0]?.id ?? null);
      setMobileDetail(false);
      setNotice('条目已删除。');
    });
  };
  const exportBackup = async () => {
    const version = epoch.current;
    if (busyRef.current || !isActive(version) || !sessionRef.current) return;
    const current = sessionRef.current;
    busyRef.current = true;
    setBusy('正在导出备份…');
    setError('');
    try {
      const blob = await api.backup(current.token);
      if (!isActive(version)) return;
      const url = URL.createObjectURL(blob);
      try {
        const date = new Date();
        const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const link = document.createElement('a');
        link.href = url;
        link.download = `local-password-vault-${stamp}.pvlt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setNotice('已发起加密备份下载，请检查浏览器下载记录并妥善保管备份。');
      } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (cause) {
      if (isActive(version) && !handleFailure(cause, version)) setError(errorText(cause));
    } finally {
      if (isCurrent(version)) { busyRef.current = false; setBusy(null); }
    }
  };
  const changeStorageLocation = async (directory: string) => {
    const version = epoch.current;
    if (busyRef.current || !isActive(version) || !sessionRef.current || !status?.storagePath) return;
    const current = sessionRef.current;
    const storagePath = status.storagePath;
    const targetPath = `${directory.replace(/[\\/]+$/, '')}${directory.includes('\\') ? '\\' : '/'}vault.pvlt`;
    if (!window.confirm(`确认迁移密码库？\n\n当前文件：${storagePath}\n新文件：${targetPath}\n\n保留原密码库作为历史副本，不再同步；旧备份不搬迁。不会覆盖已有目标文件。完成后所有会话将锁定，后续只使用新位置。`)) return;
    if (busyRef.current || !isActive(version)) return;
    busyRef.current = true;
    migrationRef.current = true;
    // Also discard status/activity requests that began before this migration.
    migrationVersion.current += 1;
    setBusy('正在迁移密码库…');
    setError('');
    setNotice('');
    setConflict(false);
    try {
      const result = await api.storageLocation(current.token, directory, storagePath, current.vault.revision);
      if (!isActive(version)) {
        if (alive.current && !sessionRef.current) setStatusAttempt(previous => previous + 1);
        return;
      }
      clearSensitive(`迁移完成，会话已锁定。旧文件保留于：${result.previousStoragePath}（历史副本，不再同步）。旧备份仍在原目录。`);
      setStatus(result.status);
    } catch (cause) {
      if (!isActive(version)) return;
      if (handleFailure(cause, version)) {
        if (cause instanceof ApiError && cause.status === 0) setError('迁移结果尚未确认，请重新检查本地服务，核对文件位置后再解锁。');
        else setStatusAttempt(previous => previous + 1);
        return;
      }
      setError(errorText(cause));
    } finally {
      if (isCurrent(version)) { busyRef.current = false; migrationRef.current = false; setBusy(null); }
    }
  };
  const openEditor = (entry?: VaultEntry) => {
    if (busyRef.current) return;
    setError('');
    setConflict(false);
    setEditor({ entry, type: entry?.type ?? (category === 'all' ? 'account' : category), revision: sessionRef.current?.vault.revision ?? 0, reloaded: false });
  };
  const chooseCategory = (next: Category) => { setCategory(next); setView('vault'); setMobileDetail(false); };
  const backToList = () => {
    const version = epoch.current;
    setMobileDetail(false);
    window.requestAnimationFrame(() => {
      if (isCurrent(version)) document.querySelector<HTMLButtonElement>('.entry-row.selected')?.focus();
    });
  };
  const seconds = session ? Math.max(0, Math.ceil((session.expiresAt - now) / 1000)) : 0;
  const remaining = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const entries = session?.vault.entries ?? [];
  const query = search.trim().toLocaleLowerCase();
  const filtered = sorted(entries.filter(entry => (category === 'all' || entry.type === category) && (!query || [entry.name, entry.username, entry.address].some(value => value.toLocaleLowerCase().includes(query)))));
  const selected = filtered.find(entry => entry.id === selectedId) ?? (!mobileDetail ? filtered[0] : undefined);
  const currentEpoch = epoch.current;
  const remoteChanged = session && status?.revision !== null && status?.revision !== undefined && status.revision > session.vault.revision;
  const navigation: { key: Category; label: string; icon: IconName }[] = [{ key: 'all', label: '全部条目', icon: 'grid' }, { key: 'account', label: typeNames.account, icon: 'account' }, { key: 'server', label: typeNames.server, icon: 'server' }, { key: 'api', label: typeNames.api, icon: 'api' }];

  return <>
    {!session ? <div className="auth-page">
      <header className="auth-header"><Brand /><span className="local-badge"><span />只在本机，安心保管</span></header>
      <main className="auth-main">
        <section className="auth-intro"><p className="eyebrow"><span className="short-line" /> A QUIET PLACE FOR YOUR SECRETS</p><h1>重要的密码，<br />有自己的<span>位置。</span></h1><p className="intro-description">从日常账号到服务器凭据，<br />把数字生活的钥匙，收在一个安心的地方。</p>
          <div className="vault-illustration" aria-hidden="true"><div className="illustration-ring ring-one" /><div className="illustration-ring ring-two" /><div className="illustration-dot dot-one" /><div className="illustration-dot dot-two" /><div className="vault-tile tile-back" /><div className="vault-tile tile-front"><Icon name="shield" size={64} /><span>PRIVATE BY DESIGN</span></div><span className="illustration-caption"><span />本地保存 · 加密备份 · 自动锁定</span></div>
          <div className="intro-facts"><span><Icon name="shield" size={17} />无云端账户</span><span><Icon name="lock" size={17} />主密码保护</span><span><Icon name="file" size={17} />本地文件存储</span></div>
        </section>
        <section className="auth-card" aria-labelledby="auth-title"><div className="auth-card-heading"><span className="round-icon"><Icon name="lock" size={25} /></span><p className="eyebrow">{status?.exists ? 'WELCOME BACK' : 'YOUR PRIVATE SPACE'}</p><h2 id="auth-title">{statusLoading && !status ? '连接本地保管库' : status?.exists ? '欢迎回来' : status ? '从一把主钥匙开始' : '暂时无法连接'}</h2><p>{status?.exists ? '解锁之前，所有条目都保持私密。' : '创建专属于你的本地密码库。'}</p></div>
          {notice && <div className="message subtle" role="status"><Icon name="info" /><span>{notice}</span></div>}
          {error && <ErrorMessage>{error}</ErrorMessage>}
          {statusLoading ? <p className="loading-state" role="status">正在读取本地密码库状态…</p> : status ? <AuthForm key={`${status.exists}-${currentEpoch}`} exists={status.exists} busy={authBusy || lockPending || restoreOpen} onSubmit={password => void authenticate(password)} /> : null}
          {!statusLoading && (!status || error) && <button className="button secondary full-width" onClick={() => setStatusAttempt(previous => previous + 1)} disabled={authBusy || lockPending}>重新检查本地服务</button>}
          <div className="auth-divider"><span />或从已有备份开始<span /></div><button className="button restore-entry" onClick={() => setRestoreOpen(true)} disabled={authBusy || lockPending || statusLoading}><Icon name="upload" size={17} />从加密备份恢复<Icon name="chevron" size={14} /></button>
          {status && <div className="storage-location"><Icon name="file" size={16} /><div><span>密码库文件位置</span><code>{status.storagePath || '正在获取文件位置'}</code></div></div>}
        </section>
      </main><footer className="auth-footer"><span>少一分记忆负担，多一分安心。</span><span>LOCAL FIRST · ALWAYS PRIVATE</span></footer>
    </div> : <div className="app-shell">
      <header className="app-header"><Brand /><div className="global-search"><Icon name="search" size={19} /><label className="sr-only" htmlFor="vault-search">搜索名称、用户名或地址</label><input id="vault-search" value={search} onChange={event => { setSearch(event.target.value); setView('vault'); setMobileDetail(false); }} placeholder="搜索名称、用户名或地址…" autoComplete="off" spellCheck={false} />{search ? <button className="icon-button" aria-label="清空搜索" onClick={() => { setSearch(''); document.getElementById('vault-search')?.focus(); }}><Icon name="close" size={16} /></button> : <span className="search-key"><Icon name="search" size={12} /></span>}</div><div className="header-actions"><button className="button primary" onClick={() => openEditor()} disabled={!!busy}><Icon name="plus" size={18} /><span>新增条目</span></button><button className="button secondary lock-button" onClick={() => lock()}><Icon name="lock" size={17} /><span>锁定</span></button></div></header>
      <div className="workspace">
        <aside className="sidebar"><div className="sidebar-top"><p className="eyebrow">我的保管库</p><nav aria-label="条目分类">{navigation.map(item => <button key={item.key} className={`nav-item${view === 'vault' && category === item.key ? ' active' : ''}`} aria-current={view === 'vault' && category === item.key ? 'page' : undefined} onClick={() => chooseCategory(item.key)}><Icon name={item.icon} size={19} /><span>{item.label}</span><span className="nav-count">{item.key === 'all' ? entries.length : entries.filter(entry => entry.type === item.key).length}</span></button>)}</nav><div className="nav-divider" /><button className={`nav-item${view === 'settings' ? ' active' : ''}`} onClick={() => { setView('settings'); setMobileDetail(false); }} aria-current={view === 'settings' ? 'page' : undefined}><Icon name="settings" size={19} /><span>设置与备份</span></button></div>
          <div className="sidebar-bottom"><div className="privacy-card"><Icon name="shield" size={22} /><strong>秘密不必远行</strong><p>凭据保存在本机文件中。<br />记得定期导出加密备份。</p><button onClick={() => { setView('settings'); setMobileDetail(false); }}>管理我的备份<Icon name="arrow" size={14} /></button></div><div className={`session-indicator${seconds <= 30 ? ' expiring' : ''}`}><span className="status-dot" /><span>本地会话已解锁</span><span className="countdown" title="距离自动锁定">{remaining}</span></div><p className="sidebar-footnote">{session.vault.settings.autoLockMinutes} 分钟无操作后自动锁定</p></div>
        </aside>
        <main className={`main-workspace${view === 'settings' ? ' settings-view' : ''}${mobileDetail && selected ? ' showing-detail' : ''}`}>
          <div className="workspace-messages">
            {seconds <= 30 && <div className="message warning" role="alert"><Icon name="clock" /><span>{migrationRef.current ? '迁移期间暂停续期，仍会自动锁定。' : '即将自动锁定，未保存的草稿会丢失。请继续操作以续期。'}</span><strong>{remaining}</strong></div>}
            {error && !editor && !storageOpen && <ErrorMessage>{error}</ErrorMessage>}
            {conflict && !editor && <div className="message warning"><span>库版本已变化，本次操作没有覆盖其他修改。</span><button onClick={reload} disabled={!!busy}>重新载入</button></div>}
            {remoteChanged && !conflict && <div className="message subtle"><span>检测到密码库的新版本，请重新载入后再编辑。</span><button onClick={reload} disabled={!!busy}>重新载入</button></div>}
            {notice && <div className="notice-bar" role="status"><Icon name="check" size={16} /><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="关闭提示"><Icon name="close" size={14} /></button></div>}
            {safetyPath && <div className="message subtle safety-path"><Icon name="file" /><span>恢复前安全副本：<code>{safetyPath}</code></span></div>}
            {busy && <div className="operation-status" role="status">{busy}</div>}
          </div>
          {view === 'vault' ? <div className="vault-columns"><section className="entry-list" aria-labelledby="list-title"><header className="list-header"><div><p className="eyebrow">YOUR COLLECTION</p><h1 id="list-title">{search ? '搜索结果' : category === 'all' ? '全部条目' : typeNames[category]}<span>{filtered.length}</span></h1></div><p><Icon name="clock" size={13} />最近修改排序</p></header>
            {filtered.length ? <ul className="entries">{filtered.map(entry => <li key={entry.id}><button className={`entry-row${selected?.id === entry.id ? ' selected' : ''}`} onClick={() => { setSelectedId(entry.id); setMobileDetail(true); }} aria-pressed={selected?.id === entry.id}><span className={`entry-emblem ${entry.type}`}><Icon name={entry.type} size={22} /></span><span className="entry-row-text"><strong>{entry.name}</strong><span>{entry.username || entry.address || typeNames[entry.type]}</span></span><span className="entry-row-end"><time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</time><Icon name="chevron" size={14} /></span></button></li>)}</ul> : <div className="empty-state"><span className="round-icon"><Icon name={search ? 'search' : 'plus'} size={28} /></span><h2>{search ? '没有找到相关条目' : entries.length ? '这个分类还很安静' : '从第一条密码开始'}</h2><p>{search ? '试试名称、用户名或地址。搜索不会读取密码和备注。' : '把重要凭据收进来，下一次需要时，就在这里。'}</p>{search ? <button className="button secondary" onClick={() => setSearch('')}>清空搜索</button> : <button className="button primary" onClick={() => openEditor()} disabled={!!busy}><Icon name="plus" size={17} />添加条目</button>}</div>}
            <footer className="list-footer"><Icon name="lock" size={13} />仅在解锁的会话中显示</footer>
          </section><section className="detail-pane" aria-label="条目详情">{selected ? <EntryDetail key={`${selected.id}-${selected.updatedAt}`} entry={selected} busy={!!busy} onEdit={() => openEditor(selected)} onDelete={() => removeEntry(selected)} onBack={backToList} focusOnOpen={mobileDetail} /> : <div className="detail-placeholder"><div className="placeholder-art"><Icon name="shield" size={48} /></div><p className="eyebrow">A LITTLE MORE PEACE OF MIND</p><h2>每一个秘密，都值得被保管</h2><p>从左侧选择一条记录，查看你的凭据。<br />没有条目时，可以先添加一个。</p><span><Icon name="lock" size={14} />本地保存，默认隐藏秘密</span></div>}</section></div> : <section className="settings-content" aria-labelledby="settings-title"><p className="eyebrow">MAKE YOURSELF AT HOME</p><h1 id="settings-title">设置与备份</h1><p className="section-description">按你的节奏保护凭据，为重要内容留一份备份。</p>
            <section className="settings-card"><div className="settings-card-title"><span className="round-icon small-round"><Icon name="clock" /></span><div><h2>自动锁定</h2><p>没有实际操作时，自动清空敏感视图并锁定会话。</p></div></div><form onSubmit={event => { event.preventDefault(); void runMutation('正在保存设置…', current => api.settings(current.token, settingChoice, current.vault.revision), () => setNotice('自动锁定设置已保存。')); }}><label htmlFor="auto-lock">无操作等待时间</label><div className="settings-controls"><select id="auto-lock" value={settingChoice} onChange={event => setSettingChoice(Number(event.target.value) as AutoLockMinutes)} disabled={!!busy}><option value={1}>1 分钟</option><option value={5}>5 分钟（推荐）</option><option value={15}>15 分钟</option></select><button type="submit" className="button primary" disabled={!!busy || conflict || settingChoice === session.vault.settings.autoLockMinutes}>保存设置</button></div></form><p className="field-hint">锁定会丢弃未保存的草稿；刷新页面也需要重新解锁。</p></section>
            <section className="settings-card"><div className="settings-card-title"><span className="round-icon small-round"><Icon name="file" /></span><div><h2>密码库文件</h2><p>文件由本地服务管理，界面不会自动打开路径或地址。</p></div></div><p className="storage-path-label">当前存储位置</p><code className="path-block">{status?.storagePath || '正在获取文件位置…'}</code><button className="button secondary storage-change-button" onClick={() => { if (busyRef.current || !isActive(epoch.current)) return; setError(''); setConflict(false); setStorageOpen(true); }} disabled={!!busy || !status?.storagePath}><Icon name="edit" size={17} />修改存储位置</button></section>
            <section className="settings-card"><div className="settings-card-title"><span className="round-icon small-round"><Icon name="shield" /></span><div><h2>备份与恢复</h2><p>备份是加密文件，恢复时仍需备份的主密码。</p></div></div><div className="backup-action"><div><h3>导出加密备份</h3><p>建议定期备份，并将备份保存在安全的位置。</p></div><button className="button secondary" onClick={() => void exportBackup()} disabled={!!busy}><Icon name="download" size={17} />导出备份</button></div><div className="backup-action"><div><h3>从备份恢复</h3><p>整库替换，不会合并。覆盖前会创建当前库的安全副本。</p></div><button className="button secondary" onClick={() => setRestoreOpen(true)} disabled={!!busy}><Icon name="upload" size={17} />恢复备份</button></div></section>
            <p className="settings-disclaimer"><Icon name="info" size={17} />请牢记主密码。忘记主密码后，无法找回密码库或解密备份。</p>
          </section>}
        </main>
      </div><footer className="app-footer"><span><Icon name="shield" size={13} />本地优先，隐私为本</span><span>未保存的草稿会在锁定时丢弃</span></footer>
    </div>}
    {editor && session && <EntryEditor entry={editor.entry} initialType={editor.type} busy={!!busy} error={error} conflict={conflict} reloaded={editor.reloaded} onClose={() => { setEditor(null); setError(''); setConflict(false); }} onSave={saveEntry} onReload={reload} onLock={() => lock()} lockSeconds={seconds} />}
    {storageOpen && session && <StorageLocationDialog storagePath={status?.storagePath ?? ''} busy={!!busy} error={error} onClose={() => { if (!busyRef.current) { setStorageOpen(false); setError(''); } }} onSubmit={directory => void changeStorageLocation(directory)} onLock={() => lock()} lockSeconds={seconds} />}
    {restoreOpen && <RestoreDialog token={session?.token} hasVault={status?.exists ?? false} onClose={() => setRestoreOpen(false)} onSuccess={result => installSession(result, currentEpoch)} onFailure={cause => handleFailure(cause, currentEpoch)} onLock={session ? () => lock() : undefined} lockSeconds={session ? seconds : undefined} />}
  </>;
}
