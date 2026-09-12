// Existing illustration of the Ziwu proposal, never a generic Northern Expedition result.
export function localOpeningStory(title:string,background:string){
 const text=title+' '+background;
 if(!/子午谷|子午奇谋/.test(text))return;
 if(/大学|学子|学生|穿越|失败|撤军|败退|已经|攻克|已占领|草船|赤壁|不要|不画|而非|改为|切换/.test(text))return;
 return {image:'/art/story-ziwu.webp',sceneKey:'ziwu-valley-proposal',title:'子午谷方案示意',caption:'魏延提议奇出子午谷，直趋长安；此图表现方案设想。',location:'子午谷'};
}
