import { useEffect, useMemo, useRef, useState } from 'react';
import { collectNativeAgents, mergeNativeAgentMessages, nativeAgentStatusLabel } from '../data/nativeAgents';
import { bridge } from '../bridge';
import type { ConversationMessage } from '../data/types';

export function NativeAgentsDialog({ sessionId, messages, onClose }: { sessionId: string; messages: ConversationMessage[]; onClose: () => void }) {
  const [history, setHistory] = useState<ConversationMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const loadedOlder = useRef(false);
  const agents = useMemo(() => collectNativeAgents(mergeNativeAgentMessages(history, messages)), [history, messages]);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = agents.find((entry) => entry.agent.id === selectedId) ?? agents.at(-1);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const page = await bridge.getSessionNativeAgents({ sessionId });
        if (cancelled) return;
        setHistory((current) => mergeNativeAgentMessages(current, page.messages));
        if (!loadedOlder.current) setNextBefore(page.nextBefore);
        setError('');
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : '读取子 agent 失败。'); }
      if (!cancelled) timer = setTimeout(refresh, 2000);
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId]);
  const loadOlder = async () => {
    if (!nextBefore || loading) return;
    setLoading(true);
    try {
      const page = await bridge.getSessionNativeAgents({ sessionId, before: nextBefore });
      setHistory((current) => mergeNativeAgentMessages(current, page.messages));
      setNextBefore(page.nextBefore);
      loadedOlder.current = true;
      setError('');
    } catch { loadedOlder.current = false; setError('记录已更新，正在刷新列表，请稍后重试。'); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return <div className="dialog-backdrop" role="presentation" onClick={onClose}>
    <section className="dialog-card native-agents-dialog" role="dialog" aria-modal="true" aria-label="原生子 agent" onClick={(event) => event.stopPropagation()}>
      <div className="dialog-head"><div><h2>原生子 agent</h2><p>由 CLI 创建和管理，输出独立于主回复。</p></div><button type="button" className="dialog-button secondary" onClick={onClose}>关闭</button></div>
      {error ? <p className="native-agent-note" role="status">{error}</p> : null}
      <div className="native-agents-layout">
        <nav className="native-agents-tree" aria-label="子 agent 列表">{agents.map(({ agent, depth, ownerLabel }) => <button type="button" key={agent.id} className={selected?.agent.id === agent.id ? 'selected' : ''} onClick={() => setSelectedId(agent.id)} style={{ paddingLeft: 12 + depth * 14 }}>
          <strong>{depth ? '↳ ' : ''}{agent.label}</strong><span>{ownerLabel || (agent.provider === 'claude' ? 'Claude' : 'Codex')} · {nativeAgentStatusLabel[agent.status]}</span>
        </button>)}{nextBefore ? <button type="button" disabled={loading} onClick={() => void loadOlder()}>{loading ? '加载中…' : '更早的记录'}</button> : null}</nav>
        {selected ? <article className="native-agent-detail">
          <div className="native-agent-detail-heading"><h3>{selected.agent.label}</h3><span className={`native-agent-status status-${selected.agent.status}`}>{nativeAgentStatusLabel[selected.agent.status]}</span></div>
          <p className="native-agent-meta">{selected.agent.provider === 'claude' ? 'Claude CLI' : 'Codex CLI'} 管理{selected.agent.model ? ` · ${selected.agent.model}` : ''}</p>
          {selected.agent.prompt ? <details><summary>任务说明</summary><pre>{selected.agent.prompt}</pre></details> : null}
          <h4>输出</h4>
          {selected.agent.outputNote ? <p className="native-agent-note">{selected.agent.outputNote}</p> : null}
          {selected.content ? <pre className="native-agent-output">{selected.content}</pre> : <p className="native-agent-note">尚未收到可展示的文本输出。</p>}
        </article> : <p className="native-agents-empty">CLI 创建子 agent 后，它们的状态、父子关系和输出会显示在这里。</p>}
      </div>
    </section>
  </div>;
}
