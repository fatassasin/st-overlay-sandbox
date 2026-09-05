// overlay.js — 渲染层外壳（视觉小说阅读器舞台）
// 职责：创建全屏 position:fixed 容器（light DOM），构建分层舞台：
//       背景层 bg → 立绘层 sprite(左/右) → 全屏 cg → 磨砂正文面板 panel → 道具浮层 items
//       + 右侧片段跳转条 jumpbar + 设置抽屉 drawer + 底部输入 composer。
//       浮锚（入口按钮/背包/状态条）由 index.js 用 draggable.js 注册，不在外壳内固定。
//
// 定位：本扩展是 ST 聊天的「沉浸式皮肤」——读 ST 聊天，按舞台标签一屏一片段重画，
//       自有输入框代理回 ST。绝不搬移/改动 ST 原 DOM。
//
// 为什么 light DOM：复用 ST messageFormatting() 产出的 HTML（code 高亮/表格等依赖全局样式）；
//       自身样式以 #st-overlay-root 前缀隔离。

let overlayRoot = null;   // 外层全屏 <div id="st-overlay-root">
let shell = null;         // .ov-window 外壳
let stageEl = null;       // 阅读器舞台 .ov-stage（分层容器）
let visible = false;

/** 初始化 overlay 容器与外壳。幂等。 */
export function initOverlay() {
    if (overlayRoot) return getRefs();

    overlayRoot = document.createElement('div');
    overlayRoot.id = 'st-overlay-root';
    overlayRoot.style.display = 'flex';

    overlayRoot.innerHTML = `
        <div class="ov-window">
            <!-- 分层舞台：一屏一片段 -->
            <div class="ov-stage" id="ov-stage">
                <div class="ov-layer ov-bg" id="ov-bg" aria-hidden="true"></div>
                <div class="ov-layer ov-sprites" id="ov-sprites" aria-hidden="true">
                    <div class="ov-sprite ov-sprite-left" id="ov-sprite-left"></div>
                    <div class="ov-sprite ov-sprite-right" id="ov-sprite-right"></div>
                </div>
                <div class="ov-layer ov-cg" id="ov-cg" aria-hidden="true"></div>
                <div class="ov-vignette" id="ov-vignette" aria-hidden="true"></div>

                <!-- 正文面板（视觉中心） -->
                <div class="ov-panel" id="ov-panel">
                    <div class="ov-speaker" id="ov-speaker"></div>
                    <div class="ov-panel-text mes_text" id="ov-panel-text"></div>
                    <div class="ov-advance-hint" id="ov-advance-hint" aria-hidden="true">▾</div>
                </div>

                <!-- 道具浮层（附着当前片段） -->
                <div class="ov-layer ov-items" id="ov-items"></div>

                <!-- 左下角状态条（HUD：AI 给的血条等，可拖） -->
                <div class="ov-status" id="ov-status"></div>

                <!-- 片段跳转条（旧楼层才显） -->
                <div class="ov-jumpbar" id="ov-jumpbar" hidden></div>

                <!-- 跨楼层提示（到边界继续滚动切楼层时淡入） -->
                <div class="ov-floor-hint ov-floor-hint-top" id="ov-floor-hint-top" hidden aria-hidden="true">
                    <span class="ov-fh-arrow">▲</span><span class="ov-fh-text">继续滚动，切换上一楼层</span>
                </div>
                <div class="ov-floor-hint ov-floor-hint-bottom" id="ov-floor-hint-bottom" hidden aria-hidden="true">
                    <span class="ov-fh-text">继续滚动，切换下一楼层</span><span class="ov-fh-arrow">▼</span>
                </div>

                <!-- 顶部极简操作（顺序与抽屉标签一致：设置/测试/素材/道具/背包 + 全屏 + 关闭） -->
                <div class="ov-topbar">
                    <span class="ov-floor-meta" id="ov-floor-meta"></span>
                    <div class="ov-topbar-wrap" id="ov-topbar-wrap">
                        <div class="ov-topbar-actions" id="ov-topbar-actions">
                            <button class="ov-icon-btn" id="ov-settings-btn" title="设置" type="button">
                                <i class="fa-solid fa-gear"></i>
                            </button>
                            <button class="ov-icon-btn" id="ov-test-btn" title="测试" type="button">
                                <i class="fa-solid fa-flask"></i>
                            </button>
                            <button class="ov-icon-btn" id="ov-assets-btn" title="素材" type="button">
                                <i class="fa-solid fa-images"></i>
                            </button>
                            <button class="ov-icon-btn ov-bag-btn" id="ov-props-btn" title="道具与背包" type="button">
                                <svg class="ov-bag-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M8 7V6.2C8 4.4 9.8 3 12 3s4 1.4 4 3.2V7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                                    <path d="M6.6 7h10.8c1 0 1.9.7 2.1 1.7l1.3 9.2c.2 1.5-1 2.8-2.5 2.8H5.7c-1.5 0-2.7-1.3-2.5-2.8l1.3-9.2C4.7 7.7 5.6 7 6.6 7Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                                    <path d="M4.2 12.4h15.6" stroke="currentColor" stroke-width="1.5"/>
                                    <path d="M10 12.4h4v2.2a2 2 0 0 1-4 0v-2.2Z" fill="currentColor" opacity="0.25" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                                </svg>
                                <span class="ov-bag-count" id="ov-bag-count">0</span>
                            </button>
                            <button class="ov-icon-btn" id="ov-fullscreen-btn" title="全屏（F11）" type="button">
                                <i class="fa-solid fa-expand"></i>
                            </button>
                            <button class="ov-icon-btn ov-close-btn" id="ov-close-btn" title="关闭界面" type="button">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>
                        <button class="ov-icon-btn ov-topbar-toggle" id="ov-topbar-toggle" title="展开/收起（可拖动）" type="button" aria-label="展开操作">
                            <i class="fa-solid fa-angle-left"></i>
                        </button>
                    </div>
                </div>

                <!-- 等待态指示（空窗期） -->
                <div class="ov-waiting" id="ov-waiting" hidden><span class="ov-waiting-dots"><i>正</i><i>在</i><i>生</i><i>成</i><i>中</i></span></div>

                <!-- 选择模式右键菜单（定位到光标处；复制/搜索当前选中文本） -->
                <div class="ov-copy-fab" id="ov-copy-fab" hidden aria-label="选中文本菜单">
                    <button type="button" data-act="copy" title="复制"><i class="fa-solid fa-copy"></i></button>
                    <button type="button" data-act="google" title="用 Google 搜索"><i class="fa-solid fa-question"></i></button>
                </div>
            </div>

            <!-- 顶部「上一条我的输入」唤起提示箭头（朝下；与底部箭头上下镜像） -->
            <div class="ov-reply-arrow" id="ov-reply-arrow" aria-hidden="true">
                <svg viewBox="0 0 40 12" preserveAspectRatio="none" aria-hidden="true">
                    <polyline points="2,3 20,9 38,3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
                </svg>
            </div>

            <!-- 顶部唤起热区（几何标记；永不收指针事件，判定见 index.js 的 mousemove） -->
            <div class="ov-reply-hotzone" id="ov-reply-hotzone" aria-hidden="true"></div>

            <!-- 顶部只读回显：产生当前楼的那条用户输入 -->
            <div class="ov-reply" id="ov-reply">
                <div class="ov-reply-inner">
                    <div class="ov-reply-text mes_text" id="ov-reply-text"></div>
                </div>
            </div>

            <!-- 底部输入唤起提示箭头（自动隐藏时，提示鼠标下移唤起输入框） -->
            <div class="ov-composer-arrow" id="ov-composer-arrow" aria-hidden="true">
                <svg viewBox="0 0 40 12" preserveAspectRatio="none" aria-hidden="true">
                    <polyline points="2,9 20,3 38,9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
                </svg>
            </div>

            <!-- 底部输入唤起热区（自动隐藏时，鼠标进入此高度即显输入框；高度由 composerHotzone 设置） -->
            <div class="ov-composer-hotzone" id="ov-composer-hotzone" aria-hidden="true"></div>

            <!-- 右侧楼层按钮唤起热区（自动隐藏时，鼠标进入右侧边缘即显跳转条） -->
            <div class="ov-jumpbar-hotzone" id="ov-jumpbar-hotzone" aria-hidden="true"></div>

            <!-- 底部输入 -->
            <div class="ov-composer" id="ov-composer">
                <div class="ov-composer-inner">
                    <textarea class="ov-input" id="ov-input" rows="1"
                        placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"></textarea>
                    <button class="ov-send" id="ov-send" title="发送" type="button">
                        <i class="fa-solid fa-paper-plane"></i>
                    </button>
                    <button class="ov-stop" id="ov-stop" title="停止生成" type="button" style="display:none;">
                        <i class="fa-solid fa-stop"></i>
                    </button>
                </div>
            </div>

            <!-- 右侧抽屉（从右滑入，标签页：设置/测试/素材/道具/背包；底部 Log 折叠区） -->
            <div class="ov-drawer" id="ov-drawer" hidden>
                <div class="ov-drawer-head">
                    <div class="ov-drawer-tabs">
                        <button class="ov-dtab" data-tab="settings" type="button">设置</button>
                        <button class="ov-dtab" data-tab="test" type="button">测试</button>
                        <button class="ov-dtab" data-tab="assets" type="button">素材</button>
                        <button class="ov-dtab" data-tab="props" type="button">道具<span class="ov-dtab-count" id="ov-dtab-bag">0</span></button>
                    </div>
                    <button class="ov-icon-btn" id="ov-drawer-close" title="关闭" type="button">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <div class="ov-drawer-body">
                    <div class="ov-pane" data-pane="settings" id="ov-pane-settings"></div>
                    <div class="ov-pane" data-pane="test" id="ov-pane-test"></div>
                    <div class="ov-pane" data-pane="assets" id="ov-pane-assets"></div>
                    <div class="ov-pane" data-pane="props" id="ov-pane-props"></div>
                </div>
                <!-- Log 查看器：钉底，默认折叠 -->
                <div class="ov-log" id="ov-log" data-open="false">
                    <button class="ov-log-head" id="ov-log-head" type="button">
                        <span><i class="fa-solid fa-chevron-right ov-log-caret"></i> 日志</span>
                        <span class="ov-log-actions">
                            <span class="ov-log-count" id="ov-log-count">0</span>
                            <span class="ov-log-clear" id="ov-log-clear" title="清空">清空</span>
                        </span>
                    </button>
                    <div class="ov-log-body" id="ov-log-body"></div>
                </div>
            </div>
            <div class="ov-drawer-scrim" id="ov-drawer-scrim" hidden></div>
        </div>
        <button class="ov-key-button" id="ov-key-button" type="button" hidden title="模拟 Right Alt">
            <i class="fa-solid fa-microphone"></i>
        </button>
        <!-- 无操作黑幕：盖住整个 Sandbox（含浮锚），不吃事件 -->
        <div class="ov-idle-dim" id="ov-idle-dim" aria-hidden="true"></div>
    `;
    document.body.appendChild(overlayRoot);

    shell = overlayRoot.querySelector('.ov-window');
    stageEl = overlayRoot.querySelector('#ov-stage');

    return getRefs();
}

