import {readFileSync} from 'node:fs';
import {Store} from './store.js';
import {AgentError} from './contracts.js';
import {prepare,type ArtProvider} from './provider.js';
import {StoryLibrary} from './story-library.js';
import {AssetLibrary} from './asset-library.js';
export class Worker {
  active=false;stopping=false;store:Store;provider:ArtProvider;library?:AssetLibrary;stories?:StoryLibrary;
  constructor(store:Store,provider:ArtProvider,library?:AssetLibrary,stories?:StoryLibrary){this.store=store;this.provider=provider;this.library=library;this.stories=stories;}
  private requestedRuns=new Set<string>();
  private allRuns=false;
  async drain(runId?:string){
    if(runId)this.requestedRuns.add(runId);else this.allRuns=true;
    if(this.active||this.stopping)return;this.active=true;
    try{while(!this.stopping){
      // Library hits are resolved before calibration or any paid request, including later cast slots.
      if(this.library){for(const pending of this.store.jobs().filter(j=>j.kind==='portrait'&&['queued','failed','interrupted'].includes(j.status))){
        const persona=this.store.run(pending.runId).spec.cast.find(p=>p.id===pending.subjectId);if(!persona)continue;
        try{const found=await this.library.find(persona);if(found){this.store.saveAsset(pending,found.png);pending.assetSource=found.entry.source==='provided'?'provided':'library';pending.error=undefined;pending.resumeDraft=false;this.store.step(pending,'succeeded','直接复用人物素材库：'+found.entry.name);}}
        catch(e){pending.error=(e as Error).message;this.store.step(pending,'failed',pending.error);}
      }}
      if(this.stories){for(const pending of this.store.jobs().filter(j=>j.kind==='storyboard'&&!j.majorCandidate&&['queued','failed','interrupted'].includes(j.status))){
        try{const found=await this.stories.find(pending);if(found){this.store.saveAsset(pending,found.png);pending.assetSource='library';pending.plan={prompt:'本地资产复用',summary:found.title,night:false,evidence:[found.detail]};pending.error=undefined;pending.resumeDraft=false;this.store.step(pending,'succeeded',found.detail);}}
        catch(e){pending.error=(e as Error).message;this.store.step(pending,'failed',pending.error);}
      }}
      if(process.env.AGENT_ALLOW_API_GENERATION==='false')break;
      const jobs=this.store.jobs().filter(j=>this.allRuns||this.requestedRuns.has(j.runId));
      const job=jobs.find(j=>{
        if(j.status!=='queued')return false;if(j.kind!=='portrait')return true;
        const first=jobs.find(p=>p.runId===j.runId&&p.kind==='portrait'&&p.assetSource!=='provided'&&p.assetSource!=='library');
        return first?.id===j.id||first?.status==='succeeded';
      });
      if(!job)break;
      if(job.kind==='portrait'){
        const calibrated=this.store.jobs(job.runId).find(j=>j.kind==='portrait'&&j.status==='succeeded'&&j.assetSource!=='provided'&&j.assetSource!=='library');
        job.transparency=calibrated?.transparency||job.transparency||(job.feedback.includes('[ALPHA]')?'chroma':this.provider.transparencyMode||'native');
      }
      for(let attempt=0;attempt<3;attempt++){
        let draftAvailable=false;
        try{
          job.priorDesigns=this.store.jobs(job.runId).filter(j=>j.id!==job.id&&j.status==='succeeded'&&j.plan?.portraitDesign).map(j=>j.plan!.portraitDesign!);
          job.attempts++;
          let draft:Buffer;let qa:string;
          if(job.resumeDraft&&job.draftAttempt!==undefined&&job.plan){
            qa=this.store.draftDirectory(job);draft=readFileSync(this.store.draftPath(job));draftAvailable=true;
          }else{
            this.store.step(job,'planning','依据原 Skill 及参考文件准备画面');
            if(job.majorCandidate){job.majorEvent=this.provider.classifyMajor?await this.provider.classifyMajor(job):false;job.majorCandidate=false;this.store.saveJob(job);}
            job.plan=await this.provider.plan(job);this.store.saveJob(job);
            if(this.stopping){this.store.step(job,'interrupted','服务正在停止，尚未发起绘图');break;}
            this.store.step(job,'generating','调用 gpt-image-2 绘图');
            const references=job.kind==='storyboard'?this.store.jobs(job.runId).filter(j=>j.kind==='portrait'&&j.status==='succeeded'&&j.asset).slice(-5).map(j=>readFileSync(this.store.asset(j.asset!))):[];
            draft=await this.provider.generate(job,references);
            qa=this.store.saveDraft(job,draft);draftAvailable=true;this.store.saveJob(job);
          }
          this.store.step(job,'checking','按原 Skill 检查构图、透明文件、画面与文字');
          if(this.stopping){job.resumeDraft=true;this.store.step(job,'interrupted','草稿已保存，重试将继续检查');break;}
          if(this.provider.preflight){const preflight=await this.provider.preflight(job,draft);if(!preflight.pass)throw new AgentError(preflight.reason,422);}
          const png=await(this.provider.prepare?this.provider.prepare(job,draft,qa):prepare(draft,job.kind,job.majorEvent));
          const review=await this.provider.review(job,png);if(!review.pass)throw new AgentError(review.reason,422);
          this.store.saveAsset(job,png);job.assetSource='generated';job.error=undefined;job.resumeDraft=false;if(job.kind==='portrait'&&this.library){const persona=this.store.run(job.runId).spec.cast.find(p=>p.id===job.subjectId);if(persona)this.library.remember(persona,png,job);}
          if(job.kind==='storyboard'&&this.stories){try{this.stories.remember(job,png);}catch{job.trace.push({at:new Date().toISOString(),step:'cache-warning',detail:'图片已保存，本次未写入复用库'});}}
          this.store.step(job,'succeeded','图片通过原 Skill 检查并已保存');break;
        }catch(e){
          const error=e instanceof Error?e.message:'任务失败';job.feedback=error;job.error=error;
          const quality=e instanceof AgentError&&e.status===422;
          job.resumeDraft=draftAvailable&&!quality;
          if(job.kind==='portrait'&&error.includes('[ALPHA]'))job.transparency='chroma';
          if(quality&&attempt<2&&!this.stopping){this.store.step(job,'planning',`定向修正：${error}`);continue;}
          this.store.step(job,'failed',error);break;
        }
      }
    }}finally{this.active=false;}
  }
}
