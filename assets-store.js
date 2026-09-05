// assets-store.js — 素材库（图标/图片/UI 资产）
// 职责：用户手动添加的资产登记表，存 localStorage（小图 dataURL / 远程 URL）。
//   每条：{ id, name, tag, url, path, kind, category, visible, addedSeq }
//   category: bg|char|cg|item|sprite|other（目录里显示 category:bg 等）
//   visible=false → 不进 {{material}} 路径目录
//
// 注意：localStorage 容量有限（~5MB），大图建议用 URL；dataURL 仅适合小图标。

const KEY = 'st-overlay-assets';
let _list = null;
const _subs = new Set();
let _seq = 0;

const CATEGORIES = new Set(['bg', 'char', 'cg', 'item', 'sprite', 'other', 'video', 'audio']);

function normPath(p) { return String(p || '').trim().replace(/^\/+|\/+$/g, ''); }
function normFolderPath(p) {
    return String(p || '').trim().replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

/** 规整 category：bg/char/cg/item/sprite/other；也认 background→bg、sprite→char 别名 */
export function normalizeCategory(c) {
    const s = String(c || '').trim().toLowerCase().replace(/^category:/, '');
    if (!s) return '';
    if (s === 'background' || s === 'scene') return 'bg';
    if (s === 'character' || s === 'sprite' || s === 'role') return 'char';
    if (s === 'image' || s === 'pic') return 'cg';
    if (s === 'prop') return 'item';
    if (CATEGORIES.has(s)) return s;
    return s.slice(0, 24);
}

function load() {
    if (_list) return _list;
    _list = [];
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
        if (Array.isArray(raw)) _list = raw;
    } catch (_) { _list = []; }
    for (const a of _list) {
        if (a.addedSeq > _seq) _seq = a.addedSeq;
        if (!a.path) a.path = '';
        if (a.visible === undefined) a.visible = true;
        if (a.category === undefined) {
            // 从旧 tag 里抠 category:xx
            const m = String(a.tag || '').match(/category:([\w-]+)/i);
            a.category = m ? normalizeCategory(m[1]) : '';
        } else {
            a.category = normalizeCategory(a.category);
        }
    }
    return _list;
}

function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(_list)); }
    catch (e) { console.warn('[overlay] 素材保存失败（可能超出 localStorage 容量）：', e); }
    for (const fn of _subs) { try { fn(); } catch (_) {} }
}

function genId() { return 'asset-' + (++_seq) + '-' + (load().length); }

export function assetRefPath(a) {
    if (!a) return '';
    const p = normPath(a.path);
    const n = String(a.name || '未命名').trim() || '未命名';
    return p ? `${p}/${n}` : n;
}

export function splitAssetRef(ref) {
    const full = normFolderPath(String(ref || '').replace(/\\/g, '/'));
    if (!full) return { path: '', name: '未命名' };
    const i = full.lastIndexOf('/');
    if (i < 0) return { path: '', name: full };
    return { path: full.slice(0, i), name: full.slice(i + 1) || '未命名' };
}

export function addAsset({ name, tag, url, path, visible, category }) {
    if (!url) return null;
    load();
    const entry = {
        id: genId(),
        name: name || '未命名',
        tag: tag || '',
        path: normPath(path),
        url,
        kind: 'image',
        category: normalizeCategory(category),
        visible: visible === false ? false : true,
        addedSeq: _seq,
    };
    _list.push(entry);
    persist();
    return entry;
}

/** 按路径写入/覆盖（AI <save>）。opts.category → category:bg 等 */
export function upsertAssetByRef(ref, url, { tag = '', visible = true, category = '' } = {}) {
    if (!url) return null;
    const { path, name } = splitAssetRef(ref);
    load();
    const key = assetRefPath({ path, name }).toLowerCase();
    const cat = normalizeCategory(category);
    const exist = _list.find((a) => a.kind !== 'folder' && assetRefPath(a).toLowerCase() === key);
    if (exist) {
        exist.url = url;
        if (tag) exist.tag = tag;
        if (cat) exist.category = cat;
        if (visible !== undefined) exist.visible = !!visible;
        persist();
        return exist;
    }
    if (path) {
        let acc = '';
        for (const part of path.split('/')) {
            acc = acc ? `${acc}/${part}` : part;
            addFolder(acc);
        }
    }
    return addAsset({ name, tag, url, path, visible, category: cat });
}

