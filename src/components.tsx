import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { EntryInput, EntryType, RestorePreview, SessionResponse, VaultEntry } from '../shared/types';
import { api } from './api';

const iconPaths = {
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M6 10h12a1 1 0 0 1 1 1v9H5v-9a1 1 0 0 1 1-1ZM12 14v3',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3ZM8.5 12l2.5 2.5 4.5-5',
  grid: 'M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h6v6h-6Z',
  account: 'M3 5h18v14H3ZM3 9h18M7 7h.01M10 7h.01M7 13h5M7 16h9',
  server: 'M4 3h16v7H4ZM4 14h16v7H4ZM7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5',
  api: 'm8 6-6 6 6 6M16 6l6 6-6 6M14 4l-4 16',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3ZM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  back: 'M19 12H5m5-5-5 5 5 5',
  chevron: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12M18 6 6 18',
  copy: 'M9 8h11v13H9ZM15 8V3H4v13h5',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  hidden: 'm3 3 18 18M9 5.5A12 12 0 0 1 12 5c6.5 0 10 7 10 7a20 20 0 0 1-3 4M6 6.5A22 22 0 0 0 2 12s3.5 7 10 7c1.7 0 3.3-.5 4.5-1.2M10 10a3 3 0 0 0 4 4',
  edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14l-1 7M13 21h8',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 6v6l4 2',
  check: 'm5 12 4 4L19 6',
  file: 'M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 13h8M8 17h6',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20ZM12 11v6M12 7h.01',
} as const;
export type IconName = keyof typeof iconPaths;
export const typeNames: Record<EntryType, string> = { account: '网站与应用', server: '服务器', api: 'API 凭据' };

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

export function Modal({ title, eyebrow, children, onClose, entryForm = false, closeDisabled = false, onLock, lockSeconds }: {
  title: string; eyebrow: string; children: ReactNode; onClose: () => void; entryForm?: boolean; closeDisabled?: boolean;
  onLock?: () => void; lockSeconds?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    if (dialog && !dialog.open) {
      dialog.showModal();
      if (entryForm) dialog.querySelector<HTMLInputElement>('input[type="text"]')?.focus();
    }
    return () => {
      if (dialog?.open) dialog.close();
      if (entryForm && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [entryForm]);
  return <dialog ref={ref} className={entryForm ? 'modal entry-modal' : 'modal'} aria-modal="true" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!closeDisabled) onClose(); }}>
    <header className="modal-header"><div><p className="eyebrow">{eyebrow}</p><h2 id={titleId}>{title}</h2></div><div className="modal-header-actions">{onLock && <button className="icon-button" type="button" aria-label="立即锁定并丢弃未保存内容" title="立即锁定并丢弃未保存内容" onClick={onLock}><Icon name="lock" size={18} /></button>}<button className="icon-button" type="button" aria-label="关闭对话框" onClick={onClose} disabled={closeDisabled}><Icon name="close" /></button></div></header>
    {lockSeconds !== undefined && lockSeconds <= 30 && <div className="message warning modal-lock-warning" role="alert"><Icon name="clock" /><span>30 秒内将自动锁定，未保存内容会丢失。继续操作可续期。</span><strong aria-hidden="true">{lockSeconds}s</strong></div>}
    {children}
  </dialog>;
}

export function ErrorMessage({ children }: { children: ReactNode }) {
  return <div className="message error" role="alert"><Icon name="info" /><div>{children}</div></div>;
}

function blankEntry(type: EntryType): EntryInput {
  return { type, name: '', username: '', address: '', port: '', password: '', apiKey: '', secret: '', notes: '' };
}
function entryInput(entry: VaultEntry): EntryInput {
  return { type: entry.type, name: entry.name, username: entry.username, address: entry.address, port: entry.port, password: entry.password, apiKey: entry.apiKey, secret: entry.secret, notes: entry.notes };
}
function validateEntry(entry: EntryInput): string {
  if (!entry.name.trim()) return '请填写条目名称。';
  const limits: [keyof Omit<EntryInput, 'type'>, number, string][] = [
    ['name', 120, '名称'], ['username', 512, '用户名'], ['address', 2048, '地址'], ['port', 5, '端口'],
    ['password', 16384, '密码'], ['apiKey', 16384, 'API Key'], ['secret', 16384, 'Secret'], ['notes', 10000, '备注'],
  ];
  for (const [field, limit, label] of limits) if (entry[field].length > limit) return `${label}不能超过 ${limit} 个字符。`;
  if (entry.port && (!/^\d{1,5}$/.test(entry.port) || Number(entry.port) < 1 || Number(entry.port) > 65535)) return '端口请留空，或填写 1–65535 的整数。';
  if (entry.type === 'api' ? !entry.apiKey && !entry.secret : !entry.username && !entry.password) {
    return entry.type === 'api' ? '请至少填写 API Key 或 Secret。' : '请至少填写用户名或密码。';
  }
  return '';
}

