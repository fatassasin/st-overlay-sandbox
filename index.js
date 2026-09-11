// index.js — 扩展入口
// 职责：等待 ST context → 初始化 overlay 外壳 → 启动桥/阅读器 → 装配设置抽屉 →
//       注册入口按钮/背包浮锚 → 拦截 AI 消息剥标签 → 注入舞台协议 → 注册 slash 命令。
//
// 本扩展是 ST 聊天的「沉浸式视觉小说皮肤」：读 ST 聊天，按舞台标签一屏一片段重画，
// 自有输入框代理回 ST。原生气泡里的标签经 display_text 剥掉。关闭=最小化（隐藏皮肤）。
//
// ⚠️ ST 接口假设（已核实）：
//   A：MESSAGE_RECEIVED 回调 (messageId:number, type:string)。
//   B：在 MESSAGE_RECEIVED 里设 chat[id].extra.display_text，原生气泡显示去标签文本（流式/非流式皆生效）。
//   C：扩展加载时全局可能未就绪，轮询兜底。
//   D：setExtensionPrompt 经 getContext() 暴露；BEFORE_PROMPT=2、role SYSTEM=0（字面量）。
//   E：STREAM_TOKEN_RECEIVED 载荷为累积全文；messageFormatting/executeSlashCommandsWithOptions 经 getContext() 暴露。

import { initOverlay, show as showOverlay, hide as hideOverlay, isVisible, q as ovq, getShell } from './overlay.js';
import { initBridge, refreshOnOpen, clearWaitingOnClose } from './bridge.js';
import { jumpToChatIndex, hasLiveGeneration } from './reader.js';
import * as hk from './hotkey.js';
import { wireUI, applyCurrentSettings } from './ui.js';
import { applyInstruction, applyAll } from './parser.js';
import { parseStageMessage, hasOverlayStageTags, stripOverlayStageTags, stripForTavernDisplay, stripVnMarker, processSaveTags } from './stage-parser.js';
import { loadSettings, getSetting, setSetting } from './settings.js';
import { buildProtocolPrompt, INJECT_KEY, setCustomProtocolGetter } from './protocol.js';
import { initAssets } from './assets.js';
import { buildMaterialCatalog } from './assets-store.js';
import { initInventory } from './inventory.js';
import { initProps } from './props.js';
import { makeDraggable } from './draggable.js';
import { initIdleDim, applyIdleDim } from './idle-dim.js';
import { installConsoleCapture } from './logger.js';

const POS_BEFORE_PROMPT = 2;
const POS_IN_CHAT = 1;
// setExtensionPrompt 的 role 常量（ST：SYSTEM=0, USER=1, ASSISTANT=2）
const ROLE_MAP = { system: 0, user: 1, assistant: 2 };
// autoShow：每条 AI 楼层只自动开一次（不写 chat extra，避免污染存档）
const _autoShownMsg = new Set();

function getCtx() {
    try {
        return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
    } catch (_) { return null; }
}

function waitForContext(maxTries = 40, interval = 250) {
    return new Promise((resolve) => {
        let tries = 0;
        const tick = () => {
            const ctx = getCtx();
            if (ctx) return resolve(ctx);
            if (++tries >= maxTries) { console.warn('[overlay] 轮询超时，未拿到 context。'); return resolve(null); }
            setTimeout(tick, interval);
        };
        tick();
    });
}

// —— 打开 / 最小化 ——

/** 读「用户在酒馆原生聊天里正看着哪一楼」→ 该条的 mesid（= chat 数组下标）。
 *  取与可视区交叠最多的那条 .mes：滚到底时它就是末楼（与旧行为一致），
 *  停在半空翻历史时是屏幕上占地最大的那条，和肉眼判断的「我在看这楼」一致。
 *  拿不到（DOM 未就绪 / 没有消息 / 聊天区不可见）返回 -1，调用方保持原落点。 */
function currentStChatIndex() {
    try {
        const chat = document.getElementById('chat');
        if (!chat) return -1;
        const box = chat.getBoundingClientRect();
        if (!(box.bottom > box.top)) return -1;
        let bestIdx = -1;
        let bestArea = 0;
        for (const el of chat.querySelectorAll('.mes[mesid]')) {
            const r = el.getBoundingClientRect();
            const overlap = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
            if (overlap > bestArea) {
                bestArea = overlap;
                bestIdx = Number(el.getAttribute('mesid'));
            }
        }
        return Number.isInteger(bestIdx) ? bestIdx : -1;
    } catch (_) { return -1; }
}

