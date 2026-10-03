#!/usr/bin/env node
/**
 * 生成 24 条 Steam 成就的图标（彩色 icon.png + 灰度 icongray.png），并回填
 * achievements.json 的 icon / icongray 字段。
 *
 * 为什么要有这个脚本：achievements.json 是 Steamworks 后台要求的官方格式，
 * 其中 icon / icongray 不能为空，而 24 条成就逐个手绘导出 PNG 不可维护——
 * 于是图标收敛为本文件里的「图形语义表 + 共享画框」，改一条图形只动一处，
 * 换一档配色只动一处，重新生成一条命令搞定。
 *
 * 设计约束（Steam 成就图标规范 + 本项目视觉语言）：
 *   - PNG、正方形、64×64（Steam 官方建议尺寸，Steam 会自行缩放到显示尺寸）；
 *     渲染时先用超大画布超采样再降采样，保证缩到 64px 后边缘不发毛。
 *   - 透明背景：画布四角落在圆角铭牌之外，必须是全透明像素。
 *   - 灰度版 = 同一图形的去饱和版本（sharp greyscale，BT.601 亮度），不做第二套稿。
 *   - 风格统一「青铜 / 鎏金 / 水墨」：圆角金属铭牌 + 铆钉 + 淡墨底纹 + 水墨图形，
 *     与 public/favicon.svg、electron/build/icon.ico 的品牌色同源。
 *   - 金 / 银 / 铜三档靠外框底色区分：金=鎏金、银=银灰、铜=青铜，
 *     玩家扫一眼就知道成就价值；图形本身也按档位取同一套金属色系。
 *
 * 单一事实来源：成就列表只从 steam/achievements.mjs（achievements.ts 的预编译产物，
 * 由 steam/build.mjs 生成）读取；json 的 icon 路径由本脚本回填，不手改。
 *
 * 用法：node steam/make-achievement-icons.mjs（幂等：同样的输入 Byte 级一致的输出，
 * 可反复覆盖；顺手清掉 icons/ 里已删成就的残留 PNG）
 * 测试：node --test steam/icons.test.mjs
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ICONS_DIR = join(HERE, 'icons');
const JSON_PATH = join(HERE, 'achievements.json');
const TS_PATH = join(HERE, 'achievements.ts');
const MJS_PATH = join(HERE, 'achievements.mjs');
const BUILD_MJS = join(HERE, 'build.mjs');

/** Steam 官方建议的成就图标尺寸（也是 Steam 覆盖层里成就列表的显示尺寸） */
const ICON_PX = 64;
/** SVG 渲染密度：256 画布 × 384/72 ≈ 1365px 超采样，再 Lanczos 降采样到 64px */
const RENDER_DENSITY = 384;

/* ---- 调色板：青铜 / 鎏金 / 水墨 / 朱砂 ---- */
const INK = '#2B241D';        // 水墨：图形主色（深褐墨）
const PAPER = '#F1E7D0';      // 宣纸：图形受光面
const VERMILION = '#B23B2E';  // 朱砂：印章、绢带、焰心等点睛色
const AMBER = '#E9A94D';      // 琥珀：火焰内焰等高亮
/** 档位金属色：外框底色的唯一来源，同档所有图标共用，保证「一眼辨档」 */
const TIER = {
  gold: { key: 'gold', light: '#F0D678', base: '#D9B44A', dark: '#9A7A24', deep: '#6E5614' }, // 鎏金
  silver: { key: 'silver', light: '#E8EBEF', base: '#C6CBD3', dark: '#8B919B', deep: '#5F656E' }, // 银灰
  bronze: { key: 'bronze', light: '#DFA968', base: '#B57C36', dark: '#7C5422', deep: '#553A15' }, // 青铜
};

/** 每条成就的图形类别：决定背后的淡墨底纹，也让 24 个图形成组可读 */
const CATEGORY = {
  first_run_complete: 'first', first_year_jump: 'first', first_edict: 'first',
  capture_first_city: 'military', cut_enemy_supply: 'military', outnumbered_victory: 'military',
  bloodless_capture: 'military', annihilate_army: 'military',
  treasury_10k: 'economy', province_surplus: 'economy', tuntian_effective: 'economy',
  all_factions_loyal: 'politics', no_one_angry: 'politics', eunuch_dominance: 'politics',
  alliance_formed: 'diplomacy', treaty_breached: 'diplomacy', hegemony_100: 'diplomacy',
  campaign_victory: 'military',
  fire_attack: 'stratagem', empty_fort: 'stratagem', sow_discord: 'stratagem',
  harem_year: 'leisure', historian_100: 'leisure',
  thirty_years: 'endurance', veteran_five_runs: 'endurance',
};

