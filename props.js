// props.js — 道具库（骰子 / 硬币等用户侧小工具）
// 职责：在抽屉「道具」标签页里提供一组可交互道具。点击有动画，结算结果写进输入框。
//   用户用 + 把默认库里的道具加入「已启用」、用 - 移除（存 localStorage）。
//   与 inventory.js（AI 用 <item> 赋予的剧情道具）分开：props 是用户侧工具。
//
// 设计：纯前端、无随机性以外的副作用；结果经 overlay.insertIntoComposer 写回输入框（不自动发送）。

import { q, insertIntoComposer } from './overlay.js';

const STORE_KEY = 'st-overlay-props';
const PANE_ID = 'ov-pane-props';

// 默认道具库：id 唯一；roll() 返回展示用结果文本。
export const DEFAULT_PROPS = [
    { id: 'd6',   glyph: '🎲', name: 'D6',  roll: () => die(6) },
    { id: 'd20',  glyph: '🎲', name: 'D20', roll: () => die(20) },
    { id: 'd100', glyph: '🎲', name: 'D100', roll: () => die(100) },
    { id: 'coin', glyph: '🪙', name: '硬币', roll: () => coin() },
];

// —— 随机助手（用 crypto 取整，避免可预测）——
function rnd(n) {
    try {
        const a = new Uint32Array(1);
        (self.crypto || window.crypto).getRandomValues(a);
        return a[0] % n;
    } catch (_) { return Math.floor(Math.random() * n); }
}
function die(sides) { const v = rnd(sides) + 1; return { value: v, text: `🎲 d${sides} → ${v}` }; }
function coin() { const h = rnd(2) === 0; return { value: h, text: `🪙 ${h ? '正面' : '反面'}` }; }

// —— 持久化：保存「已启用」的道具 id 列表 ——
function loadActive() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        if (Array.isArray(raw)) return raw;
    } catch (_) {}
    return DEFAULT_PROPS.map((p) => p.id); // 默认四个道具全部启用（点击即用，无需添加）
}
function saveActive(ids) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(ids)); } catch (_) {}
}

let active = loadActive();

/** 接线道具：渲染到抽屉「道具」标签页。幂等。 */
export function initProps() {
    const pane = q('#' + PANE_ID);
    if (!pane) return;
    if (pane.dataset.bound === '1') { renderPropsPane(); return; }
    pane.dataset.bound = '1';
    renderPropsPane();
}

/** 重画道具面板：已启用道具 + 未启用道具（带 +/-）。不触碰背包段落。 */
function renderPropsPane() {
    const pane = q('#' + PANE_ID);
    if (!pane) return;

    // 用专门的 props 内容壳（避免冲掉背包段落 .ov-bag-section）
    let wrap = pane.querySelector('.ov-props-wrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'ov-props-wrap';
        pane.appendChild(wrap);
    }
    wrap.innerHTML = '';

    const hint = document.createElement('div');
    hint.className = 'ov-hint';
    hint.textContent = '点击道具掷骰/抛硬币，结果写进输入框。';
    wrap.appendChild(hint);

    // 道具网格：默认四个道具全部启用，点击即用。悬停出现「−」可停用；停用后进「可添加」区。
    const activeGrid = document.createElement('div');
    activeGrid.className = 'ov-props-grid';
    for (const id of active) {
        const def = DEFAULT_PROPS.find((p) => p.id === id);
        if (!def) continue;
        activeGrid.appendChild(buildPropCard(def, true));
    }
    if (!active.length) {
        const e = document.createElement('div');
        e.className = 'ov-asset-empty'; e.textContent = '尚未启用任何道具。';
        activeGrid.appendChild(e);
    }
    wrap.appendChild(activeGrid);

    // 未启用（可添加）——仅当确有停用的道具时才显示；四个都在则完全不显示（用户要求「可添加为空就好」）。
    const remaining = DEFAULT_PROPS.filter((p) => !active.includes(p.id));
    if (remaining.length) {
        const availTitle = document.createElement('div');
        availTitle.className = 'ov-set-title';
        availTitle.textContent = '可添加';
        wrap.appendChild(availTitle);
        const availGrid = document.createElement('div');
        availGrid.className = 'ov-props-grid';
        for (const def of remaining) availGrid.appendChild(buildPropCard(def, false));
        wrap.appendChild(availGrid);
    }
}

/** 构建一张道具卡：active=true 时点击掷骰、带 −；false 时带 +。 */
function buildPropCard(def, isActive) {
    const card = document.createElement('div');
    card.className = 'ov-prop-card' + (isActive ? ' ov-prop-on' : '');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ov-prop';
    btn.title = isActive ? `${def.name}（点击使用）` : `${def.name}（添加）`;
    btn.innerHTML = `<span class="ov-prop-glyph">${def.glyph}</span><span class="ov-prop-name">${def.name}</span>`;
    if (isActive) {
        btn.addEventListener('click', () => rollProp(btn, def));
        const minus = document.createElement('span');
        minus.className = 'ov-prop-toggle ov-prop-minus';
        minus.textContent = '−';
        minus.title = '停用';
        minus.addEventListener('click', (e) => { e.stopPropagation(); removeProp(def.id); });
        card.appendChild(minus);
    } else {
        btn.classList.add('ov-prop-add');
        btn.addEventListener('click', () => addProp(def.id));
    }
    card.appendChild(btn);
    return card;
}

function rollProp(btn, def) {
    const r = def.roll();
    btn.classList.remove('ov-rolling');
    void btn.offsetWidth;
    btn.classList.add('ov-rolling');
    setTimeout(() => btn.classList.remove('ov-rolling'), 600);
    insertIntoComposer(r.text);
}

function addProp(id) {
    if (!active.includes(id)) { active.push(id); saveActive(active); renderPropsPane(); }
}
function removeProp(id) {
    active = active.filter((x) => x !== id); saveActive(active); renderPropsPane();
}