/** @param {{atStFloor?: boolean}} [opts] atStFloor:false 强制落最新楼（自动弹出用），
 *  不传则按设置 enterAtStFloor 决定跟不跟酒馆的阅读位置。 */
function open(opts = {}) {
    // 落点要在建舞台、显外壳之前读：showOverlay 会盖满屏幕并可能进全屏，
    // 之后再量 #chat 的可视区就不是用户刚才看到的那一屏了。
    const stIdx = (opts.atStFloor !== false && getSetting('enterAtStFloor'))
        ? currentStChatIndex() : -1;
    refreshOnOpen();   // 先完成内容重建，避免旧舞台先淡入后再次跳变
    // 生成中不抢落点：那一屏正在逐字出，refreshOnOpen 已经接管了实时楼。
    if (stIdx >= 0 && !hasLiveGeneration()) jumpToChatIndex(stIdx);
    showOverlay();
    syncLaunchBtn();
    applyChromeState();
    applyKeyButtonState();
    applyIdleDim();    // 进界面即开始无操作计时
    // 恢复上次全屏状态
    if (getSetting('fullscreen')) requestFullscreenSafe();
}
function minimize() {
    clearWaitingOnClose();   // 先清理状态，避免退场动画期间舞台再次变更
    hideOverlay();
    syncLaunchBtn();
    applyIdleDim();    // 退出即停表并撤黑幕，避免下次打开残留
    // 退出沉浸时也退出全屏（不改记忆设置，下次打开仍恢复）
    exitFullscreenSafe();
}
function toggleOpen() { isVisible() ? minimize() : open(); }

// 入口图标：进界面后隐藏（沉浸），关闭后重现。
function syncLaunchBtn() {
    const btn = document.getElementById('st-overlay-launch');
    if (!btn) return;
    btn.classList.toggle('ov-active', isVisible());
    btn.style.display = isVisible() ? 'none' : '';
}

// —— 全屏（等效 F11） ——
function requestFullscreenSafe() {
    try { const el = document.documentElement; if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {}); } catch (_) {}
}
function exitFullscreenSafe() {
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); } catch (_) {}
}
function toggleFullscreen() {
    if (document.fullscreenElement) { exitFullscreenSafe(); setSetting('fullscreen', false); }
    else { requestFullscreenSafe(); setSetting('fullscreen', true); }
}

// —— 顶栏折叠 / 输入框自动隐藏：按设置应用到外壳的 data 属性（CSS 接管显隐动画） ——
function applyChromeState() {
    const shell = getShell();
    if (!shell) return;
    shell.dataset.topbar = getSetting('topbarAutohide') ? 'auto' : 'pinned';
    shell.dataset.composer = getSetting('composerAutohide') ? 'auto' : 'pinned';
    shell.dataset.reply = getSetting('replyAutohide') ? 'auto' : 'pinned';
    shell.dataset.jumpbar = getSetting('jumpbarAutohide') ? 'auto' : 'pinned';
    const wrap = ovq('#ov-topbar-wrap');
    if (wrap) {
        const r = wrap.getBoundingClientRect();
        if (r.right < 12 || r.bottom < 12 || r.left > window.innerWidth - 12 || r.top > window.innerHeight - 12) {
            wrap.style.left = ''; wrap.style.top = ''; wrap.style.right = '0'; wrap.style.bottom = '';
            try { localStorage.removeItem('st-overlay-topbar-toggle-pos'); } catch (_) {}
        }
    }
}