function getRefs() {
    return { root: overlayRoot, shell, stage: stageEl };
}

/** 显示 overlay：根容器常驻，避免 display 切换触发整层重绘。 */
export function show() {
    if (!overlayRoot) return;
    visible = true;
    overlayRoot.classList.add('ov-visible');
}

/** 隐藏 overlay：保留布局与合成层，只关闭可见性和交互。 */
export function hide() {
    if (!overlayRoot) return;
    visible = false;
    overlayRoot.classList.remove('ov-visible');
}

export function isVisible() { return visible; }
export function getRoot() { return overlayRoot; }
export function getShell() { return shell; }
export function getStage() { return stageEl; }
/** 左下角状态条容器（HUD 组件挂这里） */
export function getStatus() { return q('#ov-status'); }

/** light DOM 查询助手 */
export function q(sel) { return overlayRoot ? overlayRoot.querySelector(sel) : null; }
export function qAll(sel) { return overlayRoot ? Array.from(overlayRoot.querySelectorAll(sel)) : []; }

/** 打开/关闭设置抽屉 */
export function openDrawer() {
    const d = q('#ov-drawer'); const s = q('#ov-drawer-scrim');
    if (d) { d.hidden = false; void d.offsetWidth; d.classList.add('ov-open'); }
    if (s) { s.hidden = false; void s.offsetWidth; s.classList.add('ov-open'); }
}
export function closeDrawer() {
    const d = q('#ov-drawer'); const s = q('#ov-drawer-scrim');
    if (d) { d.classList.remove('ov-open'); setTimeout(() => { if (!d.classList.contains('ov-open')) d.hidden = true; }, 300); }
    if (s) { s.classList.remove('ov-open'); setTimeout(() => { if (!s.classList.contains('ov-open')) s.hidden = true; }, 300); }
}

/**
 * 把文本插入到底部输入框（不自动发送）。点 UI 可交互项（背包/道具/素材）时调用。
 * 追加在已有内容后（带换行分隔），触发 input 事件让 bridge 同步高度，并聚焦。
 * @param {string} text
 */
export function insertIntoComposer(text) {
    const input = q('#ov-input');
    if (!input || text == null) return;
    const add = String(text);
    const cur = input.value || '';
    input.value = cur ? (cur.replace(/\s*$/, '') + ' ' + add) : add;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // 自动隐藏模式下需先显出输入框
    if (shell) shell.classList.add('ov-composer-show');
    try { input.focus(); const n = input.value.length; input.setSelectionRange(n, n); } catch (_) {}
}
