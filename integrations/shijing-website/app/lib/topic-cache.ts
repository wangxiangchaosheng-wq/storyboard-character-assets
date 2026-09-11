import type { SceneAssets } from './scene-assets';
import type { TopicPlan } from './topic';
export type SavedScene={plan:TopicPlan;assets:SceneAssets;mode:'native'|'chroma';storyVisual?:TopicPlan['visual']};
const memory=new Map<string,SavedScene>();
function database(){return new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('shijing-topic-art',1);request.onupgradeneeded=()=>request.result.createObjectStore('scenes');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
export async function readScene(key:string):Promise<SavedScene|undefined>{
  if(memory.has(key))return structuredClone(memory.get(key));
  try{const db=await database();return await new Promise((resolve,reject)=>{const tx=db.transaction('scenes');const request=tx.objectStore('scenes').get('v1:'+key);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);tx.oncomplete=()=>db.close();});}catch{return undefined;}
}
export async function saveScene(key:string,value:SavedScene){
  memory.set(key,structuredClone(value));
  const db=await database();
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('scenes','readwrite');tx.objectStore('scenes').put(value,'v1:'+key);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};tx.onabort=()=>{db.close();reject(tx.error);};});
}