// 接线右上角控件（关闭 X / 全屏 / 折叠箭头）与输入框热区。幂等。
function wireChrome() {
    const close = ovq('#ov-close-btn');
    if (close && !close.dataset.bound) { close.dataset.bound = '1'; close.addEventListener('click', () => minimize()); }
    const fs = ovq('#ov-fullscreen-btn');
    if (fs && !fs.dataset.bound) {
        fs.dataset.bound = '1';
        fs.addEventListener('click', () => toggleFullscreen());
    }
    // 全屏态变化 → 同步图标
    if (!wireChrome._fsBound) {
        wireChrome._fsBound = true;
        document.addEventListener('fullscreenchange', () => {
            const b = ovq('#ov-fullscreen-btn');
            const icon = b && b.querySelector('i');
            const on = !!document.fullscreenElement;
            if (icon) { icon.className = on ? 'fa-solid fa-compress' : 'fa-solid fa-expand'; }
        });
    }
    // iframe HTML 楼层自动调高：监听 postMessage → 更新 iframe height
    if (!wireChrome._htmlFrameBound) {
        wireChrome._htmlFrameBound = true;
        window.addEventListener('message', (e) => {
            const d = e && e.data || {};
            if (typeof d.ovHtmlHeight === 'number' && d.ovHtmlHeight > 0) {
                const iframes = document.querySelectorAll('#st-overlay-root iframe.ov-html-frame');
                for (const iframe of iframes) {
                    if (iframe.contentWindow === e.source) {
                        iframe.style.height = `${d.ovHtmlHeight}px`;
                        break;
                    }
                }
            }
        });
    }
    // 顶栏折叠箭头：标准图标按钮，可拖到任意位置（拖动整个 .ov-topbar-wrap），单击展开/收起。
    //   位置持久化到 localStorage；刷新后保持。
    const toggle = ovq('#ov-topbar-toggle');
    const wrap = ovq('#ov-topbar-wrap');
    if (toggle && wrap && !toggle.dataset.bound) {
        toggle.dataset.bound = '1';
        makeDraggable(toggle, {
            moveTarget: wrap,
            storageKey: 'st-overlay-topbar-toggle-pos',
            onClick: () => { const shell2 = getShell(); if (shell2) shell2.classList.toggle('ov-topbar-show'); },
        });
    }
    // 输入框 / 顶部回显唤起热区：自动隐藏时悬停显示。
    // 上下两套共用同一次 mousemove 与同一份 iframe 坐标转发，不重复绑监听。
    const shell = getShell();
    const hot = ovq('#ov-composer-hotzone');
    const arrow = ovq('#ov-composer-arrow');
    const composer = ovq('#ov-composer');
    // 悬停唤起挂在胶囊上，不能挂全宽横条：横条已设 pointer-events:none（让开选项按钮），
    // 收不到 mouseenter/mouseleave，:hover 也永远为假。
    const composerInner = ovq('#ov-composer .ov-composer-inner');
    const input = ovq('#ov-input');
    const rhot = ovq('#ov-reply-hotzone');
    const rarrow = ovq('#ov-reply-arrow');
    const replyInner = ovq('#ov-reply .ov-reply-inner');
    if (shell && hot && composer && !hot.dataset.bound) {
        hot.dataset.bound = '1';
        const showC = () => shell.classList.add('ov-composer-show');
        const showR = () => shell.classList.add('ov-reply-show');
        // 指针是否落在某个热区内。热区 DOM 不收指针事件（否则会盖住 <opt> 选项框），
        // 所以只能按矩形自己算。用实际 rect 而不是读 CSS 变量，
        // 这样热区滑条一动立刻生效，不用重新绑定。
        let inZone = false;    // 底部输入框热区
        let inZoneR = false;   // 顶部回显热区
        const zoneHit = (el, clientY) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (!r.height) return false;   // 非自动隐藏（或本楼无用户输入）时热区 display:none，rect 全 0
            return clientY >= r.top && clientY <= r.bottom;
        };
        const hideC = () => {
            if (input && document.activeElement === input) return;
            if (inZone || (composerInner && composerInner.matches(':hover')) || (arrow && arrow.matches(':hover'))) return;
            shell.classList.remove('ov-composer-show');
        };
        // 顶部是只读的，没有「聚焦粘住」这回事；但鼠标移进胶囊读长文本时不能收。
        const hideR = () => {
            if (inZoneR || (replyInner && replyInner.matches(':hover')) || (rarrow && rarrow.matches(':hover'))) return;
            shell.classList.remove('ov-reply-show');
        };
        const onMove = (clientY) => {
            const nowC = zoneHit(hot, clientY);
            if (nowC !== inZone) {
                inZone = nowC;
                if (nowC) showC(); else setTimeout(hideC, 80);
            }
            const nowR = zoneHit(rhot, clientY);
            if (nowR !== inZoneR) {
                inZoneR = nowR;
                if (nowR) showR(); else setTimeout(hideR, 80);
            }
        };
        shell.addEventListener('mousemove', (e) => onMove(e.clientY));
        shell.addEventListener('mouseleave', () => {
            inZone = false; inZoneR = false;
            setTimeout(hideC, 80); setTimeout(hideR, 80);
        });
        // 选项框是沙箱 iframe，指针进去后父页面收不到 mousemove，
        // 光标停在选项上时热区就会「失联」。iframe 内部把 clientY 转发上来补齐。
        if (!wireChrome._hotzoneMsgBound) {
            wireChrome._hotzoneMsgBound = true;
            window.addEventListener('message', (e) => {
                const d = e && e.data || {};
                if (typeof d.ovPointerY !== 'number') return;
                const frames = document.querySelectorAll('#st-overlay-root iframe.ov-html-frame');
                for (const f of frames) {
                    if (f.contentWindow !== e.source) continue;
                    onMove(f.getBoundingClientRect().top + d.ovPointerY);
                    break;
                }
            });
        }
        if (arrow) {
            arrow.addEventListener('mouseenter', showC);
            arrow.addEventListener('click', (e) => { e.stopPropagation(); showC(); });
            arrow.addEventListener('mouseleave', () => setTimeout(hideC, 80));
        }
        if (composerInner) {
            composerInner.addEventListener('mouseenter', showC);
            composerInner.addEventListener('mouseleave', () => setTimeout(hideC, 80));
        }
        if (input) {
            input.addEventListener('focus', showC);
            input.addEventListener('blur', () => setTimeout(hideC, 120));
        }
        if (rarrow) {
            rarrow.addEventListener('mouseenter', showR);
            rarrow.addEventListener('click', (e) => { e.stopPropagation(); showR(); });
            rarrow.addEventListener('mouseleave', () => setTimeout(hideR, 80));
        }
        if (replyInner) {
            replyInner.addEventListener('mouseenter', showR);
            replyInner.addEventListener('mouseleave', () => setTimeout(hideR, 80));
        }
    }
    const jhot = ovq('#ov-jumpbar-hotzone');
    const jbar = ovq('#ov-jumpbar');
    if (shell && jhot && jbar && !jhot.dataset.bound) {
        jhot.dataset.bound = '1';
        const showJ = () => shell.classList.add('ov-jumpbar-show');
        const hideJ = () => {
            if (jhot.matches(':hover') || jbar.matches(':hover')) return;
            shell.classList.remove('ov-jumpbar-show');
        };
        jhot.addEventListener('mouseenter', showJ);
        jhot.addEventListener('mouseleave', () => setTimeout(hideJ, 80));
        jbar.addEventListener('mouseenter', showJ);
        jbar.addEventListener('mouseleave', () => setTimeout(hideJ, 80));
    }
    applyChromeState();
}

