// idle-dim.js — 无操作自动黑屏
// 职责：Sandbox 打开且用户停手超过设定秒数 → 全屏黑幕在 3 秒内渐入；
//       任何鼠标/键盘动作 → 瞬间撤掉黑幕（无过渡），继续阅读不被打断。
//
// 为什么不用 CSS animation：渐入要可被"瞬间取消"，transition-duration 改 0s 即可立刻归位，
//       animation 取消会有一帧回跳。
//
// 计时策略：鼠标移动每秒可达上百次，若每次都 clear/setTimeout 会有无谓开销。
//       活动时只写一个时间戳；单个待触发的定时器自己按 lastActive 续期。

import { getSetting } from './settings.js';
import { isVisible, q } from './overlay.js';

// 渐黑时长（秒）。需求固定 3 秒，不做成设置项。
const FADE_SEC = 3;
// 唤醒事件：鼠标与键盘。passive+capture，只读不拦，绝不影响既有交互。
const WAKE_EVENTS = ['mousemove', 'mousedown', 'wheel', 'keydown', 'touchstart'];

let timer = null;
let lastActive = 0;
let dimmed = false;
let bound = false;

function enabled() {
    return !!getSetting('idleDim') && isVisible();
}

function delayMs() {
    const s = Number(getSetting('idleDimDelay'));
    return Math.max(1, Number.isFinite(s) ? s : 60) * 1000;
}

function setDim(on) {
    const el = q('#ov-idle-dim');
    if (!el || dimmed === on) return;
    dimmed = on;
    // 变黑走 3s 过渡；恢复把过渡时长清零 → 瞬间还原。
    el.style.transitionDuration = on ? `${FADE_SEC}s` : '0s';
    el.style.opacity = on ? '1' : '0';
}

function tick() {
    timer = null;
    if (!enabled()) return;
    const rest = delayMs() - (Date.now() - lastActive);
    if (rest > 0) { timer = setTimeout(tick, rest); return; }  // 期间有活动 → 顺延，不重置定时器链
    setDim(true);
}

function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!enabled()) return;
    timer = setTimeout(tick, delayMs());
}

function onActivity() {
    lastActive = Date.now();
    if (dimmed) { setDim(false); schedule(); return; }
    if (!timer) schedule();   // 定时器已用尽（或刚开启功能）才重新排；常规移动只写时间戳
}

/** 绑定唤醒监听。幂等，在 initOverlay() 之后调用一次。 */
export function initIdleDim() {
    if (bound) return;
    bound = true;
    for (const type of WAKE_EVENTS) {
        document.addEventListener(type, onActivity, { capture: true, passive: true });
    }
    applyIdleDim();
}

/** 设置变更 / 打开 / 最小化后重新评估：先还原画面，再按当前状态重新计时。 */
export function applyIdleDim() {
    lastActive = Date.now();
    setDim(false);
    schedule();
}
