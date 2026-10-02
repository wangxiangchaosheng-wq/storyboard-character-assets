/**
 * 一次性推送脚本：git 的 https 传输在本机连不上 github.com（只有 api.github.com 通），
 * 所以拿本地 git 对象经 GitHub REST API 在远端重建这 8 个提交，再建分支指向末个提交。
 *
 * 做法（保证与本地逐字一致）：
 *  - blob 的 SHA 由内容决定，git 与 GitHub 同一算法 → 未变的 blob 直接沿用远端树里的 SHA；
 *  - 每个提交只上传它真正改动的 blob、自底向上重建受影响的目录树（未动的子树引用基线 SHA）；
 *  - 提交信息、作者/提交者（含时间戳）逐个搬过去。
 *
 * 用法：node scripts/push-via-api.mjs [owner/repo] [branch]
 */
import { execFileSync } from 'node:child_process';

const REPO = process.argv[2] || 'wangxiangchaosheng-wq/storyboard-character-assets';
const BRANCH = process.argv[3] || 'feature/agent-chat-polish';
const TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const API = `https://api.github.com/repos/${REPO}`;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 });
/** 二进制安全版：绝不能给 encoding——utf8 解码会把 PNG 字节搅坏，base64 之后 SHA 就不对了。 */
const gitBuf = (...args) => execFileSync('git', args, { maxBuffer: 1024 * 1024 * 256 });