// —— <overlay> 指令拦截（不污染聊天气泡） ——

function resolveMessageIndex(arg, ctx) {
    if (typeof arg === 'number') return arg;
    if (arg && typeof arg === 'object') {
        if (typeof arg.messageId === 'number') return arg.messageId;
        if (typeof arg.index === 'number') return arg.index;
    }
    if (ctx && Array.isArray(ctx.chat) && ctx.chat.length > 0) return ctx.chat.length - 1;
    return -1;
}

// 舞台标签 + overlay HUD 段，从「原生气泡」里剥掉的正则（仅用于 display_text，不动原文 mes）
const STAGE_STRIP_RE = /<scene\b[^>]*\/?>|<(narration|say|cg|item)\b[^>]*>[\s\S]*?<\/\1>|<overlay>[\s\S]*?<\/overlay>/gi;
// 裸 HUD 行：{"op":"add",...} 或 {...}（可嵌套一层）
const BARE_JSON_OBJ_RE = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
// 半角/全角括号段
const PAREN_STRIP_RE = /\([^)]*\)|（[^）]*）/g;

/** 是否需要剥气泡（有舞台标签或裸 {json}） */
function needsTavernStrip(mes) {
    if (typeof mes !== 'string' || !mes) return false;
    if (hasOverlayStageTags(mes)) return true;
    if (/<(?:fetch|save)/i.test(mes)) return true;
    BARE_JSON_OBJ_RE.lastIndex = 0;
    return BARE_JSON_OBJ_RE.test(mes);
}

