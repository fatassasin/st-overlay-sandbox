// video.js — 阅读器里的视频：滚到就自动播一遍 + 触控点画面中间也能播
// 职责：overlay 里所有 <video>（正文里生视频插件回写的内联视频、VN 的 <video> 片段）：
//   1) 滚到眼前（露出至少一半）自动播放，只播一遍：不循环，同一段视频本次会话里只自动起播一次；
//   2) 点画面中间切换播放/暂停，鼠标与手指一个样。
//
// 为什么要 2)：Chrome 原生 controls 对鼠标单击是「切播放」，对触控点按却只是「唤出控制条」，
//   远控的触屏模式下只能去戳左下角那颗小播放键。这里不认指针类型，而是等原生先处理：
//   点完那一拍 paused 没变 = 原生没管，才由我们来切。鼠标点击原生已切过，我们什么都不做，不会切两次。
//
// 为什么扫描而不用 IntersectionObserver：overlay 隐藏时是 visibility:hidden，IO 照样报「可见」；
//   等真正显示出来，交叉状态又没变化、不会再回调。自己扫 + 在「打开 / 滚动 / 正文重写」时各扫一次，
//   能直接把 isVisible() 当闸门，省掉反复 unobserve/observe 的花活。

import { getSetting } from './settings.js';
import { getRoot, isVisible, q } from './overlay.js';

// 本次会话里已经起播过的视频（按 src 记）。正文会被整段重写（打字机收尾、生图回写后的重建），
// 同一段视频会换成新元素；按元素记的话，重建一次就再自动播一次，正在看的也会被从头拉回去。
const played = new Set();
const PLAYED_CAP = 500;
// 元素露出多少算「滚到了」：自身高度与可视区高度取小者的一半。高过一屏的竖版视频照样能触发。
const SHOW_RATIO = 0.5;
// 原生控制条那一条不接管，让进度条、音量、全屏按钮照常点得到。
const CONTROLS_STRIP_PX = 48;

let bound = false;
let scanTimer = 0;

// 先取属性原文：currentSrc 要等资源选择跑完才有值，且是规范化后的绝对地址，
// 同一段视频前后两次取出来可能不一样，拿它当键会让「播过」认不出来。
function videoKey(v) {
    return v.getAttribute('src') || v.querySelector('source[src]')?.getAttribute('src') || v.currentSrc || '';
}

function markPlayed(v) {
    const key = videoKey(v);
    if (!key) return;
    played.add(key);
    if (played.size > PLAYED_CAP) played.delete(played.values().next().value);
}

/** 视频此刻露出了多少：先夹到视口，再夹到它所在的正文滚动框。 */
function isShownEnough(v) {
    const r = v.getBoundingClientRect();
    if (r.height <= 0 || r.width <= 0) return false;   // #ov-cg[hidden] 之类
    let top = 0;
    let bottom = window.innerHeight;
    const box = v.closest('#ov-panel-text');
    if (box) {
        const b = box.getBoundingClientRect();
        top = Math.max(top, b.top);
        bottom = Math.min(bottom, b.bottom);
    }
    const shown = Math.min(r.bottom, bottom) - Math.max(r.top, top);
    return shown > 0 && shown >= Math.min(r.height, bottom - top) * SHOW_RATIO;
}

function autoplay(v) {
    markPlayed(v);
    v.loop = false;   // 只播一遍
    const p = v.play();
    if (!p || typeof p.catch !== 'function') return;
    p.catch((err) => {
        // 页面还没被点过（只滚过轮子不算）时浏览器不准带声自动播，静音再试一次；
        // 控制条上点一下喇叭即可放出声音。
        if (err && err.name === 'NotAllowedError' && !v.muted) {
            v.muted = true;
            v.play().catch(() => {});
        }
    });
}

/** 扫一遍 overlay 里的视频，露够了、还没播过的就起播。 */
export function scanVideos() {
    clearTimeout(scanTimer);
    scanTimer = 0;
    if (!getSetting('videoAutoplay') || !isVisible()) return;
    const root = getRoot();
    if (!root) return;
    for (const v of root.querySelectorAll('video')) {
        if (!v.paused || v.closest('.ov-typing')) continue;   // 打字机每帧重写正文，元素下一帧就没了，等它写完
        const key = videoKey(v);
        if (!key || played.has(key)) continue;
        if (isShownEnough(v)) autoplay(v);
    }
}

/** 攒一下再扫：滚动、打字机每帧重写正文都会连发，扫一次就够。 */
export function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(scanVideos, 120);
}

/** 关界面时把还在放的视频停下，不在看不见的地方继续出声。 */
export function pauseVideos() {
    const root = getRoot();
    if (!root) return;
    root.querySelectorAll('video').forEach((v) => { if (!v.paused) v.pause(); });
}

export function initVideos() {
    const root = getRoot();
    if (!root || bound) return;
    bound = true;

    // 点画面中间切播放/暂停（见文件头：等原生先处理，没切才补）。
    // controls 在视频的 shadow DOM 里，点击在这里的 target 已被重定向成 <video> 本身。
    root.addEventListener('click', (e) => {
        const v = e.target && e.target.closest ? e.target.closest('video') : null;
        if (!v) return;
        const r = v.getBoundingClientRect();
        if (v.controls && e.clientY > r.bottom - Math.min(CONTROLS_STRIP_PX, r.height * 0.3)) return;
        const wasPaused = v.paused;
        setTimeout(() => {
            if (v.paused !== wasPaused) return;   // 原生已经切过（鼠标单击）
            if (v.paused) v.play().catch(() => {});
            else v.pause();
        }, 0);
    });

    // 手动点开的也算播过，之后滚回来不再自动起播。play 不冒泡，走捕获。
    root.addEventListener('play', (e) => { if (e.target instanceof HTMLVideoElement) markPlayed(e.target); }, true);

    // 滚动（正文框内的滚动不冒泡，走捕获）与正文重写都重新扫一次。
    root.addEventListener('scroll', scheduleScan, { capture: true, passive: true });
    window.addEventListener('resize', scheduleScan, { passive: true });
    new MutationObserver(scheduleScan).observe(root, { childList: true, subtree: true });
    const panel = q('#ov-panel-text');
    if (panel) new MutationObserver(scheduleScan).observe(panel, { attributes: true, attributeFilter: ['class'] });
}
