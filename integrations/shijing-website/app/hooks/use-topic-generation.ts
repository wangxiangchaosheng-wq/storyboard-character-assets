'use client';
import { useEffect, useRef, useState } from 'react';
import { type SceneAssets } from '../lib/scene-assets';
import { defaultTopic, parseTopic, slotIds, topicKey, type Topic, type TopicPlan, type Visual } from '../lib/topic';
import { AlphaError, postJSON, prepareImage } from '../lib/image-client';
import { readScene, saveScene, type SavedScene } from '../lib/topic-cache';
export const emptyAssets:SceneAssets={characters:slotIds.map(id=>({id,name:'待选角',role:'',card:'',avatar:'',hero:''})),storyboard:{image:'',sceneKey:'',title:'',caption:'',location:''}};
export default function useTopicGeneration(onAssets:(assets:SceneAssets)=>void,onPlan:(plan:TopicPlan)=>void){
  const [topic,setTopic]=useState<Topic>(defaultTopic),[plan,setPlan]=useState<TopicPlan|null>(null),[busy,setBusy]=useState(true),[status,setStatus]=useState('正在读取议题…'),[errors,setErrors]=useState<Record<string,string>>({}),[done,setDone]=useState(0),[saveWarning,setSaveWarning]=useState('');
  const callbacks=useRef({onAssets,onPlan}); callbacks.current={onAssets,onPlan};
  const [visual,setVisual]=useState<Visual|null>(null);
  const controller=useRef<AbortController|null>(null),version=useRef(0),saved=useRef<SavedScene|null>(null),topicRef=useRef(defaultTopic),running=useRef(false);
  async function generate(currentTopic:Topic){
    if(running.current)return;
    running.current=true;controller.current?.abort();const control=new AbortController();controller.current=control;const run=++version.current;
    const current=()=>run===version.current&&!control.signal.aborted;
    setBusy(true);setErrors({});setStatus('正在研究议题与选择五位人物…');
    const key=topicKey(currentTopic);
    try{
      let record=saved.current || await readScene(key);
      if(!current())return;
      if(!record){
        const nextPlan=await postJSON<TopicPlan>('/api/topic',{topic:currentTopic},control.signal);
        record={plan:nextPlan,mode:'chroma',assets:{characters:nextPlan.characters.map(c=>({id:c.id,name:c.name,role:c.role,card:'',avatar:'',hero:''})),storyboard:{...emptyAssets.storyboard}}};
      }
      const working=record;saved.current=working;
      setPlan(working.plan);setVisual(working.storyVisual||working.plan.visual);callbacks.current.onPlan(working.plan);
      const publish=async()=>{
        if(!current())return;
        callbacks.current.onAssets(structuredClone(working.assets));
        setDone(working.assets.characters.filter(c=>c.card).length+(working.assets.storyboard.image?1:0));
        try{await saveScene(key,structuredClone(working));}catch{if(current())setSaveWarning('当前浏览器无法保存图片，离开页面后可能需要重新生成。');}
      };
      await publish();
      const story=async()=>{
        if(working.assets.storyboard.image)return;
        try{
          const visual=working.storyVisual||working.plan.visual;
          const result=await postJSON<{image:string}>('/api/storyboard',{visual},control.signal);
          const image=await prepareImage(result.image,'storyboard');
          await postJSON('/api/validate-image',{kind:'storyboard',images:image.previews,context:visual},control.signal);
          if(!current())return;
          working.assets.storyboard={image:image.image,sceneKey:visual.scene_key,location:visual.location,title:visual.title,caption:visual.summary};
          await publish();
        }catch(e){if(current())setErrors(old=>({...old,storyboard:e instanceof Error?e.message:'故事板生成失败。'}));}
      };
      const cast=async()=>{
        for(let i=0;i<working.plan.characters.length;i++){
          if(!current())return;
          if(working.assets.characters[i].card)continue;
          const character=working.plan.characters[i];setStatus(`正在绘制与检查 ${character.name}…`);
          try{
            const create=async(mode:string)=>{const result=await postJSON<{image:string;mode?:string}>('/api/characters',{topic:currentTopic,character,mode},control.signal);return prepareImage(result.image,'character',result.mode||mode);};
            let image;
            try{image=await create(working.mode);}catch(e){if(e instanceof AlphaError&&i===0&&working.mode==='native'){working.mode='chroma';image=await create('chroma');}else throw e;}
            await postJSON('/api/validate-image',{kind:'character',images:image.previews,context:{topic:currentTopic,character}},control.signal);
            if(!current())return;
            working.assets.characters[i]={...working.assets.characters[i],card:image.image,avatar:image.image,hero:image.image};await publish();
          }catch(e){if(current())setErrors(old=>({...old,[character.id]:e instanceof Error?e.message:'人物生成失败。'}));if(i===0)return;}
        }
      };
      await Promise.allSettled([story(),cast()]);
      if(current())setStatus('生成结束');
    }catch(e){if(current()){setErrors({topic:e instanceof Error?e.message:'议题准备失败。'});setStatus('尚未完成生成');}}
    finally{if(current()){setBusy(false);running.current=false;}}
  }
  useEffect(()=>{
    let currentTopic=defaultTopic;
    try{const query=new URLSearchParams(window.location.search).get('topic');if(query)currentTopic=parseTopic(JSON.parse(query));}catch{setErrors({topic:'议题链接无法读取，请返回地图重新进入。'});setBusy(false);return;}
    topicRef.current=currentTopic;setTopic(currentTopic);
    const timer=setTimeout(()=>{void generate(currentTopic);},0);
    return()=>{clearTimeout(timer);++version.current;controller.current?.abort();running.current=false;};
    // Initialization is deliberately tied to page navigation, not callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  async function commitStory(assets:SceneAssets,visual:TopicPlan['visual']){if(!saved.current)return;saved.current={...saved.current,assets,storyVisual:visual};setDone(assets.characters.filter(c=>c.card).length+(assets.storyboard.image?1:0));setVisual(visual);setErrors(old=>Object.fromEntries(Object.entries(old).filter(([key])=>key!=='storyboard')));try{await saveScene(topicKey(topicRef.current),saved.current);}catch{setSaveWarning('图片仅保留在当前页面，浏览器保存失败。');}}
  return {topic,plan,visual,busy,status,errors,done,saveWarning,retry:()=>void generate(topicRef.current),commitStory};
}