/** 把 mes 剥成酒馆气泡文本（不动原文） */
function buildTavernDisplay(mes) {
    let stripped = stripForTavernDisplay(mes);
    stripped = stripped.replace(STAGE_STRIP_RE, '').replace(BARE_JSON_OBJ_RE, '').replace(PAREN_STRIP_RE, '');
    return stripped.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 写 display_text 后重渲气泡（MESSAGE_RECEIVED 时 DOM 已按 mes 渲过，不重渲则看不到剥离） */
function applyTavernDisplay(ctx, idx, msg) {
    if (!getSetting('stripTags')) return;
    if (!needsTavernStrip(msg.mes)) return;
    msg.extra = msg.extra || {};
    msg.extra.display_text = buildTavernDisplay(msg.mes);
    // 优先 ST 公开 API；没有就直接改 .mes_text
    try {
        if (typeof ctx?.updateMessageBlock === 'function') {
            ctx.updateMessageBlock(idx, msg, { rerenderMessage: true });
            return;
        }
    } catch (_) { /* fall through */ }
    const el = document.querySelector(`#chat .mes[mesid="${idx}"] .mes_text`);
    if (!el) return;
    try {
        if (typeof ctx?.messageFormatting === 'function') {
            el.innerHTML = ctx.messageFormatting(msg.extra.display_text, msg.name, msg.is_system, msg.is_user, idx);
        } else {
            el.textContent = msg.extra.display_text;
        }
    } catch (_) {
        el.textContent = msg.extra.display_text;
    }
}

function makeOnMessage(ctx) {
    return function onMessage(arg) {
        try {
            const idx = resolveMessageIndex(arg, ctx);
            if (idx < 0 || !ctx.chat || !ctx.chat[idx]) return;
            const msg = ctx.chat[idx];
            if (typeof msg.mes !== 'string') return;
            // 用户楼层绝不剥气泡 / 不入库（否则「（翻开 便签本）」会被括号规则吃掉）
            if (msg.is_user) return;
            // AI <save> 入库：不要求 VN 标记（生图后非 VN 楼也可能带 save）
            if (/<save/i.test(msg.mes)) {
                try { processSaveTags(msg.mes); } catch (e) { console.warn('[overlay] save 入库失败：', e); }
            }
            const hasTags = hasOverlayStageTags(msg.mes);
            BARE_JSON_OBJ_RE.lastIndex = 0;
            const hasBareHud = BARE_JSON_OBJ_RE.test(msg.mes);
            if (!hasTags && !hasBareHud && !/<save/i.test(msg.mes) && !/<fetch/i.test(msg.mes)) return;

            // 1) 原生气泡：写 display_text 并重渲（仅气泡；mes 原文留给 sandbox）
            applyTavernDisplay(ctx, idx, msg);

            // 2) HUD 指令喂左下角状态条
            const { hudOps } = parseStageMessage(msg.mes);
            if (hudOps && hudOps.length > 0) applyAll(hudOps);

            // 3) 有舞台内容则按设置自动弹出（每条消息只一次；生成中由 bridge once-per-gen 主路径）
            if (hasTags && getSetting('autoShow') && !isVisible() && !_autoShownMsg.has(idx)) {
                _autoShownMsg.add(idx);
                open({ atStFloor: false });
            }
        } catch (e) { console.error('[overlay] 处理消息出错：', e); }
    };
}

function registerHotkey() {
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
            e.preventDefault();
            toggleOpen();
            return;
        }
        // 自定义快捷键（出厂空 = 不启用）。
        // 不带修饰键的组合要让开输入场景，否则在酒馆输入框里打那个字母就会触发。
        const inEditable = isEditableTarget(e.target);
        const fire = (combo, run) => {
            if (!combo || !hk.matches(e, combo)) return false;
            if (inEditable && !hk.hasModifier(combo)) return false;
            e.preventDefault();
            run();
            return true;
        };
        if (fire(getSetting('hotkeyToggle'), toggleOpen)) return;
        // 全屏只在 overlay 开着时有意义：关着按等于把整个酒馆页面全屏，不是用户要的。
        fire(getSetting('hotkeyFullscreen'), () => { if (isVisible()) toggleFullscreen(); });
    });
}

