// 纯文本语义分段：供阅读器给括号内容套颜色，也可在 Node 中独立自检。
const BRACKET_RE = /(\([^()\n]*\)|（[^（）\n]*）|\[[^\[\]\n]*\]|［[^［］\n]*］|【[^【】\n]*】|\{[^{}\n]*\}|｛[^｛｝\n]*｝|〔[^〔〕\n]*〕)/g;

export function splitBracketSegments(text) {
    const value = String(text || '');
    const out = [];
    let at = 0;
    for (const match of value.matchAll(BRACKET_RE)) {
        if (match.index > at) out.push({ text: value.slice(at, match.index), bracket: false });
        out.push({ text: match[0], bracket: true });
        at = match.index + match[0].length;
    }
    if (at < value.length) out.push({ text: value.slice(at), bracket: false });
    return out.length ? out : [{ text: value, bracket: false }];
}

export function selfCheckTextColoring() {
    const got = splitBracketSegments('正文（旁白） and [note] `code`');
    const marked = got.filter((part) => part.bracket).map((part) => part.text);
    if (marked.join('|') !== '（旁白）|[note]') throw new Error('bracket segmentation failed');
    return true;
}
