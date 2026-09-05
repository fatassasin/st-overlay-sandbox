// media-capture.js — 捕获 #pic / #video 生成的媒体（纯函数，无 DOM 依赖）
// 背景：ST 的 #pic / #video 命令在聊天楼层里产出形如：
//   <img src="http://127.0.0.1:8188/view?filename=xxx.png&subfolder=&type=output"
//        title="<pic>prompt=medium shot ...|w=896|h=1152</pic>">
//   （视频同理，title 内为 <video>...</video>；src 指向视频或其封面）
// 本模块的职责【仅仅是捕获】：从一段文本里抽出这些媒体的「地址」+「下方 Raw 数据」
//   （title 里 <pic>/<video> 包裹的原始 prompt 与宽高），交给上层（阅读器/资产）使用。
//
// 设计：容错——title 可能被 HTML 实体转义（&lt;pic&gt; / &quot; / &amp;）；src 同理。
//   先做一次轻量实体解码，再用正则抽取，不依赖 DOMParser（便于 node 测试）。

// 匹配 <img ...> 与 <video ...>（含自闭合 / 配对，惰性，跨行）
const IMG_RE = /<img\b([^>]*?)\/?>/gi;
const VIDEO_RE = /<video\b([^>]*?)\/>|<video\b([^>]*?)>([\s\S]*?)<\/video>/gi;
const AUDIO_RE = /<audio\b([^>]*?)>([\s\S]*?)<\/audio>|<audio\b([^>]*?)\/?>/gi;
const ROLE_RE = /^\s*<(background|bg|scene|cg|image|pic|video|vid|bgm|music|sfx|effect|sound|voice|icon|item)\s*\/?>/i;
const ROLE_WORD_RE = /^(background|bg|scene|cg|image|pic|video|vid|bgm|music|sfx|effect|sound|voice|icon|item)$/i;
// 从属性串里取某属性值（双/单引号）
function attr(attrStr, name) {
    const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i');
    const m = re.exec(attrStr || '');
    return m ? (m[1] ?? m[2] ?? '') : '';
}