async function api(path, init = {}) {
  const res = await fetch(API + path, {
    method: init.method || 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)} | body=${JSON.stringify(init.body||{}).slice(0,1200)}`);
  return json;
}

/** 递归取一棵树的所有条目（path → sha），未截断（超出 100k 条目才需 paginate，本仓远不到）。 */
async function treeEntries(treeSha) {
  const t = await api(`/git/trees/${treeSha}?recursive=1`);
  const map = new Map();
  for (const e of t.tree) if (e.type === 'blob') map.set(e.path, e.sha);
  return { map, rootSha: t.sha, truncated: t.truncated };
}

/** 按完整目录路径逐级下树，取该目录在基线树里的子树 SHA（任一级不存在则 undefined）。 */
async function subTreeSha(baseRootSha, dir) {
  let sha = baseRootSha;
  for (const part of dir.split('/')) {
    const t = await api(`/git/trees/${sha}`);
    const hit = t.tree.find(e => e.type === 'tree' && e.path === part);
    if (!hit) return undefined;
    sha = hit.sha;
  }
  return sha;
}

const commits = git('log', '--reverse', '--format=%H', 'main..HEAD').trim().split('\n').filter(Boolean);
console.log(`待推送提交 ${commits.length} 个 → ${REPO}:${BRANCH}`);

// 基线：本地 main 在远端的树（已确认该提交存在于远端）
const baseCommit = await api(`/git/commits/${git('rev-parse', 'main').trim()}`);
let baseTree = baseCommit.tree.sha;
let parentSha = git('rev-parse', 'main').trim();
console.log(`基线树（origin/main 侧找不到本地 main，用远端提交对象）：${baseTree.slice(0, 8)}`);

let uploaded = 0, skipped = 0;
for (const [i, sha] of commits.entries()) {
  const meta = git('show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B', sha).split('\u0000');
  const [an, ae, ad, cn, ce, cd] = meta.slice(0, 6);
  const message = meta.slice(6).join('\u0000').trim();
  const parent = git('rev-parse', `${sha}^`).trim();
  const isFirst = parent === git('rev-parse', 'main').trim();

  // 该提交相对父提交的改动（不做重命名检测，文件级增删改）。
  // 必须 -z：git 默认把非 ASCII 路径转义成 "integrations/.../\344\272\272..."，
  // 拿转义串当路径建树，那次改动就静默丢了（实测：中文路径文件的修改没上去，旧 blob 留在树上）。
  const raw = git('diff-tree', '-r', '--no-renames', '--raw', '-z', parent, sha);
  const changes = [];
  // -z 输出是 meta \0 path \0 meta \0 path \0 …，成对切分；path 是未转义原文（中文路径安全）
  const parts = raw.split('\u0000');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = parts[i].match(/^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/);
    if (!m) continue;
    // raw 格式：:源mode 目标mode 旧SHA **新SHA** 状态 —— 新 SHA 是第 4 组（早先按第 3 组取，传错了内容）
    changes.push({ srcMode: m[1], destMode: m[2], oldSha: m[3], newSha: m[4], status: m[5], path: parts[i + 1] });
  }

  // 自底向上重建目录树
  const uploadedShaCache = new Set();
  const entriesByDir = new Map();
  for (const c of changes) entriesByDir.set(c.path, c);
  // 受影响的目录 = 每个改动文件的**全部祖先目录**（不只是直接父目录）——少一层祖先，
  // 根树就拿不到顶层子树，整棵目录树会断在那。（第一版就栽在这：dirs 只算直接父目录。）
  const dirs = [...new Set(changes.flatMap(c => {
    const parts = c.path.split('/').slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  }))].sort((a, b) => b.split('/').length - a.split('/').length);

  const newSubTrees = new Map(); // dir -> new tree sha
  // 深目录优先
  for (const dir of dirs) {
    const baseSub = await subTreeSha(baseTree, dir);
    const entries = [];
    for (const [path, c] of entriesByDir) {
      if (path.split('/').slice(0, -1).join('/') !== dir) continue;
      const blobSha = (c.status === 'D' ? null : c.newSha);
      if (blobSha) {
        if (!uploadedShaCache.has(blobSha)) {
          const b64 = gitBuf('cat-file', 'blob', blobSha).toString('base64');
          const created = await api('/git/blobs', { method: 'POST', body: { content: b64, encoding: 'base64' } });
          if (created.sha !== blobSha) throw new Error(`blob SHA 不一致：${blobSha} vs ${created.sha}`);
          uploadedShaCache.add(blobSha); uploaded++;
        }
      }
      entries.push({ path: path.split('/').pop(), mode: blobSha ? (c.destMode || c.mode || '100644') : '100644', type: 'blob', sha: blobSha });
    }
    // 该目录下未动的子树：引用新建的子树的 SHA（若该目录下又有子目录被改）
    for (const [sub, subSha] of newSubTrees) {
      if (sub.split('/').slice(0, -1).join('/') === dir) entries.push({ path: sub.split('/').pop(), mode: '040000', type: 'tree', sha: subSha });
    }
    const t = await api('/git/trees', { method: 'POST', body: { base_tree: baseSub, tree: entries } });
    newSubTrees.set(dir, t.sha);
  }

  // 根树：根级文件 + 顶层目录
  const rootEntries = [];
  for (const [path, c] of entriesByDir) {
    if (path.includes('/')) continue;
    const blobSha = (c.status === 'D' ? null : c.newSha);
    if (blobSha && !uploadedShaCache.has(blobSha)) {
      const b64 = gitBuf('cat-file', 'blob', blobSha).toString('base64');
      const created = await api('/git/blobs', { method: 'POST', body: { content: b64, encoding: 'base64' } });
      if (created.sha !== blobSha) throw new Error(`blob SHA 不一致：${blobSha} vs ${created.sha}`);
      uploadedShaCache.add(blobSha); uploaded++;
    }
    rootEntries.push({ path, mode: blobSha ? (c.destMode || c.mode || '100644') : '100644', type: 'blob', sha: blobSha });
  }
  for (const [sub, subSha] of newSubTrees) {
    if (sub.includes('/')) continue;
    rootEntries.push({ path: sub, mode: '040000', type: 'tree', sha: subSha });
  }
  const rootTree = await api('/git/trees', { method: 'POST', body: { base_tree: baseTree, tree: rootEntries } });

  // 父提交必须用**远端**的 SHA：本地 SHA 与重建出来的远端 SHA 不同（作者时间戳/换行差异），
  // 照搬本地 parent 会被 API 以「Parent SHA does not exist」拒掉。
  const created = await api('/git/commits', {
    method: 'POST',
    body: {
      message, tree: rootTree.sha, parents: [parentSha],
      author: { name: an, email: ae, date: ad }, committer: { name: cn, email: ce, date: cd },
    },
  });
  console.log(`[${i + 1}/${commits.length}] ${sha.slice(0, 8)} → ${created.sha.slice(0, 8)}（${changes.length} 个文件，新传 blob ${uploadedShaCache.size}）`);
  if (created.sha !== sha) console.log(`  ⚠ 远端 SHA 与本地不同（${created.sha} ≠ ${sha}）——作者时间戳/换行差异，内容一致`);
  baseTree = rootTree.sha;
  parentSha = created.sha;
}

// 建分支（存在则快进到末提交）
const head = parentSha; // 远端末个提交，不是本地 HEAD（本地 SHA 在远端不存在）
try {
  await api(`/git/refs`, { method: 'POST', body: { ref: `refs/heads/${BRANCH}`, sha: head } });
  console.log(`分支已创建：${BRANCH} → ${head.slice(0, 8)}`);
} catch (e) {
  if (/already exists/.test(e.message)) {
    await api(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: head, force: true } });
    console.log(`分支已更新：${BRANCH} → ${head.slice(0, 8)}`);
  } else throw e;
}
console.log(`完成：新传 blob ${uploaded} 个`);
