# Changelog

## 2026-08-31 v6.3 — PNG-only default delivery

- Changed the default user-facing deliverable to exactly five final transparent PNG assets.
- Removed the default `manifest.md`, prompt/source report, QA preview, path list and ZIP from the delivery contract.
- Kept character research, Action Signatures, Prop Cards, generation parameters, Alpha validation and black/white previews as internal workflow state, so asset quality and historical controls are unchanged.
- Required drafts and QA artifacts to remain outside the final PNG directory and outside the default final response.
- Extra documentation or packaging is now produced only when the user explicitly requests it.

## 2026-08-31 v6.2 — Required canvas-edge crop

- Changed the default half-body rule from “bottom contact allowed” to “broad, continuous bottom contact required”; a transparent gap now fails.
- Added `--require-bottom-touch` and `--min-bottom-contact` to `validate_character_assets.py`; the default requirement is at least 25% visible bottom-edge contact.
- Added `scripts/align_bottom_crop.py` for the narrow case where a generated asset already has a stable, broad, straight lower cut but is separated from the canvas edge by transparent pixels.
- The alignment helper refuses rounded, narrow or materially trailing lower silhouettes, so it cannot flatten a failed framing into a false pass.
- Updated the entrypoint, prompt template, transparency workflow, atomicity contract and quality standard to use the stricter gate.

## 2026-08-31 v6.1 — One character prop atomicity

- Strengthened the primary invariant to `one asset = one character = one primary action = one character prop`.
- Defined a character prop as one independently removable object used, worn, viewed, or operated by the character; normal garment structure does not count.
- Zero props, two or more props, or disguising multiple objects as one “set” are now atomicity hard failures.
- Synchronized the entrypoint, atomicity contract, historical-prop research, prompt templates, UI prompt, manifest requirements, and visual QA around the exact-one-prop rule.

## 2026-08-31 v6 — Historical prop cards + Flat-bottom half body

- Fixed the prior overcorrection that treated prop removal as the safest default. Historical characters now research 2–3 candidates and keep one evidence-backed, role-signature prop by default.
- Added `references/historical-props.md` with narrative and historical fit gates, four evidence outcomes, source priority, a required Prop Card, anti-hybrid rules, group-level coverage checks, and a documented no-prop exception.
- A five-character historical set may not leave three or more characters prop-free without returning to research and action design; an empty-handed cast is no longer accepted as a shortcut around historical verification.
- Changed the prop gate from “the action must become impossible without it” to “the prop must materially improve action readability or identity recognition and have adequate evidence.”
- Added museum-backed Three Kingdoms research starting points for slips and writing tools, tiger tallies, ring-pommel swords, and Han official seals, with explicit limits on personal-ownership claims.
- Forbids assembling real components into an undocumented hybrid device such as a tally dashboard, process board, control console, or ancient data panel.
- Locked the default framing to a waist-up portrait whose robe is cropped straight by the bottom canvas edge; rounded, oval, floating, badge-like, faded, crouching, kneeling, and full-body results are hard failures.
- Added `--allow-bottom-touch` to conversion and validation so an intentional straight half-body crop can touch the bottom edge while top and side margins remain mandatory.

## 2026-08-30 v5 — Reliable Alpha merge

- Merged the v4 atomic single-character, Action Signature, core-five selection, prop-necessity, and anti-map-bias rules with a production-safe transparency workflow.
- Removed the invalid assumption that every built-in image tool exposes `transparent_background=true`; the skill now inspects the actual tool schema and never invents unsupported fields.
- Added a two-path transparency gate: native Alpha first, then a deterministic uniform-chroma-matte fallback when native output is RGB or contains a painted checkerboard.
- Added `scripts/chroma_to_alpha.py`, using only the Python standard library, with border coverage, removable-area, edge-contact, color-decontamination, non-destructive-output, and input-scope safeguards.
- Added mandatory black- and white-background QA previews for detecting colored fringes, haze, broken fine details, and accidental clipping.
- Added a one-character calibration gate before batch generation and locked the whole set to one transparency path and one conversion configuration.
- Expanded `manifest.md` traceability to include transparency path, conversion settings, strict Alpha metrics, and preview results.

## 2026-08-30 v4 — Prop necessity gate + Anti-map bias

- Added a hard **prop necessity gate**: identity or topic keywords may not auto-trigger props.
- Added a dedicated **map gate**: maps are only allowed when the primary action explicitly requires reading, annotating, simulating, or identifying geographic routes and removing the map would make the action unreadable.
- Explicitly forbids “Three Kingdoms / Northern Expedition / strategist / general = map” prompt shortcuts.
- Added group-level prop deduplication: no “everyone holds/points at a map”, “everyone has a scroll”, or similar repeated core-prop templates.
- Reworked Three Kingdoms Action Signature examples so Zhuge Liang can use orders/markers, the university-student representative uses counting sticks + writing board, Wei Yan uses forward pressure + scabbard/command slip, Ma Su uses command token/gesture, and Sima Yi uses scout reports.
- Updated prompt template and QA checklist to record prop necessity, map-gate status, and group prop deduplication.
- Maps that do pass the gate must remain small, subordinate, and free of large labels, route arrows, territory diagrams, or infographic treatment.

## 2026-08-30 v3 — Atomic single-character assets + Core Five selection

- Added `references/atomicity-contract.md`: hard rule `ONE ASSET = ONE CHARACTER = ONE ACTION`.
- Default character selection is now exactly the 5 most causally indispensable roles when possible.
- Characters 6+ require a strict causal-extension test and explicit counterfactual justification.
- Group concepts such as “10,000 university students” default to one representative character asset.
- Multi-character, collage, sticker-sheet, character-sheet, multi-pose, poster, or storyboard outputs are now Atomicity Hard Fail.
- Atomicity failures must be discarded and regenerated from blank; they may not be repaired by editing the failed collage.
- Prompt template now carries an atomicity hard prefix and forbids supporting/background people, crowds, duplicate poses, scenes, text, and explanatory graphics.
- Reference-image rules now warn against people-heavy/multi-character references and prohibit using failed collages as subsequent references.
- Quality and manifest requirements now record atomicity and extra-character justification.

## v2 — 透明硬约束 + 人物动作签名

### 透明 PNG（以下为 v2 当时策略，已由 v5 的能力探测与双路径回退取代）
- 不再把“透明背景”仅作为 prompt 文案。
- v2 曾错误假定所有内置 `image_gen` 都暴露统一透明参数；v5 已改为先检查真实工具结构，缺少该能力时自动走幕布回退。
- OpenAI Images API/CLI：强制 `background="transparent"` + `output_format="png"`。
- 新增 `references/transparency-contract.md`。
- 加严 PNG alpha 校验：默认要求至少 8% 像素为清晰透明（alpha <= 16）、至少 70% 外边框清晰透明、四角必须透明；防止“只透明一点点也通过”。

### 人物动作
- 新增 `references/action-signature.md`。
- 角色动作从“人物名 + 道具 + 通用姿态”改为：具体事件瞬间 → 角色功能 → 能力来源 → 主动动词 → 手/道具交互 → 身体重心 → 视线 → 表情 → 剪影。
- 动作特异性评分低于 8/10 不进入生成。
- 新增“禁止通用姿态”，避免诸葛亮/魏延/大学生等都退化为站桩立绘。
- prompt 模板与质量标准同步更新。

### 可追溯性
- manifest 增加 Action Signature、动作评分、透明执行模式与 alpha 校验结果。
