// components.js — HUD 组件库（喂左下角状态条）
// 职责：
//   1) 按 spec 构建组件 DOM（createComponent），并在内部 Map 记录每个 id 的最新 spec，供 update/remove。
//   2) 提供 updateComponent/removeSpec/getSpec/clearSpecs。
// 约定：每个组件 DOM 都带 data-id 与 data-type，便于指令定位。
// 类型：progressbar（血条/进度）、stat（数值卡）、alert（提示）、divider（分隔，兜底保留）。
// 由 AI 的 <overlay>{json} HUD 指令经 parser.js 驱动（视觉小说协议里的状态条）。

// id → 最新完整 spec（update 时合并，供 re-render）
const _specs = new Map();

/**
 * 构建一个组件 DOM 节点（纯函数：不读写 _specs）。
 * @param {object} spec
 * @returns {HTMLElement|null}
 */
function buildNode(spec) {
    if (!spec || typeof spec !== 'object') return null;
    switch (spec.type) {
        case 'progressbar': return buildProgressBar(spec);
        case 'stat':         return buildStat(spec);
        case 'alert':        return buildAlert(spec);
        case 'divider':      return buildDivider(spec);
        default:
            console.warn('[overlay] 未知组件类型:', spec.type);
            return null;
    }
}

/**
 * 创建组件并登记 spec。供 parser 的 add 指令与元素面板调用。
 * @returns {HTMLElement|null}
 */
export function createComponent(spec) {
    if (!spec || !spec.id) return null;
    const node = buildNode(spec);
    if (node) _specs.set(spec.id, { ...spec });
    return node;
}

/** 按 id 读取已登记 spec（不存在返回 undefined） */
export function getSpec(id) {
    return _specs.get(id);
}

/** 列出全部已登记 spec（供元素管理面板渲染列表） */
export function listSpecs() {
    return Array.from(_specs.values());
}

/**
 * 按 id 合并更新：把 patch 并入已存 spec，重新构建节点返回。
 * 调用方负责把返回节点替换掉舞台上的旧节点。
 * @returns {HTMLElement|null} 新节点；id 不存在则 null
 */
export function updateComponent(id, patch) {
    const prev = _specs.get(id);
    if (!prev) return null;
    const next = { ...prev, ...patch, id, type: prev.type }; // id/type 不可被 patch 改写
    _specs.set(id, next);
    return buildNode(next);
}

/** 按 id 移除 spec 登记（仅清内存；DOM 由调用方移除） */
export function removeSpec(id) {
    _specs.delete(id);
}

/** 清空全部 spec 登记 */
export function clearSpecs() {
    _specs.clear();
}

// —— 各组件构建函数 ——

function buildProgressBar(spec) {
    const { id = '', label = '', value = 0, max = 100 } = spec;
    const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

    const wrap = document.createElement('div');
    wrap.className = 'comp progressbar';
    wrap.dataset.id = id;
    wrap.dataset.type = 'progressbar';
    wrap.innerHTML = `
        <div class="pb-head">
            <span class="pb-label"></span>
            <span class="pb-num"></span>
        </div>
        <div class="pb-track"><div class="pb-fill"></div></div>
    `;
    wrap.querySelector('.pb-label').textContent = label;
    wrap.querySelector('.pb-num').textContent = `${value} / ${max}`;
    wrap.querySelector('.pb-fill').style.width = `${pct}%`;
    return wrap;
}

function buildStat(spec) {
    const { id = '', label = '', value = 0, max, unit = '' } = spec;
    const wrap = document.createElement('div');
    wrap.className = 'comp stat';
    wrap.dataset.id = id;
    wrap.dataset.type = 'stat';
    const numText = (max !== undefined && max !== null && max !== '')
        ? `${value}<span class="stat-sep">/</span><span class="stat-max">${max}</span>`
        : `${value}`;
    wrap.innerHTML = `
        <div class="stat-label"></div>
        <div class="stat-value"></div>
        <div class="stat-unit"></div>
    `;
    wrap.querySelector('.stat-label').textContent = label;
    wrap.querySelector('.stat-value').innerHTML = numText;
    wrap.querySelector('.stat-unit').textContent = unit || '';
    return wrap;
}

function buildAlert(spec) {
    const { id = '', level = 'info', text = '' } = spec;
    const wrap = document.createElement('div');
    wrap.className = `comp alert alert-${level}`;
    wrap.dataset.id = id;
    wrap.dataset.type = 'alert';
    wrap.innerHTML = `<span class="alert-glyph"></span><span class="alert-text"></span>`;
    wrap.querySelector('.alert-glyph').textContent = level === 'danger' ? '✕' : (level === 'warn' ? '!' : 'i');
    wrap.querySelector('.alert-text').textContent = text;
    return wrap;
}

function buildDivider(spec) {
    const { id = '', label = '' } = spec;
    const wrap = document.createElement('div');
    wrap.className = 'comp divider';
    wrap.dataset.id = id;
    wrap.dataset.type = 'divider';
    wrap.innerHTML = `<span class="divider-label"></span>`;
    const labelEl = wrap.querySelector('.divider-label');
    labelEl.textContent = label;
    // 无 label 时让横线铺满
    if (!label) wrap.classList.add('no-label');
    return wrap;
}