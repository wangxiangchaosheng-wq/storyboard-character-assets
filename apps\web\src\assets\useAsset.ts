/**
 * 素材运行时实现（docs/12 · 真源在 shared/contracts/src/assets.ts）：
 *  1. 启动时静态 import manifest 清单（视觉同学只改 assets/manifest.json + 放文件）；
 *  2. 图片资源用 <img> 探测真实可用性 —— 文件未交付 → 确定性占位 SVG；
 *  3. 组件一律只调 useAsset(key)，禁止硬编码路径。
 */
import { useEffect, useState } from 'react';
import type { AssetCategory, AssetManifest, AssetResolution } from '@sim/contracts';
import manifestJson from '../../assets/manifest.json';
import { placeholderDataUri } from './placeholder.ts';

const MANIFEST = manifestJson as unknown as AssetManifest;

interface Resolved extends AssetResolution {
  alt: string;
  w: number;
  h: number;
}

const missing = (key: string): Resolved => ({
  url: placeholderDataUri(`未登记:${key}`),
  isPlaceholder: true,
  alt: key,
  w: 1,
  h: 1,
});

/** 同步解析：加载 manifest 条目 → 素材 URL（不校验文件存在性，交给 useAsset 的探测） */
export function getAsset(key: string, kind: 'image' | 'audio' = 'image'): Resolved {
  const entry = MANIFEST.entries.find((e) => e.key === key);
  if (!entry) return missing(key);
  const url = `${import.meta.env.BASE_URL}assets/${entry.file}`;
  return {
    url,
    isPlaceholder: false,
    alt: entry.alt,
    w: entry.w ?? 320,
    h: entry.h ?? 240,
  };
}

/** 探测图片是否真实存在（美术未交付 → onerror → 占位回退） */
function probeImage(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

/** 资源 key → 可用 URL；key 缺失或文件未交付 → 占位 SVG（带 key/alt 水印文本） */
export function useAsset(key: string, opts?: { kind?: 'image' | 'audio' }): AssetResolution {
  const kind = opts?.kind ?? 'image';
  const base = getAsset(key, kind);
  const [broken, setBroken] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    if (kind !== 'image' || base.isPlaceholder) {
      setBroken(true);
      return;
    }
    probeImage(base.url).then((ok) => {
      if (alive) setBroken(!ok);
    });
    return () => {
      alive = false;
    };
  }, [key, base.url, kind]);

  if (!base.isPlaceholder && broken === false) {
    return { url: base.url, isPlaceholder: false };
  }
  return { url: placeholderDataUri(base.alt ?? key), isPlaceholder: true };
}

export type { AssetCategory };