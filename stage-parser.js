// stage-parser.js — 舞台标签解析（视觉小说协议核心）
// 职责：把一条 AI 回复正文解析成「一串舞台片段 + 一串 HUD 指令」。
//   AI 不再吐自然语言文章，而是吐带标签的舞台片段：
//     <scene bg="..." fade="12s"/>   背景层，向后结转（不单独成屏）
//     <narration>白字旁白</narration>  无说话人正文 → 一片段（一屏）
//     <say char="x" pos="left" emo="y">「对白」</say>  立绘+对白 → 一片段
//     <cg img="...">caption</cg>       全屏插画 → 一片段（点击推进）
//     <item img="..." name="..." url="..." pos="float-right" clickable="true" action="（翻开 便签）" reveal="揭示">caption</item>
//       道具浮图，附着当前片段 + 进背包。clickable/action/reveal 由 AI 决定：
//       clickable="false" → 仅展示；hover 显示 reveal；click 展开额外信息（caption/reveal），不写输入框。
//       action 仅作协议提示：用户手动把 action 发到输入框后生成。
//       图片：url / img 内嵌 <fetch>路径</fetch><item/> 或 <pic>…</pic><item/> / 素材库名。
//     <overlay>{json}</overlay>        HUD 指令（progressbar/stat/alert），喂左下角状态条
//   片段粒度（已定）：每个标签 = 一屏。标签之间的裸文字也各自成 narration 片段。
//   容错：无标签的纯文字 → 整条当 narration 白字，不崩。
//
// 设计：纯函数、无 DOM 依赖，便于测试。HUD 的 <overlay> 抽取复用 parser.js。

import { extractOverlay } from './parser.js';
import { captureMedia, captureMediaMarks, hasCapturableMedia } from './media-capture.js';
import { findAssetByPath, upsertAssetByRef, normalizeCategory } from './assets-store.js';

// VN 正文必须第一行显式声明；没声明的消息一律当普通正文交给 SillyTavern 原生输出。
const VN_MARK_RE = /^\s*(?:<!--\s*OV:VN\s*-->|<ov-vn\s*\/?>|\[OV:VN\]|\[VN\])\s*(?:\r?\n)?/i;
const THINK_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const STORY_RE = /^\s*<story\b[^>]*>\s*([\s\S]*?)(?:<\/story>|$)/i;

function storyBody(mes) {
    const s = String(mes || '');
    const m = STORY_RE.exec(s);
    if (!m) return s;
    const body = m[1];
    return VN_MARK_RE.test(body) || /<think\b/i.test(body) ? body : s;
}

// 配对标签：narration / say / cg / item（非贪婪、跨行、忽略大小写）
const PAIR_RE = /<(narration|say|cg|item)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const MEDIA_RE = /<(pic|vid|video|sound|audio|bgm|sfx|voice|fetch)\b([^>]*)>([\s\S]*?)<\/\1>\s*(<\w+\s*\/?>)?/gi;
const MEDIA_ROLE_RE = /^\s*<(background|bg|scene|cg|image|pic|video|vid|bgm|music|sfx|effect|sound|voice|icon|item)\s*\/?>/i;
const MEDIA_ROLE_WORD_RE = /^(background|bg|scene|cg|image|pic|video|vid|bgm|music|sfx|effect|sound|voice|icon|item)$/i;
// 自闭合 scene：<scene .../> 或 <scene ...>
const SCENE_RE = /<scene\b([^>]*?)\/?>/gi;

/**
 * 解析属性串 ' char="alethea" pos="left" ' → { char:'alethea', pos:'left' }
 * 支持双引号/单引号/无引号值。
 */

