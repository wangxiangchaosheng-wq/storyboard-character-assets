import { createElement, type ReactNode } from 'react';
import design from '../lib/original-design.json';
import { defaultAssets, type SceneAssets } from '../lib/scene-assets';

type SvgNode = { tag: string; attrs: Record<string, unknown>; children: SvgNode[] };
const root = design as SvgNode;
const cardY = [131, 270.5, 410, 549.5, 689];
const cardPaths = [[58,73], [59,69], [60,70], [61,71], [62,72]];
const messageLayers = new Set([29,31,34,36,38,47,48,49,50,51,52,53,54,55,56,57,63,64,65,66,68,74,75,76,78]);
const slots: Record<number, [number, 'card' | 'avatar' | 'hero']> = {
  28:[0,'card'],29:[0,'avatar'],30:[1,'card'],31:[1,'avatar'],32:[1,'hero'],33:[2,'card'],34:[2,'avatar'],35:[3,'card'],36:[3,'avatar'],37:[4,'card'],38:[4,'avatar'],
};
function draw(node: SvgNode, key: string | number): ReactNode {
  return createElement(node.tag, { ...node.attrs, key }, ...node.children.map((child,i) => draw(child,`${key}-${i}`)));
}
function imageInRect(node: SvgNode, href: string, key: number) {
  const { fill: _fill, ...attrs } = node.attrs;
  if (!href) return null;
  return <image {...attrs} href={href} preserveAspectRatio="xMidYMax meet" key={key} />;
}

export default function OriginalScene({ assets, activeId, pristine, editingInput }: { assets: SceneAssets; activeId: string; pristine: boolean; editingInput: boolean }) {
  const activeIndex = assets.characters.findIndex(c => c.id === activeId);
  const active = assets.characters[activeIndex];
  const changedStory = assets.storyboard.image !== defaultAssets.storyboard.image;
  return <svg {...root.attrs} className="original-scene" aria-hidden="true">
    {root.children.map((node,index) => {
      if (!pristine && messageLayers.has(index)) return null;
      if (index === 77 && editingInput) return null;
      if (index === 67) {
        return <text key={index} x="810" y="152" fontSize="35" fontFamily="Songti SC, STSong, serif" fill="#171b13">{active.name}</text>;
      }
      if (index === 45) {
        return <g key={index}>{draw(node,index)}<rect x="806" y="168" width="138" height="21" fill="#29281e" /><text x="875" y="184" textAnchor="middle" fontSize="16" fill="#e4d2ab">{active.role}</text></g>;
      }
      for (let c=0;c<5;c++) {
        const [nameIndex,roleIndex] = cardPaths[c];
        if (index===nameIndex) return <foreignObject key={index} x="391" y={cardY[c]+10} width="76" height="118">
          <div style={{height:'100%',display:'flex',flexDirection:'column',justifyContent:'safe center',gap:8,overflowY:'auto',overflowX:'hidden',color:'#171b13',fontFamily:'Songti SC, STSong, serif',whiteSpace:'normal',overflowWrap:'anywhere',wordBreak:'normal',boxSizing:'border-box'}}>
            <div style={{fontSize:24,lineHeight:1.22,flexShrink:0}}>{assets.characters[c].name}</div>
            <div style={{fontSize:16,lineHeight:1.3,flexShrink:0}}>{assets.characters[c].role}</div>
          </div>
        </foreignObject>;
        if (index===roleIndex) return null;
      }
      if (index>=2 && index<=13) {
        if(index!==2)return null;
        return <g key="uniform-character-frames">{cardY.map((y,c)=>c===activeIndex
          ? <g key={c} transform={`translate(0 ${y}) scale(1 ${139/141}) translate(0 -270)`}>{[2,3,4,5].map(i=>draw(root.children[i],i))}</g>
          : <g key={c} transform={`translate(0 ${y-131})`}>{[6,7].map(i=>draw(root.children[i],i))}</g>)}</g>;
      }
      const slot=slots[index];
      if(slot) {
        const [c,kind]=slot;
        const character=kind==='hero'?active:assets.characters[c];
        const original=kind==='hero'?defaultAssets.characters[1]:defaultAssets.characters[c];
        if(kind==='card'){const aligned={...node,attrs:{...node.attrs,y:cardY[c]+9,height:124}};return character[kind]!==original[kind]?imageInRect(aligned,character[kind],index):draw(aligned,index);}
        if (character[kind]!==original[kind]) return imageInRect(node,character[kind],index);
      }
      if (index===79 && !assets.storyboard.image) return null;
      if (index===79 && changedStory) {
        // Keep the original mask; blend the uncropped illustration with Darken, matching the design.
        return <g key={index} style={{mixBlendMode:'darken'}}>{draw(node.children[0],'mask')}<g mask="url(#mask0_152_29)"><image href={assets.storyboard.image} x="977" y="70" width="456" height="809" preserveAspectRatio="xMidYMid meet" /></g></g>;
      }
      return draw(node,index);
    })}
  </svg>;
}
