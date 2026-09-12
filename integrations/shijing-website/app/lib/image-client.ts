export class AlphaError extends Error {}
export async function postJSON<T>(path: string, data: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data), signal });
  const result = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(result.error || '生成请求失败，请重试。');
  return result as T;
}
export function loadImage(url:string) { return new Promise<HTMLImageElement>((resolve,reject) => { const image = new Image(); image.onload=()=>resolve(image); image.onerror=()=>reject(new Error('生成图片无法读取。')); image.src=url; }); }
export async function prepareImage(url:string, kind:'character'|'storyboard', mode='native') {
  const source = await loadImage(url); const canvas = document.createElement('canvas');
  if (kind==='storyboard') {
    // Crop only the tiny API size rounding difference, never stretch the scene.
    const factor = Math.floor(Math.min(source.naturalWidth/452,source.naturalHeight/801));
    if (factor < 1) throw new Error('故事板分辨率不足。');
    canvas.width=452*factor; canvas.height=801*factor;
    if (1-(canvas.width*canvas.height)/(source.naturalWidth*source.naturalHeight) > .04) throw new Error('故事板比例偏差过大，请重新生成。');
  } else { canvas.width=source.naturalWidth; canvas.height=source.naturalHeight; }
  const ctx=canvas.getContext('2d',{willReadFrequently:true})!;
  ctx.drawImage(source,(canvas.width-source.naturalWidth)/2,(canvas.height-source.naturalHeight)/2);
  if (kind==='character') {
    if (canvas.width<512 || canvas.height<512) throw new Error('人物图片分辨率不足。');
    const pixels=ctx.getImageData(0,0,canvas.width,canvas.height), p=pixels.data;
    if(mode==='chroma') {
      // Only the intentionally generated uniform magenta backdrop is keyed.
      let border=0,magenta=0;
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(x<8||x>=canvas.width-8||y<8){const i=(y*canvas.width+x)*4;border++;if(p[i]>200&&p[i+1]<55&&p[i+2]>200)magenta++;}
      if(magenta/border<.94)throw new Error('幕布不均匀，无法可靠转换透明背景。');
      for(let i=0;i<p.length;i+=4){const strength=Math.min(p[i],p[i+2])-p[i+1];if(strength>80&&p[i]>140&&p[i+2]>140){const alpha=Math.max(0,Math.min(1,(150-strength)/70));p[i+3]=Math.round(p[i+3]*alpha);if(alpha>0){const neutral=(p[i]+p[i+1]+p[i+2])/3;p[i]=Math.min(p[i],neutral+20);p[i+2]=Math.min(p[i+2],neutral+20);}}}
    }
    let transparent=0,opaque=0,borderClear=0,borderTotal=0,bottomOpaque=0;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const a=p[(y*canvas.width+x)*4+3];if(a<=8)transparent++;if(a>=240)opaque++;if(x<4||x>=canvas.width-4||y<4){borderTotal++;if(a<=8)borderClear++;}if(y===canvas.height-1&&a>=240)bottomOpaque++;}
    if(transparent/(canvas.width*canvas.height)<.12 || borderClear/borderTotal<.97)throw new AlphaError('人物背景尚未达到透明要求。');
    if(opaque/(canvas.width*canvas.height)<.12)throw new Error('人物主体不完整，请重试。');
    if(bottomOpaque/canvas.width<.28)throw new Error('人物下缘未贴底平直裁切，请重试此人物。');
    ctx.putImageData(pixels,0,0);
  }
  const image=canvas.toDataURL('image/png');
  const previews = kind==='character' ? ['#000000','#ffffff'].map(color => {const preview=document.createElement('canvas');preview.width=768;preview.height=Math.round(canvas.height/canvas.width*768);const c=preview.getContext('2d')!;c.fillStyle=color;c.fillRect(0,0,preview.width,preview.height);c.drawImage(canvas,0,0,preview.width,preview.height);return preview.toDataURL('image/jpeg',.9);}) : [image];
  return {image,previews,width:canvas.width,height:canvas.height};
}
