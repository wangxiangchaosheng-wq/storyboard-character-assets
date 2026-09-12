export type Character = { id: string; name: string; role: string; card: string; avatar: string; hero: string };
export type Storyboard = { image: string; sceneKey: string; title: string; location: string; caption: string };
export type SceneAssets = { characters: Character[]; storyboard: Storyboard };
export type AssetPatch = { characters?: (Partial<Character> & { id: string; image?: string })[]; storyboard?: Partial<Storyboard> };
export const defaultAssets: SceneAssets = {
  characters: [
    { id: 'zhuge', name: '诸葛亮', role: '蜀汉丞相', card: '/art/zhuge-card.webp', avatar: '/art/zhuge-avatar.webp', hero: '/art/zhuge-card.webp' },
    { id: 'weiyan', name: '魏延', role: '蜀汉前军将军', card: '/art/weiyan-card.webp', avatar: '/art/weiyan-avatar.webp', hero: '/art/weiyan-hero.webp' },
    { id: 'yangyi', name: '杨仪', role: '蜀汉尚书令', card: '/art/yangyi-card.webp', avatar: '/art/yangyi-avatar.webp', hero: '/art/yangyi-card.webp' },
    { id: 'jiangwei', name: '姜维', role: '蜀汉中军将领', card: '/art/jiangwei-card.webp', avatar: '/art/jiangwei-avatar.webp', hero: '/art/jiangwei-card.webp' },
    { id: 'feiyi', name: '费祎', role: '蜀汉中护军', card: '/art/feiyi-card.webp', avatar: '/art/feiyi-avatar.webp', hero: '/art/feiyi-card.webp' },
  ],
  storyboard: { image: '/art/story-ziwu.webp', sceneKey: 'ziwu-valley-ambush-route', title: '子午奇谋 · 十日可临长安', location: '子午谷', caption: '' },
};

export function mergeAssets(current: SceneAssets, patch: AssetPatch): SceneAssets {
  return {
    characters: current.characters.map(character => {
      const update = patch.characters?.find(item => item.id === character.id);
      if (!update) return character;
      const { image, ...fields } = update;
      return { ...character, ...(image ? { card: image, avatar: image, hero: image } : {}), ...fields };
    }),
    storyboard: { ...current.storyboard, ...patch.storyboard },
  };
}

export async function validatePatch(patch: AssetPatch) {
  if (!patch || typeof patch !== 'object') throw new Error('素材配置格式不正确');
  if (patch.characters && !Array.isArray(patch.characters)) throw new Error('人物配置需要是列表');
  const urls = new Set<string>();
  for (const character of patch.characters ?? []) {
    if (!character || typeof character.id !== 'string' || !defaultAssets.characters.some(c => c.id === character.id)) throw new Error('人物槽位不存在');
    for (const key of ['image', 'card', 'avatar', 'hero'] as const) {
      if (character[key] !== undefined) urls.add(character[key]!);
    }
    for (const key of ['name', 'role'] as const) if (character[key] !== undefined && (typeof character[key] !== 'string' || !character[key]!.trim())) throw new Error('人物名称和身份不能为空');
  }
  if (patch.storyboard) {
    for (const value of Object.values(patch.storyboard)) if (typeof value !== 'string') throw new Error('故事板配置格式不正确');
    if (patch.storyboard.image !== undefined) urls.add(patch.storyboard.image);
  }
  await Promise.all([...urls].map(url => new Promise<void>((resolve, reject) => {
    if (typeof url !== 'string' || !/^(\/(?!\/)|https:\/\/|data:image\/(png|webp|jpeg);base64,|blob:)/.test(url)) { reject(new Error('请提供有效的图片路径')); return; }
    const img = new Image(); const timeout = window.setTimeout(() => reject(new Error('图片加载超时，已保留原图')), 15000);
    img.onload = () => { clearTimeout(timeout); resolve(); };
    img.onerror = () => { clearTimeout(timeout); reject(new Error('图片无法加载，已保留原图')); };
    img.src = url;
  })));
}
