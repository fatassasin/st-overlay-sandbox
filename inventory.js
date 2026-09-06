// inventory.js — 背包（剧情道具，AI 用 <item> 赋予）
// 职责：背包道具展示在「道具」标签页内（与骰子等用户侧道具合并在同一面板）。
//   顶栏道具按钮带角标显示背包数量。
//   道具来源：reader 解析每个楼层时收集的 items（img + caption）。本模块维护去重累计表，
//   并提供 setItems(allItems) 由 bridge/reader 在重建/定稿时灌入。
//   点击道具 → 把「使用 XXX」插入输入框（由 AI 决定文案；默认占位）。
//
// M1：道具图为占位（白线框 + img 描述 + caption）；M2 接生图后换真图。

import { q } from './overlay.js';
import { resolveImage } from './assets.js';
import { findAssetByPath, listAssets, removeAsset } from './assets-store.js';

const TOP_COUNT_ID = 'ov-bag-count';
const PANE_ID = 'ov-pane-props';
const TAB_COUNT_ID = 'ov-dtab-bag';
const DELETED_ITEMS_KEY = 'st-overlay-deleted-items';

let items = [];        // [{ img, caption, pos, action, reveal, clickable }]
let deletedKeys = loadDeletedKeys();

function loadDeletedKeys() {
    try {
        const raw = JSON.parse(localStorage.getItem(DELETED_ITEMS_KEY) || '[]');
        return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch (_) { return new Set(); }
}

function saveDeletedKeys() {
    try { localStorage.setItem(DELETED_ITEMS_KEY, JSON.stringify([...deletedKeys])); } catch (_) {}
}

/** 为同一物品生成稳定身份：即使删除素材后重新解析，也能继续过滤掉它。 */
function itemKeys(it) {
    const keys = new Set();
    const add = (value, prefix = '') => {
        const s = String(value || '').trim();
        if (s) keys.add(prefix + s.toLowerCase());
    };
    add(it?.assetId, 'id:');
    add(it?.assetRef, 'ref:');
    add(it?.url, 'url:');
    add(it?.img, 'img:');
    add(it?.img?.replace?.(/^道具\//, ''), 'img:');
    add(`${it?.img || ''}|${it?.caption || ''}`, 'text:');
    return keys;
}

function isDeleted(it) {
    return [...itemKeys(it)].some((key) => deletedKeys.has(key));
}

function findItemAsset(it) {
    const img = String(it?.img || '').trim().replace(/^道具\//, '').toLowerCase();
    const url = String(it?.url || '').trim();
    const isItemAsset = (a) => a && a.kind !== 'folder' && (!a.category || a.category === 'item');
    const exact = listAssets().find((a) => isItemAsset(a) && (
        (url && String(a.url || '') === url) ||
        (img && String(a.name || '').trim().toLowerCase() === img)
    ));
    if (exact) return exact;
    const byPath = findAssetByPath(it?.assetRef || it?.img || '');
    return isItemAsset(byPath) ? byPath : null;
}

function deleteItem(it) {
    const asset = findItemAsset(it);
    if (asset?.id) removeAsset(asset.id);
    for (const key of itemKeys(it)) deletedKeys.add(key);
    saveDeletedKeys();
    items = items.filter((candidate) => candidate !== it && !isDeleted(candidate));
    renderCount();
    renderBagSection();
}

let viewer = null;

function ensureViewer() {
    if (viewer) return viewer;
    viewer = document.createElement('div');
    viewer.className = 'ov-item-viewer';
    viewer.hidden = true;
    viewer.innerHTML = `
        <div class="ov-item-viewer-card" role="dialog" aria-modal="true" aria-label="物品预览">
            <button class="ov-item-viewer-close" type="button" title="关闭预览" aria-label="关闭预览"><i class="fa-solid fa-xmark"></i></button>
            <div class="ov-item-viewer-media"><img alt="" /><div class="ov-item-viewer-placeholder" hidden></div></div>
            <div class="ov-item-viewer-info"><div class="ov-item-viewer-title"></div><div class="ov-item-viewer-detail"></div></div>
        </div>`;
    document.body.appendChild(viewer);
    const close = () => { viewer.hidden = true; };
    viewer.querySelector('.ov-item-viewer-close')?.addEventListener('click', close);
    viewer.addEventListener('click', (e) => { if (e.target === viewer) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !viewer.hidden) close(); });
    return viewer;
}

function openItemViewer(it) {
    const modal = ensureViewer();
    const img = modal.querySelector('img');
    const placeholder = modal.querySelector('.ov-item-viewer-placeholder');
    const title = modal.querySelector('.ov-item-viewer-title');
    const detail = modal.querySelector('.ov-item-viewer-detail');
    const url = String(it?.url || '').trim();
    title.textContent = it?.caption || it?.img || '未命名物品';
    detail.textContent = [
        it?.img && it.img !== it.caption ? `图标：${it.img}` : '',
        it?.reveal ? `信息：${it.reveal}` : '',
        it?.action ? `动作：${it.action}` : '',
    ].filter(Boolean).join('\n') || '暂无更多信息';
    if (url) {
        img.src = url;
        img.alt = it?.caption || it?.img || '';
        img.hidden = false;
        placeholder.hidden = true;
    } else {
        img.removeAttribute('src');
        img.hidden = true;
        placeholder.textContent = it?.img || '暂无图标';
        placeholder.hidden = false;
    }
    modal.hidden = false;
}
/**
 * 接线背包：初始化计数（面板由 props.js 构建，背包内容由 setItems 填充）。幂等。
 */
export function initInventory() {
    renderCount();
}

/** 灌入当前全部道具（去重：img+caption 为键），刷新计数与面板。 */
export function setItems(allItems) {
    const seen = new Set();
    items = [];
    for (const it of (allItems || [])) {
        if (isDeleted(it)) continue;
        const key = `${it.img}|${it.caption}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(it);
    }
    renderCount();
    renderBagSection();
}

/** 计数同步到顶栏道具按钮角标 + 抽屉 tab 角标；空时隐藏。 */
function renderCount() {
    const tc = q('#' + TOP_COUNT_ID);
    const tabc = q('#' + TAB_COUNT_ID);
    const n = items.length;
    if (tc) { tc.textContent = String(n); tc.style.display = n ? '' : 'none'; }
    if (tabc) tabc.textContent = String(n);
}

/** 在「道具」标签页内渲染背包段落。先确保段落存在，再填网格。 */
function renderBagSection() {
    const pane = q('#' + PANE_ID);
    if (!pane) return;

    // 找或建背包段落
    let section = pane.querySelector('.ov-bag-section');
    if (!section) {
        section = document.createElement('div');
        section.className = 'ov-bag-section ov-set-group';
        section.innerHTML = `<div class="ov-set-title">背包</div>
            <div class="ov-hint">AI 用 <code>&lt;item&gt;</code> 赋予的剧情道具会出现在这里。悬停看揭示，点击展开详情。</div>
            <div class="ov-bag-grid" id="ov-bag-grid"></div>`;
        // 插到 pane 的 props 内容后面
        pane.appendChild(section);
    }
    if (!items.length) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';

    const grid = section.querySelector('#ov-bag-grid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const it of items) {
        const cell = document.createElement('div');
        cell.className = 'ov-bag-cell' + (it.clickable === false ? '' : ' ov-clickable');
        cell.title = it.reveal ? '悬停显示揭示 · 点击展开详情' : '点击展开详情';
        const ph = document.createElement('div');
        ph.className = 'ov-bag-img ov-placeholder';
        // 取图口径必须和舞台上的道具浮层（reader.js renderItems）完全一致：显式 url 优先，
        // 否则回落到 resolveImage（测试预览图 → 素材库）。这里以前只认 it.url，于是素材库
        // 里明明有图、测试面板也填了图，背包卡却永远是「道具名 + 一行说明」的纯文字。
        const img = it.url
            ? { url: it.url }
            : resolveImage('item', { img: it.img, caption: it.caption });
        if (img && img.url) {
            ph.classList.remove('ov-placeholder');
            ph.style.backgroundImage = 'url("' + String(img.url).replace(/"/g, '') + '")';
            ph.style.backgroundSize = 'contain';
            ph.style.backgroundPosition = 'center';
            ph.style.backgroundRepeat = 'no-repeat';
            ph.textContent = '';
        } else {
            ph.textContent = it.img || '';
        }
        const actions = document.createElement('div');
        actions.className = 'ov-bag-actions';
        const eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'ov-bag-eye';
        eye.title = '全屏查看';
        eye.setAttribute('aria-label', '全屏查看');
        eye.innerHTML = '<i class="fa-solid fa-eye"></i>';
        eye.addEventListener('click', (e) => { e.stopPropagation(); openItemViewer(it); });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'ov-bag-delete';
        del.title = '删除物品及 item 素材';
        del.setAttribute('aria-label', '删除物品');
        del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteItem(it); });
        actions.append(eye, del);
        const cap = document.createElement('div');
        cap.className = 'ov-bag-cap';
        cap.textContent = it.caption || it.img || '';
        cell.append(ph, actions);
        cell.appendChild(cap);
        if (it.clickable !== false) {
            if (it.reveal) {
                cell.addEventListener('mouseenter', () => { cell.title = it.reveal; });
            }
            cell.addEventListener('click', () => {
                let r = cell.querySelector('.ov-bag-reveal');
                if (!r) {
                    r = document.createElement('div');
                    r.className = 'ov-bag-reveal';
                    cell.appendChild(r);
                }
                const open = cell.classList.toggle('ov-bag-open');
                r.textContent = [it.caption, it.reveal].filter(Boolean).join('\n\n') || it.img || '';
                r.hidden = !open;
            });
        }
        grid.appendChild(cell);
    }
}