/** 轻量 HTML 实体解码（够用即可：&lt; &gt; &quot; &#39; &amp;；&amp; 最后处理避免二次解码） */
export function decodeEntities(s) {
    if (typeof s !== 'string') return '';
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;|&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * 解析 title 里的 Raw 数据：<pic background>prompt=...</pic> 或 <video cg>...</video><background>。
 * 裸 <pic>/<video>/<sound> 只算正文媒体，不升级成 overlay 楼层。
 * @param {string} titleRaw 元素 title 属性原文
 * @param {string} [fallbackRole] title 里没有 role 时的兜底（元素后紧跟的后缀标记，如 <background/>）
 * @returns {{ kind:'pic'|'video'|'audio'|'media', role:string, prompt:string, w?:number, h?:number, raw:string }|null}
 */
export function parseRaw(titleRaw, fallbackRole = '') {
    const title = decodeEntities(titleRaw || '').trim();
    let kind = 'media';
    let role = '';
    let body = title;
    const wrap = /<(pic|vid|video|sound|audio)\b([^>]*)>([\s\S]*?)<\/\1>\s*(<\w+\s*\/?>)?/i.exec(title);
    if (wrap) {
        kind = wrap[1].toLowerCase();
        if (kind === 'vid') kind = 'video';
        if (kind === 'sound') kind = 'audio';
        body = wrap[3].trim();
        role = mediaRole(wrap[2]) || mediaRole(wrap[4]) || mediaRole(body);
    } else {
        role = mediaRole(title);
    }
    if (!role) role = String(fallbackRole || '').toLowerCase();
    if (!role) return null;
    // body 形如 "prompt=...|w=896|h=1152"，用 | 分段
    const parts = body.split('|');
    let prompt = '';
    let w, h;
    for (const p of parts) {
        const seg = p.trim();
        const kv = /^(\w+)\s*=\s*([\s\S]*)$/.exec(seg);
        if (kv) {
            const key = kv[1].toLowerCase();
            const val = kv[2].trim();
            if (key === 'prompt') prompt = val;
            else if (key === 'w') w = Number(val) || undefined;
            else if (key === 'h') h = Number(val) || undefined;
        } else if (!prompt) {
            prompt = seg; // 无 key=value 时整段当 prompt
        }
    }
    return { kind, role, prompt, w, h, raw: body };
}

function mediaRole(s) {
    const raw = String(s || '').trim();
    const m = ROLE_RE.exec(raw);
    if (m) return m[1].toLowerCase();
    const head = raw.match(/^([\w-]+)/);
    return head && ROLE_WORD_RE.test(head[1]) ? head[1].toLowerCase() : '';
}

/**
 * 带位置的媒体捕获：除 title 元数据外，还识别元素后紧跟的用途后缀标记
 * （生图引擎把 <pic>prompt</pic><background/> 原地换成 <img ...> 后，后缀会留在 img 后面，
 *   插件从这里读回该图的用途；后缀被并入 [start,end)，不会漏进正文）。
 * @param {string} text 楼层原始文本（可能含 HTML 实体转义）
 * @returns {Array<{ start:number, end:number, kind:'pic'|'video'|'audio'|'media', role:string, url:string, prompt:string, w?:number, h?:number, raw:string }>}
 */
export function captureMediaMarks(text) {
    if (typeof text !== 'string' || !text) return [];
    const out = [];
    // 元素后紧跟的角色后缀：<background/> / <cg/> / <video/> …（允许空白/换行分隔）
    const suffixAt = (idx) => {
        const m = ROLE_RE.exec(text.slice(idx, idx + 64));
        return m ? { role: m[1].toLowerCase(), len: m[0].length } : null;
    };

    IMG_RE.lastIndex = 0;
    let m;
    while ((m = IMG_RE.exec(text)) !== null) {
        const attrs = m[1] || '';
        const url = decodeEntities(attr(attrs, 'src'));
        if (!url) continue;
        let end = IMG_RE.lastIndex;
        const suf = suffixAt(end);
        const meta = parseRaw(attr(attrs, 'title'), suf ? suf.role : '');
        if (!meta) continue;
        if (suf) end += suf.len;
        if (!meta.prompt) meta.prompt = decodeEntities(attr(attrs, 'alt'));
        out.push({ start: m.index, end, kind: meta.kind === 'video' ? 'video' : meta.kind === 'audio' ? 'audio' : 'pic', role: meta.role, url, prompt: meta.prompt, w: meta.w, h: meta.h, raw: meta.raw });
    }

    VIDEO_RE.lastIndex = 0;
    while ((m = VIDEO_RE.exec(text)) !== null) {
        const attrs = m[1] || m[2] || '';
        const inner = m[3] || '';
        // <video src=...> 或 <video><source src=...></video>
        let url = decodeEntities(attr(attrs, 'src'));
        if (!url && inner) url = decodeEntities(attr(inner, 'src'));
        if (!url) continue;
        let end = VIDEO_RE.lastIndex;
        const suf = suffixAt(end);
        const meta = parseRaw(attr(attrs, 'title'), suf ? suf.role : '');
        if (!meta) continue;
        if (suf) end += suf.len;
        out.push({ start: m.index, end, kind: meta.kind === 'audio' ? 'audio' : 'video', role: meta.role, url, prompt: meta.prompt, w: meta.w, h: meta.h, raw: meta.raw });
    }

    return out.sort((a, b) => a.start - b.start);
}

/**
 * 从一段文本中捕获所有 #pic / #video 媒体（无位置版，按出现顺序）。
 * @param {string} text 楼层原始文本（可能含 HTML 实体转义）
 * @returns {Array<{ kind:'pic'|'video'|'media', url:string, prompt:string, w?:number, h?:number, raw:string }>}
 */
export function captureMedia(text) {
    return captureMediaMarks(text).map(({ start, end, ...rest }) => rest);
}

/** 文本是否含可捕获媒体（快速判定，避免无谓解析） */
export function hasCapturableMedia(text) {
    return typeof text === 'string' && /<img\b|<video\b/i.test(text);
}