/* ---- 读成就：优先 achievements.mjs；旧了先重编译，再不行退回 Node 原生类型剥离读 .ts ---- */
async function loadAchievements() {
  const tsMtime = existsSync(TS_PATH) ? statSync(TS_PATH).mtimeMs : 0;
  const mjsMtime = existsSync(MJS_PATH) ? statSync(MJS_PATH).mtimeMs : 0;
  if (existsSync(MJS_PATH) && mjsMtime >= tsMtime) {
    return (await import(pathToFileURL(MJS_PATH).href)).ACHIEVEMENTS;
  }
  if (existsSync(BUILD_MJS)) {
    const built = spawnSync(process.execPath, [BUILD_MJS], { cwd: HERE, stdio: 'pipe' });
    if (built.status === 0 && existsSync(MJS_PATH)) {
      return (await import(pathToFileURL(MJS_PATH).href)).ACHIEVEMENTS;
    }
  }
  if (existsSync(TS_PATH)) return (await import(pathToFileURL(TS_PATH).href)).ACHIEVEMENTS;
  throw new Error('既没有可用的 achievements.mjs，也没有 achievements.ts');
}

/* ---- SVG 小工具：共性属性收敛，图形代码才读得懂 ---- */
const r = (x, y, w, h, rx, fill, stroke, sw, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}"${rx ? ` rx="${rx}"` : ''} fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}${extra}/>`;
const c = (cx, cy, rad, fill, stroke, sw, extra = '') =>
  `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}${extra}/>`;
const l = (x1, y1, x2, y2, stroke, sw, extra = '') =>
  `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${stroke}" stroke-width="${sw}" fill="none"${extra}/>`;
const p = (d, fill, stroke, sw, extra = '') =>
  `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${extra}/>`;

/* ---- 共享画框：圆角金属铭牌 + 内沿暗纹 + 四颗铆钉 + 宣纸晕光 ---- */
function frame(t) {
  const rivet = (x, y) =>
    `${c(x, y, 7, t.deep)}${c(x + 2, y + 2, 2.6, t.light, null, 0, ' opacity=".85"')}`;
  return `
    <defs>
      <linearGradient id="plaque" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${t.light}"/>
        <stop offset=".5" stop-color="${t.base}"/>
        <stop offset="1" stop-color="${t.dark}"/>
      </linearGradient>
      <radialGradient id="halo" cx=".5" cy=".5" r=".5">
        <stop offset="0" stop-color="${PAPER}" stop-opacity=".18"/>
        <stop offset=".72" stop-color="${PAPER}" stop-opacity=".05"/>
        <stop offset="1" stop-color="${PAPER}" stop-opacity="0"/>
      </radialGradient>
    </defs>
    ${r(12, 12, 232, 232, 44, 'url(#plaque)', t.deep, 6)}
    ${r(26, 26, 204, 204, 34, 'none', t.light, 3, ' opacity=".55"')}
    ${r(31, 31, 198, 198, 29, 'none', t.deep, 2, ' opacity=".28"')}
    ${c(128, 128, 90, 'url(#halo)')}
    ${rivet(46, 46)}${rivet(210, 46)}${rivet(46, 210)}${rivet(210, 210)}`;
}