export function EntryEditor({ entry, initialType, busy, error, conflict, reloaded, onClose, onSave, onReload, onLock, lockSeconds }: {
  entry?: VaultEntry; initialType: EntryType; busy: boolean; error: string; conflict: boolean; reloaded: boolean;
  onClose: () => void; onSave: (entry: EntryInput) => void; onReload: () => void; onLock: () => void; lockSeconds: number;
}) {
  const [initial] = useState(() => entry ? entryInput(entry) : blankEntry(initialType));
  const [draft, setDraft] = useState<EntryInput>(initial);
  const [validation, setValidation] = useState('');
  const id = useId();
  const close = () => {
    if (busy) return;
    if (JSON.stringify(initial) !== JSON.stringify(draft) && !window.confirm('放弃未保存的修改？草稿不会被保留。')) return;
    onClose();
  };
  const changeType = (type: EntryType) => {
    setDraft(previous => ({ ...previous, type, port: type === 'server' ? previous.port : '', username: type === 'api' ? '' : previous.username, password: type === 'api' ? '' : previous.password, apiKey: type === 'api' ? previous.apiKey : '', secret: type === 'api' ? previous.secret : '' }));
    setValidation('');
  };
  const field = (key: Exclude<keyof EntryInput, 'type' | 'notes'>, label: string, maxLength: number, options: { secret?: boolean; placeholder?: string; required?: boolean } = {}) => <div className="form-field" key={key}>
    <label htmlFor={`${id}-${key}`}>{label}{options.required && <span className="required"> *</span>}</label>
    <input id={`${id}-${key}`} value={draft[key]} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} type={options.secret ? 'password' : 'text'} autoComplete={options.secret ? 'new-password' : 'off'} spellCheck={false} maxLength={maxLength} required={options.required} placeholder={options.placeholder} inputMode={key === 'port' ? 'numeric' : undefined} disabled={busy} />
  </div>;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const problem = validateEntry(draft);
    setValidation(problem);
    if (problem) return;
    if (reloaded && entry && !window.confirm('最新密码库已重新载入。继续保存会用当前草稿替换这条记录，请确认已核对修改。')) return;
    onSave(draft);
  };
  return <Modal title={entry ? '编辑条目' : '添加新条目'} eyebrow={entry ? 'EDIT ITEM' : 'NEW ITEM'} onClose={close} entryForm closeDisabled={busy} onLock={onLock} lockSeconds={lockSeconds}>
    <form className="editor-form" onSubmit={submit} autoComplete="off" aria-busy={busy}>
      <div className="modal-body">
        <div className="message subtle"><Icon name="lock" /><span>草稿仅暂存于本页。手动或自动锁定都会丢弃未保存的内容。</span></div>
        <fieldset className="type-picker" disabled={busy}><legend>条目类型</legend><div className="type-options">{(Object.keys(typeNames) as EntryType[]).map(type => <label className={draft.type === type ? 'type-option selected' : 'type-option'} key={type}><input type="radio" name={`${id}-type`} checked={draft.type === type} onChange={() => changeType(type)} /><Icon name={type} /><span>{typeNames[type]}</span></label>)}</div></fieldset>
        <p className="field-hint">切换类型将清空不适用字段。</p>
        {field('name', '名称', 120, { required: true, placeholder: '为这条凭据取一个容易找到的名字' })}
        {field('username', draft.type === 'api' ? '标识 / Access Key ID（可选）' : '用户名 / 账号', 512, { placeholder: draft.type === 'api' ? '用于区分这组 API 凭据的标识' : '登录用户名或邮箱' })}
        {field('address', draft.type === 'server' ? '主机地址' : draft.type === 'api' ? '服务地址' : '网站 / 应用地址', 2048, { placeholder: draft.type === 'server' ? '主机名或 IP 地址' : '仅保存为文本，不会自动访问' })}
        {draft.type === 'server' && field('port', '端口（可选）', 5, { placeholder: '1–65535' })}
        {draft.type !== 'api' && field('password', '密码', 16384, { secret: true, placeholder: '输入需要保管的密码' })}
        {draft.type === 'api' && <>{field('apiKey', 'API Key', 16384, { secret: true })}{field('secret', 'Secret', 16384, { secret: true })}</>}
        <p className="field-hint">{draft.type === 'api' ? 'API Key 与 Secret 至少填写一项。' : '用户名与密码至少填写一项。'}秘密内容会原样保存，不会移除空格。</p>
        <div className="form-field"><label htmlFor={`${id}-notes`}>备注<span className="optional">可选</span></label><textarea id={`${id}-notes`} value={draft.notes} onChange={event => setDraft(previous => ({ ...previous, notes: event.target.value }))} maxLength={10000} rows={4} autoComplete="off" spellCheck={false} placeholder="补充说明、用途或其他需要记住的内容" disabled={busy} /></div>
        {(validation || error) && <ErrorMessage>{validation || error}</ErrorMessage>}
        {conflict && <div className="conflict-note"><p>草稿已保留。重新载入最新版本后，核对内容再保存，不会自动覆盖。</p><button type="button" className="button secondary" onClick={onReload} disabled={busy}>重新载入最新密码库</button></div>}
        {reloaded && !conflict && <p className="message subtle" role="status">最新版本已载入，草稿保持不变。请核对后再保存。</p>}
      </div>
      <footer className="modal-footer"><button className="button secondary" type="button" onClick={close} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy || conflict}><Icon name="check" />{busy ? '正在处理…' : '保存条目'}</button></footer>
    </form>
  </Modal>;
}