/** 焦点是否在可输入处（含 ST 那些 contenteditable 的输入框） */
function isEditableTarget(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
}

const KEY_DEFS = {
    AltRight: { key: 'Alt', label: 'Right Alt', location: 2 },
    AltLeft: { key: 'Alt', label: 'Left Alt', location: 1 },
    ControlRight: { key: 'Control', label: 'Right Ctrl', location: 2 },
    ControlLeft: { key: 'Control', label: 'Left Ctrl', location: 1 },
    ShiftRight: { key: 'Shift', label: 'Right Shift', location: 2 },
    ShiftLeft: { key: 'Shift', label: 'Left Shift', location: 1 },
    Enter: { key: 'Enter', label: 'Enter', location: 0 },
    Space: { key: ' ', label: 'Space', location: 0 },
    Escape: { key: 'Escape', label: 'Escape', location: 0 },
    Tab: { key: 'Tab', label: 'Tab', location: 0 },
};
function keyButtonInfo() {
    const code = String(getSetting('keyButtonCode') || 'AltRight');
    const def = KEY_DEFS[code];
    const customKey = String(getSetting('keyButtonKey') || code);
    return { code, key: def?.key || customKey, label: def?.label || customKey, location: def?.location || 0 };
}
function applyKeyButtonState() {
    const btn = ovq('#ov-key-button'); if (!btn) return;
    const info = keyButtonInfo(); btn.hidden = !getSetting('keyButtonEnabled'); btn.title = `系统按键：${info.label}`;
    applyKeyButtonPlacement();
}
function applyKeyButtonPlacement() {
    const btn = ovq('#ov-key-button');
    if (!btn) return;
    const root = document.getElementById('st-overlay-root');
    const inner = ovq('#ov-composer .ov-composer-inner');
    const send = ovq('#ov-send');
    const docked = !!getSetting('keyButtonDocked');
    btn.classList.toggle('ov-key-docked', docked);
    if (docked && inner && send) {
        if (btn.parentElement !== inner) inner.insertBefore(btn, send);
        btn.style.left = ''; btn.style.top = ''; btn.style.right = ''; btn.style.bottom = '';
        return;
    }
    if (!docked && root && btn.parentElement !== root) root.appendChild(btn);
    if (!docked) {
        try {
            const saved = JSON.parse(localStorage.getItem('st-overlay-key-button-pos') || 'null');
            if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
                btn.style.left = `${saved.left}px`; btn.style.top = `${saved.top}px`;
                btn.style.right = 'auto'; btn.style.bottom = 'auto';
            } else {
                btn.style.left = ''; btn.style.top = ''; btn.style.right = ''; btn.style.bottom = '';
            }
        } catch (_) {}
    }
}