export function removeAsset(id) {
    load();
    const i = _list.findIndex((a) => a.id === id);
    if (i !== -1) { _list.splice(i, 1); persist(); }
}

/** 统计某文件夹（含子路径）内素材数量（不含 folder 节点） */
export function countAssetsInFolder(folderPath) {
    load();
    const base = normFolderPath(folderPath);
    if (!base) return 0;
    let n = 0;
    for (const a of _list) {
        if (a.kind === 'folder') continue;
        const p = normFolderPath(a.path);
        if (p === base || p.startsWith(base + '/')) n++;
    }
    return n;
}

/** 取文件夹内前 maxN 张素材 URL（用于马赛克预览） */
export function listFolderPreviewUrls(folderPath, maxN = 5) {
    load();
    const base = normFolderPath(folderPath);
    if (!base) return [];
    const urls = [];
    for (const a of _list) {
        if (a.kind === 'folder' || !a.url) continue;
        const p = normFolderPath(a.path);
        if (p === base || p.startsWith(base + '/')) {
            urls.push(a.url);
            if (urls.length >= maxN) break;
        }
    }
    return urls;
}

/**
 * 删除文件夹及其下所有素材/子文件夹。
 * @returns {{ removed: number, assets: number }}
 */
export function removeFolder(folderPath) {
    load();
    const base = normFolderPath(folderPath);
    if (!base) return { removed: 0, assets: 0 };
    let assets = 0;
    const next = [];
    for (const a of _list) {
        const p = normFolderPath(a.path);
        const hit = a.kind === 'folder'
            ? (p === base || p.startsWith(base + '/'))
            : (p === base || p.startsWith(base + '/'));
        if (hit) {
            if (a.kind !== 'folder') assets++;
            continue;
        }
        next.push(a);
    }
    const removed = _list.length - next.length;
    _list = next;
    if (removed) persist();
    return { removed, assets };
}

export function updateAsset(id, patch) {
    load();
    const a = _list.find((it) => it.id === id);
    if (!a) return null;
    if (a.kind === 'folder') {
        const oldP = a.path;
        const newP = normFolderPath(patch.path || patch.name || a.name);
        a.name = (patch.name || a.name || '文件夹').trim();
        a.path = newP;
        if (oldP && oldP !== newP) {
            for (const it of _list) {
                if (it.kind === 'folder' || it === a) continue;
                if (it.path === oldP || it.path.startsWith(oldP + '/')) {
                    it.path = (newP ? newP + '/' : '') + it.path.slice(oldP.length).replace(/^\/+/, '');
                }
            }
        }
        persist();
        return a;
    }
    Object.assign(a, {
        name: patch.name || '未命名',
        tag: patch.tag !== undefined ? patch.tag : a.tag,
        path: normPath(patch.path !== undefined ? patch.path : a.path),
        url: patch.url || a.url,
    });
    if (patch.visible !== undefined) a.visible = !!patch.visible;
    if (patch.category !== undefined) a.category = normalizeCategory(patch.category);
    persist();
    return a;
}

export function setAssetVisible(id, visible) {
    load();
    const a = _list.find((it) => it.id === id);
    if (!a || a.kind === 'folder') return null;
    a.visible = !!visible;
    persist();
    return a;
}

export function addFolder(nameOrPath) {
    load();
    const path = normFolderPath(nameOrPath);
    if (!path) return null;
    const exist = _list.find((a) => a.kind === 'folder' && a.path === path);
    if (exist) return exist;
    const last = path.split('/').pop() || path;
    const entry = { id: genId(), name: last, tag: '', path, kind: 'folder', url: '', category: '', visible: true, addedSeq: _seq };
    _list.push(entry);
    persist();
    return entry;
}

export function renameFolderPath(oldPath, newPath) {
    load();
    const oldP = normFolderPath(oldPath);
    const newP = normFolderPath(newPath);
    if (!oldP || !newP || oldP === newP) return null;
    for (const it of _list) {
        const p = normFolderPath(it.path);
        if (p === oldP || p.startsWith(oldP + '/')) {
            it.path = (newP ? newP + '/' : '') + p.slice(oldP.length).replace(/^\/+/, '');
            if (it.kind === 'folder') it.name = it.path.split('/').pop() || it.name;
        }
    }
    persist();
    return newP;
}