export function ChangeMasterPasswordDialog({ busy, error, conflict, onClose, onSubmit, onReload, onLock, lockSeconds }: {
  busy: boolean; error: string; conflict: boolean; onClose: () => void;
  onSubmit: (currentPassword: string, newPassword: string, confirmPassword: string) => void;
  onReload: () => void; onLock: () => void; lockSeconds: number;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [validation, setValidation] = useState('');
  const id = useId();
  const clearPasswords = () => { setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); };
  useEffect(() => {
    if (busy) { setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); }
  }, [busy]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || conflict) return;
    if (currentPassword.length < 1 || currentPassword.length > 1024) { setValidation('当前主密码需要 1–1024 个字符。'); return; }
    if (newPassword.length < 12 || newPassword.length > 1024) { setValidation('新主密码需要 12–1024 个字符。'); return; }
    if (newPassword !== confirmPassword) { setValidation('两次输入的新主密码不一致，请修改后重试。'); return; }
    if (currentPassword === newPassword) { setValidation('新主密码不能与当前主密码相同。'); return; }
    setValidation('');
    onSubmit(currentPassword, newPassword, confirmPassword);
    clearPasswords();
  };
  return <Modal title="修改主密码" eyebrow="MASTER PASSWORD" onClose={onClose} closeDisabled={busy} onLock={onLock} lockSeconds={busy ? undefined : lockSeconds}>
    <form onSubmit={submit} autoComplete="off" aria-busy={busy}>
      <div className="modal-body">
        <div className="message warning"><Icon name="info" /><span>此功能不是找回密码，必须提供当前主密码。旧备份及历史迁移副本不会改变，仍需使用各自对应的旧主密码。</span></div>
        <p className="body-copy">凭据内容不会改变。修改成功后会锁定所有会话，请使用新主密码重新解锁，并重新导出加密备份。</p>
        <div className="form-field"><label htmlFor={`${id}-current`}>当前主密码</label><input ref={input => { input?.setAttribute('autofocus', ''); }} id={`${id}-current`} type="password" autoComplete="off" value={currentPassword} onChange={event => { setCurrentPassword(event.target.value); setValidation(''); }} required minLength={1} maxLength={1024} disabled={busy} autoFocus /></div>
        <div className="form-field"><label htmlFor={`${id}-new`}>新主密码</label><input id={`${id}-new`} type="password" autoComplete="new-password" value={newPassword} onChange={event => { setNewPassword(event.target.value); setValidation(''); }} required minLength={12} maxLength={1024} disabled={busy} /></div>
        <div className="form-field"><label htmlFor={`${id}-confirm`}>确认新主密码</label><input id={`${id}-confirm`} type="password" autoComplete="new-password" value={confirmPassword} onChange={event => { setConfirmPassword(event.target.value); setValidation(''); }} required maxLength={1024} disabled={busy} /></div>
        <p className="field-hint">新主密码至少 12 个字符。密码原样提交，不会移除空格；提交后输入立即清空。</p>
        {(validation || error) && <ErrorMessage>{validation || error}</ErrorMessage>}
        {conflict && <div className="conflict-note"><p>库版本已变化，请先重新载入最新密码库，再重新输入主密码提交。不会自动覆盖其他修改。</p><button type="button" className="button secondary" onClick={() => { clearPasswords(); setValidation(''); onReload(); }} disabled={busy}>重新载入最新密码库</button></div>}
        {busy && <p className="message subtle" role="status">正在处理，请勿重复提交。修改期间暂停会话续期，仍会自动锁定。</p>}
      </div>
      <footer className="modal-footer"><button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy || conflict}>{busy ? '正在处理…' : '确认修改'}</button></footer>
    </form>
  </Modal>;
}

