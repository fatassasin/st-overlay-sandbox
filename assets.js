// assets.js — 图像资产解析接缝（里程碑 1：占位；里程碑 2：本地生图 + IndexedDB 缓存）
// 职责（关键设计）：把「生图」这件高风险、慢、需缓存的事，隔离在这一个文件里。
//   reader.js 永远只调 resolveImage(role, descriptor)，拿到 URL 就贴图、拿到 null 就渲占位框。
//   M1：恒返回 null（=占位）；M2 在此接 ctx.executeSlashCommandsWithOptions('/imagine ... quiet=true')
//       → result.pipe（/user/images/... URL），并加 id=hash(prompt) 内容寻址 + IndexedDB + LRU 驱逐。
//   这样 reader/parser 在 M2 完全不用改。
//
// role: 'bg' | 'sprite' | 'cg' | 'item'
// descriptor: 该 role 的语义描述对象，例如 bg → { bg:'夜·太空舱·红光', fade:'12s' }；
//             sprite → { char, emo }；cg/item → { img, caption }
//
// 返回：{ url } 已就绪 | { pending:true } 生成中（M2） | null 无图（占位）

import { findAsset } from './assets-store.js';

let _ctx = null;

// 测试用图覆盖（仅「测试」标签页预览用）：slotKey→dataURL。
//   关键：按【具名图位】而非笼统 role 存——同为 item 的「黄铜罗盘」和「油布斗篷」是两个独立图位，
//   同为 sprite 的不同角色也各自独立。slotKeyFor 生成稳定键（role + 具体描述符）。
//   reader.rebuild 会 clearTestImages() 防止泄漏到真实聊天。
const _testImages = {};

/** 为 (role, descriptor) 生成稳定的具名图位键。同一具名位（如同一背景短语/同一角色/同一道具名）→ 同键。 */
export function slotKeyFor(role, d) {
    if (!role) return '';
    const dd = d || {};
    switch (role) {
        case 'bg':     return 'bg:' + (dd.bg || '');
        case 'sprite': return 'sprite:' + (dd.char || '') + (dd.emo ? '|' + dd.emo : '');
        case 'cg':     return 'cg:' + (dd.img || dd.caption || '');
        case 'item':   return 'item:' + (dd.img || dd.caption || '');
        default:       return role + ':' + (dd.img || dd.bg || dd.char || dd.caption || '');
    }
}

/** 设置某个具名图位的测试图（测试 Tab 上传自定义图注入预览）。key 由 slotKeyFor 生成。 */
export function setTestImage(key, url) {
    if (!key) return;
    if (url) _testImages[key] = url;
    else delete _testImages[key];
}
/** 读取某具名图位当前测试图 URL（测试面板回显缩略图用）。 */
export function getTestImage(key) {
    return key && _testImages[key] ? _testImages[key] : '';
}
/** 清空所有测试图（真实重建时调用，避免测试图污染真实聊天）。 */
export function clearTestImages() {
    for (const k of Object.keys(_testImages)) delete _testImages[k];
}

/** 注入 ST context（index.js 在 ctx 就绪后调用）。M1 不用，M2 生图要用。 */
export function initAssets(ctx) {
    _ctx = ctx || null;
}

/**
 * 解析某 role 的图像。
 * M1：占位策略——一律返回 null，由 reader 渲描述占位框。
 *   例外：测试 Tab 上传的自定义图经 _testImages 覆盖（按具名图位键，优先返回）。
 * @param {'bg'|'sprite'|'cg'|'item'} role
 * @param {object} descriptor
 * @returns {{url:string}|{pending:true}|null}
 */
export function resolveImage(role, descriptor) {
    // 测试预览图覆盖（最高优先级）——按具名图位精确匹配
    const key = slotKeyFor(role, descriptor);
    if (key && _testImages[key]) return { url: _testImages[key] };

    const label = placeholderLabel(role, descriptor);
    const asset = findAsset(label) || findAsset(key);
    if (asset?.url) return { url: asset.url };

    // —— M1 占位接缝：暂不生图 ——
    return null;

    // —— M2 预留（伪代码，本里程碑不启用）——
    // const prompt = buildPrompt(_role, _descriptor);
    // const cached = await cacheGet(hash(prompt));
    // if (cached) return { url: cached.url };
    // const res = await _ctx.executeSlashCommandsWithOptions(`/imagine ${prompt} quiet=true`, {});
    // const url = res?.pipe; if (url) { await cachePut(hash(prompt), url); return { url }; }
    // return { pending: true };
}

/** 取一个 role 的占位描述文字（reader 渲占位框用） */
export function placeholderLabel(role, descriptor) {
    switch (role) {
        case 'bg':     return descriptor?.bg || '';
        case 'sprite': return descriptor?.char ? `${descriptor.char}${descriptor.emo ? ' · ' + descriptor.emo : ''}` : '';
        case 'cg':     return descriptor?.img || descriptor?.caption || '';
        case 'item':   return descriptor?.img || descriptor?.caption || '';
        default:       return '';
    }
}
