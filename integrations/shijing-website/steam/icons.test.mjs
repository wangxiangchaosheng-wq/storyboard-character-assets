import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {ACHIEVEMENTS} from './achievements.ts';

/**
 * 成就图标守界测试。图标的单一事实来源是 steam/make-achievement-icons.mjs
 * （图形语义表 + 档位画框），本文件只验「产物仍然满足 Steam 规范与档位约定」：
 * 存在、正方形、真透明、灰度版够灰、json 指向真实文件、同档外框一致。
 * 故意不测「图形长什么样」——那由 generate 时的自检和人工评审负责。
 */
const HERE=fileURLToPath(new URL('.',import.meta.url));
const ICONS_DIR=join(HERE,'icons');
const JSON_PATH=join(HERE,'achievements.json');
/** 生成脚本写入的边长：Steam 官方建议的 64×64（Steam 会自行缩放到显示尺寸） */
const SIZE=64;
/** 外框采样点（64px 画布）：四条边的中点，落在铭牌外框色带上，不碰图形 */
const FRAME_POINTS=[[32,4],[4,32],[32,59],[59,32]];

/** 按字节读回像素：四通道，alpha 是第 4 个字节——不猜文件头 */
async function raw(file){
  const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  return {data,w:info.width,h:info.height};
}
function px(img,x,y){
  const o=(y*img.w+x)*4;
  return {r:img.data[o],g:img.data[o+1],b:img.data[o+2],a:img.data[o+3]};
}
const sha=buf=>createHash('sha256').update(buf).digest('hex');
/** 只统计完全不透明的像素：半透明边缘的颜色会受抗锯齿 fringe 污染 */
function meanSaturation(img){
  let sum=0,n=0;
  for(let i=0;i<img.w*img.h;i++){
    const o=i*4;
    if(img.data[o+3]!==255)continue;
    const r=img.data[o],g=img.data[o+1],b=img.data[o+2];
    sum+=Math.max(r,g,b)-Math.min(r,g,b);
    n++;
  }
  return n?sum/n:0;
}

test('icons: every achievement ships a color and a gray PNG, and nothing stale',()=>{
  for(const a of ACHIEVEMENTS){
    assert.ok(existsSync(join(ICONS_DIR,`${a.id}.png`)),`缺少 ${a.id}.png（跑 node steam/make-achievement-icons.mjs）`);
    assert.ok(existsSync(join(ICONS_DIR,`${a.id}-gray.png`)),`缺少 ${a.id}-gray.png`);
  }
  const expected=new Set(ACHIEVEMENTS.flatMap(a=>[`${a.id}.png`,`${a.id}-gray.png`]));
  const actual=readdirSync(ICONS_DIR).filter(f=>f.endsWith('.png'));
  assert.deepEqual([...actual].sort(),[...expected].sort(),'icons/ 里的 PNG 必须正好是 24 条成就的两个版本，不多不少');
});

test('icons: square 64x64 PNGs with a real alpha channel and transparent pixels',async()=>{
  for(const a of ACHIEVEMENTS){
    for(const suffix of['','-gray']){
      const file=join(ICONS_DIR,`${a.id}${suffix}.png`);
      const meta=await sharp(file).metadata();
      assert.equal(meta.format,'png',`${file} 不是 PNG`);
      assert.ok(meta.width===meta.height,`${file} 不是正方形：${meta.width}×${meta.height}`);
      assert.equal(meta.width,SIZE,`${file} 应为 ${SIZE}×${SIZE}（Steam 建议尺寸），实际 ${meta.width}×${meta.height}`);
      const img=await raw(file);
      // Steam 规范：透明背景——四角必须全透明（圆角铭牌之外）
      for(const [x,y] of[[0,0],[SIZE-1,0],[0,SIZE-1],[SIZE-1,SIZE-1]]){
        assert.equal(px(img,x,y).a,0,`${file} 的角 (${x},${y}) 不透明，违反 Steam 透明背景规范`);
      }
      let transparent=0,opaque=0;
      for(let i=0;i<img.w*img.h;i++){
        const al=img.data[i*4+3];
        if(al===0)transparent++;
        else if(al===255)opaque++;
      }
      assert.ok(transparent>=100,`${file} 透明像素过少（${transparent}），疑似整幅不透明`);
      assert.ok(opaque>=2000,`${file} 实心像素过少（${opaque}），图形疑似没渲染出来`);
    }
  }
});

