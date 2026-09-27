// device.js — 分辨「在电脑前直接用」还是「手机/平板 UU 远程连进来」
// 判据照搬 Localless（micwatch.rs 的 client_looks_desktop）：UU 远程（网易 GameViewer）推流时
// 会按客户端造一块虚拟显示器，主机自己的输出全部置为 inactive，于是主屏尺寸就是客户端尺寸。
// 同一台主机实测：手机、iPad 连进来都是 1920×1080 @175%；这台电脑本机是 3840×2160 @200%。
// 比 1080p 大 = 电脑前。
//
// 浏览器给的 screen.width 是逻辑尺寸，必须乘回 devicePixelRatio 才是物理像素
// （远程时 1097 × 1.75 = 1919.75），所以留 16px 余量吸收换算误差。
// 已知误判：1366×768 那类笔记本远程连过来，虚拟屏同样是 1920×1080，会被当成手机。
//
// 竖屏另算：手机竖着拿时虚拟屏是 1244×2160 @200%——高 2160 超过 1080p，光看尺寸会被当成电脑。
// 所以「高大于宽」一律算远程。代价是：电脑要是接了一块竖放的主屏，也会被当成手机。
//
// 换设备时 resize / screen change 不保证每次都到，所以另外每 3 秒重读一次兜底，代价只是两次乘法。

const DESKTOP_W = 1920;
const DESKTOP_H = 1080;
const SLACK = 16;
const POLL_MS = 3000;

let _remote = null;
let _sizeKey = '';
let _watching = false;
const _subs = new Set();

/** 当前主屏物理像素（读不到返回 null）。 */
export function physicalScreen() {
    const s = window.screen;
    const dpr = window.devicePixelRatio || 1;
    if (!s || !s.width || !s.height) return null;   // 显示器正在切换的那一瞬可能读到 0
    return { w: Math.round(s.width * dpr), h: Math.round(s.height * dpr) };
}

/** 主屏物理尺寸写成 'WxH'（按分辨率存方案用的键）；读不到返回 ''。 */
export function screenKey() {
    const p = physicalScreen();
    return p ? `${p.w}x${p.h}` : '';
}

function detect() {
    const p = physicalScreen();
    if (!p) return _remote;   // 读不到就维持上一次的结论
    if (p.h > p.w) return true;
    return !(p.w > DESKTOP_W + SLACK || p.h > DESKTOP_H + SLACK);
}

/** 是否像是远程客户端（手机/平板经 UU 远程）。 */
export function isRemoteClient() {
    if (_remote === null) _remote = !!detect();
    return _remote;
}

function recheck() {
    const p = physicalScreen();
    const key = p ? `${p.w}×${p.h}` : '';
    const now = !!detect();
    const flipped = now !== _remote;
    if (!flipped && key === _sizeKey) return;
    _remote = now;
    _sizeKey = key;
    if (flipped) console.info(`[overlay] 屏幕 ${key || '?'} → ${now ? '远程' : '电脑'}`);
    for (const fn of _subs) { try { fn(now); } catch (_) {} }
}

/** 订阅主屏变化（电脑 ↔ 远程翻转，或尺寸变了）；返回取消函数。首个订阅者负责起巡逻。 */
export function onDeviceChange(fn) {
    _subs.add(fn);
    if (!_watching) {
        _watching = true;
        isRemoteClient();
        const p = physicalScreen();
        _sizeKey = p ? `${p.w}×${p.h}` : '';
        window.addEventListener('resize', recheck, { passive: true });
        try { window.screen.addEventListener?.('change', recheck); } catch (_) {}
        setInterval(recheck, POLL_MS);
    }
    return () => _subs.delete(fn);
}