/* ---- 分类淡墨底纹：只做氛围，6% 透明度绝不与图形争 ---- */
const BACKDROP = {
  first: `
    <path d="M60 74 Q128 40 196 74" stroke="${INK}" stroke-width="14" stroke-opacity=".06" fill="none"/>
    <path d="M60 182 Q128 216 196 182" stroke="${INK}" stroke-width="14" stroke-opacity=".06" fill="none"/>`,
  military: `
    <path d="M70 60 L186 196" stroke="${INK}" stroke-width="12" stroke-opacity=".06" fill="none"/>
    <path d="M186 60 L70 196" stroke="${INK}" stroke-width="12" stroke-opacity=".06" fill="none"/>`,
  economy: `
    <circle cx="176" cy="176" r="40" stroke="${INK}" stroke-width="9" stroke-opacity=".06" fill="none"/>
    <circle cx="176" cy="176" r="24" stroke="${INK}" stroke-width="9" stroke-opacity=".06" fill="none"/>`,
  politics: `
    <rect x="86" y="86" width="84" height="84" rx="10" transform="rotate(-4 128 128)" stroke="${INK}" stroke-width="10" stroke-opacity=".06" fill="none"/>`,
  diplomacy: `
    <path d="M128 46 Q196 96 128 128 Q60 160 128 210" stroke="${INK}" stroke-width="12" stroke-opacity=".06" fill="none"/>
    <path d="M128 46 Q60 96 128 128 Q196 160 128 210" stroke="${INK}" stroke-width="12" stroke-opacity=".06" fill="none"/>`,
  stratagem: `
    <path d="M60 196 Q60 150 96 150 Q112 150 112 132 Q112 106 140 108 Q168 110 164 140" stroke="${INK}" stroke-width="12" stroke-opacity=".06" fill="none"/>`,
  leisure: `
    <path d="M52 112 Q92 92 128 112 T204 112" stroke="${INK}" stroke-width="12" stroke-opacity=".06" fill="none"/>
    <path d="M52 144 Q92 124 128 144 T204 144" stroke="${INK}" stroke-width="12" stroke-opacity=".06" fill="none"/>`,
  endurance: `
    <path d="M64 56 L64 200" stroke="${INK}" stroke-width="10" stroke-opacity=".06" fill="none"/>
    ${c(64, 72, 9, INK, null, 0, ' fill-opacity=".06"')}${c(64, 112, 9, INK, null, 0, ' fill-opacity=".06"')}
    ${c(64, 152, 9, INK, null, 0, ' fill-opacity=".06"')}${c(64, 192, 9, INK, null, 0, ' fill-opacity=".06"')}`,
};

