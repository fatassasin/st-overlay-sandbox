// hotkey.js — 组合键的录入 / 存储 / 匹配 / 显示
// 存成 "ctrl+shift+KeyO" 这种字符串：修饰键按固定顺序在前，主键用 e.code。
// 用 code 不用 key：code 是物理键位，不随键盘布局和输入法变，也不受 Shift 影响
//（Shift+2 的 key 是 '@'、code 仍是 'Digit2'），录进去的是哪个键，按下时就还是哪个键。

const MOD_CODES = new Set([
    'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight',
]);

/** 这一下是不是只按了修饰键本身（录入时要等一个真正的主键，不能把 Ctrl 自己存进去） */
export function isModifierOnly(e) {
    if (!e) return true;
    if (MOD_CODES.has(e.code)) return true;
    return ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key);
}

/** 从 keydown 事件生成组合键字符串；只按了修饰键返回 '' */
export function fromEvent(e) {
    if (!e || isModifierOnly(e)) return '';
    const code = e.code || e.key;
    if (!code) return '';
    const parts = [];
    if (e.ctrlKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    if (e.metaKey) parts.push('meta');
    parts.push(code);
    return parts.join('+');
}

/** 拆回 { ctrl, alt, shift, meta, code }；空串/非法返回 null */
export function parse(combo) {
    const s = String(combo || '').trim();
    if (!s) return null;
    const parts = s.split('+');
    const code = parts.pop();
    if (!code) return null;
    const mods = new Set(parts.map((p) => p.toLowerCase()));
    return {
        ctrl: mods.has('ctrl'), alt: mods.has('alt'),
        shift: mods.has('shift'), meta: mods.has('meta'), code,
    };
}

/** 事件是否正好命中这个组合键（修饰键要求完全一致，多按一个也不算） */
export function matches(e, combo) {
    const want = parse(combo);
    if (!want || !e) return false;
    return !!e.ctrlKey === want.ctrl
        && !!e.altKey === want.alt
        && !!e.shiftKey === want.shift
        && !!e.metaKey === want.meta
        && (e.code || e.key) === want.code;
}

/** 是否带修饰键。不带的（单个字母/数字）在输入框里要让位，否则正常打字会被吃掉。 */
export function hasModifier(combo) {
    const p = parse(combo);
    return !!p && (p.ctrl || p.alt || p.shift || p.meta);
}

const CODE_LABELS = {
    Space: 'Space', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab', Backspace: 'Backspace',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

/** 给人看的写法：'ctrl+KeyM' → 'Ctrl + M'；空串 → '未设置' */
export function label(combo) {
    const p = parse(combo);
    if (!p) return '未设置';
    const parts = [];
    if (p.ctrl) parts.push('Ctrl');
    if (p.alt) parts.push('Alt');
    if (p.shift) parts.push('Shift');
    if (p.meta) parts.push('Meta');
    const c = p.code;
    parts.push(CODE_LABELS[c]
        || (c.startsWith('Key') ? c.slice(3) : null)
        || (c.startsWith('Digit') ? c.slice(5) : null)
        || (c.startsWith('Numpad') ? `小键盘${c.slice(6)}` : null)
        || c);
    return parts.join(' + ');
}