/** 从 item 属性里解析道具图：url/src 优先；img/name/image 可为素材名或内嵌 <fetch>/<pic>。 */
function resolveItemImage(attrs) {
    const a = attrs || {};
    let url = String(a.url || a.src || '').trim();
    let name = String(a.name || a.img || a.image || a.label || '').trim();
    // 属性值里可能误写了整段 fetch/pic 标签
    const blob = [a.img, a.image, a.name, a.item, a['item image'], a.itemimage, a['item-image']].filter(Boolean).map(String).join('\n');
    if (!url && blob) {
        const fm = /<fetch\b[^>]*>([\s\S]*?)<\/fetch>/i.exec(blob);
        if (fm) {
            const asset = findAssetByPath(fm[1].trim());
            if (asset?.url) { url = asset.url; if (!name) name = asset.name || fm[1].trim(); }
        }
        if (!url) {
            const pm = /<(?:pic|img)\b[^>]*(?:src|url)=["']([^"']+)["'][^>]*>/i.exec(blob)
                || /<img\b[^>]*src=["']([^"']+)["']/i.exec(blob);
            if (pm) url = pm[1];
        }
    }
    // 纯路径/名 → 素材库
    if (!url && name) {
        const asset = findAssetByPath(name) || findAssetByPath(name.replace(/^道具\//, ''));
        if (asset?.url) { url = asset.url; name = asset.name || name; }
    }
    // 去掉 name 里残留标签
    name = name.replace(/<[^>]+>/g, '').trim() || name;
    return { url, name };
}

export function parseAttrs(str) {
    const attrs = {};
    if (typeof str !== 'string') return attrs;
    const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
    let m;
    while ((m = re.exec(str)) !== null) {
        const key = m[1].toLowerCase();
        attrs[key] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return attrs;
}

function mediaRole(attrs, suffix, inner) {
    const tag = String(attrs?._tag || '').toLowerCase();
    if (/^(bgm|sfx|voice)$/.test(tag)) return tag;
    if (attrs?.role) return String(attrs.role).toLowerCase();
    const m = MEDIA_ROLE_RE.exec(String(suffix || '')) || MEDIA_ROLE_RE.exec(String(inner || '').trim());
    if (m) return m[1].toLowerCase();
    const raw = String(attrs?._raw || '').trim();
    const head = raw.match(/^([\w-]+)/);
    return head && MEDIA_ROLE_WORD_RE.test(head[1]) ? head[1].toLowerCase() : '';
}

function audioKind(role) {
    if (/^(bgm|music)$/i.test(role || '')) return 'bgm';
    if (/^voice$/i.test(role || '')) return 'voice';
    return 'sfx';
}

/** 裸 <pic>/<vid> 生图提示词（无用途后缀）——从正文剥掉，避免与已生成的 <img> 并存时漏提示词。 */
const ORPHAN_MEDIA_PROMPT_RE = /<(pic|vid|video)\b(?![^>]*\b(?:src|url)\s*=)(?![^>]*\/>)[^>]*>([\s\S]*?)<\/\1>\s*(?!(?:<\s*(?:background|bg|scene|cg|image|pic|video|vid)\s*\/?>))/gi;


/** <save category="bg">路径</save> — 紧跟在 pic/img 后，把图入库；不渲染 */
const SAVE_RE = /<save\b([^>]*)>([\s\S]*?)<\/save>/gi;

/**
 * 处理消息里的 <save>：把前一个可捕获媒体 / genmedia url 按路径写入素材库。
 * 不改 mes 原文；返回入库条数。
 */
export function processSaveTags(mes) {
    if (typeof mes !== 'string' || !mes || !/<save\b/i.test(mes)) return 0;
    // 收集带 url 的媒体位置
    const media = [];
    if (hasCapturableMedia(mes)) {
        for (const gm of captureMediaMarks(mes)) {
            if (gm.url) media.push({ start: gm.start, end: gm.end, url: gm.url, role: gm.role || '', prompt: gm.prompt || '' });
        }
    }
    // 也认未替换的 <pic ... src/url> 与 <fetch>路径</fetch>（解析素材库 url）
    MEDIA_RE.lastIndex = 0;
    let m;
    while ((m = MEDIA_RE.exec(mes)) !== null) {
        const attrs = parseAttrs(m[2]);
        attrs._raw = m[2];
        attrs._tag = m[1];
        const role = mediaRole(attrs, m[4], m[3]);
        let url = attrs.src || attrs.url || '';
        const inner = String(m[3] || '').trim();
        if (!url && String(m[1] || '').toLowerCase() === 'fetch') {
            const asset = findAssetByPath(inner);
            if (asset?.url) url = asset.url;
        }
        if (!url) continue;
        media.push({ start: m.index, end: MEDIA_RE.lastIndex, url, role, prompt: inner });
    }
    media.sort((a, b) => a.start - b.start);

    let n = 0;
    SAVE_RE.lastIndex = 0;
    while ((m = SAVE_RE.exec(mes)) !== null) {
        const attrs = parseAttrs(m[1]);
        const ref = String(m[2] || '').trim();
        if (!ref) continue;
        // 找 save 标签前最近的媒体
        const pos = m.index;
        let best = null;
        for (const md of media) {
            if (md.end <= pos) best = md;
            else break;
        }
        if (!best?.url) continue;
        let cat = normalizeCategory(attrs.category || attrs.cat || attrs.type || '');
        if (!cat && best.role) {
            if (/^(background|bg|scene)$/i.test(best.role)) cat = 'bg';
            else if (/^(cg|image|pic)$/i.test(best.role)) cat = 'cg';
            else if (/^item$/i.test(best.role)) cat = 'item';
        }
        const entry = upsertAssetByRef(ref, best.url, { category: cat, tag: attrs.tag || '' });
        if (entry) n++;
    }
    return n;
}
function stripOrphanMediaPrompts(text) {
    if (typeof text !== 'string' || !text) return '';
    // 1) 剥掉「后面不带用途后缀」的裸 pic/vid 提示词标签
    let out = text.replace(ORPHAN_MEDIA_PROMPT_RE, '');
    // 2) 剥掉已捕获的背景/CG 生图 <img>/<video>…（含后缀），只留真正的聊天正文
    if (hasCapturableMedia(out)) {
        const sources = [];
        MEDIA_RE.lastIndex = 0;
        let m;
        while ((m = MEDIA_RE.exec(out)) !== null) {
            const attrs = parseAttrs(m[2]);
            attrs._raw = m[2];
            attrs._tag = m[1];
            sources.push({ type: m[1].toLowerCase(), role: mediaRole(attrs, m[4], m[3]), start: m.index, end: MEDIA_RE.lastIndex });
        }
        const marks = captureMediaMarks(out).slice().sort((a, b) => b.start - a.start);
        for (const gm of marks) {
            if (!/^(background|bg|scene|cg|image|pic|video|vid)$/i.test(gm.role || '')) continue;
            let start = gm.start;
            for (let i = sources.length - 1; i >= 0; i--) {
                if (!isGeneratedMediaReplacement(out, sources[i], gm)) continue;
                start = sources[i].start;
                break;
            }
            out = out.slice(0, start) + out.slice(gm.end);
        }
    }
    out = out.replace(/<save\b[^>]*>[\s\S]*?<\/save>/gi, '');
    return out.replace(/\n{3,}/g, '\n\n').trim();
}

function isGeneratedMediaReplacement(text, source, generated) {
    const sourceType = String(source?.type || source?.attrs?._tag || '').toLowerCase();
    const sourceKind = sourceType === 'pic' ? 'pic' : /^(vid|video)$/.test(sourceType) ? 'video' : '';
    const generatedKind = generated?.kind === 'video' ? 'video' : generated?.kind === 'pic' ? 'pic' : '';
    if (!sourceKind || sourceKind !== generatedKind || source.end > generated.start) return false;
    if (text.slice(source.end, generated.start).trim()) return false;

    const normalizeRole = (role) => {
        const value = String(role || '').toLowerCase();
        if (/^(background|bg|scene)$/.test(value)) return 'background';
        if (/^(cg|image|pic)$/.test(value)) return 'cg';
        if (/^(video|vid)$/.test(value)) return 'video';
        return value;
    };
    const sourceRole = normalizeRole(source.role);
    const generatedRole = normalizeRole(generated.role);
    return !sourceRole || !generatedRole || sourceRole === generatedRole;
}

/**
 * 非 VN 楼层若「只剩生图媒体」（背景/CG/视频）→ 按舞台处理，不进 plain 全文。
 * 仅背景 → fragments 空 + lastScene；有 CG/视频 → 对应片段。
 */
function tryParseMediaOnlyFloor(text, thinking) {
    if (!hasCapturableMedia(text) && !/<(pic|vid|video|fetch)\b/i.test(text || '')) return null;
    // 去掉裸提示词与 capturable 后若还有实质正文 → 不是 media-only
    const rest = stripOrphanMediaPrompts(text);
    // strip 后仍有非空白且不像纯 HTML 残渣
    const restPlain = rest.replace(/<[^>]+>/g, '').trim();
    if (restPlain) return null;

    const marks = hasCapturableMedia(text) ? captureMediaMarks(text) : [];
    // 也认尚未换成 img 的 <pic>…</pic><background/>
    const pending = [];
    MEDIA_RE.lastIndex = 0;
    let m;
    while ((m = MEDIA_RE.exec(text)) !== null) {
        const attrs = parseAttrs(m[2]);
        attrs._raw = m[2];
        attrs._tag = m[1];
        const role = mediaRole(attrs, m[4], m[3]);
        if (!role) continue;
        pending.push({ type: m[1].toLowerCase(), role, inner: m[3], attrs, start: m.index, end: MEDIA_RE.lastIndex });
    }
    const remainingPending = pending.filter((source) => !marks.some((generated) => isGeneratedMediaReplacement(text, source, generated)));
    if (!marks.length && !remainingPending.length) return null;

    let lastScene;
    const fragments = [];
    for (const gm of marks) {
        if (/^(background|bg|scene)$/i.test(gm.role || '')) {
            lastScene = { bg: gm.prompt || gm.raw || '', url: gm.url || '' };
            continue;
        }
        if (gm.kind === 'audio' || /^(bgm|music|sfx|effect|sound|voice)$/i.test(gm.role || '')) continue;
        if (gm.kind === 'video' || /^(video|vid)$/i.test(gm.role || '')) {
            fragments.push({ kind: 'video', raw: gm.prompt || '', url: gm.url, poster: '', scene: lastScene, items: [], audio: [] });
        } else {
            fragments.push({ kind: 'cg', raw: gm.prompt || '', img: gm.prompt || '', url: gm.url, scene: lastScene, items: [], audio: [] });
        }
    }
    for (const p of remainingPending) {
        if (/^(background|bg|scene)$/i.test(p.role)) {
            const label = (p.inner || '').replace(MEDIA_ROLE_RE, '').trim();
            lastScene = { bg: lastScene?.bg || label, url: p.attrs.src || p.attrs.url || lastScene?.url || '' };
            continue;
        }
        if (/^(cg|image|pic)$/i.test(p.role)) {
            fragments.push({
                kind: 'cg', raw: (p.inner || '').replace(MEDIA_ROLE_RE, '').trim(),
                img: p.attrs.img || '', url: p.attrs.src || p.attrs.url || '',
                scene: lastScene, items: [], audio: [],
            });
        }
    }
    // 只有背景、无 CG/视频 → 不成屏
    if (!fragments.length) {
        if (!lastScene) return null;
        return { fragments: [], hudOps: [], items: [], plain: false, thinking: thinking || '', lastScene };
    }
    return { fragments, hudOps: [], items: [], plain: false, thinking: thinking || '', lastScene };
}

export function stripVnMarker(mes) {
    return typeof mes === 'string' ? storyBody(mes).replace(VN_MARK_RE, '') : '';
}

export function splitThinking(mes) {
    const chunks = [];
    let text = storyBody(mes).replace(THINK_RE, (_all) => {
        const inner = _all.replace(/^<think\b[^>]*>/i, '').replace(/<\/think>$/i, '').trim();
        if (inner) chunks.push(inner);
        return '';
    });
    text = text.replace(/<think\b[^>]*>[\s\S]*$/i, (_all) => {
        const inner = _all.replace(/^<think\b[^>]*>/i, '').trim();
        if (inner) chunks.push(inner);
        return '';
    });
    return { text, thinking: chunks.join('\n\n') };
}

function closeLiveTail(text) {
    const s = String(text || '');
    const m = s.match(/<(narration|say|cg|item)\b[^>]*>(?![\s\S]*<\/\1>)[\s\S]*$/i);
    return m ? s + `</${m[1].toLowerCase()}>` : s;
}

export function isVnStageMessage(mes) {
    return typeof mes === 'string' && VN_MARK_RE.test(storyBody(mes));
}

export function hasOverlayStageTags(mes) {
    if (!isVnStageMessage(mes)) return false;
    mes = stripVnMarker(mes);
    if (/<overlay>[\s\S]*?<\/overlay>/i.test(mes)) return true;
    if (/<scene\b|<(narration|say|cg|item)\b/i.test(mes)) return true;
    MEDIA_RE.lastIndex = 0;
    let m;
    while ((m = MEDIA_RE.exec(mes)) !== null) {
        if (mediaRole({ ...parseAttrs(m[2]), _raw: m[2], _tag: m[1] }, m[4], m[3])) return true;
    }
    // 生图引擎已把 <pic> 换成 <img …>（title/后缀带用途）的楼层也算舞台内容
    if (hasCapturableMedia(mes) && captureMediaMarks(mes).length) return true;
    return false;
}

export function stripOverlayStageTags(mes) {
    if (typeof mes !== 'string') return '';
    let out = stripVnMarker(mes)
        .replace(THINK_RE, '')
        .replace(/<scene\b[^>]*\/?>/gi, '')
        .replace(/<(narration|say|cg|item)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<overlay>[\s\S]*?<\/overlay>/gi, '')
        .replace(/<save\b[^>]*>[\s\S]*?<\/save>/gi, '')
        .replace(/<fetch\b[^>]*>[\s\S]*?<\/fetch>/gi, '');
    MEDIA_RE.lastIndex = 0;
    out = out.replace(MEDIA_RE, (all, _tag, rawAttrs, _inner, suffix) => {
        // fetch 一律剥；其它带用途后缀的媒体剥
        if (String(_tag || '').toLowerCase() === 'fetch') return '';
        return mediaRole({ ...parseAttrs(rawAttrs), _raw: rawAttrs, _tag: _tag }, suffix, _inner) ? '' : all;
    });
    return out;
}

/**
 * 剥一对平衡括号段（支持嵌套）。用于酒馆气泡隐藏 {json} 等。
 * @param {string} text
 * @param {string} open
 * @param {string} close
 */
function stripBalancedPairs(text, open, close) {
    let s = String(text || '');
    let guard = 0;
    while (guard++ < 64) {
        let depth = 0;
        let start = -1;
        let found = false;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (ch === open) {
                if (depth === 0) start = i;
                depth++;
            } else if (ch === close && depth > 0) {
                depth--;
                if (depth === 0 && start >= 0) {
                    s = s.slice(0, start) + s.slice(i + 1);
                    found = true;
                    break;
                }
            }
        }
        if (!found) break;
    }
    return s;
}

/**
 * 酒馆原生气泡用：舞台标签 + 裸 {json} + 括号段全部隐藏。
 * 只应写进 extra.display_text，绝不动 mes（sandbox / 解析仍读原文）。
 */
export function stripForTavernDisplay(mes) {
    if (typeof mes !== 'string') return '';
    let out = stripOverlayStageTags(mes);
    // 再清一轮可能残留的 stage/overlay 字样
    out = out
        .replace(/<scene\b[^>]*\/?>/gi, '')
        .replace(/<(narration|say|cg|item)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<overlay>[\s\S]*?<\/overlay>/gi, '');
    // 裸 HUD/JSON：{"op":"add",...}
    out = stripBalancedPairs(out, '{', '}');
    // 括号：半角 + 全角（用户要求气泡里整段隐藏）
    out = out.replace(/\([^)]*\)/g, '').replace(/（[^）]*）/g, '');
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 把一条消息正文解析为舞台片段 + HUD 指令。
 * @param {string} mes 原始消息文本（含标签）
 * @returns {{ fragments: object[], hudOps: object[], items: object[] }}
 *   fragment: { kind:'narration'|'say'|'cg', raw, speaker?, pos?, emo?, scene?, img?, items[] }
 *   scene:    { bg, fade } 或 undefined（向后结转，由 reader 跨楼层继承）
 *   item:     { img, pos, caption }
 */
export function parseStageMessage(mes, opts = {}) {
    const fragments = [];
    const items = [];           // 本条消息累计的全部道具（喂背包）
    if (typeof mes !== 'string' || mes.length === 0) {
        return { fragments, hudOps: [], items };
    }

    // 第一行没有 VN 标记：默认普通正文。但「只含带用途后缀的生图媒体」仍走舞台（背景不成屏）。
    if (!isVnStageMessage(mes)) {
        const split = splitThinking(mes);
        const mediaOnly = tryParseMediaOnlyFloor(split.text, split.thinking);
        if (mediaOnly) return mediaOnly;
        // 剥掉残留的裸 <pic>提示词</pic>（生图后常与 <img> 并存），避免提示词漏进正文
        const whole = stripOrphanMediaPrompts(split.text).trim();
        return {
            fragments: whole ? [{ kind: 'plain', raw: whole, scene: undefined, items: [], audio: [] }] : [],
            hudOps: [], items, plain: true, thinking: split.thinking,
        };
    }

    // 1) 先抽走 <overlay>{json}</overlay> → HUD 指令；余文进标签扫描
    const split = splitThinking(stripVnMarker(mes));
    const { cleanedText, payloads: hudOps } = extractOverlay(split.text);
    let text = opts.live ? closeLiveTail(cleanedText) : cleanedText;
    // <save> 只入库，不进正文/片段；processSaveTags 另走原文
    text = text.replace(SAVE_RE, '');

    // 2) 收集所有「标记」（scene 自闭合 + 配对标签），按出现位置排序，
    //    标记之间的裸文字段 → narration 片段。
    const marks = [];
    let m;

    SCENE_RE.lastIndex = 0;
    while ((m = SCENE_RE.exec(text)) !== null) {
        marks.push({ start: m.index, end: SCENE_RE.lastIndex, type: 'scene', attrs: parseAttrs(m[1]) });
    }
    PAIR_RE.lastIndex = 0;
    while ((m = PAIR_RE.exec(text)) !== null) {
        marks.push({
            start: m.index, end: PAIR_RE.lastIndex,
            type: m[1].toLowerCase(), attrs: parseAttrs(m[2]), inner: m[3],
        });
    }
    MEDIA_RE.lastIndex = 0;
    while ((m = MEDIA_RE.exec(text)) !== null) {
        const attrs = parseAttrs(m[2]);
        attrs._raw = m[2];
        attrs._tag = m[1];
        const role = mediaRole(attrs, m[4], m[3]);
        // 裸 <pic>/<vid> 也要进 marks（吞掉区间），否则中间的提示词会当 narration 漏出一屏
        marks.push({
            start: m.index, end: MEDIA_RE.lastIndex,
            type: m[1].toLowerCase(), role: role || '', attrs, inner: m[3],
        });
    }
    // 生图引擎产物：<pic>提示词</pic><background/> 被原地换成 <img …>（后缀留在 img 后）→
    //   从 title/后缀读回用途，定位成标记。背景并入当前 scene，CG/视频成片段，
    //   同时把 <img> 与后缀从旁白正文里吃掉。
    if (hasCapturableMedia(text)) {
        for (const gm of captureMediaMarks(text)) {
            // 生图插件会保留原始 <pic>/<vid> 请求，再紧邻插入生成结果；二者是同一媒体，不应各成一个片段。
            let start = gm.start;
            for (let i = marks.length - 1; i >= 0; i--) {
                if (!isGeneratedMediaReplacement(text, marks[i], gm)) continue;
                start = marks[i].start;
                marks.splice(i, 1);
                break;
            }
            const generatedMark = { start, end: gm.end, type: 'genmedia', role: gm.role, attrs: {}, inner: '', url: gm.url, prompt: gm.prompt, genKind: gm.kind };
            const overlap = marks.find((k) => gm.start < k.end && gm.end > k.start);
            if (overlap) Object.assign(overlap, generatedMark);
            else marks.push(generatedMark);
        }
    }
    marks.sort((a, b) => a.start - b.start);

    // 3) 当前结转的 scene（楼层内向后沿用）；当前可附着 item 的片段
    let curScene = undefined;
    let lastFrag = null;        // 最近产出的片段，供 item/audio 附着
    let cursor = 0;
    const pendingItems = [];    // 出现在任何片段之前的 item，灌给首个后继片段
    const pendingAudio = [];    // 出现在任何片段之前的音频，灌给首个后继片段
    const drainPending = (frag) => {
        if (pendingItems.length) { frag.items.push(...pendingItems); pendingItems.length = 0; }
        if (pendingAudio.length) { frag.audio.push(...pendingAudio); pendingAudio.length = 0; }
    };

    const pushNarrationText = (rawText) => {
        const t = (rawText || '').trim();
        if (!t) return;
        lastFrag = { kind: 'narration', raw: t, scene: curScene, items: [], audio: [] };
        drainPending(lastFrag);
        fragments.push(lastFrag);
    };

    for (const mk of marks) {
        // 标记前的裸文字 → narration 片段
        if (mk.start > cursor) pushNarrationText(text.slice(cursor, mk.start));
        cursor = mk.end;

        if (mk.type === 'scene') {
            curScene = { bg: mk.attrs.bg || '', fade: mk.attrs.fade || '', url: mk.attrs.url || mk.attrs.src || '' };
            continue; // scene 不单独成屏，只切换背景结转
        }
        if (mk.type === 'item') {
            const clickable = mk.attrs.clickable === undefined ? null
                : /^(1|true|yes|on)$/i.test(String(mk.attrs.clickable));
            const resolved = resolveItemImage(mk.attrs);
            const item = {
                img: resolved.name || mk.attrs.img || mk.attrs.name || '',
                pos: mk.attrs.pos || 'float-right',
                caption: (mk.inner || '').trim(),
                clickable,                                  // null=未声明(默认可点), true=可点, false=不可点
                action: (mk.attrs.action || '').trim() || '',// 协议动作文案（用户手动发送）；不再自动写入输入框
                reveal: (mk.attrs.reveal || '').trim() || '',// 悬停显示；点击后与 caption 一并钉住
                url: resolved.url || '',
            };
            items.push(item);
            if (lastFrag) lastFrag.items.push(item);
            else pendingItems.push(item);
            continue;
        }
        if (mk.type === 'genmedia') {
            const role = mk.role || '';
            if (mk.genKind === 'audio' || /^(bgm|music|sfx|effect|sound|voice)$/i.test(role)) {
                const audio = { kind: audioKind(role), src: mk.url, volume: '', loop: /^(bgm|music)$/i.test(role), caption: mk.prompt || '' };
                if (lastFrag) lastFrag.audio.push(audio);
                else pendingAudio.push(audio);
                continue;
            }
            if (/^(background|bg|scene)$/i.test(role)) {
                // 生成的背景图贴到当前 scene：保留 <scene bg="…"/> 的场景名，只补真图 url
                curScene = { bg: curScene?.bg || mk.prompt || '', fade: curScene?.fade || '', url: mk.url };
                continue;
            }
            if (/^item$/i.test(role)) {
                const item = {
                    img: mk.prompt || '',
                    pos: 'float-right',
                    caption: mk.prompt || '',
                    clickable: null,
                    action: '',
                    reveal: '',
                    url: mk.url || '',
                };
                items.push(item);
                if (lastFrag) lastFrag.items.push(item);
                else pendingItems.push(item);
                continue;
            }
            if (mk.genKind === 'video' || /^(video|vid)$/i.test(role)) {
                lastFrag = { kind: 'video', raw: mk.prompt || '', url: mk.url, poster: '', scene: curScene, items: [], audio: [] };
            } else {
                lastFrag = { kind: 'cg', raw: mk.prompt || '', img: mk.prompt || '', url: mk.url, scene: curScene, items: [], audio: [] };
            }
            drainPending(lastFrag);
            fragments.push(lastFrag);
            continue;
        }
        const t = mk.type === 'vid' ? 'video' : mk.type === 'sound' || mk.type === 'audio' ? audioKind(mk.role) : mk.type;
        if (t === 'bgm' || t === 'sfx' || t === 'voice') {
            const audio = {
                kind: t,
                src: mk.attrs.src || mk.attrs.url || '',
                volume: mk.attrs.volume || '',
                loop: mk.attrs.loop === undefined ? t === 'bgm' : /^(1|true|yes|on)$/i.test(String(mk.attrs.loop)),
                caption: (mk.inner || '').replace(MEDIA_ROLE_RE, '').trim(),
            };
            if (lastFrag) lastFrag.audio.push(audio);
            else pendingAudio.push(audio);
            continue;
        }
        if (mk.type === 'say') {
            lastFrag = {
                kind: 'say', raw: (mk.inner || '').trim(),
                speaker: mk.attrs.char || '', pos: mk.attrs.pos || 'left', emo: mk.attrs.emo || '',
                scene: curScene, items: [], audio: [],
                // 对白片段也可由 AI 标记为可点击（如「这段话可作为行动入口」）
                clickable: mk.attrs.clickable === undefined ? null
                    : /^(1|true|yes|on)$/i.test(String(mk.attrs.clickable)),
                action: (mk.attrs.action || '').trim() || '',
                reveal: (mk.attrs.reveal || '').trim() || '',
            };
            drainPending(lastFrag);
            fragments.push(lastFrag);
            continue;
        }
        if (mk.type === 'cg' || mk.type === 'pic' || mk.type === 'fetch') {
            // <fetch>路径</fetch><background|cg|item…/>：从素材库取 url，规则同 <pic> 后缀
            let label = (mk.inner || '').replace(MEDIA_ROLE_RE, '').trim();
            let url = mk.attrs.src || mk.attrs.url || '';
            if (mk.type === 'fetch') {
                const asset = findAssetByPath(label);
                if (asset?.url) {
                    url = asset.url;
                    label = asset.name || label;
                }
            }
            if (/^(background|bg|scene)$/i.test(mk.role || '')) {
                // <pic>…</pic><background/> 或 <fetch>路径</fetch><background/>
                curScene = { bg: curScene?.bg || label, fade: mk.attrs.fade || curScene?.fade || '', url: url || curScene?.url || '' };
                continue;
            }
            if (/^item$/i.test(mk.role || '')) {
                const item = {
                    img: label || mk.attrs.img || mk.attrs.name || '',
                    pos: mk.attrs.pos || 'float-right',
                    caption: (mk.attrs.caption || label || '').trim() || label,
                    clickable: mk.attrs.clickable === undefined ? null
                        : /^(1|true|yes|on)$/i.test(String(mk.attrs.clickable)),
                    action: (mk.attrs.action || '').trim() || '',
                    reveal: (mk.attrs.reveal || '').trim() || '',
                    url: url || '',
                };
                items.push(item);
                if (lastFrag) lastFrag.items.push(item);
                else pendingItems.push(item);
                continue;
            }
            // 裸 <pic>/<fetch> 无用途后缀：pic=生图请求；fetch=只吞路径不渲染。
            // 但 <cg> 不能一起丢：它是协议里的一等标签（<cg img="…">caption</cg>），
            // 由 PAIR_RE 匹配，而 role 只在 MEDIA_RE 那条路上才会被赋值——
            // 也就是说 <cg> 的 role 恒为 undefined，跟着 pic/fetch 一起 continue
            // 等于让手写的 <cg> 永远解析不出片段（生图产出的 CG 走 genmedia 分支，不受影响）。
            if (!mk.role && mk.type !== 'cg') continue;
            lastFrag = {
                kind: 'cg',
                raw: label,
                img: mk.attrs.img || label,
                url: url || '',
                scene: curScene,
                items: [],
                audio: [],
            };
            drainPending(lastFrag);
            fragments.push(lastFrag);
            continue;
        }
        if (mk.type === 'video' || mk.type === 'vid') {
            // 裸 <vid> 提示词：同 pic，不成屏
            if (!mk.role && !mk.attrs?.src && !mk.attrs?.url) continue;
            lastFrag = { kind: 'video', raw: (mk.inner || '').replace(MEDIA_ROLE_RE, '').trim(), url: mk.attrs.src || mk.attrs.url || '', poster: mk.attrs.poster || '', scene: curScene, items: [], audio: [] };
            drainPending(lastFrag);
            fragments.push(lastFrag);
            continue;
        }
        if (mk.type === 'narration') {
            lastFrag = { kind: 'narration', raw: (mk.inner || '').trim(), scene: curScene, items: [], audio: [] };
            drainPending(lastFrag);
            fragments.push(lastFrag);
            continue;
        }
    }
    // 末尾剩余裸文字
    if (cursor < text.length) pushNarrationText(text.slice(cursor));

    // 仅有 scene/背景/音频/道具等「不成屏」标记 → 不硬补 narration 屏（否则单条 <pic>…</pic><background/>
    // 会变成一整屏旁白，把生图提示词当正文）。场景结转靠返回 lastScene，由 rebuild 继承。
    // （旧逻辑：if (!fragments.length && marks.length) push empty narration with curScene.bg）

    // 关键：没有任何舞台标签（scene/say/cg/narration/item）的楼层 = 「普通楼层」。
    //   不拆片段、不做视觉小说处理，整条作为一片完整正文显示（plain），像正常聊天一样。
    //   注意：仅有 <overlay> HUD 也算无舞台标签 → 仍按普通楼层显示其文字。
    const hadStageTags = marks.length > 0;
    if (!hadStageTags) {
        if (hasCapturableMedia(text)) {
            const media = captureMedia(text);
            const audio = media
                .filter((m) => m.kind === 'audio')
                .map((m) => ({ kind: audioKind(m.role), src: m.url, volume: '', loop: /^(bgm|music)$/i.test(m.role || ''), caption: m.prompt || m.raw || '' }));
            const visual = media.filter((m) => m.kind !== 'audio');
            // 仅背景图：不成屏，只回传 lastScene
            const onlyBg = visual.length > 0 && visual.every((m) => /^(background|bg|scene)$/i.test(m.role || ''));
            if (onlyBg) {
                const m0 = visual[visual.length - 1];
                return {
                    fragments: [],
                    hudOps, items, plain: false, thinking: split.thinking,
                    lastScene: { bg: m0.prompt || m0.raw || '', url: m0.url || '' },
                };
            }
            if (visual.length) {
                return {
                    fragments: visual.map((m) => {
                        const isBg = /^(background|bg|scene)$/i.test(m.role || '');
                        return {
                            kind: isBg ? 'narration' : m.kind === 'video' ? 'video' : 'cg',
                            raw: isBg ? '' : (m.prompt || m.raw || ''),
                            img: m.prompt || m.raw || '',
                            url: isBg ? '' : m.url,
                            scene: isBg ? { bg: m.prompt || m.raw || '', url: m.url } : undefined,
                            items: [],
                            audio: audio.splice(0),
                        };
                    }).filter((f) => f.kind !== 'narration' || f.raw || f.scene?.url),
                    hudOps, items, plain: false, thinking: split.thinking,
                    lastScene: curScene,
                };
            }
        }
        const whole = text.trim();
        const fragments2 = whole
            ? [{ kind: 'plain', raw: whole, scene: undefined, items: [], audio: [] }]
            : [];
        return { fragments: fragments2, hudOps, items, plain: true, thinking: split.thinking, lastScene: curScene };
    }

    if (pendingAudio.length && fragments.length) fragments[fragments.length - 1].audio.push(...pendingAudio);
    return { fragments, hudOps, items, plain: false, thinking: split.thinking, lastScene: curScene };
}



