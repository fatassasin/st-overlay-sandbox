// draggable.js — 通用「指针拖动 + 位置持久化 + 视口夹取」助手
// 职责：把入口按钮的拖动逻辑抽成可复用函数。入口按钮、右侧背包、左下角状态条共用。
//   直接回答用户「位置不知道怎么存放、不想固定」：拖到哪存哪（localStorage），刷新保持，
//   拖动与点击靠阈值区分（小幅移动=点击，超阈值=拖动）。
//
// 用 Pointer Events（pointerdown/move/up + setPointerCapture），触屏/鼠标统一。

const DRAG_THRESHOLD = 4; // px，超过才算拖动

/**
 * 让一个元素可拖动并持久化位置。
 * @param {HTMLElement} el 目标元素（须 position:fixed/absolute）
 * @param {object} opts
 * @param {string}  opts.storageKey   localStorage 键；存 { left, top }
 * @param {() => void} [opts.onClick]  未拖动（视为点击）时回调
 * @param {string}  [opts.dragClass]   拖动期间附加的 class（默认 'ov-dragging'）
 * @param {() => void} [opts.onMove]   拖动中回调（可用于实时反馈）
 * @returns {{ applyPos:(l:number,t:number)=>void, destroy:()=>void }}
 */
export function makeDraggable(el, opts = {}) {
    const { storageKey, onClick, dragClass = 'ov-dragging', onMove, moveTarget } = opts;
    // moveTarget：拖动位移应用的目标元素（默认 el 本身）。监听仍挂在 handle(el)，
    //   方便「用小箭头拖动整个顶栏 wrap」这类场景——handle 是抓手，moveTarget 才跟着走。
    const target = moveTarget || el;

    function clampToViewport(left, top) {
        const r = target.getBoundingClientRect();
        const maxL = Math.max(0, window.innerWidth - r.width);
        const maxT = Math.max(0, window.innerHeight - r.height);
        return { left: Math.min(Math.max(0, left), maxL), top: Math.min(Math.max(0, top), maxT) };
    }

    function applyPos(left, top) {
        const p = clampToViewport(left, top);
        target.style.left = p.left + 'px';
        target.style.top = p.top + 'px';
        target.style.right = 'auto';
        target.style.bottom = 'auto';
    }

    // 恢复保存位置（覆盖 CSS 默认锚点）
    if (storageKey) {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
            if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
                applyPos(saved.left, saved.top);
            }
        } catch (_) { /* 无保存位置，用 CSS 默认 */ }
    }

    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;

    function onPointerDown(e) {
        dragging = true; moved = false;
        sx = e.clientX; sy = e.clientY;
        const r = target.getBoundingClientRect();
        ox = r.left; oy = r.top;
        el.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    }
    function onPointerMove(e) {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) { moved = true; el.classList.add(dragClass); }
        if (moved) { applyPos(ox + dx, oy + dy); onMove?.(); }
    }
    function onPointerUp(e) {
        if (!dragging) return;
        dragging = false;
        el.classList.remove(dragClass);
        el.releasePointerCapture?.(e.pointerId);
        if (moved) {
            const r = target.getBoundingClientRect();
            if (storageKey) { try { localStorage.setItem(storageKey, JSON.stringify({ left: r.left, top: r.top })); } catch (_) {} }
        } else {
            onClick?.(); // 未拖动 = 点击
        }
    }

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);

    // 窗口尺寸变化：重新应用「保存的位置」并按新视口夹取。
    //   关键：不读 getBoundingClientRect（那是上次夹取后的渲染位置，会随窗口缩小而漂走，
    //   再放大也回不去）。改读 localStorage 里拖拽时写入的「预期位置」，重新夹取即可——
    //   窗口缩小时贴边，放大时回到用户当初拖到的位置。
    //   无保存位置（首次加载未拖过）则不动，让 CSS 默认锚点（如 right/top）自然跟随。
    const onResize = () => {
        if (!storageKey) { const r = target.getBoundingClientRect(); applyPos(r.left, r.top); return; }
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
            if (saved && typeof saved.left === 'number' && typeof saved.top === 'number') {
                applyPos(saved.left, saved.top);
            }
            // 无保存 → 不动，CSS 默认锚点跟随窗口
        } catch (_) { const r = target.getBoundingClientRect(); applyPos(r.left, r.top); }
    };
    window.addEventListener('resize', onResize);

    function destroy() {
        el.removeEventListener('pointerdown', onPointerDown);
        el.removeEventListener('pointermove', onPointerMove);
        el.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('resize', onResize);
    }

    return { applyPos, destroy };
}
