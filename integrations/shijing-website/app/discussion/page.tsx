'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import AgentDiscussion from '../components/AgentDiscussion';
import OriginalScene from '../components/OriginalScene';
import CandleHome from '../components/CandleHome';
import useTopicGeneration, { emptyAssets } from '../hooks/use-topic-generation';
import { postJSON, prepareImage } from '../lib/image-client';
import type { Visual, TopicPlan } from '../lib/topic';
import { AssetPatch, mergeAssets, SceneAssets, validatePatch } from '../lib/scene-assets';

type Message = { id: number; role: 'user' | 'assistant'; characterId: string; speaker: string; text: string };
type Recognition = { lang: string; interimResults: boolean; onresult: (event: { results: { transcript: string }[][] }) => void; onerror: () => void; onend: () => void; start: () => void; stop: () => void };

declare global {
  interface Window {
    shijing?: { updateAssets: (patch: AssetPatch) => Promise<void>; getAssets: () => SceneAssets };
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  }
}

function LegacyDiscussion() {
  const [assets, setAssets] = useState(emptyAssets);
  const [activeId, setActiveId] = useState('weiyan');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [responding, setResponding] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [listening, setListening] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [scale, setScale] = useState(1);
  const [pristine, setPristine] = useState(false);
  const [editingInput, setEditingInput] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const assetsRef = useRef(assets);
  const imageVersion = useRef(0);
  const patchVersion = useRef(0);
  const slotVersions = useRef<Record<string, number>>({});
  const id = useRef(6);
  const locked = useRef(false);
  const recognition = useRef<Recognition | null>(null);
  const [pendingVisual, setPendingVisual] = useState<Visual | null>(null);
  const currentVisual = useRef<Visual | null>(null);
  const planRef = useRef<TopicPlan | null>(null);
  const initializedPlan = useRef(false);
  const generation = useTopicGeneration(next => { setAssets(next); assetsRef.current = next; }, nextPlan => {
    planRef.current = nextPlan;
    if (!initializedPlan.current) {
      initializedPlan.current = true;
      setMessages(nextPlan.characters.map(c => ({ id: id.current++, role: 'assistant', characterId: c.id, speaker: c.name, text: c.opening })));
    }
  });
  const activeCharacter = assets.characters.find(c => c.id === activeId)!;

  const updateAssets = useCallback(async (patch: AssetPatch) => {
    const version = ++patchVersion.current;
    if (!patch || typeof patch !== 'object' || (patch.characters && !Array.isArray(patch.characters))) throw new Error('素材配置格式不正确');
    const keys = [...(patch.characters ?? []).map(c => `character:${c.id}`), ...(patch.storyboard ? ['storyboard'] : [])];
    for (const key of keys) slotVersions.current[key] = version;
    if (patch.storyboard) { ++imageVersion.current; setGenerating(false); }
    await validatePatch(patch);
    const latestPatch = {
      characters: patch.characters?.filter(c => slotVersions.current[`character:${c.id}`] === version),
      storyboard: slotVersions.current.storyboard === version ? patch.storyboard : undefined,
    };
    setAssets(current => { const next = mergeAssets(current, latestPatch); assetsRef.current = next; return next; });
  }, []);

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  useEffect(() => {
    const controller = new AbortController();
    window.shijing = { updateAssets, getAssets: () => structuredClone(assetsRef.current) };
    const onPatch = (event: Event) => { void updateAssets((event as CustomEvent<AssetPatch>).detail).catch(e => setError(e.message)); };
    window.addEventListener('shijing:assets-update', onPatch);
    return () => { controller.abort(); window.removeEventListener('shijing:assets-update', onPatch); delete window.shijing; recognition.current?.stop(); };
  }, [updateAssets]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setScale(Math.min(width / 1672, Math.max(200, entry.contentRect.height - 82) / 941));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (messages.length > 5 || responding) conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'smooth' });
  }, [messages, responding]);

  function selectCharacter(characterId: string) {
    if (generation.busy || locked.current || activeId === characterId) return;
    ++imageVersion.current;
    setPendingVisual(null);
    setGenerating(false);
    setActiveId(characterId);
    setPristine(false);
    const character = assets.characters.find(c => c.id === characterId)!;
    setMessages([{ id: id.current++, role: 'assistant', characterId, speaker: character.name, text: planRef.current?.characters.find(c => c.id === characterId)?.opening || `我们来继续讨论「${generation.topic.title}」。` }]);
    setInput(''); setError(''); setShowSuggestions(false);
  }

  async function submitMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = input.trim();
    if (!text || generation.busy || !generation.plan || locked.current) return;
    locked.current = true;
    setPristine(false);
    let responsePending = true;
    recognition.current?.stop();
    const character = activeCharacter;
    const turnVersion = ++imageVersion.current;
    const next = [...messages, { id: id.current++, role: 'user' as const, characterId: 'user', speaker: '你', text }];
    setPendingVisual(null);
    setMessages(next); setInput(''); setError(''); setResponding(true); setGenerating(false); setShowSuggestions(false);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, character: character.name, topic: generation.topic, personality: planRef.current?.characters.find(c => c.id === character.id)?.personality, currentVisual: currentVisual.current || generation.visual || planRef.current?.visual, currentSceneKey: assetsRef.current.storyboard.sceneKey, history: next.slice(-8).map(m => ({ role: m.role, content: m.text })) }),
      });
      if (!response.ok) { const failure = await response.json().catch(() => ({})) as {error?: string}; throw new Error(failure.error || '这一轮对话没有接通，请稍后再试。'); }
      const data: { reply: string; visual: Visual; demo?: boolean } = await response.json();
      setMessages(current => [...current, { id: id.current++, role: 'assistant', characterId: character.id, speaker: character.name, text: data.reply }]);
      setResponding(false); locked.current = false;
      responsePending = false;
      if (turnVersion === imageVersion.current && data.visual.action === 'GENERATE') {
        setPendingVisual(data.visual);
        await generateStory(data.visual, turnVersion);
      }
    } catch (cause) {
      if (turnVersion === imageVersion.current) { setError(cause instanceof Error ? cause.message : '暂时无法连接，请稍后再试。'); setGenerating(false); }
    } finally { if (responsePending) { setResponding(false); locked.current = false; } }
  }

  async function generateStory(visual: Visual, version: number) {
    setGenerating(true);
    try {
      const result = await postJSON<{image: string}>('/api/storyboard', { visual });
      const picture = await prepareImage(result.image, 'storyboard');
      await postJSON('/api/validate-image', { kind: 'storyboard', images: picture.previews, context: visual });
      if (version !== imageVersion.current) return;
      const next = mergeAssets(assetsRef.current, { storyboard: { image: picture.image, sceneKey: visual.scene_key, location: visual.location, title: visual.title, caption: visual.summary } });
      setAssets(next); assetsRef.current = next; currentVisual.current = visual;
      setPendingVisual(null); setError('');
      await generation.commitStory(next, visual);
    } catch (cause) {
      if (version === imageVersion.current) setError(cause instanceof Error ? cause.message : '故事板尚未更新，请重试。');
    } finally { if (version === imageVersion.current) setGenerating(false); }
  }

  function toggleVoice() {
    if (listening) { recognition.current?.stop(); return; }
    const Speech = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Speech) { setError('当前浏览器不支持语音输入，请使用文字输入。'); textarea.current?.focus(); return; }
    setError('');
    const instance = new Speech(); recognition.current = instance;
    instance.lang = 'zh-CN'; instance.interimResults = false;
    instance.onresult = event => { setInput(current => current + event.results[0][0].transcript); textarea.current?.focus(); };
    instance.onerror = () => { setListening(false); setError('语音未能识别，请检查麦克风权限或使用文字输入。'); };
    instance.onend = () => setListening(false);
    try { instance.start(); setListening(true); } catch { setListening(false); setError('麦克风未能启动，请使用文字输入。'); }
  }

  return (
    <main className="scene-viewport" ref={viewport}>
      <header className="topic-toolbar">
        <a href="/">← 返回战略地图</a>
        <div><strong>{generation.topic.title}</strong><small>{generation.plan?.factNote || `公元 ${generation.topic.year} 年 · ${generation.topic.season}`}</small></div>
        <span aria-live="polite">{generation.busy ? generation.status : generation.done === 6 ? (generation.saveWarning ? '人物与故事板已就绪 · 当前页面保留' : '人物与故事板已就绪 · 本机保存') : `已完成 ${generation.done}/6 张`}</span>
        {!generation.busy && generation.done < 6 && <button type="button" onClick={generation.retry}>重试未完成项</button>}
      </header>
      <div className="artboard" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <OriginalScene assets={assets} activeId={activeId} pristine={pristine} editingInput={editingInput || !!input} />
        <CandleHome />
        <aside className="character-rail" aria-label="对话人物">
          <h2 className="sr-only">对话人物</h2>
          <div className="character-list">
            {assets.characters.map(character => (
              <button key={character.id} type="button" className={`character-card ${character.id === activeId ? 'selected' : ''}`} aria-pressed={character.id === activeId} disabled={responding || generation.busy || !generation.plan} onClick={() => selectCharacter(character.id)}>
                <span className="sr-only">{character.name} · {character.role}</span>{!character.card && <span className="asset-pending">{generation.errors[character.id] ? '待重试' : generation.busy ? '绘制中' : '尚未生成'}</span>}
              </button>
            ))}
          </div>
        </aside>
        <section className={`dialogue-panel ${pristine ? 'pristine' : ''}`} aria-label={`与${activeCharacter.name}的对话`}>
          <div className="conversation" ref={conversation} role="log" aria-label="对话记录" aria-live="polite" aria-busy={responding}>
            {messages.map(message => {
              const character = assets.characters.find(c => c.id === message.characterId);
              return <article className={`message ${message.role}`} key={message.id}>
                {character?.avatar ? <img className="message-portrait" src={character.avatar} alt="" /> : <span className="user-mark">{character ? character.name.slice(0, 1) : '你'}</span>}
                <div className="message-content"><b>{character?.name ?? message.speaker}</b><p>{message.text}</p></div>
              </article>;
            })}
            {responding && <article className="message thinking">{activeCharacter.avatar ? <img className="message-portrait" src={activeCharacter.avatar} alt="" /> : <span className="user-mark">{activeCharacter.name.slice(0, 1)}</span>}<div className="message-content"><b>{activeCharacter.name}</b><p>正在思量<span aria-hidden="true">···</span></p></div></article>}
          </div>
        </section>
        <form className="composer" onSubmit={submitMessage}>
          <label className="sr-only" htmlFor="message">与{activeCharacter.name}交谈</label>
          <textarea ref={textarea} id="message" rows={1} maxLength={1200} value={input} disabled={responding || generation.busy || !generation.plan} onChange={event => setInput(event.target.value)} placeholder="" onFocus={() => setEditingInput(true)} onBlur={() => setEditingInput(false)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submitMessage(); } }} />
          <button className={`art-button voice-button ${listening ? 'listening' : ''}`} type="button" aria-label={listening ? '结束语音输入' : '语音输入'} aria-pressed={listening} disabled={responding || generation.busy || !generation.plan} onClick={toggleVoice}><span className="sr-only">语音输入</span></button>
          <button className="art-button suggestion-button" type="button" aria-label="展开对话建议" aria-expanded={showSuggestions} disabled={responding || generation.busy || !generation.plan} onClick={() => setShowSuggestions(!showSuggestions)}><span className="sr-only">对话建议</span></button>
          <button className="art-button send-button" type="submit" aria-label="发送" disabled={responding || generation.busy || !generation.plan || !input.trim()}><span className="sr-only">发送</span></button>
          {showSuggestions && <div className="suggestions">{(generation.plan?.suggestions || []).map(prompt => <button type="button" key={prompt} onClick={() => { setInput(prompt); setShowSuggestions(false); textarea.current?.focus(); }}>{prompt}</button>)}</div>}
        </form>
        {!assets.storyboard.image && <div className="story-pending" role="status"><strong>故事板</strong><p>{generation.busy ? '画师正在构思当前议题…' : '本次故事板尚未生成'}</p></div>}
        {(error || generating || listening) && <div className={`scene-notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{error || (generating ? '画师正在落墨…' : listening ? '正在聆听，再次点击麦克风结束' : '')}</div>}
      </div>
      {(Object.keys(generation.errors).length > 0 || generation.saveWarning) && <details className="generation-errors" open>
        <summary>生成尚未完成</summary>
        {Object.entries(generation.errors).map(([key, message]) => <p key={key}>{key === 'topic' ? '议题' : key === 'storyboard' ? '故事板' : generation.plan?.characters.find(c => c.id === key)?.name}：{message}</p>)}
        {generation.saveWarning && <p>{generation.saveWarning}</p>}
      </details>}
      {pendingVisual && !generating && <button className="retry-story" type="button" onClick={() => void generateStory(pendingVisual, ++imageVersion.current)}>重试当前故事板</button>}
    </main>
  );
}

export default function DiscussionPage(){
  const [legacy,setLegacy]=useState<boolean|null>(null);
  useEffect(()=>setLegacy(new URLSearchParams(location.search).get("legacy")==="1"),[]);
  if(legacy===null)return <main aria-busy="true">正在进入议题…</main>;
  return legacy?<LegacyDiscussion/>:<AgentDiscussion/>;
}