/* ---- 24 条图形语义：一条一个念得出来的名目，绝不重样 ---- */
const GLYPH = {
  /* 终局：北伐功成——城头旗扬，半壁归图 */
  campaign_victory: t => `
    ${r(52, 148, 152, 60, 8, t.base, t.deep, 6)}
    ${r(112, 120, 36, 30, 14, t.deep)}
    ${r(56, 140, 144, 14, 4, t.deep)}
    ${r(120, 36, 7, 104, 3, INK)}
    <path d="M127 40 L179 54 L127 70 Z" fill="${VERMILION}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
    ${c(72, 176, 6, PAPER)}${c(104, 176, 6, PAPER)}${c(152, 176, 6, PAPER)}${c(184, 176, 6, PAPER)}`,
  /* 首局：启卷 / 岁星 / 诏书 */
  first_run_complete: t => `
    ${r(62, 88, 132, 88, 6, PAPER, INK, 5)}
    ${l(78, 104, 150, 104, INK, 7)}${l(78, 124, 166, 124, INK, 7)}${l(78, 144, 118, 144, INK, 7)}
    <g transform="rotate(-8 150 157)">
      ${r(136, 144, 26, 26, 3, VERMILION)}${r(144, 152, 10, 10, 0, PAPER)}
    </g>
    ${r(48, 78, 15, 108, 7.5, t.base, t.deep, 4)}${r(193, 78, 15, 108, 7.5, t.base, t.deep, 4)}
    ${c(55.5, 76, 8, t.deep)}${c(55.5, 188, 8, t.deep)}${c(200.5, 76, 8, t.deep)}${c(200.5, 188, 8, t.deep)}`,
  first_year_jump: t => `
    <ellipse cx="128" cy="140" rx="94" ry="40" transform="rotate(-16 128 140)" stroke="${INK}" stroke-width="6" stroke-dasharray="18 14" fill="none"/>
    <g transform="translate(171 94)">
      ${p('M0 -34 C3 -18 10 -9 28 -2 C10 5 3 14 0 30 C-3 14 -10 5 -28 -2 C-10 -9 -3 -18 0 -34 Z', PAPER, INK, 5)}
      ${c(0, 0, 6, VERMILION)}
    </g>
    ${c(92, 172, 8, INK)}${l(82, 180, 64, 190, INK, 5)}${l(88, 186, 74, 198, INK, 5)}`,
  first_edict: t => `
    ${l(128, 40, 128, 56, t.deep, 5)}
    ${r(88, 54, 80, 10, 5, t.base, t.deep, 4)}
    ${r(92, 62, 72, 114, 8, PAPER, INK, 5)}
    ${l(112, 80, 112, 124, INK, 7)}${l(128, 80, 128, 124, INK, 7)}${l(144, 80, 144, 124, INK, 7)}
    ${r(102, 132, 52, 32, 4, VERMILION)}
    ${l(112, 142, 144, 142, PAPER, 3, ' opacity=".8"')}${l(112, 152, 144, 152, PAPER, 3, ' opacity=".8"')}
    ${l(128, 176, 128, 192, VERMILION, 6)}${c(128, 196, 6, VERMILION)}
    ${l(128, 202, 118, 214, VERMILION, 4)}${l(128, 202, 128, 216, VERMILION, 4)}${l(128, 202, 138, 214, VERMILION, 4)}`,
  /* 军事：城郭 / 断粮 / 以少胜多 / 不损一兵 / 断戟 */
  capture_first_city: t => `
    ${r(52, 116, 152, 76, 0, t.base, t.deep, 5)}
    ${r(62, 96, 26, 22, 0, t.base, t.deep, 5)}${r(115, 96, 26, 22, 0, t.base, t.deep, 5)}${r(168, 96, 26, 22, 0, t.base, t.deep, 5)}
    ${l(128, 96, 128, 44, t.deep, 7)}
    ${p('M128 48 L186 62 L128 78 Z', VERMILION)}
    ${p('M104 192 V150 Q128 124 152 150 V192 Z', INK)}
    ${c(116, 172, 4, t.base)}${c(140, 172, 4, t.base)}`,
  cut_enemy_supply: t => `
    ${l(52, 208, 204, 208, t.deep, 5, ' opacity=".6"')}
    ${r(108, 104, 96, 42, 6, t.base, t.deep, 5)}
    ${l(98, 116, 140, 106, INK, 6)}${p('M140 106 L152 118 L160 126', 'none', INK, 6)}${l(160, 126, 202, 134, INK, 6)}
    ${c(128, 164, 20, PAPER, t.deep, 8)}${c(128, 164, 5, t.deep)}
    ${l(128, 144, 128, 184, t.deep, 4)}${l(108, 164, 148, 164, t.deep, 4)}
    ${c(112, 192, 5, PAPER, INK, 3)}${c(140, 197, 4, PAPER, INK, 3)}${c(166, 190, 5, PAPER, INK, 3)}`,
  outnumbered_victory: t => `
    ${p('M56 92 L92 102 L56 112 Z', t.base, t.deep, 4)}
    ${p('M56 118 L92 128 L56 138 Z', t.base, t.deep, 4)}
    ${p('M56 144 L92 154 L56 164 Z', t.base, t.deep, 4)}
    ${p('M148 128 L206 94 L206 162 Z', INK)}
    ${l(158, 122, 198, 100, PAPER, 5, ' opacity=".8"')}
    ${l(128, 104, 142, 122, INK, 6)}${l(126, 128, 146, 128, INK, 6)}${l(128, 152, 142, 134, INK, 6)}`,
  bloodless_capture: t => `
    ${p('M128 52 L192 74 V140 Q192 180 128 206 Q64 180 64 140 V74 Z', t.base, t.deep, 6)}
    ${p('M128 68 L178 86 V138 Q178 168 128 190 Q78 168 78 138 V86 Z', 'none', PAPER, 3, ' opacity=".55"')}
    ${p('M108 174 V148 Q128 128 148 148 V174 Z', INK)}
    ${p('M112 150 L122 162 L146 136', 'none', PAPER, 7)}`,
  annihilate_army: t => `
    ${l(62, 202, 102, 160, t.deep, 11)}
    ${p('M100 162 L116 142 L110 164 Z', t.base, t.deep, 3)}${p('M92 188 L108 180 L100 196 Z', t.base, t.deep, 3)}
    ${l(152, 106, 198, 48, t.deep, 11)}
    ${p('M180 76 L212 26 L200 82 Z', PAPER, INK, 5)}
    ${l(124, 136, 140, 128, INK, 5)}${l(120, 148, 136, 154, INK, 5)}`,
  /* 经济：钱串 / 谷仓 / 犁 */
  treasury_10k: t => `
    ${l(128, 38, 128, 218, INK, 5)}
    ${[84, 128, 172].map(cy => `
      ${c(128, cy, 31, t.base, t.deep, 6)}${c(128, cy, 22, 'none', t.deep, 3)}${r(120, cy - 8, 16, 16, 0, INK)}`).join('')}`,
  province_surplus: t => `
    ${p('M50 114 L128 52 L206 114 Z', t.dark, t.deep, 5)}
    ${r(74, 114, 108, 74, 0, t.base, t.deep, 5)}
    ${l(100, 114, 100, 188, t.deep, 3, ' opacity=".5"')}${l(156, 114, 156, 188, t.deep, 3, ' opacity=".5"')}
    ${l(74, 151, 182, 151, t.deep, 3, ' opacity=".5"')}
    ${r(112, 142, 32, 46, 3, INK)}
    ${p('M50 202 Q92 166 128 202 Z', PAPER, INK, 5)}${p('M142 202 Q162 180 182 202 Z', PAPER, INK, 4)}`,
  tuntian_effective: t => `
    ${p('M44 180 Q84 170 128 180 T212 178', 'none', t.deep, 5, ' opacity=".85"')}
    ${p('M44 196 Q84 186 128 196 T212 194', 'none', t.deep, 5, ' opacity=".85"')}
    ${p('M44 212 Q84 202 128 212 T212 210', 'none', t.deep, 5, ' opacity=".85"')}
    ${l(56, 152, 196, 114, t.deep, 9)}${l(100, 62, 154, 148, t.deep, 9)}
    ${c(94, 56, 9, t.base, t.deep, 4)}
    ${p('M176 104 L212 120 L182 136 Z', t.base, t.deep, 5)}`,
  /* 政治：印绶 / 天平 / 阴影 */
  all_factions_loyal: t => `
    ${p('M112 94 L144 94 L138 64 Q128 54 118 64 Z', t.base, t.deep, 5)}
    ${r(84, 94, 88, 78, 8, t.base, t.deep, 6)}
    ${r(98, 106, 60, 54, 3, PAPER, t.deep, 4)}
    ${r(108, 116, 10, 10, 0, INK)}${r(126, 116, 10, 10, 0, INK)}${r(108, 134, 10, 10, 0, INK)}${r(126, 134, 10, 10, 0, INK)}
    ${p('M98 172 C88 192 74 198 66 210', 'none', VERMILION, 8)}
    ${p('M158 172 C168 192 182 198 190 210', 'none', VERMILION, 8)}`,
  no_one_angry: t => `
    ${l(52, 96, 204, 96, t.deep, 9)}
    ${p('M128 96 L110 138 L146 138 Z', t.base, t.deep, 5)}
    ${p('M96 150 H160 L150 164 H106 Z', t.base, t.deep, 5)}
    ${l(70, 96, 50, 120, INK, 4)}${l(70, 96, 90, 120, INK, 4)}${l(186, 96, 166, 120, INK, 4)}${l(186, 96, 206, 120, INK, 4)}
    ${p('M46 120 Q70 146 94 120 Z', PAPER, INK, 5)}${p('M162 120 Q186 146 210 120 Z', PAPER, INK, 5)}
    ${c(128, 116, 7, VERMILION)}`,
  eunuch_dominance: t => `
    ${l(52, 204, 204, 204, t.deep, 6, ' opacity=".8"')}
    ${c(176, 90, 20, INK, null, 0, ' opacity=".26"')}
    ${p('M150 204 Q152 128 176 106 Q200 128 202 204 Z', INK, null, 0, ' opacity=".26"')}
    ${c(84, 100, 13, INK)}${p('M66 204 Q68 134 84 118 Q100 134 102 204 Z', INK)}
    ${p('M104 76 Q116 70 126 74', 'none', INK, 4, ' opacity=".55"')}
    ${p('M106 92 Q120 88 132 94', 'none', INK, 4, ' opacity=".55"')}`,
  /* 外交：结绳 / 裂简 / 冠冕 */
  alliance_formed: t => `
    ${c(96, 128, 42, 'none', t.deep, 20)}${c(96, 128, 42, 'none', t.base, 10)}
    ${c(160, 128, 42, 'none', t.deep, 20)}${c(160, 128, 42, 'none', t.base, 10)}
    ${c(128, 128, 9, VERMILION, INK, 3)}`,
  treaty_breached: t => `
    <g transform="rotate(-5 87 138)">${r(52, 82, 70, 112, 10, t.base, t.deep, 5)}</g>
    <g transform="rotate(5 169 138)">${r(134, 82, 70, 112, 10, t.base, t.deep, 5)}</g>
    ${c(87, 100, 4, t.deep, null, 0, ' opacity=".7"')}${c(87, 176, 4, t.deep, null, 0, ' opacity=".7"')}
    ${c(169, 100, 4, t.deep, null, 0, ' opacity=".7"')}${c(169, 176, 4, t.deep, null, 0, ' opacity=".7"')}
    ${p('M128 60 L116 90 L134 114 L120 140 L136 164 L124 196', 'none', INK, 7)}
    ${p('M110 94 L122 86 L116 102 Z', PAPER, INK, 3)}${p('M140 158 L152 152 L144 166 Z', PAPER, INK, 3)}`,
  hegemony_100: t => `
    ${p('M64 126 L88 68 L112 126 Z', t.base, t.deep, 5)}
    ${p('M112 126 L136 46 L160 126 Z', t.base, t.deep, 5)}
    ${p('M158 126 L182 74 L196 126 Z', t.base, t.deep, 5)}
    ${r(64, 126, 128, 36, 8, t.base, t.deep, 6)}
    ${c(88, 68, 8, VERMILION, t.deep, 3)}${c(136, 46, 9, VERMILION, t.deep, 3)}${c(182, 74, 7, VERMILION, t.deep, 3)}
    ${c(94, 144, 6, PAPER, t.deep, 3)}${c(162, 144, 6, PAPER, t.deep, 3)}
    ${r(58, 162, 140, 10, 5, t.deep)}`,
  /* 计策：火焰 / 空城门 / 离间双影 */
  fire_attack: t => `
    ${c(88, 56, 5, AMBER)}${c(172, 64, 4, AMBER)}${c(128, 26, 4, AMBER)}
    ${p('M128 44 Q141 84 165 94 Q188 107 185 144 Q182 192 128 204 Q74 192 71 144 Q68 107 91 94 Q115 84 128 44 Z', VERMILION, INK, 5)}
    ${p('M128 92 Q139 112 152 120 Q166 130 164 150 Q162 180 128 186 Q94 180 92 150 Q90 130 104 120 Q117 112 128 92 Z', AMBER)}`,
  empty_fort: t => `
    ${c(178, 92, 9, INK)}${p('M164 136 Q166 108 178 102 Q190 108 192 136 Z', INK)}
    ${l(162, 130, 202, 140, INK, 6)}
    ${r(42, 152, 172, 56, 0, t.base, t.deep, 5)}
    ${r(48, 132, 28, 22, 0, t.base, t.deep, 5)}${r(180, 132, 28, 22, 0, t.base, t.deep, 5)}
    ${p('M100 208 V170 Q128 142 156 170 V208 Z', INK)}`,
  sow_discord: t => `
    ${c(86, 94, 13, INK)}${p('M62 196 Q64 128 86 112 Q108 128 110 196 Z', INK)}
    ${c(170, 94, 13, INK)}${p('M146 196 Q148 128 170 112 Q192 128 194 196 Z', INK)}
    ${l(112, 72, 126, 66, INK, 4, ' opacity=".55"')}${l(114, 86, 130, 84, INK, 4, ' opacity=".55"')}
    ${p('M128 50 L118 86 L134 110 L120 136 L136 160 L126 200', 'none', VERMILION, 8)}`,
  /* 趣味：宫灯 / 史笔 */
  harem_year: t => `
    ${l(128, 34, 128, 50, INK, 5)}
    ${p('M104 50 L152 50 L144 70 L112 70 Z', t.deep)}
    ${p('M94 72 Q128 60 162 72 L166 164 Q128 180 90 164 Z', VERMILION, INK, 5)}
    ${p('M108 70 Q104 118 106 168', 'none', INK, 4, ' opacity=".5"')}
    ${l(128, 66, 128, 174, INK, 4, ' opacity=".5"')}
    ${p('M148 70 Q152 118 149 168', 'none', INK, 4, ' opacity=".5"')}
    ${r(98, 66, 60, 12, 6, t.base, t.deep, 4)}${r(92, 158, 72, 12, 6, t.base, t.deep, 4)}
    ${l(128, 170, 128, 190, INK, 4)}${c(128, 194, 7, t.base, t.deep, 4)}
    ${l(128, 201, 118, 214, VERMILION, 4)}${l(128, 201, 128, 216, VERMILION, 4)}${l(128, 201, 138, 214, VERMILION, 4)}`,
  historian_100: t => `
    ${r(52, 96, 50, 14, 4, t.base, t.deep, 4)}${r(52, 114, 50, 14, 4, t.base, t.deep, 4)}
    ${r(52, 132, 50, 14, 4, t.base, t.deep, 4)}${r(52, 150, 50, 14, 4, t.base, t.deep, 4)}
    ${l(58, 92, 58, 170, INK, 3, ' opacity=".6"')}${l(96, 92, 96, 170, INK, 3, ' opacity=".6"')}
    ${p('M104 204 Q138 200 172 188', 'none', INK, 8, ' opacity=".5"')}
    ${p('M116 192 Q148 178 198 152', 'none', INK, 13)}
    ${l(96, 172, 176, 92, INK, 15)}
    ${l(168, 100, 184, 84, t.deep, 24)}${l(170, 98, 182, 86, t.base, 14)}
    ${p('M180 92 L210 54 L198 96 Z', INK)}`,
  /* 耐力：年轮 / 老将盔 */
  thirty_years: t => `
    ${c(128, 132, 74, 'none', t.deep, 12)}
    ${c(128, 132, 68, PAPER, INK, 6)}
    ${c(128, 132, 52, 'none', INK, 4.5)}${c(128, 132, 34, 'none', INK, 4.5)}${c(128, 132, 17, 'none', INK, 4.5)}
    ${c(128, 132, 6, VERMILION)}`,
  veteran_five_runs: t => `
    ${p('M128 64 Q106 48 94 34', 'none', VERMILION, 9)}
    ${p('M128 64 Q128 42 128 30', 'none', VERMILION, 9)}
    ${p('M128 64 Q150 48 162 34', 'none', VERMILION, 9)}
    ${p('M62 148 Q62 80 128 80 Q194 80 194 148 Z', t.base, t.deep, 6)}
    ${r(114, 64, 28, 18, 8, t.deep, INK, 3)}
    ${r(56, 144, 144, 22, 8, t.deep)}
    ${[76, 104, 132, 160, 184].map(x => c(x, 155, 5.5, PAPER)).join('')}
    ${p('M120 166 L136 166 L132 190 L124 190 Z', t.deep)}`,
};