export function StorageLocationDialog({ token, storagePath, busy, error, onClose, onSubmit, onLock, lockSeconds, onFailure, onClearError }: {
  token: string; storagePath: string; busy: boolean; error: string; onClose: () => void;
  onSubmit: (directory: string) => void; onLock: () => void; lockSeconds: number;
  onFailure: (error: unknown) => boolean; onClearError: () => void;
}) {
  const [directory, setDirectory] = useState('');
  const [validation, setValidation] = useState('');
  const [picking, setPicking] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState('');
  const selectionRef = useRef<AbortController | null>(null);
  const id = useId();
  useEffect(() => () => { selectionRef.current?.abort(); }, [token]);
  const chooseFolder = async () => {
    if (busy || selectionRef.current) return;
    const controller = new AbortController();
    selectionRef.current = controller;
    setPicking(true);
    setValidation('');
    setSelectionNotice('');
    onClearError();
    try {
      const result = await api.selectStorageFolder(token, controller.signal);
      if (controller.signal.aborted) return;
      if (result.directory !== null) {
        setDirectory(result.directory);
        setSelectionNotice('文件夹已选择，确认迁移后才会修改存储位置。');
      } else {
        setSelectionNotice('已取消选择，存储位置未改变。');
      }
    } catch (cause) {
      if (!controller.signal.aborted && !onFailure(cause)) {
        setValidation(cause instanceof Error ? cause.message : '无法打开文件夹选择窗口，请重试。');
      }
    } finally {
      if (!controller.signal.aborted) setPicking(false);
      if (selectionRef.current === controller) selectionRef.current = null;
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || picking) return;
    if (!directory) { setValidation('请先选择一个文件夹。'); return; }
    setValidation('');
    onSubmit(directory);
  };
  return <Modal title="修改存储位置" eyebrow="STORAGE LOCATION" onClose={onClose} closeDisabled={busy} onLock={onLock} lockSeconds={busy ? undefined : lockSeconds}>
    <form className="storage-location-form" onSubmit={submit} autoComplete="off" aria-busy={busy || picking}>
      <div className="modal-body">
        <p className="storage-path-label">当前文件</p><code className="path-block">{storagePath}</code>
        <div className="form-field folder-selection">
          <label htmlFor={`${id}-directory`}>新存储目录</label>
          <output id={`${id}-directory`} className={`selected-folder${directory ? '' : ' empty'}`} aria-describedby={`${id}-hint`}>{directory || '尚未选择文件夹'}</output>
          <button className="button secondary" type="button" onClick={() => void chooseFolder()} disabled={busy || picking}><Icon name="file" size={17} />{picking ? '等待选择文件夹…' : '选择文件夹'}</button>
        </div>
        <p className="field-hint" id={`${id}-hint`}>点击按钮，在 Windows 窗口中选择本机文件夹，也可以新建文件夹；文件名固定为 vault.pvlt。</p>
        {picking && <p className="message subtle" role="status">请在系统窗口中选择文件夹；如果未看到窗口，请检查任务栏。取消不会改变存储位置，等待期间仍会自动锁定。</p>}
        {selectionNotice && <p className="field-hint" role="status">{selectionNotice}</p>}
        <div className="message warning"><Icon name="info" /><span>不推荐使用云同步盘或可拔出介质。迁移不会覆盖已有目标文件；完成后所有会话都会锁定。</span></div>
        <p className="storage-migration-note">原密码库会保留为历史副本，不再同步；旧备份不搬迁，仍留在旧目录。后续只写入新目录。</p>
        <p className="field-hint">目录偏好保存在原启动配置目录的 storage-location.json 中，请保留该配置文件，重启后会继续使用新位置。</p>
        {(validation || error) && <ErrorMessage>{validation || error}</ErrorMessage>}
        {busy && <p className="message subtle" role="status">正在迁移，请勿重复提交。迁移期间暂停会话续期，仍会自动锁定。</p>}
      </div>
      <footer className="modal-footer"><button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy || picking || !directory}>{busy ? '正在迁移…' : '迁移并使用新位置'}</button></footer>
    </form>
  </Modal>;
}

