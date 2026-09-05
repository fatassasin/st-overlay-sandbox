// parser.js — B 层语义指令：拦截 + 解析 + 分发
// 职责：
//   1) 从文本里提取所有 <overlay>…</overlay> 段，返回「去掉这些段后的干净文本」
//   2) 把每段内部 JSON 解析成指令对象
//   3) 按 op 分发，操作舞台元素：add / update / remove / clear

import { createComponent, updateComponent, removeSpec, clearSpecs, getSpec, removeSpecsByOrigin } from './components.js';
import { getStatus } from './overlay.js';

// 匹配 <overlay> ... </overlay>，非贪婪，跨行，忽略大小写
const OVERLAY_RE = /<overlay>([\s\S]*?)<\/overlay>/gi;

/**
 * 从文本中提取 overlay 指令。
 * @param {string} text
 * @returns {{ cleanedText: string, payloads: object[] }}
 */
export function extractOverlay(text) {
    const payloads = [];
    if (typeof text !== 'string' || text.length === 0) {
        return { cleanedText: text ?? '', payloads };
    }

    let match;
    OVERLAY_RE.lastIndex = 0;
    while ((match = OVERLAY_RE.exec(text)) !== null) {
        const raw = match[1].trim();
        const parsed = safeParseJSON(raw);
        if (parsed !== undefined) {
            if (Array.isArray(parsed)) payloads.push(...parsed);
            else payloads.push(parsed);
        }
    }

    const cleanedText = text.replace(OVERLAY_RE, '').replace(/\n{3,}/g, '\n\n').trim();
    return { cleanedText, payloads };
}

/** 宽松解析：纯 JSON。失败返回 undefined 并告警（不抛错中断管线）。 */
function safeParseJSON(raw) {
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.warn('[overlay] JSON 解析失败，已跳过：', raw, e);
        return undefined;
    }
}

/**
 * 调试用：解析「自由文本」。兼容 <overlay>…</overlay> 标签文本与直接粘贴的纯 JSON。
 * @returns {object[]} 指令对象数组
 */
export function parseFreeText(text) {
    if (typeof text !== 'string') return [];
    const trimmed = text.trim();
    if (/<overlay>/i.test(trimmed)) {
        return extractOverlay(trimmed).payloads;
    }
    const parsed = safeParseJSON(trimmed);
    if (parsed === undefined) return [];
    return Array.isArray(parsed) ? parsed : [parsed];
}

/** 在状态条容器里按 id 查找现有节点 */
function findNode(id) {
    const stage = getStatus();
    if (!stage || !id) return null;
    return stage.querySelector(`[data-id="${cssEscape(id)}"]`);
}

/** 转义 data-id 选择器里的特殊字符 */
function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
}

/**
 * 按指令分发执行：add / update / remove / clear。
 * @param {object} payload
 */
export function applyInstruction(payload, origin = '') {
    if (!payload || typeof payload !== 'object') return;
    const stage = getStatus();
    if (!stage) return;

    switch (payload.op) {
        case 'add': {
            const node = createComponent(payload, origin);
            if (!node) return;
            // id 已存在则替换（幂等，避免重复堆叠）
            const existing = findNode(payload.id);
            if (existing) existing.replaceWith(node);
            else stage.appendChild(node);
            break;
        }

        case 'update': {
            if (!getSpec(payload.id)) {
                console.warn('[overlay] update 找不到元素 id:', payload.id, '；已忽略。');
                return;
            }
            const node = updateComponent(payload.id, payload);
            if (!node) return;
            const existing = findNode(payload.id);
            if (existing) existing.replaceWith(node);
            else stage.appendChild(node);
            break;
        }

        case 'remove': {
            const existing = findNode(payload.id);
            if (existing) existing.remove();
            removeSpec(payload.id);
            break;
        }

        case 'clear': {
            stage.innerHTML = '';
            clearSpecs();
            break;
        }

        default:
            console.warn('[overlay] 未知指令 op:', payload.op, payload);
    }
}

/** 便捷批量执行。origin 透传给 add 指令，供后续按来源定点清理。 */
export function applyAll(payloads, origin = '') {
    if (!Array.isArray(payloads)) return;
    for (const p of payloads) applyInstruction(p, origin);
}

/** 按来源清除组件（DOM + spec 登记）。
 *  测试预览退出时调 clearByOrigin('test')：只摘测试灌进来的状态条，
 *  真实消息创建的组件保持原样——两者共用同一个 _specs，不能用 clearSpecs 一把梭。 */
export function clearByOrigin(origin) {
    const ids = removeSpecsByOrigin(origin);
    if (!ids.length) return 0;
    for (const id of ids) {
        const node = findNode(id);
        if (node) node.remove();
    }
    return ids.length;
}