test('icons: gray versions are truly grayscale while color versions are not',async()=>{
  for(const a of ACHIEVEMENTS){
    const grayImg=await raw(join(ICONS_DIR,`${a.id}-gray.png`));
    for(let i=0;i<grayImg.w*grayImg.h;i++){
      const o=i*4;
      assert.equal(grayImg.data[o],grayImg.data[o+1],`${a.id}-gray.png 第 ${i} 像素 R≠G`);
      assert.equal(grayImg.data[o+1],grayImg.data[o+2],`${a.id}-gray.png 第 ${i} 像素 G≠B`);
    }
    // 灰度版饱和度必须为 0，彩色版必须显著高于 0（银档天生低饱和，实测最低约 11，阈值取 5 留足余量）
    assert.equal(meanSaturation(grayImg),0,`${a.id}-gray.png 饱和度不为 0`);
    const colorImg=await raw(join(ICONS_DIR,`${a.id}.png`));
    assert.ok(meanSaturation(colorImg)>5,`${a.id}.png 饱和度仅 ${meanSaturation(colorImg).toFixed(1)}，不像是彩色版`);
  }
});

test('icons: color and gray versions are different files',()=>{
  for(const a of ACHIEVEMENTS){
    const color=readFileSync(join(ICONS_DIR,`${a.id}.png`));
    const gray=readFileSync(join(ICONS_DIR,`${a.id}-gray.png`));
    assert.notEqual(sha(color),sha(gray),`${a.id} 的彩色版与灰度版是同一个文件`);
  }
});

test('achievements.json points every icon at a real file',()=>{
  const json=JSON.parse(readFileSync(JSON_PATH,'utf8'));
  const byId=new Map(ACHIEVEMENTS.map(a=>[a.id,a]));
  const jsonIds=json.map(x=>x.name).sort();
  assert.deepEqual(jsonIds,ACHIEVEMENTS.map(a=>a.id).sort(),'json 与成就代码的 id 集合必须一致');
  for(const entry of json){
    assert.ok(entry.icon&&entry.icon.length>0,`${entry.name} 的 icon 为空`);
    assert.ok(entry.icongray&&entry.icongray.length>0,`${entry.name} 的 icongray 为空`);
    // 与生成脚本的命名约定一致：icons/<id>.png 与 icons/<id>-gray.png
    assert.equal(entry.icon,`icons/${entry.name}.png`,`${entry.name} 的 icon 路径不符约定：${entry.icon}`);
    assert.equal(entry.icongray,`icons/${entry.name}-gray.png`,`${entry.name} 的 icongray 路径不符约定：${entry.icongray}`);
    assert.ok(existsSync(join(HERE,entry.icon)),`${entry.icon} 指向不存在的文件`);
    assert.ok(existsSync(join(HERE,entry.icongray)),`${entry.icongray} 指向不存在的文件`);
    assert.ok(byId.has(entry.name),`json 里的 ${entry.name} 不在成就清单里`);
  }
});

test('icons: tier frames are pixel-identical within a tier and distinct across tiers',async()=>{
  const byTier=new Map();
  for(const a of ACHIEVEMENTS){
    const img=await raw(join(ICONS_DIR,`${a.id}.png`));
    const signature=FRAME_POINTS.map(([x,y])=>{
      const {r,g,b,a:al}=px(img,x,y);
      assert.equal(al,255,`${a.id} 的外框采样点 (${x},${y}) 不是实心像素，采样点设计失效`);
      return `${r},${g},${b}`;
    }).join('|');
    if(!byTier.has(a.tier))byTier.set(a.tier,new Map());
    const group=byTier.get(a.tier);
    const holder=group.get(signature)??a.id;
    group.set(signature,holder);
  }
  for(const [tier,group] of byTier){
    assert.equal(group.size,1,`${tier} 档图标的外框色不一致：${[...group.keys()].join(' ; ')}`);
  }
  // 三档之间必须能分辨：金 ≠ 银 ≠ 铜（至少一个采样点的颜色不同）
  const sigOf=tier=>[...byTier.get(tier).keys()][0];
  assert.notEqual(sigOf('gold'),sigOf('silver'),'金档与银档外框色相同，玩家无法一眼辨档');
  assert.notEqual(sigOf('silver'),sigOf('bronze'),'银档与铜档外框色相同');
  assert.notEqual(sigOf('gold'),sigOf('bronze'),'金档与铜档外框色相同');
});
