import { useEffect, useState } from 'react';
import type { EasyAIFlowBridge } from '../bridge';
import { useBridge } from '../BridgeContext';
import { MAX_GROUP_PARTICIPANTS, nextGroupParticipantId, validateGroupParticipantConfigs } from '../data/groupParticipants';
import { describeModelCatalog, findProviderModel, modelEffortOptions, modelOptionsWithCurrent, type ProviderModelCatalog } from '../data/providerModels';
import type { GroupParticipantConfig, SessionProvider, SessionRecord } from '../data/types';
import type { GroupPlacementOptions } from '../data/devices';

type Props = { session: SessionRecord; busy: boolean; onClose: () => void; onSaved: (result: Awaited<ReturnType<EasyAIFlowBridge['updateGroupParticipants']>>) => void };

export function GroupParticipantsDialog({ session, busy, onClose, onSaved }: Props) {
  const bridge = useBridge();
  const group = session.group?.kind === 'room' ? session.group : undefined;
  const [participants, setParticipants] = useState<GroupParticipantConfig[]>(() => group?.participants.map(({ id, label, provider, enabled, model, effort, instructions, remote }) => ({ id, label, provider, enabled, model, effort, instructions,
    ...(remote ? { placement: { deviceId: remote.deviceId, projectId: remote.projectId } } : {}) })) ?? []);
  const remoteMembers = new Map(group?.participants.filter((participant) => participant.remote).map((participant) => [participant.id, participant.remote!]) ?? []);
  // Unavailable when this room is on a routed device: placement needs the room device's own peers.
  const [placementOptions, setPlacementOptions] = useState<GroupPlacementOptions | null>(null);
  const [revision] = useState(group?.configurationRevision ?? 0);
  const [collaborationEnabled, setCollaborationEnabled] = useState(group?.collaborationEnabled === true);
  const [originalCount] = useState(group?.participants.length ?? 0);
  const [catalogs, setCatalogs] = useState<Partial<Record<SessionProvider, ProviderModelCatalog>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);
  useEffect(() => {
    let cancelled = false;
    for (const provider of ['claude', 'codex'] as const) {
      void bridge.getProviderModels({ provider, cwd: session.workspace })
        .then((catalog) => { if (!cancelled) setCatalogs((current) => ({ ...current, [provider]: catalog })); })
        .catch(() => { if (!cancelled) setCatalogError('模型列表读取失败，可保留已有模型或填写模型 ID。'); });
    }
    return () => { cancelled = true; };
  }, [session.workspace]);
  useEffect(() => {
    let cancelled = false;
    void bridge.getGroupPlacementOptions().then((options) => { if (!cancelled) setPlacementOptions(options); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const refreshModels = async () => {
    setRefreshing(true);
    setCatalogError('');
    try {
      const results = await Promise.all((['claude', 'codex'] as const).map((provider) => bridge.getProviderModels({ provider, cwd: session.workspace, force: true })));
      setCatalogs(Object.fromEntries(results.map((catalog) => [catalog.provider, catalog])));
    } catch (reason) { setCatalogError(reason instanceof Error ? reason.message : '模型刷新失败。'); }
    finally { setRefreshing(false); }
  };
  const update = (index: number, values: Partial<GroupParticipantConfig>) => setParticipants((current) => current.map((participant, position) => position === index ? { ...participant, ...values } : participant));
  const add = (provider: SessionProvider) => setParticipants((current) => {
    const id = nextGroupParticipantId(provider, current.map((participant) => participant.id));
    return [...current, { id, label: id, provider, enabled: true, effort: 'default', model: catalogs[provider]?.models.find((model) => model.isDefault)?.id }];
  });
  const save = async () => {
    setError('');
    try {
      const configs = validateGroupParticipantConfigs(participants);
      setSaving(true);
      const result = await bridge.updateGroupParticipants({ sessionId: session.id, expectedRevision: revision, participants: configs, collaborationEnabled });
      onSaved(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^EAF_OPERATION_REJECTED:\s*/, '') : '保存失败。'); }
    finally { setSaving(false); }
  };
  return <div className="dialog-backdrop" role="presentation" onClick={() => { if (!saving) onClose(); }}>
    <section className="dialog-card group-members-dialog" role="dialog" aria-modal="true" aria-label="群成员" onClick={(event) => event.stopPropagation()}>
      <div className="dialog-head"><h2>群成员</h2><button type="button" className="dialog-button secondary" disabled={saving} onClick={onClose}>关闭</button></div>
      <p className="dialog-description">为每位成员设置角色和模型。用 @标识 点名，或用 @all 同时派发；每位成员保留独立会话。</p>
      <label className="group-members-notice"><input type="checkbox" checked={collaborationEnabled} disabled={saving || busy} onChange={(event) => setCollaborationEnabled(event.target.checked)} />允许群成员相互委派任务并等待回复（每条用户任务最多 16 次委派）</label>
      {busy ? <p className="group-members-notice">群聊正在执行任务，结束或停止后才能保存修改。</p> : null}
      <div className="group-members-list">
        {participants.map((participant, index) => {
          const catalog = catalogs[participant.provider];
          const options = modelOptionsWithCurrent(catalog?.models ?? [], [participant.model ?? '']);
          const isExisting = index < originalCount;
          const capabilities = findProviderModel(catalog?.models ?? [], participant.model);
          const efforts = capabilities ? modelEffortOptions(capabilities) : ['default'];
          const effortOptions = [...new Set([...efforts, participant.effort ?? 'default'])];
          const savedRemote = isExisting ? remoteMembers.get(participant.id) : undefined;
          const placementDevice = placementOptions?.devices.find((device) => device.id === participant.placement?.deviceId);
          const placementField = savedRemote
            ? <label>执行设备<input aria-label={`成员 ${index + 1} 执行设备`} value={`${savedRemote.deviceName || savedRemote.deviceId} · ${savedRemote.workspace}`} disabled title="已有成员的执行设备不能更换" /></label>
            : isExisting || !placementOptions?.devices.length ? null
            : <>
              <label>执行设备<select aria-label={`成员 ${index + 1} 执行设备`} value={participant.placement?.deviceId ?? ''} onChange={(event) => {
                const device = placementOptions.devices.find((entry) => entry.id === event.target.value);
                update(index, { placement: device?.projects[0] ? { deviceId: device.id, projectId: device.projects[0].id } : undefined, model: undefined, effort: 'default' });
              }}><option value="">本机（群聊所在设备）</option>{placementOptions.devices.map((device) => <option key={device.id} value={device.id} disabled={device.connection !== 'online' || device.projects.length === 0}>{device.name}{device.connection !== 'online' ? '（离线）' : device.projects.length === 0 ? '（无项目）' : ''}</option>)}</select></label>
              {placementDevice ? <label>设备项目<select aria-label={`成员 ${index + 1} 设备项目`} value={participant.placement?.projectId ?? ''} onChange={(event) => update(index, { placement: { deviceId: placementDevice.id, projectId: event.target.value } })}>{placementDevice.projects.map((project) => <option key={project.id} value={project.id} title={project.rootPath}>{project.name}</option>)}</select></label> : null}
            </>;
          const remotePlaced = Boolean(participant.placement);
          return <fieldset className={`group-member-card${participant.enabled ? '' : ' disabled'}`} key={index} disabled={saving}>
            <div className="group-member-heading"><strong>{participant.label || '新成员'}</strong><label><input type="checkbox" checked={participant.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} />启用</label></div>
            <div className="group-member-fields">
              <label>名称<input aria-label={`成员 ${index + 1} 名称`} value={participant.label} maxLength={60} onChange={(event) => update(index, { label: event.target.value })} /></label>
              <label>@标识<input aria-label={`成员 ${index + 1} 标识`} value={participant.id} maxLength={48} disabled={isExisting} onChange={(event) => update(index, { id: event.target.value.toLowerCase() })} /></label>
              <label>Provider<select aria-label={`成员 ${index + 1} Provider`} value={participant.provider} disabled={isExisting} onChange={(event) => update(index, { provider: event.target.value as SessionProvider, model: undefined, effort: 'default' })}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>
              <label>模型<input aria-label={`成员 ${index + 1} 模型`} list={`group-member-models-${index}`} value={participant.model ?? ''} placeholder={remotePlaced ? '执行设备推荐模型' : '运行时推荐模型'} onChange={(event) => update(index, { model: event.target.value, effort: 'default' })} /><datalist id={`group-member-models-${index}`}>{remotePlaced ? null : options.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}</datalist></label>
              <label>推理档位<select aria-label={`成员 ${index + 1} 推理档位`} value={participant.effort ?? 'default'} onChange={(event) => update(index, { effort: event.target.value })}>{effortOptions.map((value) => <option key={value} value={value}>{value === 'default' ? '模型默认' : value}</option>)}</select></label>
              {placementField}
            </div>
            <label className="group-member-role">角色说明<textarea aria-label={`成员 ${index + 1} 角色说明`} rows={2} maxLength={8000} value={participant.instructions ?? ''} placeholder="例如：负责审查代码，指出问题并给出验证方法。" onChange={(event) => update(index, { instructions: event.target.value })} /></label>
            {isExisting ? <small>停用会保留该成员的会话和历史。</small> : <button className="dialog-button secondary" type="button" onClick={() => setParticipants((current) => current.filter((_, position) => position !== index))}>移除未保存成员</button>}
          </fieldset>;
        })}
      </div>
      {catalogError ? <p role="status" className="group-members-notice">{catalogError}</p> : null}
      {catalogs.codex ? <small title={catalogs.codex.runtimePath}>{describeModelCatalog(catalogs.codex)}</small> : null}
      {error ? <p role="alert" className="ui-error-banner">{error}</p> : null}
      <div className="group-members-add"><button type="button" className="dialog-button secondary" disabled={saving || participants.length >= MAX_GROUP_PARTICIPANTS} onClick={() => add('claude')}>+ Claude</button><button type="button" className="dialog-button secondary" disabled={saving || participants.length >= MAX_GROUP_PARTICIPANTS} onClick={() => add('codex')}>+ Codex</button><button type="button" className="dialog-button secondary" disabled={refreshing} onClick={() => void refreshModels()}>{refreshing ? '刷新中…' : '刷新模型'}</button><small>{participants.length} / {MAX_GROUP_PARTICIPANTS} 位成员</small></div>
      <div className="dialog-actions"><button type="button" className="dialog-button secondary" disabled={saving} onClick={onClose}>取消</button><button type="button" className="dialog-button primary" disabled={saving || busy} onClick={() => void save()}>{saving ? '保存中…' : '保存成员'}</button></div>
    </section>
  </div>;
}
