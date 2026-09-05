// logger.js — 插件内日志收集器（供抽屉底部的 Log 查看器）
// 职责：维护一个环形缓冲的日志列表；捕获本扩展的 console 输出（[overlay] 前缀）+ 自有 log()；
//       提供订阅，供 Log 查看器实时刷新。
// 设计：不打断原 console（仍照常打印到 devtools）；只是顺手把相关行收进缓冲。

const MAX = 400;             // 环形缓冲上限
const _entries = [];         // { t:序号, level:'info'|'warn'|'error'|'log', msg:string }
const _subs = new Set();
let _seq = 0;
let _installed = false;

function push(level, args) {
    const msg = args.map(stringify).join(' ');
    _entries.push({ t: ++_seq, level, msg });
    if (_entries.length > MAX) _entries.splice(0, _entries.length - MAX);
    for (const fn of _subs) { try { fn(); } catch (_) {} }
}

function stringify(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    try { return JSON.stringify(a); } catch (_) { return String(a); }
}

/** 自有日志：始终入缓冲（不依赖 console 过滤）。 */
export function log(...args) { push('log', args); }
export function warn(...args) { push('warn', args); }
export function error(...args) { push('error', args); }

/**
 * 安装 console 钩子：把含 [overlay] 的行也收进缓冲。幂等。
 * 不改变 console 行为，只旁路收集。
 */
export function installConsoleCapture() {
    if (_installed || typeof console === 'undefined') return;
    _installed = true;
    for (const level of ['log', 'info', 'warn', 'error']) {
        const orig = console[level] ? console[level].bind(console) : () => {};
        console[level] = (...args) => {
            try {
                const first = args.length ? stringify(args[0]) : '';
                if (first.indexOf('[overlay]') !== -1) {
                    push(level === 'info' ? 'log' : level, args);
                }
            } catch (_) {}
            orig(...args);
        };
    }
}

/** 取全部日志条目（新对象数组）。 */
export function getEntries() { return _entries.slice(); }

/** 清空缓冲。 */
export function clear() { _entries.length = 0; for (const fn of _subs) { try { fn(); } catch (_) {} } }

/** 订阅变更，返回取消函数。 */
export function subscribe(fn) { _subs.add(fn); return () => _subs.delete(fn); }