export function RestoreDialog({ token, hasVault, onClose, onSuccess, onFailure, onLock, lockSeconds }: {
  token?: string; hasVault: boolean; onClose: () => void;
  onSuccess: (session: SessionResponse) => void; onFailure: (error: unknown) => boolean;
  onLock?: () => void; lockSeconds?: number;
}) {
  const [password, setPassword] = useState('');
  const [filename, setFilename] = useState('');
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const fileRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<RestorePreview | null>(null);
  const alive = useRef(false);
  const generation = useRef(0);
  const id = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current += 1;
      if (previewRef.current) void api.cancelRestore(previewRef.current.restoreToken, token).catch(() => undefined);
      previewRef.current = null;
    };
  }, [token]);
  useEffect(() => {
    if (!preview) return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (time >= preview.expiresAt && busy !== 'confirm' && previewRef.current === preview) {
        previewRef.current = null;
        setPreview(null);
        setAccepted(false);
        setError('预览已过期并清空，请重新选择文件并验证备份密码。');
        void api.cancelRestore(preview.restoreToken, token).catch(() => undefined);
      }
    };
    const timer = window.setInterval(tick, 500);
    document.addEventListener('visibilitychange', tick);
    tick();
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [preview, busy, token]);
  const cancelPreview = () => {
    const old = previewRef.current;
    previewRef.current = null;
    setPreview(null);
    setAccepted(false);
    setPassword('');
    setFilename('');
    if (fileRef.current) fileRef.current.value = '';
    if (old) void api.cancelRestore(old.restoreToken, token).catch(cause => {
      if (alive.current && !onFailure(cause)) setError('取消预览请求失败；此预览会在一分钟后失效。');
    });
  };
  const close = () => { if (busy !== 'confirm') onClose(); };
  const startPreview = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const file = fileRef.current?.files?.[0];
    const submittedPassword = password;
    setPassword('');
    setError('');
    if (!file) { setError('请选择一个加密备份文件。'); return; }
    if (file.size > 8 * 1024 * 1024) { setError('备份文件不能超过 8 MiB。'); return; }
    if (!submittedPassword) { setError('请输入创建该备份时的主密码。'); return; }
    const version = ++generation.current;
    setBusy('preview');
    try {
      const text = await file.text();
      if (!alive.current || version !== generation.current) return;
      const result = await api.preview(text, submittedPassword, token);
      if (!alive.current || version !== generation.current) {
        void api.cancelRestore(result.restoreToken, token).catch(() => undefined);
        return;
      }
      if (result.expiresAt <= Date.now()) {
        void api.cancelRestore(result.restoreToken, token).catch(() => undefined);
        setError('预览已过期，请重新验证备份。');
        return;
      }
      previewRef.current = result;
      setPreview(result);
      setNow(Date.now());
      setAccepted(false);
      setFilename('');
      if (fileRef.current) fileRef.current.value = '';
    } catch (cause) {
      if (alive.current && version === generation.current && !onFailure(cause)) setError(cause instanceof Error ? cause.message : '无法读取备份文件。');
    } finally {
      if (alive.current && version === generation.current) setBusy(null);
    }
  };
  const confirm = async () => {
    if (!preview || busy || !accepted || preview.expiresAt <= Date.now()) return;
    if ((hasVault || preview.willReplace) && !window.confirm('确认覆盖当前密码库？恢复不会合并条目，当前内容将被整库替换。服务端会先创建当前库的安全副本。')) return;
    const version = ++generation.current;
    setBusy('confirm');
    setError('');
    try {
      const result = await api.confirmRestore(preview.restoreToken, token);
      if (!alive.current || version !== generation.current) {
        void api.lock(result.token).catch(() => undefined);
        return;
      }
      previewRef.current = null;
      onSuccess(result);
    } catch (cause) {
      if (alive.current && version === generation.current && !onFailure(cause)) setError(cause instanceof Error ? cause.message : '恢复失败，请重新预览后重试。');
    } finally {
      if (alive.current && version === generation.current) setBusy(null);
    }
  };
  const seconds = preview ? Math.max(0, Math.ceil((preview.expiresAt - now) / 1000)) : 0;
  return <Modal title="从备份恢复" eyebrow="RESTORE VAULT" onClose={close} closeDisabled={busy === 'confirm'} onLock={onLock} lockSeconds={lockSeconds}>
    {!preview ? <form onSubmit={startPreview} autoComplete="off" aria-busy={busy !== null}>
      <div className="modal-body">
        <p className="body-copy">找回熟悉的密码库。从本机选择加密备份，再用备份的主密码验证。</p>
        <div className="message warning"><Icon name="info" /><span>恢复是整库替换，不会合并条目。{hasVault ? '当前库会被覆盖；替换前服务端会创建安全副本。' : '验证成功后仍需明确确认，才会写入密码库。'}</span></div>
        <div className="form-field file-field"><label htmlFor={`${id}-file`}><Icon name="upload" />选择加密备份文件</label><input ref={fileRef} id={`${id}-file`} type="file" accept=".pvlt,application/octet-stream" required disabled={busy !== null} onChange={event => { setFilename(event.target.files?.[0]?.name ?? ''); setError(''); }} /><p className="field-hint">{filename || '本机 .pvlt 文件，最大 8 MiB'}</p></div>
        <div className="form-field"><label htmlFor={`${id}-password`}>备份主密码</label><input id={`${id}-password`} type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} required disabled={busy !== null} placeholder="创建这份备份时使用的主密码" /></div>
        <p className="field-hint">验证前不会显示备份中的条目数量。密码仅用于本次恢复。</p>
        {error && <ErrorMessage>{error}</ErrorMessage>}
      </div>
      <footer className="modal-footer"><button className="button secondary" type="button" onClick={close}>取消</button><button className="button primary" type="submit" disabled={busy !== null}>{busy ? '正在验证…' : '验证并预览'}<Icon name="arrow" /></button></footer>
    </form> : <div aria-busy={busy !== null}>
      <div className="modal-body">
        <div className="restore-summary"><span className="round-icon"><Icon name="shield" size={28} /></span><p className="eyebrow">备份密码验证成功</p><h3>{preview.entryCount}<span> 个条目</span></h3><p>确认后将使用这份备份的主密码。</p></div>
        <div className="message warning"><Icon name="info" /><span>{hasVault || preview.willReplace ? '这将覆盖当前密码库，而不是合并。当前库将在替换前保存为安全副本，完成后会显示副本路径。' : '这将以备份内容创建密码库，不会与其他条目合并。'}</span></div>
        {seconds > 0 ? <p className="field-hint"><Icon name="clock" size={15} />预览在 {seconds} 秒后失效，请核对后确认。</p> : <ErrorMessage>预览已过期。请重新选择文件并验证密码。</ErrorMessage>}
        <label className="checkbox-label"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} disabled={busy !== null || seconds === 0} /><span>我已了解整库替换风险，确认恢复这 {preview.entryCount} 个条目{hasVault || preview.willReplace ? '并覆盖当前密码库' : ''}。</span></label>
        {error && <ErrorMessage>{error}</ErrorMessage>}
      </div>
      <footer className="modal-footer"><button type="button" className="button secondary" onClick={cancelPreview} disabled={busy !== null}>重新选择</button><button type="button" className="button primary" onClick={() => void confirm()} disabled={busy !== null || !accepted || seconds === 0}>{busy ? '正在恢复…' : '确认恢复'}<Icon name="check" /></button></footer>
    </div>}
  </Modal>;
}