function iconSvg(ach) {
  const t = TIER[ach.tier];
  if (!t) throw new Error(`成就 ${ach.id} 的档位 ${ach.tier} 没有对应配色`);
  const glyph = GLYPH[ach.id];
  if (!glyph) throw new Error(`成就 ${ach.id} 没有对应图形设计：新成就必须先在 GLYPH 里补一个`);
  const backdrop = BACKDROP[CATEGORY[ach.id]] ?? '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <title>${ach.id}</title>
  ${frame(t)}
  ${backdrop}
  <g stroke-linecap="round" stroke-linejoin="round" fill="none">${glyph(t)}</g>
</svg>`;
}

/* ---- 渲染：SVG → 超采样 PNG → 64×64；自检格式/尺寸/透明背景 ---- */
async function renderIcon(svg, label) {
  const png = await sharp(Buffer.from(svg), { density: RENDER_DENSITY })
    .resize(ICON_PX, ICON_PX, { fit: 'contain', kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const meta = await sharp(png).metadata();
  if (meta.format !== 'png' || meta.width !== ICON_PX || meta.height !== ICON_PX) {
    throw new Error(`${label} 渲染结果异常：${meta.format} ${meta.width}×${meta.height}`);
  }
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let transparent = 0, opaque = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const a = data[i * 4 + 3];
    if (a === 0) transparent++;
    else if (a === 255) opaque++;
  }
  // Steam 要求透明背景：四角必须透明，且铭牌主体必须实心
  if (data[3] !== 0) throw new Error(`${label} 左上角不是全透明，违反 Steam 透明背景规范`);
  if (transparent < 100) throw new Error(`${label} 透明像素过少（${transparent}），疑似整幅不透明`);
  if (opaque < 2000) throw new Error(`${label} 实心像素过少（${opaque}），图形渲染可能失败`);
  return png;
}

/** 灰度版：同一图形的去饱和（BT.601 亮度），R==G==B；alpha 原样保留 */
async function renderGray(png, label) {
  const gray = await sharp(png).greyscale().png({ compressionLevel: 9 }).toBuffer();
  const meta = await sharp(gray).metadata();
  if (meta.width !== ICON_PX || meta.height !== ICON_PX) {
    throw new Error(`${label} 灰度版尺寸异常：${meta.width}×${meta.height}`);
  }
  const { data, info } = await sharp(gray).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * 4;
    if (data[o] !== data[o + 1] || data[o + 1] !== data[o + 2]) {
      throw new Error(`${label} 灰度版不是纯灰度（R≠G≠B）`);
    }
  }
  return gray;
}

/** 回填 achievements.json 的 icon / icongray——单一事实来源，不手改 */
async function backfillJson(achievements) {
  const entries = JSON.parse(await readFile(JSON_PATH, 'utf8'));
  const byId = new Map(entries.map(e => [e.name, e]));
  const jsonIds = entries.map(e => e.name).sort();
  const codeIds = achievements.map(a => a.id).sort();
  if (jsonIds.join(',') !== codeIds.join(',')) {
    throw new Error(`achievements.json 与成就代码的 id 集合不一致，先同步再生成图标：json=[${jsonIds}] code=[${codeIds}]`);
  }
  for (const a of achievements) {
    const entry = byId.get(a.id);
    entry.icon = `icons/${a.id}.png`;
    entry.icongray = `icons/${a.id}-gray.png`;
  }
  await writeFile(JSON_PATH, JSON.stringify(entries, null, 2) + '\n');
  return entries.length;
}

const kb = n => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);

async function main() {
  const achievements = await loadAchievements();
  const ids = new Set(achievements.map(a => a.id));
  mkdirSync(ICONS_DIR, { recursive: true });

  const rows = [];
  for (const a of achievements) {
    const svg = iconSvg(a);
    const png = await renderIcon(svg, a.id);
    const gray = await renderGray(png, a.id);
    const pngPath = join(ICONS_DIR, `${a.id}.png`);
    const grayPath = join(ICONS_DIR, `${a.id}-gray.png`);
    await writeFile(pngPath, png);
    await writeFile(grayPath, gray);
    rows.push({ tier: a.tier, id: a.id, icon: png.length, gray: gray.length, png: png.length + gray.length });
  }

  // 清掉已删成就的残留 PNG（只删 .png，README.md 与其他文件不动）
  let removed = 0;
  for (const f of readdirSync(ICONS_DIR)) {
    if (!f.endsWith('.png')) continue;
    const base = f.replace(/-gray\.png$/, '').replace(/\.png$/, '');
    if (!ids.has(base)) { rmSync(join(ICONS_DIR, f)); removed++; }
  }

  const filled = await backfillJson(achievements);

  const label = { bronze: '铜', silver: '银', gold: '金' };
  for (const row of rows) {
    console.log(`【${label[row.tier]}】${row.id}  → icons/${row.id}.png (${kb(row.icon)}) + icons/${row.id}-gray.png (${kb(row.gray)})`);
  }
  const total = rows.reduce((s, x) => s + x.png, 0);
  console.log(`—`);
  console.log(`共 ${rows.length} 条成就 / ${rows.length * 2} 个 PNG，${ICON_PX}×${ICON_PX}，合计 ${kb(total)}（平均 ${kb(Math.round(total / rows.length / 2))}/张）`);
  if (removed) console.log(`已清理失效图标 ${removed} 个`);
  console.log(`achievements.json 已回填 ${filled} 条的 icon / icongray 字段`);
}

try {
  await main();
} catch (err) {
  console.error(`生成失败：${err.message}`);
  process.exit(1);
}
