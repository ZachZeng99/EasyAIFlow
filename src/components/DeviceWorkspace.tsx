import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import App, { type WorkspaceViewState } from '../App';
import { BridgeContext } from '../BridgeContext';
import { bridge, bridgeForDevice } from '../bridge';
import type { DeviceAccessGrant, DeviceAccessPurpose, DeviceDescriptor, DevicePairingCode } from '../data/devices';

const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '连接失败，请重试。';
const connectionLabel = (device: DeviceDescriptor) => device.connection === 'online' ? '在线' : device.connection === 'connecting' ? '连接中' : '离线';
const savedSelection = () => { try { return localStorage.getItem('eaf.selectedDevice') || 'local'; } catch { return 'local'; } };

export function DeviceWorkspace() {
  const [devices, setDevices] = useState<DeviceDescriptor[]>([]);
  const [selected, setSelected] = useState(savedSelection);
  const [ready, setReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState('');
  const [managing, setManaging] = useState(false);
  const [browserSession, setBrowserSession] = useState(false);
  const mounted = useRef(true);
  const viewStates = useRef(new Map<string, WorkspaceViewState>());
  if (!viewStates.current.has(selected)) viewStates.current.set(selected, {});
  const refresh = useCallback(async () => {
    try {
      const result = await bridge.getDevices();
      if (!mounted.current) return;
      setDevices(result.devices);
      setReady(true); setAuthRequired(false); setError('');
      if (bridge.runtime === 'web') {
        const response = await fetch('/api/device/session');
        if (response.ok && response.headers.get('Content-Type')?.includes('application/json') && mounted.current) setBrowserSession(Boolean((await response.json()).authenticated));
      }
    } catch (reason) {
      if (!mounted.current) return;
      const message = errorText(reason);
      if (message.includes('EAF_AUTH_REQUIRED')) setAuthRequired(true);
      else setError(message);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!disposed) timer = setTimeout(poll, 4000); };
    void poll();
    return () => { disposed = true; mounted.current = false; clearTimeout(timer); };
  }, [refresh]);
  const choose = (id: string) => {
    setSelected(id);
    try { localStorage.setItem('eaf.selectedDevice', id); } catch { /* Optional preference. */ }
  };
  const scopedBridge = useMemo(() => bridgeForDevice(selected), [selected]);
  const current = devices.find((device) => selected === 'local' ? device.kind === 'local' : device.id === selected);
  if (authRequired) return <BrowserLogin onConnected={refresh} />;
  if (!ready) return <main className="device-entry"><h1>EasyAIFlow</h1><p role="status">{error || '正在连接执行服务…'}</p>{error ? <button className="dialog-button primary" onClick={() => void refresh()}>重新连接</button> : null}</main>;
  const offline = Boolean(error) || !current || current.connection !== 'online';
  return <div className="device-workspace">
    <header className="device-toolbar">
      <label htmlFor="execution-device">执行设备</label>
      <select id="execution-device" aria-label="执行设备" value={selected} onChange={(event) => choose(event.target.value)}>
        {!current ? <option value={selected}>已移除的设备</option> : null}
        {devices.map((device) => <option key={device.id} value={device.kind === 'local' ? 'local' : device.id}>{device.name}{device.kind === 'local' ? ' · 控制端' : ''} · {connectionLabel(device)}</option>)}
      </select>
      <span className={`device-indicator ${offline ? 'offline' : 'online'}`}>{offline ? '连接中断' : '在线'}</span>
      <button type="button" className="dialog-button secondary" onClick={() => setManaging(true)}>管理设备</button>
      {browserSession ? <button type="button" className="device-logout" onClick={() => void (async () => {
        try {
          const response = await fetch('/api/device/logout', { method: 'POST' });
          if (!response.ok) throw new Error('退出失败，请重试。');
          setAuthRequired(true); setBrowserSession(false); setReady(false);
        } catch (reason) { setError(errorText(reason)); }
      })()}>退出</button> : null}
    </header>
    <div className="device-workspace-content">
      {offline ? <p className="device-offline-banner" role="status">{current?.connection === 'connecting' && !error ? '正在连接执行电脑…' : '无法连接当前设备，任务状态暂时未知。连接恢复后会同步。'}{error ? <span title={error}> 控制服务连接异常。</span> : null}</p> : null}
      <BridgeContext.Provider value={scopedBridge} key={selected}><App viewState={viewStates.current.get(selected)} /></BridgeContext.Provider>
    </div>
    {managing ? <DeviceManager devices={devices} onClose={() => setManaging(false)} onChanged={refresh} onSelect={choose} selected={selected} /> : null}
  </div>;
}