function setKeyBridgeState(state, text) {
    const btn = ovq('#ov-key-button');
    const status = ovq('#set-keybutton-status');
    if (btn) {
        btn.classList.toggle('ov-key-online', state === 'online');
        btn.classList.toggle('ov-key-error', state === 'error');
    }
    if (status) { status.dataset.state = state; status.textContent = text; }
}
function keyRequestHeaders() {
    return { ...(getCtx()?.getRequestHeaders?.() || {}), 'Content-Type': 'application/json' };
}
async function checkKeyBridge() {
    try {
        const response = await fetch('/api/plugins/st-overlay-sandbox-key/status', { cache: 'no-store' });
        if (!response.ok || !(await response.json()).ok) throw new Error(`HTTP ${response.status}`);
        setKeyBridgeState('online', '系统桥接：已连接');
        return true;
    } catch (_) {
        setKeyBridgeState('error', '系统桥接：未连接（请重启 SillyTavern）');
        return false;
    }
}
async function dispatchVirtualKey() {
    const btn = ovq('#ov-key-button'); if (!btn) return;
    const info = keyButtonInfo();
    btn.disabled = true;
    setKeyBridgeState('pending', `正在发送 ${info.label}…`);
    try {
        const response = await fetch('/api/plugins/st-overlay-sandbox-key/press', {
            method: 'POST', headers: keyRequestHeaders(), body: JSON.stringify({ code: info.code }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
        setKeyBridgeState('online', `已发送：${info.label}`);
        btn.classList.add('ov-key-pressed');
        setTimeout(() => btn.classList.remove('ov-key-pressed'), 120);
    } catch (error) {
        console.warn('[overlay] 系统按键发送失败：', error);
        setKeyBridgeState('error', `发送失败：${error.message}`);
    } finally {
        btn.disabled = false;
    }
}
function registerKeyButton() {
    const btn = ovq('#ov-key-button'); if (!btn || btn.dataset.bound) return;
    // 注意：这里【不能】把 applyKeyButtonPlacement 当 onMove 传进去。draggable 的每次
    // pointermove 都是「先 applyPos 再 onMove」，而未停靠时 applyKeyButtonPlacement 会从
    // localStorage 读回上次保存的坐标并覆写 style.left/top——等于每移动一像素就被拽回原位；
    // 而坐标只在 pointerup 时才写入，所以按钮永远拖不动。停靠状态在拖动过程中也不会变，
    // 拖到一半重算摆放本就没有意义。
    btn.dataset.bound = '1';
    makeDraggable(btn, { storageKey: 'st-overlay-key-button-pos', onClick: dispatchVirtualKey });
    applyKeyButtonState();
}
/** 注册入口按钮：默认钉右上角，可自由拖动（draggable.js），位置存 localStorage，点击=开关 */
function registerLaunchButton() {
    const BTN_ID = 'st-overlay-launch';
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.className = 'fa-solid fa-circle-half-stroke';
    btn.title = 'Overlay Sandbox（拖动可移动 · 点击开关 · Ctrl/Cmd+Shift+O）';
    document.body.appendChild(btn);
    makeDraggable(btn, { storageKey: 'st-overlay-launch-pos', onClick: () => toggleOpen() });
}

function applyProtocolInjection(enabled) {
    const c = getCtx();
    if (!c || typeof c.setExtensionPrompt !== 'function') return;
    const depth = Number(getSetting('injectDepth')) || 0;
    const role = ROLE_MAP[getSetting('injectRole')] ?? ROLE_MAP.system;
    // depth>0 表示注入到聊天内某深度（IN_CHAT），depth=0 用 BEFORE_PROMPT（贴系统提示后）
    const pos = depth > 0 ? POS_IN_CHAT : POS_BEFORE_PROMPT;
    try {
        c.setExtensionPrompt(INJECT_KEY, enabled ? buildProtocolPrompt() : '', pos, depth, false, role);
    } catch (e) { console.warn('[overlay] setExtensionPrompt 失败：', e); }
}

// 已注册的宏名（避免改名后旧宏残留无法清理；ST 允许覆盖注册同名）
let _macroName = '';
let _materialMacroName = '';
/** 注册 {{sandbox_prompt}}（或用户自定义宏名）→ 展开为协议文本，便于在预设里手动引用。
 *  ST context 暴露 registerMacro(key, value)，value 可为返回字符串的函数。 */
function registerSandboxMacro() {
    const c = getCtx();
    if (!c || typeof c.registerMacro !== 'function') return;
    // 去掉用户可能写的 {{ }} 包裹，注册裸名（引用时写 {{name}}）
    const name = String(getSetting('injectMacro') || '{{sandbox_prompt}}').replace(/[{}]/g, '').trim();
    if (!name) return;
    try {
        c.registerMacro(name, () => buildProtocolPrompt());
        _macroName = name;
        console.info('[overlay] 已注册宏 {{' + name + '}}。');
    } catch (e) { console.warn('[overlay] 注册宏失败：', e); }
    registerMaterialMacro();
}

/** 注册 {{material}}（可改 materialMacro）→ 可见素材路径 + category 目录 */
function registerMaterialMacro() {
    const c = getCtx();
    if (!c || typeof c.registerMacro !== 'function') return;
    const name = String(getSetting('materialMacro') || '{{material}}').replace(/[{}]/g, '').trim();
    if (!name) return;
    try {
        c.registerMacro(name, () => buildMaterialCatalog());
        _materialMacroName = name;
        console.info('[overlay] 已注册素材宏 {{' + name + '}}。');
    } catch (e) { console.warn('[overlay] 注册素材宏失败：', e); }
}

function registerSlashCommand(ctx) {
    const SCP = ctx && ctx.SlashCommandParser;
    const SC = ctx && ctx.SlashCommand;
    if (!SCP || !SC || typeof SCP.addCommandObject !== 'function' || typeof SC.fromProps !== 'function') {
        console.info('[overlay] 未暴露 slash API，跳过 /overlay 注册。');
        return;
    }
    const ARG = ctx.SlashCommandArgument;
    const AT = ctx.ARGUMENT_TYPE;
    const unnamed = ARG && AT ? [new ARG('show|hide|toggle|clear|add <json>', AT.STRING, false, false, '')] : [];
    SCP.addCommandObject(SC.fromProps({
        name: 'overlay',
        aliases: ['ov'],
        helpString: '控制 Overlay Sandbox：/overlay show|hide|toggle|clear 或 /overlay add {"op":"add",...}',
        unnamedArgumentList: unnamed,
        returns: AT ? AT.STRING : undefined,
        callback: (_args, value) => {
            const text = String(value ?? '').trim();
            const sp = text.indexOf(' ');
            const sub = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
            const rest = sp === -1 ? '' : text.slice(sp + 1).trim();
            switch (sub) {
                case 'show': open(); break;
                case 'hide': minimize(); break;
                case 'toggle': case '': toggleOpen(); break;
                case 'clear': applyInstruction({ op: 'clear' }); break;
                case 'add':
                    try { applyInstruction(JSON.parse(rest)); }
                    catch (e) { return `add 失败：${e.message}`; }
                    break;
                default: return `未知子命令：${sub}`;
            }
            return '';
        },
    }));
    console.info('[overlay] 已注册 /overlay 命令。');
}

async function main() {
    installConsoleCapture();           // 尽早装日志捕获，收全初始化日志
    initOverlay();
    initIdleDim();
    registerKeyButton();
    registerHotkey();
    registerLaunchButton();
    initInventory();
    initProps();
    // 让 protocol 能读到用户自定义协议（解耦 settings 依赖）
    setCustomProtocolGetter(() => getSetting('customProtocol'));

    const ctx = await waitForContext();
    if (ctx) {
        loadSettings();
        applyCurrentSettings();
        initAssets(ctx);
        initBridge(ctx);
        registerSandboxMacro();
        applyProtocolInjection(getSetting('injectProtocol'));
        registerSlashCommand(ctx);

        if (ctx.eventSource && ctx.event_types) {
            const onMsg = makeOnMessage(ctx);
            // MESSAGE_RECEIVED 时写 display_text；CHARACTER_MESSAGE_RENDERED 时 DOM 已存在，再剥一次并重渲
            ctx.eventSource.on(ctx.event_types.MESSAGE_RECEIVED, onMsg);
            if (ctx.event_types.CHARACTER_MESSAGE_RENDERED) {
                ctx.eventSource.on(ctx.event_types.CHARACTER_MESSAGE_RENDERED, onMsg);
            }
            if (ctx.event_types.MESSAGE_UPDATED) {
                ctx.eventSource.on(ctx.event_types.MESSAGE_UPDATED, onMsg);
            }
            console.info('[overlay] 已绑定 MESSAGE_RECEIVED/RENDERED 标签剥离。');
        }
    } else {
        console.warn('[overlay] 无 context，UI 仅供测试。');
        initBridge(null);
    }

    wireUI({
        onInjectProtocolChange: applyProtocolInjection,
        onChromeChange: () => { applyChromeState(); applyKeyButtonState(); },
        onMacroChange: () => { registerSandboxMacro(); if (getSetting('injectProtocol')) applyProtocolInjection(true); },
    });
    checkKeyBridge();
    wireChrome();
    console.info('[overlay] 初始化完成。右上角按钮 / Ctrl+Cmd+Shift+O 展开。');
}

main();