export function moveAssetToFolder(id, folderPath) {
    load();
    const a = _list.find((it) => it.id === id);
    if (!a || a.kind === 'folder') return null;
    a.path = normFolderPath(folderPath);
    persist();
    return a;
}

function pushFolder(folders, seenFolder, name, path, id) {
    if (!name || seenFolder.has(path)) return;
    seenFolder.add(path);
    folders.push({ name, path, id: id || '' });
}

export function listByFolder(folderFilter) {
    load();
    const base = normFolderPath(folderFilter);
    const folders = [];
    const items = [];
    const seenFolder = new Set();
    for (const a of _list) {
        const p = normFolderPath(a.path);
        if (a.kind === 'folder') {
            if (!base) {
                const top = p ? p.split('/')[0] : '';
                pushFolder(folders, seenFolder, top, top, p === top ? a.id : '');
            } else if (p === base || p.startsWith(base + '/')) {
                const rest = p === base ? '' : p.slice(base.length + 1);
                const top = rest.split('/')[0];
                if (top) pushFolder(folders, seenFolder, top, base + '/' + top, p === base + '/' + top ? a.id : '');
            }
            continue;
        }
        if (p === base) { items.push(a); continue; }
        if (base && p.startsWith(base + '/')) {
            const top = p.slice(base.length + 1).split('/')[0];
            if (top) pushFolder(folders, seenFolder, top, base + '/' + top, '');
        } else if (!base) {
            const top = p ? p.split('/')[0] : '';
            if (top) pushFolder(folders, seenFolder, top, top, '');
        }
    }
    folders.sort((x, y) => x.name.localeCompare(y.name));
    items.sort((x, y) => (x.addedSeq || 0) - (y.addedSeq || 0));
    return { folders, items };
}

export function listAssets() { return load().slice(); }

export function findAsset(query) {
    const q = String(query || '').toLowerCase();
    if (!q) return null;
    return load().find((a) => a.kind !== 'folder' && (
        a.name.toLowerCase().includes(q) ||
        (a.tag || '').toLowerCase().includes(q) ||
        (a.category || '').toLowerCase() === q ||
        assetRefPath(a).toLowerCase().includes(q)
    )) || null;
}

export function findAssetByPath(query) {
    const raw = String(query || '').trim();
    if (!raw) return null;
    const q = normFolderPath(raw).toLowerCase().replace(/\\/g, '/');
    const list = load().filter((a) => a.kind !== 'folder');
    let hit = list.find((a) => assetRefPath(a).toLowerCase() === q);
    if (hit) return hit;
    hit = list.find((a) => normPath(a.path).toLowerCase() === q);
    if (hit) return hit;
    hit = list.find((a) => String(a.name || '').toLowerCase() === q);
    if (hit) return hit;
    hit = list.find((a) => String(a.tag || '').toLowerCase() === q);
    if (hit) return hit;
    return findAsset(raw);
}

/** {{material}} 目录：路径 + category:xx + 可选 #tag */
export function buildMaterialCatalog() {
    const lines = [];
    for (const a of load()) {
        if (a.kind === 'folder') continue;
        if (a.visible === false) continue;
        const ref = assetRefPath(a);
        if (!ref) continue;
        const cat = a.category ? `  category:${a.category}` : '';
        const tag = a.tag ? `  #${a.tag}` : '';
        lines.push(ref + cat + tag);
    }
    lines.sort((x, y) => x.localeCompare(y, 'zh'));
    if (!lines.length) return '（素材库为空，或全部已用眼睛图标隐藏）';
    return [
        '可用素材路径（调用：<fetch category="bg">路径</fetch><background/>；保存：<pic>提示词</pic><background/><save category="bg">路径</save>）：',
        ...lines,
    ].join('\n');
}

export function subscribe(fn) { _subs.add(fn); return () => _subs.delete(fn); }

export function exportAssets() {
    return JSON.stringify(load().map(({ id, addedSeq, ...rest }) => rest), null, 2);
}

export function importAssets(json) {
    let arr;
    try { arr = JSON.parse(json); } catch (_) { return 0; }
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const it of arr) {
        if (!it || !it.url) continue;
        addAsset({ name: it.name, tag: it.tag, url: it.url, path: it.path, visible: it.visible, category: it.category });
        n++;
    }
    return n;
}

export function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
    });
}