function BrowserLogin({ onConnected }: { onConnected: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const login = async () => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/device/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim(), purpose: 'browser', name: '浏览器 · ' + navigator.platform }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '登录失败。');
      setCode(''); await onConnected();
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  return <main className="device-entry"><form className="device-login" onSubmit={(event) => { event.preventDefault(); void login(); }}>
    <h1>连接 EasyAIFlow</h1><p>在控制电脑上打开「管理设备 → 分享访问」，生成浏览器登录码。</p>
    <small>{location.origin}</small>
    <label>浏览器登录码<input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={256} /></label>
    {error ? <p role="alert" className="ui-error-banner">{error}</p> : null}
    <button className="dialog-button primary" disabled={busy || !code.trim()}>{busy ? '连接中…' : '连接'}</button>
  </form></main>;
}

function DeviceManager({ devices, selected, onClose, onChanged, onSelect }: { devices: DeviceDescriptor[]; selected: string; onClose: () => void; onChanged: () => Promise<void>; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<'devices' | 'connect' | 'share'>('devices');
  const [origin, setOrigin] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [expectedId, setExpectedId] = useState('');
  const [certificate, setCertificate] = useState('');
  const [trustedVpn, setTrustedVpn] = useState(false);
  const [pairing, setPairing] = useState<DevicePairingCode>();
  const [grants, setGrants] = useState<DeviceAccessGrant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const local = devices.find((device) => device.kind === 'local');
  const reloadGrants = async () => setGrants((await bridge.getDeviceAccessGrants()).grants);
  useEffect(() => { void reloadGrants().catch((reason) => setError(errorText(reason))); }, []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [busy, onClose]);
  const action = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); await onChanged(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };
  const generate = (purpose: DeviceAccessPurpose) => action(async () => setPairing(await bridge.createDevicePairing({ purpose })));
  return <div className="dialog-backdrop" role="presentation" onClick={() => { if (!busy) onClose(); }}><section className="dialog-card device-manager" role="dialog" aria-modal="true" aria-label="管理设备" onClick={(event) => event.stopPropagation()}>
    <div className="dialog-head"><div><h2>管理设备</h2><p>{local?.name} · 控制端</p></div><button className="dialog-button secondary" onClick={onClose} disabled={busy}>关闭</button></div>
    <nav className="device-tabs" aria-label="设备管理页面">{([['devices', '已连接'], ['connect', '接入电脑'], ['share', '分享访问']] as const).map(([key, label]) => <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>
    <div className="device-manager-body">
      {tab === 'devices' ? <div className="device-list">{devices.map((device) => <article className="device-card" key={device.id}>
        <div><strong>{device.name}</strong><span className={`device-indicator ${device.connection}`}>{connectionLabel(device)}</span></div>
        <p>{device.kind === 'local' ? '控制端执行服务' : device.origin} · {device.platform}</p>
        <small>设备 ID：{device.id}</small>
        {device.error ? <p className="device-error">{device.error}</p> : null}
        <div className="device-actions"><button className="dialog-button primary" disabled={busy} onClick={() => { onSelect(device.kind === 'local' ? 'local' : device.id); onClose(); }}>打开任务</button>
          {device.kind === 'remote' ? <button className="dialog-button secondary" disabled={busy} onClick={() => void action(async () => { await bridge.removeRemoteDevice({ deviceId: device.id }); if (selected === device.id) onSelect('local'); })}>移除连接</button> : null}</div>
      </article>)}<p className="device-help">移除连接会保留执行电脑上的任务。要取消其他设备的接入权限，请在那台电脑上撤销授权。</p></div> : null}
      {tab === 'connect' ? <form className="device-form" onSubmit={(event) => { event.preventDefault(); void action(async () => {
        const device = await bridge.addRemoteDevice({ origin: origin.trim(), code: code.trim(), name: name.trim(), expectedDeviceId: expectedId.trim() || undefined, trustedVpn, certificate: certificate.trim() || undefined });
        setCode(''); setTab('devices'); onSelect(device.id);
      }); }}>
        <p className="device-help">在执行电脑上打开「管理设备 → 分享访问」，生成控制配对码，然后填写它的 HTTPS 或 VPN 地址。</p>
        <label>执行电脑地址<input type="url" required value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://workstation:8887" /></label>
        <label>控制配对码<input required value={code} onChange={(event) => setCode(event.target.value)} maxLength={256} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
        <label>备注名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="例如：工作电脑" /></label>
        <details><summary>验证设备与连接设置</summary><div className="device-form">
          <label>执行电脑的设备 ID<input value={expectedId} onChange={(event) => setExpectedId(event.target.value)} placeholder="与配对码一起显示的设备 ID" /></label>
          <label className="device-checkbox"><input type="checkbox" checked={trustedVpn} onChange={(event) => setTrustedVpn(event.target.checked)} />我已通过加密 VPN 连接，允许使用 HTTP 地址</label>
          <label>公开的 CA / 自签名证书（PEM，可选）<textarea rows={4} value={certificate} onChange={(event) => setCertificate(event.target.value)} placeholder="-----BEGIN CERTIFICATE-----" maxLength={65536} /></label>
        </div></details>
        <button className="dialog-button primary" disabled={busy}>{busy ? '配对中…' : '连接电脑'}</button>
      </form> : null}
      {tab === 'share' ? <div className="device-form">
        <p className="device-help">为 {local?.name} 生成一次性接入码。浏览器登录可操作控制端及其已配对设备；控制配对码只授权操作这台执行电脑。</p>
        <div className="device-actions"><button className="dialog-button primary" disabled={busy} onClick={() => void generate('browser')}>生成浏览器登录码</button><button className="dialog-button secondary" disabled={busy} onClick={() => void generate('device')}>生成控制配对码</button></div>
        {pairing ? <div className="device-pairing"><strong>{pairing.purpose === 'browser' ? '浏览器登录码' : '控制配对码'}</strong><code>{pairing.code}</code><p>一次有效 · {new Date(pairing.expiresAt).toLocaleTimeString()} 过期</p><small>设备 ID：{pairing.device.id}</small><button className="dialog-button secondary" onClick={() => void action(async () => bridge.writeClipboardText(pairing.code))}>复制接入码</button></div> : null}
        <p className="device-help">手机需要能访问这台电脑的 HTTPS 或 VPN 网关。当前浏览器地址：{bridge.runtime === 'web' ? location.origin : '桌面客户端，请使用网关地址'}。生成接入码不会自动开放网络端口。</p>
        <h3>已授权的接入</h3>{grants.length ? grants.map((grant) => <div className="device-grant" key={grant.id}><div><strong>{grant.name}</strong><small>{grant.purpose === 'browser' ? '浏览器' : '设备控制端'} · {new Date(grant.createdAt).toLocaleString()}</small></div><button className="dialog-button secondary" disabled={busy} onClick={() => void action(async () => { await bridge.revokeDeviceAccess({ grantId: grant.id }); await reloadGrants(); })}>撤销</button></div>) : <p className="device-help">还没有授权的接入。</p>}
      </div> : null}
    </div>
    {error ? <p className="ui-error-banner" role="alert">{error}</p> : null}
  </section></div>;
}