function DetailField({ label, value, secret = false, multiline = false }: { label: string; value: string; secret?: boolean; multiline?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const [feedback, setFeedback] = useState('');
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setRevealed(false); setFeedback(''); }, [value]);
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(false), 30_000);
    return () => window.clearTimeout(timer);
  }, [revealed]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(''), 3000);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      if (alive.current) setFeedback('已复制');
    } catch {
      if (alive.current) setFeedback('复制失败，请检查剪贴板权限');
    }
  };
  if (!value) return null;
  return <div className={`detail-field${multiline ? ' multiline' : ''}`}>
    <div className="detail-field-main"><span className="field-label">{label}</span><span className={`field-value${secret && !revealed ? ' masked' : ''}${multiline ? ' preserve-lines' : ''}`}>{secret && !revealed ? '••••••••••••' : value}</span></div>
    <div className="field-actions">{secret && <button className="icon-button" onClick={() => setRevealed(previous => !previous)} aria-label={`${revealed ? '隐藏' : '显示'}${label}`} title={`${revealed ? '隐藏' : '显示'}${label}（30 秒后自动隐藏）`} aria-pressed={revealed}><Icon name={revealed ? 'hidden' : 'eye'} size={18} /></button>}<button className="icon-button" onClick={() => void copy()} aria-label={`复制${label}`} title={`复制${label}`}><Icon name={feedback === '已复制' ? 'check' : 'copy'} size={18} /></button></div>
    {feedback && <span className="copy-feedback" role={feedback === '已复制' ? 'status' : 'alert'}>{feedback}</span>}
  </div>;
}

export function EntryDetail({ entry, busy, onEdit, onDelete, onBack, focusOnOpen }: { entry: VaultEntry; busy: boolean; onEdit: () => void; onDelete: () => void; onBack: () => void; focusOnOpen: boolean }) {
  const articleRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusOnOpen && window.matchMedia('(max-width: 760px)').matches) articleRef.current?.focus();
  }, [focusOnOpen]);
  const date = (value: string) => new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return <article ref={articleRef} tabIndex={-1} className="entry-detail" aria-label={`${entry.name}的详情`}>
    <div className="detail-toolbar"><button className="button ghost mobile-back" onClick={onBack}><Icon name="back" size={17} />返回列表</button><span className="eyebrow desktop-only">ITEM DETAILS</span><button className="button secondary small" onClick={onEdit} disabled={busy}><Icon name="edit" size={16} />编辑条目</button></div>
    <div className="detail-identity"><span className={`entry-emblem large ${entry.type}`}><Icon name={entry.type} size={30} /></span><span className="type-badge">{typeNames[entry.type]}</span><h2>{entry.name}</h2><p>你的凭据，妥善保管在这里。</p></div>
    <div className="detail-fields">
      <DetailField label={entry.type === 'api' ? '标识 / Access Key ID' : '用户名 / 账号'} value={entry.username} />
      <DetailField label={entry.type === 'server' ? '主机地址' : '网站 / 服务地址'} value={entry.address} />
      {entry.type === 'server' && <DetailField label="端口" value={entry.port} />}
      {entry.type !== 'api' && <DetailField label="密码" value={entry.password} secret />}
      {entry.type === 'api' && <><DetailField label="API Key" value={entry.apiKey} secret /><DetailField label="Secret" value={entry.secret} secret /></>}
      {entry.notes && <DetailField label="备注" value={entry.notes} multiline secret />}
    </div>
    <p className="clipboard-hint"><Icon name="shield" size={16} /><span>秘密显示 30 秒后重新隐藏。复制内容可能留在系统剪贴板历史中，本应用不会自动擦除。</span></p>
    <div className="detail-meta"><span>创建于 <time dateTime={entry.createdAt}>{date(entry.createdAt)}</time></span><span>最近修改 <time dateTime={entry.updatedAt}>{date(entry.updatedAt)}</time></span></div>
    <button className="button danger-ghost" onClick={onDelete} disabled={busy}><Icon name="trash" size={16} />删除此条目</button>
  </article>;
}
