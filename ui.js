// ui.js — 右侧抽屉装配（标签页：设置 / 测试 / 素材 + 底部 Log）
// 职责：
//   1) wireUI()：接线顶栏三按钮（素材/测试/设置 → 开抽屉到对应标签）、关闭、scrim、标签切换、Log。
//   2) 构建三个面板：
//      - 设置：渲染HTML/打字机/字体/间距/配色/灯光/通知 + AI 协议注入 + Prompt 编辑器。
//      - 测试：可解析样例文本 → 一键渲染到阅读器（合成楼层预览）。
//      - 素材：图标/图片/UI 资产的增删（assets-store.js，存 localStorage）。
//   3) applyCurrentSettings()：把外观设置映射成 #st-overlay-root 的 CSS 自定义属性（切换零重渲）。
//   4) Log 查看器：订阅 logger，实时刷新；默认折叠。

import { q, qAll, getRoot, openDrawer, closeDrawer } from './overlay.js';
import { getSettings, getSetting, setSetting } from './settings.js';
import { buildProtocolPrompt, getBuiltinProtocolText, SAMPLE_STAGE_TEXT_CN, SAMPLE_STAGE_TEXT_EN } from './protocol.js';
import { listAssets, addAsset, removeAsset, updateAsset, addFolder, renameFolderPath, moveAssetToFolder, listByFolder, subscribe as subAssets, fileToDataUrl, exportAssets, importAssets, setAssetVisible, assetRefPath, removeFolder, countAssetsInFolder, listFolderPreviewUrls } from './assets-store.js';
import { getEntries, clear as clearLog, subscribe as subLog } from './logger.js';
import { exitTestPreview, loadTestMessage } from './reader.js';
import { setTestImage, getTestImage, slotKeyFor, placeholderLabel } from './assets.js';
import { parseStageMessage } from './stage-parser.js';
import { applyIdleDim } from './idle-dim.js';

// —— 外观预设映射 ——
const FONT_STACKS = {
    serif: 'Georgia, "Times New Roman", "Noto Serif SC", "Songti SC", serif',
    sans: 'system-ui, -apple-system, "Segoe UI", "Noto Sans SC", sans-serif',
    mono: 'ui-monospace, Consolas, "SFMono-Regular", monospace',
    'cn-serif': '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif',
    kai: '"LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "Noto Serif SC", serif',
    rounded: '"PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", system-ui, sans-serif',
};
const SPACING = {
    compact: { pad: '20px 26px', padX: '26px', gap: '10px' },
    cozy:    { pad: '30px 40px', padX: '40px', gap: '16px' },
    roomy:   { pad: '40px 56px', padX: '56px', gap: '22px' },
};
const SCHEMES = {
    mono:  { accent: '#d8d8dd', accent2: '#9a9aa2' },
    amber: { accent: '#e8c07a', accent2: '#9a7a3a' },
    jade:  { accent: '#8fd6b4', accent2: '#3f8a6a' },
    rose:  { accent: '#e8a0b0', accent2: '#9a4a5c' },
};
const LIGHTING = {
    off:  { vignette: 0,    panelBg: 0.42, glow: 0 },
    dim:  { vignette: 0.55, panelBg: 0.55, glow: 0.04 },
    glow: { vignette: 0.7,  panelBg: 0.6,  glow: 0.1 },
};

let _onInject = null;
let _onChrome = null;
let _onMacro = null;

/** 把任意 CSS 颜色规约成 #rrggbb（<input type=color> 只认 hex）。失败回退灰。 */
function toHexColor(c) {
    try {
        const probe = document.createElement('div');
        probe.style.color = '';
        probe.style.color = String(c).trim();
        if (!probe.style.color) return '#d8d8dd';
        document.body.appendChild(probe);
        const rgb = getComputedStyle(probe).color;
        document.body.removeChild(probe);
        const m = rgb.match(/(\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return '#d8d8dd';
        const h = (n) => Number(n).toString(16).padStart(2, '0');
        return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
    } catch (_) { return '#d8d8dd'; }
}

/** 把设置映射到根元素 CSS 变量 / data 属性。外观项变更只调本函数，无需重渲阅读器。 */
export function applyCurrentSettings() {
    const root = getRoot();
    if (!root) return;
    const s = getSettings();
    root.style.setProperty('--ov-font-family', FONT_STACKS[s.fontFamily] || FONT_STACKS.serif);
    root.style.setProperty('--ov-font-size', `${s.fontSize || 17}px`);
    root.style.setProperty('--ov-line-height', String(s.lineHeight || 1.8));
    const sp = SPACING[s.spacing] || SPACING.cozy;
    root.style.setProperty('--ov-panel-pad', sp.pad);
    root.style.setProperty('--ov-panel-pad-x', sp.padX);
    root.style.setProperty('--ov-frag-gap', sp.gap);
    // 面板宽：屏幕宽度百分比
    const pw = Number(s.panelWidth);
    root.style.setProperty('--ov-panel-width', `${Number.isFinite(pw) ? Math.max(30, Math.min(100, pw)) : 70}%`);
    const sc = SCHEMES[s.scheme] || SCHEMES.mono;
    root.style.setProperty('--ov-accent', sc.accent);
    root.style.setProperty('--ov-accent-2', sc.accent2);
    const semanticColor = (key, followKey, stVar, fallback) => s[followKey]
        ? `var(${stVar}, ${fallback})`
        : ((s[key] && String(s[key]).trim()) || fallback);
    root.style.setProperty('--ov-text-color', semanticColor('textColor', 'followTextColor', '--SmartThemeBodyColor', '#ececf0'));
    root.style.setProperty('--ov-emphasis', semanticColor('emphasisColor', 'followEmphasisColor', '--SmartThemeBodyColor', '#ececf0'));
    root.style.setProperty('--ov-quote', semanticColor('quoteColor', 'followQuoteColor', '--SmartThemeQuoteColor', sc.accent));
    root.style.setProperty('--ov-bracket', semanticColor('bracketColor', 'followBracketColor', '--SmartThemeBodyColor', '#ececf0'));
    root.style.setProperty('--ov-italic', semanticColor('italicColor', 'followItalicColor', '--SmartThemeEmColor', '#d8d8dd'));
    // 顶部回显：与「正文」同一个 ST 变量——跟随 ST 就是跟随 ST 的正文配色
    root.style.setProperty('--ov-reply-color', semanticColor('replyColor', 'followReplyColor', '--SmartThemeBodyColor', '#ececf0'));
    // 正文亮度/对比度（%→倍率）
    root.style.setProperty('--ov-text-brightness', String((Number(s.textBrightness) || 100) / 100));
    root.style.setProperty('--ov-text-contrast', String((Number(s.textContrast) || 100) / 100));
    // 文本背景：仅开关开 + 当前有生成背景图时生效（data-has-bg-img 由 renderBg 写入）
    const textBgOn = !!s.textBgEnabled && root.dataset.hasBgImg === 'true';
    root.style.setProperty('--ov-text-bg', textBgOn ? resolveTextBg(s) : 'transparent');
    root.style.setProperty('--ov-text-bg-pad', textBgOn && (Number(s.textBgOpacity) || 0) > 0 ? '10px 14px' : '0px');
    root.style.setProperty('--ov-text-bg-radius', textBgOn && (Number(s.textBgOpacity) || 0) > 0 ? '12px' : '0px');
    root.style.setProperty('--ov-text-bg-gap', textBgOn && (Number(s.textBgOpacity) || 0) > 0 ? '0.7em' : '0px');
    root.dataset.textBg = textBgOn ? 'true' : 'false';
    const lt = LIGHTING[s.lighting] || LIGHTING.dim;
    const glowEnabled = !!s.backgroundGlowEnabled;
    root.style.setProperty('--ov-vignette', String(lt.vignette));
    root.style.setProperty('--ov-panel-bg', String(lt.panelBg));
    const glowBrightness = Math.max(0, Math.min(200, Number(s.backgroundGlowBrightness) || 0)) / 100;
    root.style.setProperty('--ov-glow', String(glowEnabled ? lt.glow * glowBrightness : 0));
    root.style.setProperty('--ov-window-glow', String(glowEnabled ? 0.5 : 0));
    root.style.setProperty('--ov-placeholder-glow', String(glowEnabled ? 0.6 : 0));
    const bf = Math.max(0, Number(s.bottomFade) || 0);
    const fadeK = Math.min(1, bf / 16);
    root.style.setProperty('--ov-bottom-fade', `${bf}vh`);
    root.style.setProperty('--ov-panel-bottom', `${bf}vh`);
    root.style.setProperty('--ov-panel-bg-live', String(lt.panelBg * fadeK));
    root.style.setProperty('--ov-panel-bg-live-soft', String(lt.panelBg * 0.85 * fadeK));
    root.style.setProperty('--ov-panel-shadow-live', String(0.5 * fadeK));
    root.style.setProperty('--ov-panel-stroke-live', `rgba(255,255,255,${0.055 * fadeK})`);
    root.style.setProperty('--ov-composer-bg', String(0.55 * fadeK));
    root.style.setProperty('--ov-composer-blur', `${10 * fadeK}px`);
    root.dataset.fade = bf === 0 ? '0' : '';  // 0=完全无底部虚化
    root.style.setProperty('--ov-text-top', `${Number(s.topTextHeight) || 0}px`);  // 顶部文本高度（首行下移偏移）
    root.style.setProperty('--ov-panel-maxh', `${Number(s.vnTextHeight) || 56}vh`);  // VN 文本显示区固定高度
    const bottomTextHeight = Number(s.plainTextMaxHeight);
    root.style.setProperty('--ov-plain-bottom-gap', `${Number.isFinite(bottomTextHeight) ? Math.max(0, bottomTextHeight) : 56}vh`); // 兼容旧 key：底部文本高度
    root.style.setProperty('--ov-hotzone', `${Number(s.composerHotzone) || 28}px`);
    root.style.setProperty('--ov-arrow-size', `${Number(s.composerArrowSize) || 28}px`);
    root.style.setProperty('--ov-arrow-height', `${Number(s.composerArrowHeight) || 12}px`);
    root.style.setProperty('--ov-arrow-bottom', `${Number(s.composerArrowBottom) || 6}px`);
    // 顶部回显胶囊（与底部输入框上下镜像）
    root.style.setProperty('--ov-reply-hotzone', `${Number(s.replyHotzone) || 28}px`);
    root.style.setProperty('--ov-reply-arrow-size', `${Number(s.replyArrowSize) || 28}px`);
    root.style.setProperty('--ov-reply-arrow-height', `${Number(s.replyArrowHeight) || 12}px`);
    root.style.setProperty('--ov-reply-arrow-top', `${Math.max(0, Number(s.replyArrowTop) || 0)}px`);
    root.style.setProperty('--ov-reply-top', `${Math.max(0, Number(s.replyTop) || 0)}px`);
    root.style.setProperty('--ov-reply-maxh', `${Number(s.replyMaxHeight) || 30}vh`);
    // topFade 只管遮罩；把正文往下推是 --ov-text-top 的活，两者不重叠
    const tf = Math.max(0, Number(s.topFade) || 0);
    root.style.setProperty('--ov-top-fade', `${tf}vh`);
    root.dataset.topfade = tf === 0 ? '0' : '';
    root.style.setProperty('--ov-jumpbar-inset', `${Math.max(0, Number(s.jumpbarInset) || 0)}px`);
    root.dataset.thinkingLine = s.thinkingLine ? 'true' : 'false';
    root.dataset.pointer = s.pointerNavigation ? 'nav' : 'select';
    root.dataset.notify = s.notify || 'toast';
}


/** 文本背景 rgba；opacity=0 → transparent */
function resolveTextBg(s) {
    const op = Math.max(0, Math.min(100, Number(s.textBgOpacity) || 0)) / 100;
    if (op <= 0) return 'transparent';
    const hex = toHexColor((s.textBgColor && String(s.textBgColor).trim()) || '#000000');
    const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!m) return `rgba(0,0,0,${op})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${op})`;
}
/** 读取酒馆主题 CSS 变量（拿不到返回 ''） */
function tavernThemeColor(name) {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name);
        return v ? v.trim() : '';
    } catch (_) { return ''; }
}

// —— 折叠母组设置：原生 <details> 接管展开/收起，caret 旋转 ——
function toggleCollapseCaret() {
    qAll('.ov-collapse').forEach((d) => {
        const c = d.querySelector('.ov-collapse-caret');
        if (c) c.textContent = d.open ? '▾' : '▸';
    });
}

/** 打字速度滑块旁的实时文字提示（越小越慢，越大越快）。正文/VN 两根滑条共用。 */
function twspeedLabel(sel = '#set-twspeed-v', key = 'typewriterSpeed') {
    const el = q(sel);
    if (!el) return;
    const v = Number(getSettings()[key]);
    const ms = Math.max(1, 151 - (v || 28));
    el.textContent = v >= 150 ? '瞬显' : `${ms}ms/字`;
}

/** 底部提示箭头显隐（由 composerArrow 设置控制） */
function applyComposerArrow() {
    const a = q('#ov-composer-arrow');
    if (a) a.style.display = getSetting('composerArrow') ? '' : 'none';
}

/** 顶部提示箭头显隐（由 replyArrow 设置控制） */
function applyReplyArrow() {
    const a = q('#ov-reply-arrow');
    if (a) a.style.display = getSetting('replyArrow') ? '' : 'none';
}

// —— 标签切换 ——
function activateTab(name) {
    qAll('.ov-dtab').forEach((b) => b.classList.toggle('ov-on', b.dataset.tab === name));
    qAll('.ov-pane').forEach((p) => p.classList.toggle('ov-on', p.dataset.pane === name));
}
function openTab(name) { activateTab(name); openDrawer(); }

function closeDrawerOnly() {
    closeDrawer();
}

// —— 顶栏 + 抽屉控制 ——
function wireControls() {
    const bind = (sel, tab) => { const el = q(sel); if (el) el.addEventListener('click', () => openTab(tab)); };
    bind('#ov-settings-btn', 'settings');
    bind('#ov-test-btn', 'test');
    bind('#ov-assets-btn', 'assets');
    bind('#ov-props-btn', 'props');
    const close = q('#ov-drawer-close'); if (close) close.addEventListener('click', closeDrawerOnly);
    const scrim = q('#ov-drawer-scrim'); if (scrim) scrim.addEventListener('click', closeDrawerOnly);
    qAll('.ov-dtab').forEach((b) => b.addEventListener('click', () => { if (b.dataset.tab !== 'test') exitTestPreview(); activateTab(b.dataset.tab); }));
}

// ===== 设置面板 =====
function buildSettingsPane() {
    const mount = q('#ov-pane-settings');
    if (!mount) return;
    const s = getSettings();
    mount.innerHTML = `
        <details class="ov-collapse" open>
            <summary class="ov-collapse-head"><span class="ov-collapse-caret">▾</span>正文</summary>
            <div class="ov-collapse-body">
                <label class="ov-field checkbox"><input type="checkbox" id="set-autoshow" /><span>新回复首次识别 VN / 舞台标签时自动打开（每轮仅一次）</span></label>
                <div class="ov-hint">关 = 只点入口按钮或 Ctrl/Cmd+Shift+O。开 = 本轮生成里第一次看到 VN/舞台标签弹一次，关掉后本轮不再弹。</div>
                <label class="ov-field checkbox"><input type="checkbox" id="set-renderhtml" /><span>渲染 HTML（关则纯文本）</span></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-typewriter" /><span>打字机逐字呈现</span></label>
                <label class="ov-field"><span>打字速度·正文</span><input type="range" id="set-twspeed" min="1" max="150" step="1" /><span class="ov-hint-inline" id="set-twspeed-v"></span></label>
                <label class="ov-field"><span>打字速度·VN</span><input type="range" id="set-twspeedvn" min="1" max="150" step="1" /><span class="ov-hint-inline" id="set-twspeedvn-v"></span></label>
            </div>
        </details>
        <details class="ov-collapse" open>
            <summary class="ov-collapse-head"><span class="ov-collapse-caret">▾</span>字体与间距</summary>
            <div class="ov-collapse-body">
                <label class="ov-field"><span>字族</span>
                    <select id="set-font" class="ov-select">
                        <option value="serif">叙事衬线</option><option value="cn-serif">中文宋体</option><option value="kai">文楷 / 楷体</option><option value="sans">清爽无衬线</option><option value="rounded">圆润屏显</option><option value="mono">等宽</option>
                    </select></label>
                <label class="ov-field"><span>字号</span><input type="range" id="set-fontsize" min="13" max="26" step="1" /></label>
                <label class="ov-field"><span>行高</span><input type="range" id="set-lineheight" min="1.3" max="2.4" step="0.1" /></label>
                <div class="ov-seg" id="set-spacing"><button type="button" data-v="compact">紧凑</button><button type="button" data-v="cozy">适中</button><button type="button" data-v="roomy">宽松</button></div>
                <label class="ov-field"><span>正文宽度</span><input type="range" id="set-panelwidth" min="30" max="100" step="1" /></label>
            </div>
        </details>
        <details class="ov-collapse">
            <summary class="ov-collapse-head"><span class="ov-collapse-caret">▾</span>配色与灯光</summary>
            <div class="ov-collapse-body">
                <div class="ov-seg" id="set-scheme"><button type="button" data-v="mono">素黑</button><button type="button" data-v="amber">琥珀</button><button type="button" data-v="jade">青玉</button><button type="button" data-v="rose">绯</button></div>
                <div class="ov-field ov-semantic-row"><span>正文</span><span class="ov-semantic-controls"><input type="color" id="set-textcolor" class="ov-color ov-semantic-color" /><label class="ov-follow-option"><input type="checkbox" id="set-follow-textcolor" /><span>跟随 ST</span></label></span></div>
                <div class="ov-field ov-semantic-row"><span>强调（粗体）</span><span class="ov-semantic-controls"><input type="color" id="set-emphasiscolor" class="ov-color ov-semantic-color" /><label class="ov-follow-option"><input type="checkbox" id="set-follow-emphasiscolor" /><span>跟随 ST</span></label></span></div>
                <div class="ov-field ov-semantic-row"><span>引号（中英文）</span><span class="ov-semantic-controls"><input type="color" id="set-quotecolor" class="ov-color ov-semantic-color" /><label class="ov-follow-option"><input type="checkbox" id="set-follow-quotecolor" /><span>跟随 ST</span></label></span></div>
                <div class="ov-field ov-semantic-row"><span>括号</span><span class="ov-semantic-controls"><input type="color" id="set-bracketcolor" class="ov-color ov-semantic-color" /><label class="ov-follow-option"><input type="checkbox" id="set-follow-bracketcolor" /><span>跟随 ST</span></label></span></div>
                <div class="ov-field ov-semantic-row"><span>斜体</span><span class="ov-semantic-controls"><input type="color" id="set-italiccolor" class="ov-color ov-semantic-color" /><label class="ov-follow-option"><input type="checkbox" id="set-follow-italiccolor" /><span>跟随 ST</span></label></span></div>
                <div class="ov-field ov-semantic-row"><span>我的输入回显</span><span class="ov-semantic-controls"><input type="color" id="set-replycolor" class="ov-color ov-semantic-color" /><label class="ov-follow-option"><input type="checkbox" id="set-follow-replycolor" /><span>跟随 ST</span></label></span></div>
                <div class="ov-hint">顶部悬停显示的那条用户输入。默认跟随 ST 的正文配色（与上面「正文」同一个变量）。</div>
                <label class="ov-field checkbox"><input type="checkbox" id="set-textbgenabled" /><span>文本背景（仅有生成背景图时显示）</span></label>
                <label class="ov-field"><span>文本背景色</span><input type="color" id="set-textbgcolor" class="ov-color" /><button class="ov-btn ghost" id="set-textbgcolor-reset" type="button">默认</button></label>
                <label class="ov-field"><span>文本背景透明度</span><input type="range" id="set-textbgopacity" min="0" max="90" step="1" /></label>
                <label class="ov-field"><span>正文亮度</span><input type="range" id="set-textbrightness" min="40" max="180" step="2" /></label>
                <label class="ov-field"><span>正文对比度</span><input type="range" id="set-textcontrast" min="50" max="180" step="2" /></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-thinkingline" /><span>思维链顶部横条</span></label>
                <div class="ov-seg" id="set-lighting"><button type="button" data-v="off">无</button><button type="button" data-v="dim">暗角</button><button type="button" data-v="glow">辉光</button></div>
                <label class="ov-field checkbox"><input type="checkbox" id="set-backgroundglow-enabled" /><span>背景泛光</span></label>
                <label class="ov-field"><span>泛光亮度</span><input type="range" id="set-backgroundglow-brightness" min="0" max="200" step="5" /></label>
            </div>
        </details>
        <details class="ov-collapse">
            <summary class="ov-collapse-head"><span class="ov-collapse-caret">▾</span>导航与界面</summary>
            <div class="ov-collapse-body">
                <label class="ov-field checkbox"><input type="checkbox" id="set-showfloormeta" /><span>显示楼层号（左上角）</span></label>
                <label class="ov-field"><span>滚轮换楼力度</span><input type="range" id="set-wheelstrength" min="200" max="1400" step="20" /></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-pointernavigation" /><span>左右键切换楼层</span></label>
                <div class="ov-hint">勾选：保持当前左右键导航。取消：左右键不切换楼层；拖动选择、右键复制、滚轮和楼层按钮不受影响。</div>
                <label class="ov-field"><span>底部黑框高度</span><input type="range" id="set-bottomfade" min="0" max="40" step="1" /></label>
                <label class="ov-field"><span>顶部文本高度</span><input type="range" id="set-toptextheight" min="0" max="200" step="4" /></label>
                <label class="ov-field"><span>底部文本高度</span><input type="range" id="set-plaintextmaxheight" min="0" max="70" step="1" /></label>
                <label class="ov-field"><span>VN 文本高度</span><input type="range" id="set-vntextheight" min="24" max="90" step="2" /></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-composerautohide" /><span>输入框自动隐藏（悬停底部显示）</span></label>
                <label class="ov-field"><span>输入框唤起热区</span><input type="range" id="set-composerhotzone" min="8" max="160" step="4" /></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-composerarrow" /><span>底部提示箭头</span></label>
                <label class="ov-field"><span>提示箭头大小</span><input type="range" id="set-arrowsize" min="14" max="72" step="2" /></label>
                <label class="ov-field"><span>提示箭头形状高度</span><input type="range" id="set-arrowheight" min="4" max="40" step="1" /></label>
                <label class="ov-field"><span>提示箭头位置高度</span><input type="range" id="set-arrowbottom" min="0" max="180" step="2" /></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-replyautohide" /><span>我的输入回显自动隐藏（悬停顶部显示）</span></label>
                <div class="ov-hint">鼠标移到画面顶部，从上方滑入一条只读胶囊，显示「是哪条输入得到了这一楼」。本楼之前没有用户消息时（开局第一楼等）整套不出现。</div>
                <label class="ov-field"><span>回显唤起热区</span><input type="range" id="set-replyhotzone" min="8" max="160" step="4" /></label>
                <label class="ov-field"><span>回显位置高度</span><input type="range" id="set-replytop" min="0" max="180" step="2" /></label>
                <label class="ov-field"><span>回显最大高度</span><input type="range" id="set-replymaxheight" min="10" max="70" step="1" /></label>
                <label class="ov-field"><span>正文顶部虚化</span><input type="range" id="set-topfade" min="0" max="40" step="1" /></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-replyarrow" /><span>顶部提示箭头</span></label>
                <label class="ov-field"><span>顶部箭头大小</span><input type="range" id="set-replyarrowsize" min="14" max="72" step="2" /></label>
                <label class="ov-field"><span>顶部箭头形状高度</span><input type="range" id="set-replyarrowheight" min="4" max="40" step="1" /></label>
                <label class="ov-field"><span>顶部箭头位置高度</span><input type="range" id="set-replyarrowtop" min="0" max="180" step="2" /></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-topbarautohide" /><span>右上角图标折叠（悬停展开）</span></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-jumpbarautohide" /><span>右侧楼层按钮自动隐藏（悬停右侧显示）</span></label>
                <label class="ov-field"><span>楼层条左右位置</span><input type="range" id="set-jumpbarinset" min="0" max="160" step="1" /></label>
                <div class="ov-hint">数值越大越靠左（距右边缘更远）。默认 14px。</div>
                <label class="ov-field checkbox"><input type="checkbox" id="set-idledim" /><span>无操作自动黑屏</span></label>
                <label class="ov-field"><span>静止多久变黑</span><input type="range" id="set-idledimdelay" min="5" max="10800" step="5" /><span class="ov-hint-inline" id="set-idledimdelay-v"></span></label>
                <div class="ov-hint">鼠标和键盘都不动到这个秒数后，画面用 3 秒渐渐变黑；动一下鼠标或按任意键立刻还原。</div>
            </div>
        </details>
        <details class="ov-collapse" open>
            <summary class="ov-collapse-head"><span class="ov-collapse-caret">▾</span>移动按键</summary>
            <div class="ov-collapse-body">
                <label class="ov-field checkbox"><input type="checkbox" id="set-keybutton-enabled" /><span>显示可移动虚拟按键</span></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-keybutton-docked" /><span>固定在发送键左侧（无边框）</span></label>
                <label class="ov-field"><span>麦克风键位（mic）</span>
                    <select id="set-keybutton-code" class="ov-select">
                        <option value="AltRight">Right Alt</option><option value="AltLeft">Left Alt</option>
                        <option value="ControlRight">Right Ctrl</option><option value="ControlLeft">Left Ctrl</option>
                        <option value="ShiftRight">Right Shift</option><option value="ShiftLeft">Left Shift</option>
                        <option value="Enter">Enter</option><option value="Space">Space</option>
                        <option value="Escape">Escape</option><option value="Tab">Tab</option>
                    </select></label>
                <div class="ov-row"><button class="ov-btn ghost" id="set-keybutton-capture" type="button">录入键位</button></div>
                <div class="ov-hint" id="set-keybutton-status" data-state="pending">系统桥接：检测中…</div>
                <div class="ov-hint">按键可拖动；点击后由 Windows 发送真实系统按键。</div>
            </div>
        </details>
        <details class="ov-collapse">
            <summary class="ov-collapse-head"><span class="ov-collapse-caret">▾</span>通知</summary>
            <div class="ov-collapse-body">
                <div class="ov-seg" id="set-notify"><button type="button" data-v="toast">浮窗</button><button type="button" data-v="inline">行内</button><button type="button" data-v="off">关闭</button></div>
            </div>
        </details>
        <details class="ov-collapse">
            <summary class="ov-collapse-head"><span class="ov-collapse-caret">▾</span>音频</summary>
            <div class="ov-collapse-body">
                <label class="ov-field checkbox"><input type="checkbox" id="set-audioenabled" /><span>启用音频（bgm/sfx/voice）</span></label>
                <label class="ov-field"><span>音频音量</span><input type="range" id="set-audiovolume" min="0" max="100" step="1" /></label>
                <div class="ov-hint">AI 在回复里夹 &lt;bgm&gt;/&lt;sfx&gt;/&lt;voice&gt; 标签时播放；切片段触发 sfx/voice，bgm 持续。</div>
            </div>
        </details>
        <details class="ov-collapse">
            <summary class="ov-collapse-head"><span class="ov-collapse-caret">▾</span>AI 调用</summary>
            <div class="ov-collapse-body">
                <label class="ov-field checkbox"><input type="checkbox" id="set-inject" /><span>向 AI 注入舞台协议</span></label>
                <label class="ov-field checkbox"><input type="checkbox" id="set-striptags" /><span>酒馆气泡剥掉标签（prompt 格式时正常显示）</span></label>
                <label class="ov-field"><span>注入楼层深度</span><input type="number" id="set-injectdepth" class="ov-text" min="0" max="100" step="1" style="flex:0 0 90px;" /></label>
                <label class="ov-field"><span>注入 role</span>
                    <select id="set-injectrole" class="ov-select">
                        <option value="system">system</option><option value="user">user</option><option value="assistant">assistant</option>
                    </select></label>
                <label class="ov-field"><span>自定义宏名</span><input class="ov-text" id="set-injectmacro" placeholder="{{sandbox_prompt}}" /></label>
                <label class="ov-field"><span>素材路径宏</span><input class="ov-text" id="set-materialmacro" placeholder="{{material}}" /></label>
                <div class="ov-hint">{{material}} = 可见素材路径（文件夹/名 + category:xx）。眼睛关则不进目录。</div>
                <label class="ov-field"><span>内置提示词语言</span>
                    <select id="set-protocollang" class="ov-select">
                        <option value="cn">中文</option><option value="en">English</option>
                    </select></label>
                <div class="ov-hint">编辑下方提示词可完全自定义教给 AI 的协议。默认显示内置协议，可直接编辑后点「保存协议」覆盖；「恢复内置」回到内置并清空自定义。</div>
                <textarea class="ov-code" id="set-protocol" spellcheck="false" placeholder="（空 = 使用内置协议）"></textarea>
                <div class="ov-row">
                    <button class="ov-btn" id="set-protocol-save" type="button">保存协议</button>
                    <button class="ov-btn ghost" id="set-protocol-reset" type="button">恢复内置</button>
                    <button class="ov-btn ghost" id="set-protocol-copy" type="button">复制</button>
                    <button class="ov-btn ghost" id="set-protocol-fullscreen" type="button" title="让 textarea 铺满整个抽屉方便编辑"><i class="fa-solid fa-maximize"></i> 全屏</button>
                </div>
                <div class="ov-hint">Ctrl/Cmd+Shift+O 开关 · 勾选左右键导航后：左键下一屏、右键上一屏 · 滚轮跨楼层</div>
            </div>
        </details>
    `;
    const reflect = () => applyCurrentSettings();
    const chrome = () => { applyCurrentSettings(); _onChrome?.(); };
    bindCheckbox('#set-autoshow', 'autoShow', s);
    bindCheckbox('#set-renderhtml', 'renderHtml', s, reflect);
    bindCheckbox('#set-typewriter', 'typewriter', s);
    bindRange('#set-twspeed', 'typewriterSpeed', s, () => twspeedLabel());
    bindRange('#set-twspeedvn', 'typewriterSpeedVn', s, () => twspeedLabel('#set-twspeedvn-v', 'typewriterSpeedVn'));
    twspeedLabel();
    twspeedLabel('#set-twspeedvn-v', 'typewriterSpeedVn');
    bindSelect('#set-font', 'fontFamily', s, reflect);
    bindRange('#set-fontsize', 'fontSize', s, reflect);
    bindRange('#set-lineheight', 'lineHeight', s, reflect);
    bindSeg('#set-spacing', 'spacing', s, reflect);
    bindRange('#set-panelwidth', 'panelWidth', s, reflect);
    bindSeg('#set-scheme', 'scheme', s, reflect);
    bindSeg('#set-lighting', 'lighting', s, reflect);
    bindCheckbox('#set-backgroundglow-enabled', 'backgroundGlowEnabled', s, reflect);
    bindRange('#set-backgroundglow-brightness', 'backgroundGlowBrightness', s, applyCurrentSettings);
    bindSeg('#set-notify', 'notify', s, reflect);

    // —— 音频 ——
    bindCheckbox('#set-audioenabled', 'audioEnabled', s);
    bindRange('#set-audiovolume', 'audioVolume', s);

    // —— 导航 / 界面 ——
    bindCheckbox('#set-showfloormeta', 'showFloorMeta', s, () => {
        // 只切显隐，不写占位文本：楼层号文本由阅读器 updateFloorMeta() 填。
        // 重开时若还没渲染就写「#?」会残留假占位，故这里只负责显隐并触发重填。
        const fm = q('#ov-floor-meta');
        if (fm) fm.style.display = getSetting('showFloorMeta') ? '' : 'none';
        reflect();
    });
    bindRange('#set-wheelstrength', 'wheelStrength', s);
    bindCheckbox('#set-pointernavigation', 'pointerNavigation', s, reflect);
    bindRange('#set-bottomfade', 'bottomFade', s, reflect);
    bindRange('#set-toptextheight', 'topTextHeight', s, reflect);
    bindRange('#set-vntextheight', 'vnTextHeight', s, reflect);
    bindRange('#set-plaintextmaxheight', 'plainTextMaxHeight', s, reflect);
    bindCheckbox('#set-composerautohide', 'composerAutohide', s, chrome);
    bindRange('#set-composerhotzone', 'composerHotzone', s, chrome);
    bindCheckbox('#set-composerarrow', 'composerArrow', s, applyComposerArrow);
    applyComposerArrow();
    bindRange('#set-arrowsize', 'composerArrowSize', s, reflect);
    bindRange('#set-arrowheight', 'composerArrowHeight', s, reflect);
    bindRange('#set-arrowbottom', 'composerArrowBottom', s, reflect);
    bindCheckbox('#set-replyautohide', 'replyAutohide', s, chrome);
    bindRange('#set-replyhotzone', 'replyHotzone', s, chrome);
    bindRange('#set-replytop', 'replyTop', s, reflect);
    bindRange('#set-replymaxheight', 'replyMaxHeight', s, reflect);
    bindRange('#set-topfade', 'topFade', s, reflect);
    bindCheckbox('#set-replyarrow', 'replyArrow', s, applyReplyArrow);
    applyReplyArrow();
    bindRange('#set-replyarrowsize', 'replyArrowSize', s, reflect);
    bindRange('#set-replyarrowheight', 'replyArrowHeight', s, reflect);
    bindRange('#set-replyarrowtop', 'replyArrowTop', s, reflect);
    bindCheckbox('#set-topbarautohide', 'topbarAutohide', s, chrome);
    bindCheckbox('#set-jumpbarautohide', 'jumpbarAutohide', s, chrome);
    bindRange('#set-jumpbarinset', 'jumpbarInset', s, applyCurrentSettings);
    // 5 秒 ~ 3 小时跨度太大，秒数直读不出来 → 按量级换成 秒/分/时
    const fmtIdleDelay = (v) => (v < 60 ? `${v}秒`
        : v < 3600 ? `${Math.floor(v / 60)}分${v % 60 ? `${v % 60}秒` : ''}`
            : `${Math.floor(v / 3600)}时${Math.round((v % 3600) / 60) ? `${Math.round((v % 3600) / 60)}分` : ''}`);
    const idleDelayLabel = () => { const el = q('#set-idledimdelay-v'); if (el) el.textContent = fmtIdleDelay(Number(getSettings().idleDimDelay ?? 60)); };
    idleDelayLabel();
    bindCheckbox('#set-idledim', 'idleDim', s, applyIdleDim);
    bindRange('#set-idledimdelay', 'idleDimDelay', s, () => { idleDelayLabel(); applyIdleDim(); });
    bindCheckbox('#set-keybutton-enabled', 'keyButtonEnabled', s, _onChrome);
    bindCheckbox('#set-keybutton-docked', 'keyButtonDocked', s, _onChrome);
    bindSelect('#set-keybutton-code', 'keyButtonCode', s, _onChrome);
    const keyCapture = q('#set-keybutton-capture');
    const keySelect = q('#set-keybutton-code');
    if (keyCapture) keyCapture.addEventListener('click', () => {
        keyCapture.textContent = '请按键…';
        window.addEventListener('keydown', (e) => {
            e.preventDefault();
            const code = e.code || e.key;
            setSetting('keyButtonCode', code); setSetting('keyButtonKey', e.key);
            if (keySelect) {
                let option = Array.from(keySelect.options).find((item) => item.value === code);
                if (!option) { option = document.createElement('option'); option.value = code; option.textContent = `${e.key} (${code})`; keySelect.appendChild(option); }
                keySelect.value = code;
            }
            keyCapture.textContent = `已录入：${e.key}`; _onChrome?.();
        }, { once: true });
    });

    // —— 跟随 ST / 五类独立文字颜色 ——
    const semanticColors = [
        ['#set-textcolor', '#set-follow-textcolor', 'textColor', 'followTextColor', '--SmartThemeBodyColor', '#ececf0'],
        ['#set-emphasiscolor', '#set-follow-emphasiscolor', 'emphasisColor', 'followEmphasisColor', '--SmartThemeBodyColor', '#ececf0'],
        ['#set-quotecolor', '#set-follow-quotecolor', 'quoteColor', 'followQuoteColor', '--SmartThemeQuoteColor', (SCHEMES[s.scheme] || SCHEMES.mono).accent],
        ['#set-bracketcolor', '#set-follow-bracketcolor', 'bracketColor', 'followBracketColor', '--SmartThemeBodyColor', '#ececf0'],
        ['#set-italiccolor', '#set-follow-italiccolor', 'italicColor', 'followItalicColor', '--SmartThemeEmColor', '#d8d8dd'],
        ['#set-replycolor', '#set-follow-replycolor', 'replyColor', 'followReplyColor', '--SmartThemeBodyColor', '#ececf0'],
    ];
    const syncSemanticColors = () => {
        for (const [selector, followSelector, key, followKey, stVar, fallback] of semanticColors) {
            const input = q(selector);
            const followInput = q(followSelector);
            if (!input) continue;
            const follow = !!getSetting(followKey);
            const current = follow ? (tavernThemeColor(stVar) || fallback) : (getSetting(key) || fallback);
            input.value = toHexColor(current);
            input.disabled = follow;
            if (followInput) followInput.checked = follow;
        }
        applyCurrentSettings();
    };
    for (const [selector, followSelector, key, followKey, , fallback] of semanticColors) {
        const input = q(selector);
        if (!input) continue;
        input.value = toHexColor(getSetting(key) || fallback);
        input.addEventListener('input', () => { setSetting(key, input.value); applyCurrentSettings(); });
        bindCheckbox(followSelector, followKey, s, syncSemanticColors);
    }
    syncSemanticColors();

    // —— 文本背景 / 亮度 / 对比度 ——
    bindCheckbox('#set-textbgenabled', 'textBgEnabled', s, applyCurrentSettings);
    const tbg = q('#set-textbgcolor');
    if (tbg) {
        tbg.value = toHexColor((s.textBgColor && String(s.textBgColor).trim()) || '#000000');
        tbg.addEventListener('input', () => { setSetting('textBgColor', tbg.value); applyCurrentSettings(); });
    }
    const tbgr = q('#set-textbgcolor-reset');
    if (tbgr) tbgr.addEventListener('click', () => { setSetting('textBgColor', '#000000'); applyCurrentSettings(); if (tbg) tbg.value = '#000000'; });
    bindRange('#set-textbgopacity', 'textBgOpacity', s, applyCurrentSettings);
    bindRange('#set-textbrightness', 'textBrightness', s, applyCurrentSettings);
    bindRange('#set-textcontrast', 'textContrast', s, applyCurrentSettings);
    bindCheckbox('#set-thinkingline', 'thinkingLine', s, applyCurrentSettings);

    const inj = q('#set-inject');
    inj.checked = !!s.injectProtocol;
    inj.addEventListener('change', () => { setSetting('injectProtocol', inj.checked); _onInject?.(inj.checked); });

    // —— 剥标签 + 注入参数（depth/role/宏名） ——
    bindCheckbox('#set-striptags', 'stripTags', s);
    const reinject = () => { if (getSettings().injectProtocol) _onInject?.(true); };
    bindRange('#set-injectdepth', 'injectDepth', s, reinject); // number input 用 bindRange（取 Number）
    bindSelect('#set-injectrole', 'injectRole', s, reinject);
    const macro = q('#set-injectmacro');
    if (macro) {
        macro.value = s.injectMacro || '{{sandbox_prompt}}';
        macro.addEventListener('change', () => { setSetting('injectMacro', macro.value.trim()); _onMacro?.(); });
    }
    const mmacro = q('#set-materialmacro');
    if (mmacro) {
        mmacro.value = s.materialMacro || '{{material}}';
        mmacro.addEventListener('change', () => { setSetting('materialMacro', mmacro.value.trim()); _onMacro?.(); });
    }

    // —— Prompt 编辑器：默认显示生效协议（自定义非空则显示自定义，否则显示当前语言内置）。
    //    「保存」把当前 textarea 内容存为 customProtocol（与内置相同则存空=用内置，避免冗余）；
    //    「恢复内置」清空自定义并回填内置文本到编辑器。
    const ta = q('#set-protocol');
    const builtin = () => getBuiltinProtocolText(getSettings().protocolLanguage);
    const initialText = (s.customProtocol && String(s.customProtocol).trim()) || builtin();
    ta.value = initialText;
    ta.setAttribute('data-builtin', builtin());

    // token 计数：textarea 下灰色小字；全屏时钉在编辑区底
    let tokEl = q('#set-protocol-tokens');
    if (!tokEl) {
        tokEl = document.createElement('div');
        tokEl.id = 'set-protocol-tokens';
        tokEl.className = 'ov-code-tokens';
        tokEl.textContent = '… tokens';
        ta.insertAdjacentElement('afterend', tokEl);
    }
    let tokTimer = null;
    let tokSeq = 0;
    const roughTokens = (t) => {
        const s = String(t || '');
        const cjk = (s.match(/[一-鿿㐀-䶿豈-﫿]/g) || []).length;
        return Math.max(0, Math.ceil(cjk + (s.length - cjk) / 4));
    };
    const refreshTokens = () => {
        clearTimeout(tokTimer);
        tokTimer = setTimeout(async () => {
            const text = ta.value || '';
            const seq = ++tokSeq;
            let n = roughTokens(text);
            try {
                const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
                if (ctx && typeof ctx.getTokenCountAsync === 'function' && text) {
                    const r = await ctx.getTokenCountAsync(text);
                    if (typeof r === 'number' && !Number.isNaN(r)) n = r;
                }
            } catch (_) { /* keep rough */ }
            if (seq !== tokSeq) return;
            tokEl.textContent = `${n.toLocaleString()} tokens`;
        }, 180);
    };
    refreshTokens();
    ta.addEventListener('input', refreshTokens);

    bindSelect('#set-protocollang', 'protocolLanguage', s, () => {
        if (!getSettings().customProtocol) ta.value = builtin();
        ta.setAttribute('data-builtin', builtin());
        if (getSettings().injectProtocol) _onInject?.(true);
        refreshTokens();
    });
    q('#set-protocol-save').addEventListener('click', (e) => {
        const v = ta.value.trim();
        // 与当前语言内置一致 → 存空（走内置），否则存自定义
        const norm = v.replace(/\s+/g, ' ').trim();
        const builtinNorm = builtin().replace(/\s+/g, ' ').trim();
        setSetting('customProtocol', norm && norm !== builtinNorm ? v : '');
        if (getSettings().injectProtocol) _onInject?.(true);
        flash(e.target, '已保存 ✓', '保存协议');
        refreshTokens();
    });
    q('#set-protocol-reset').addEventListener('click', () => {
        setSetting('customProtocol', '');
        ta.value = builtin();
        ta.setAttribute('data-builtin', builtin());
        if (getSettings().injectProtocol) _onInject?.(true);
        refreshTokens();
    });
    q('#set-protocol-copy').addEventListener('click', async (e) => {
        try { await navigator.clipboard.writeText(buildProtocolPrompt()); flash(e.target, '已复制 ✓', '复制'); }
        catch { flash(e.target, '失败', '复制'); }
    });
    // 协议编辑器全屏按钮：让 textarea 铺满整个抽屉 body。
    //   全屏后原按钮行被 textarea 盖住点不到，故浮一颗「退出全屏」按钮在右上角（Esc 同效）。
    const protoFs = q('#set-protocol-fullscreen');
    if (protoFs) {
        const drawerBody = ta.closest('.ov-drawer-body');
        const exitBtn = document.createElement('button');
        exitBtn.type = 'button';
        exitBtn.className = 'ov-btn ov-code-fs-exit';
        exitBtn.title = '退出全屏（Esc）';
        exitBtn.innerHTML = '<i class="fa-solid fa-minimize"></i> 退出全屏';
        exitBtn.hidden = true;
        ta.insertAdjacentElement('afterend', exitBtn);
        const setFull = (on) => {
            ta.classList.toggle('ov-code-fullscreen', on);
            tokEl.classList.toggle('ov-code-tokens-fs', on);
            exitBtn.hidden = !on;
            if (drawerBody) {
                // 绝对定位以内容顶为原点：先滚回顶再锁滚动，textarea 才恰好盖住可视区
                if (on) drawerBody.scrollTop = 0;
                drawerBody.classList.toggle('ov-code-fs-lock', on);
            }
            protoFs.innerHTML = on ? '<i class="fa-solid fa-minimize"></i> 退出全屏' : '<i class="fa-solid fa-maximize"></i> 全屏';
            if (on) ta.focus();
            refreshTokens();
        };
        protoFs.addEventListener('click', () => setFull(!ta.classList.contains('ov-code-fullscreen')));
        exitBtn.addEventListener('click', () => setFull(false));
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && ta.classList.contains('ov-code-fullscreen')) { e.stopPropagation(); setFull(false); }
        });
    }

    wireRangeNumbers(mount);   // 所有滑条统一补上右侧可编辑数值框
}

// 滑条右侧数值的单位（纯展示；聚焦编辑时只留数字）。没列的就不带单位。
const RANGE_UNITS = {
    'set-fontsize': 'px', 'set-panelwidth': '%',
    'set-textbgopacity': '%', 'set-textbrightness': '%', 'set-textcontrast': '%',
    'set-backgroundglow-brightness': '%', 'set-audiovolume': '%',
    'set-bottomfade': 'vh', 'set-plaintextmaxheight': 'vh', 'set-vntextheight': 'vh',
    'set-toptextheight': 'px', 'set-composerhotzone': 'px', 'set-arrowsize': 'px',
    'set-arrowheight': 'px', 'set-arrowbottom': 'px', 'set-jumpbarinset': 'px',
    'set-replyhotzone': 'px', 'set-replytop': 'px', 'set-replyarrowsize': 'px',
    'set-replyarrowheight': 'px', 'set-replyarrowtop': 'px',
    'set-replymaxheight': 'vh', 'set-topfade': 'vh',
    'set-idledimdelay': 's',
};

/**
 * 给面板里每根滑条补一个右侧数值框：平时是一行数字（无边框），点进去才变成可改的输入框。
 * 写回时直接改 range.value 再派发它的 input 事件——沿用 bindRange 已有的持久化与副作用，
 * 不另起一套存储，也不必知道每根滑条对应哪个设置键。
 * @param {ParentNode} scope 设置面板根节点
 */
function wireRangeNumbers(scope) {
    for (const range of scope.querySelectorAll('input[type="range"]')) {
        const unit = RANGE_UNITS[range.id] || '';
        const box = document.createElement('input');
        box.type = 'text';
        box.className = 'ov-num';
        box.inputMode = 'decimal';
        box.setAttribute('aria-label', '数值');

        const show = () => { box.value = `${range.value}${unit}`; };
        show();
        range.addEventListener('input', show);

        box.addEventListener('focus', () => { box.value = range.value; box.select(); });
        // 数值框在 <label class="ov-field"> 里，而该 label 的隐式控件是滑条本身；
        // 拦下冒泡，免得点数字被 label 转发成"点滑条"而丢焦点。
        box.addEventListener('click', (e) => e.stopPropagation());
        box.addEventListener('blur', () => {
            const n = parseFloat(box.value);
            // 赋给 range 后浏览器自己按 min/max/step 归位，不用手写夹取
            if (Number.isFinite(n) && String(n) !== range.value) {
                range.value = String(n);
                range.dispatchEvent(new Event('input', { bubbles: true }));
            }
            show();
        });
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); box.blur(); }
            else if (e.key === 'Escape') { e.preventDefault(); show(); box.blur(); }
        });
        range.after(box);
    }
}

// ===== 测试面板 =====
// 随扩展附带的测试图（test-assets/），供「填入内置测试图」一键铺满所有图位。
// 按 role 分池、在池内循环取，而不是写死 slot key——样例文本里的角色名/道具名一改，
// 写死的 key 就全部失配，按角色顺序分配则永远对得上。
const BUILTIN_TEST_IMAGES = {
    bg:     ['bg-beacon.webp', 'bg-beacon-lit.webp'],
    sprite: ['sprite-lira.webp', 'sprite-lira-smiling.webp'],
    cg:     ['bg-beacon-lit.webp'],
    item:   ['item-compass.webp', 'item-cloak.webp'],
};
const builtinTestUrl = (file) => new URL(`./test-assets/${file}`, import.meta.url).href;

// 具名图位：从当前测试文本解析出每一个「独立图位」（背景/每个角色/每张 CG/每个道具），
//   每位给一个独立上传框。图位键由 assets.slotKeyFor(role, descriptor) 生成，与 resolveImage 完全一致，
//   所以上传的图会精确落到对应那一张（如「黄铜罗盘」和「油布斗篷」互不覆盖）。
function collectSlots(mes) {
    const parsed = parseStageMessage(String(mes ?? ''));
    const slots = [];
    const seen = new Set();
    const push = (role, descriptor, label, hint) => {
        const key = slotKeyFor(role, descriptor);
        if (!key || seen.has(key)) return;
        seen.add(key);
        slots.push({ key, role, label, hint });
    };
    for (const f of parsed.fragments) {
        if (f.scene && f.scene.bg) push('bg', f.scene, f.scene.bg, '场景背景（铺满全屏）');
        if (f.kind === 'say' && f.speaker) {
            const desc = { char: f.speaker, emo: f.emo };
            push('sprite', desc, placeholderLabel('sprite', desc), '角色立绘（透明PNG）');
        }
        if (f.kind === 'cg') push('cg', { img: f.img, caption: f.raw }, f.img || 'CG', '全屏插画');
        for (const it of (f.items || [])) push('item', { img: it.img, caption: it.caption }, it.img || '道具', '道具浮图');
    }
    // 兜底：解析不出任何图位时（纯文本）给一个背景位
    return slots;
}

function buildTestPane() {
    const mount = q('#ov-pane-test');
    if (!mount) return;
    mount.innerHTML = `
        <div class="ov-set-group">
            <div class="ov-set-title">测试文本（中英双版，覆盖几乎所有标签）</div>
            <div class="ov-seg" id="test-lang"><button type="button" data-v="cn">中文</button><button type="button" data-v="en">EN</button></div>
            <div class="ov-hint">编辑后点「渲染到阅读器」会作为合成楼层预览（不影响真实聊天）。</div>
            <textarea class="ov-code ov-code-tall" id="test-text" spellcheck="false"></textarea>
            <div class="ov-row">
                <button class="ov-btn" id="test-render" type="button">渲染到阅读器</button>
                <button class="ov-btn ghost" id="test-reset" type="button">重置样例</button>
            </div>
        </div>
        <div class="ov-set-group">
            <div class="ov-set-title">注入测试图（每个图位独立上传）</div>
            <div class="ov-hint">下面每一项对应文本里的一个具体图位（背景／每个角色／每张CG／每个道具）。上传后点「渲染到阅读器」在对应位置预览；切回真实聊天自动清除。推荐分辨率见每项提示。</div>
            <div class="ov-row">
                <button class="ov-btn ghost" id="test-fill-builtin" type="button">填入内置测试图</button>
                <button class="ov-btn ghost" id="test-clear-imgs" type="button">清空全部</button>
            </div>
            <div id="test-slots"></div>
            <div class="ov-hint" id="test-slots-empty" hidden>当前文本解析不出可上传的图位。</div>
        </div>
    `;
    const ta = q('#test-text');
    let curLang = 'cn';
    ta.value = SAMPLE_STAGE_TEXT_CN;

    // 各图位推荐分辨率（对应 style.css 的层尺寸）
    const RES = {
        bg: '1920×1080（cover 裁切铺满）',
        sprite: '透明PNG ~760×1040，底部对齐（显示约 380×72%屏高）',
        cg: '1920×1080（cover 铺满全屏）',
        item: '~256×256 透明PNG（显示框约 132×100）',
    };

    // 依据当前文本重建图位上传列表
    const rebuildSlots = () => {
        const host = q('#test-slots');
        const empty = q('#test-slots-empty');
        if (!host) return;
        host.innerHTML = '';
        const slots = collectSlots(ta.value);
        if (empty) empty.hidden = slots.length > 0;
        for (const slot of slots) {
            const row = document.createElement('div');
            row.className = 'ov-test-img';
            row.dataset.key = slot.key;
            const cur = getTestImage(slot.key);
            row.innerHTML = `
                <span class="ov-test-img-label" title="${slot.role} · ${RES[slot.role] || ''}">${escapeHtml(slot.label)}</span>
                <img class="ov-test-img-thumb" alt="" ${cur ? `src="${cur}"` : 'hidden'} />
                <label class="ov-btn ghost ov-test-pick">选择图片<input type="file" accept="image/*" hidden /></label>
                <button class="ov-btn ghost ov-test-img-clear" type="button">清除</button>
            `;
            const thumb = row.querySelector('.ov-test-img-thumb');
            const file = row.querySelector('input[type=file]');
            const clear = row.querySelector('.ov-test-img-clear');
            file.addEventListener('change', async (e) => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                try {
                    const url = await fileToDataUrl(f);
                    setTestImage(slot.key, url);
                    if (thumb) { thumb.src = url; thumb.hidden = false; }
                    loadTestMessage(ta.value);
                } catch (err) { console.warn('[overlay] 读取测试图失败：', err); }
                e.target.value = '';
            });
            clear.addEventListener('click', () => {
                setTestImage(slot.key, null);
                if (thumb) { thumb.src = ''; thumb.hidden = true; }
                loadTestMessage(ta.value);
            });
            host.appendChild(row);
        }
    };
    rebuildSlots();

    // 中英文切换
    const langSeg = q('#test-lang');
    const langBtns = langSeg ? Array.from(langSeg.querySelectorAll('button')) : [];
    const markLang = () => langBtns.forEach((b) => b.classList.toggle('ov-on', b.dataset.v === curLang));
    markLang();
    langBtns.forEach((b) => b.addEventListener('click', () => {
        const curSample = curLang === 'cn' ? SAMPLE_STAGE_TEXT_CN : SAMPLE_STAGE_TEXT_EN;
        curLang = b.dataset.v;
        const newSample = curLang === 'cn' ? SAMPLE_STAGE_TEXT_CN : SAMPLE_STAGE_TEXT_EN;
        if (ta.value === curSample || !ta.value.trim()) ta.value = newSample;
        markLang();
        rebuildSlots();   // 换语言 → 角色名/道具名变了 → 重建图位
    }));

    q('#test-fill-builtin').addEventListener('click', () => {
        const used = {};   // role → 该角色已分配到第几张，用于在池内循环
        for (const slot of collectSlots(ta.value)) {
            const pool = BUILTIN_TEST_IMAGES[slot.role];
            if (!pool || !pool.length) continue;
            const n = used[slot.role] || 0;
            used[slot.role] = n + 1;
            setTestImage(slot.key, builtinTestUrl(pool[n % pool.length]));
        }
        rebuildSlots();
        loadTestMessage(ta.value);
    });
    // test-assets/ 未随仓库发布（见 .gitignore）。没有这些文件时按钮点了也只会填出一堆 404，
    // 不如直接藏掉——探一张即可，六张要么都在要么都不在。
    fetch(builtinTestUrl(BUILTIN_TEST_IMAGES.bg[0]), { method: 'HEAD' })
        .then((r) => { if (!r.ok) q('#test-fill-builtin')?.remove(); })
        .catch(() => q('#test-fill-builtin')?.remove());
    q('#test-clear-imgs').addEventListener('click', () => {
        for (const slot of collectSlots(ta.value)) setTestImage(slot.key, null);
        rebuildSlots();
        loadTestMessage(ta.value);
    });

    q('#test-render').addEventListener('click', () => { loadTestMessage(ta.value); closeDrawer(); });
    q('#test-reset').addEventListener('click', () => {
        ta.value = curLang === 'cn' ? SAMPLE_STAGE_TEXT_CN : SAMPLE_STAGE_TEXT_EN;
        rebuildSlots();
    });
    // 手动编辑文本后也刷新图位（防抖）
    let slotTimer = null;
    ta.addEventListener('input', () => { clearTimeout(slotTimer); slotTimer = setTimeout(rebuildSlots, 400); });
}

/** 转义用于 innerHTML 的文本，防注入 */
function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
}

// ===== 素材面板 =====
function buildAssetsPane() {
    const mount = q('#ov-pane-assets');
    if (!mount) return;
    document.querySelector('#asset-modal')?.remove();
    mount.innerHTML = `
        <div class="ov-set-group">
            <div class="ov-asset-head">
                <div class="ov-set-title">素材库 <span class="ov-muted" id="asset-count"></span></div>
                <div class="ov-asset-actions">
                    <button class="ov-icon-btn" id="asset-add-open" title="添加素材" type="button"><i class="fa-solid fa-plus"></i></button>
                    <button class="ov-icon-btn" id="asset-io-open" title="导入/导出" type="button"><i class="fa-solid fa-file-import"></i></button>
                    <button class="ov-btn ghost" id="asset-folder-add" type="button"><i class="fa-solid fa-folder-plus"></i> 创建文件夹</button>
                </div>
            </div>
            <input class="ov-asset-folder-new ov-text" id="asset-folder-new" placeholder="输入文件夹名，Enter 创建" hidden />
            <div class="ov-asset-editor" id="asset-editor" hidden>
                <label class="ov-field"><span>名称</span><input class="ov-text" id="asset-name" placeholder="如：米拉 · 缓和" /></label>
                <label class="ov-field"><span>路径</span><input class="ov-text" id="asset-path" placeholder="如：角色/米拉" /></label>
                <label class="ov-field"><span>类型 category</span><select class="ov-select" id="asset-category"><option value="">（无）</option><option value="bg">bg 背景</option><option value="char">char 角色</option><option value="cg">cg 插图</option><option value="item">item 道具</option><option value="sprite">sprite</option><option value="other">other</option></select></label>
                <label class="ov-field"><span>标签</span><input class="ov-text" id="asset-tag" placeholder="可选备注" /></label>
                <label class="ov-field"><span>URL</span><input class="ov-text" id="asset-url" placeholder="图片 URL 或留空走上传" /></label>
                <div class="ov-row">
                    <button class="ov-btn" id="asset-add" type="button">添加 URL</button>
                    <label class="ov-btn ghost" for="asset-file" style="cursor:pointer;">上传文件</label>
                    <button class="ov-btn ghost" id="asset-cancel" type="button">取消</button>
                    <input type="file" id="asset-file" accept="image/*" hidden />
                </div>
                <div class="ov-hint">路径可作为分类/母路径；大图建议用 URL，上传文件会存为 dataURL。</div>
            </div>
            <div class="ov-asset-io" id="asset-io" hidden>
                <button class="ov-btn" id="asset-export" type="button">导出 JSON</button>
                <label class="ov-btn ghost" for="asset-import-file" style="cursor:pointer;">导入 JSON</label>
                <input type="file" id="asset-import-file" accept="application/json,.json" hidden />
            </div>
            <div class="ov-asset-breadcrumb" id="asset-breadcrumb"></div>
            <div class="ov-asset-grid" id="asset-grid"></div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', `
        <div class="ov-asset-modal" id="asset-modal" hidden>
            <div class="ov-asset-modal-card">
                <img class="ov-asset-modal-img" id="asset-modal-img" alt="" />
                <div class="ov-asset-modal-form">
                    <label class="ov-field"><span>名称</span><input class="ov-text" id="asset-modal-name" /></label>
                    <label class="ov-field"><span>路径</span><input class="ov-text" id="asset-modal-path" /></label>
                    <label class="ov-field"><span>类型 category</span><select class="ov-select" id="asset-modal-category"><option value="">（无）</option><option value="bg">bg</option><option value="char">char</option><option value="cg">cg</option><option value="item">item</option><option value="sprite">sprite</option><option value="other">other</option></select></label>
                    <label class="ov-field"><span>标签</span><input class="ov-text" id="asset-modal-tag" /></label>
                    <label class="ov-field"><span>URL</span><input class="ov-text" id="asset-modal-url" /></label>
                    <div class="ov-row">
                        <button class="ov-btn" id="asset-modal-save" type="button">保存</button>
                        <button class="ov-btn ghost" id="asset-modal-close" type="button">关闭</button>
                    </div>
                </div>
            </div>
        </div>
    `);
    const editor = q('#asset-editor');
    const io = q('#asset-io');
    let editingAssetId = null;
    buildAssetsPane.currentFolderPath = buildAssetsPane.currentFolderPath || '';
    const openEditor = () => { if (editor) editor.hidden = false; if (io) io.hidden = true; q('#asset-path').value = buildAssetsPane.currentFolderPath || ''; q('#asset-name')?.focus(); };
    const clearEditor = () => { q('#asset-url').value = ''; q('#asset-name').value = ''; q('#asset-tag').value = ''; if (q('#asset-category')) q('#asset-category').value = ''; q('#asset-path').value = buildAssetsPane.currentFolderPath || ''; };
    const modal = (sel) => document.querySelector(sel);
    const openAssetModal = (a) => {
        editingAssetId = a.id;
        const img = modal('#asset-modal-img');
        img.src = a.url;
        img.alt = a.name || '';
        modal('#asset-modal-name').value = a.name || '';
        modal('#asset-modal-path').value = a.path || '';
        modal('#asset-modal-tag').value = a.tag || '';
        if (modal('#asset-modal-category')) modal('#asset-modal-category').value = a.category || '';
        modal('#asset-modal-url').value = a.url || '';
        modal('#asset-modal').hidden = false;
    };
    const closeAssetModal = () => { editingAssetId = null; modal('#asset-modal').hidden = true; };
    buildAssetsPane.openAssetModal = openAssetModal;
    modal('#asset-modal').addEventListener('click', (e) => { if (e.target === modal('#asset-modal')) closeAssetModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && editingAssetId) closeAssetModal(); });
    q('#asset-add-open').addEventListener('click', openEditor);
    q('#asset-io-open').addEventListener('click', () => { if (io) io.hidden = !io.hidden; if (editor) editor.hidden = true; });
    const folderInput = q('#asset-folder-new');
    const commitFolderInput = () => {
        const name = folderInput.value.trim();
        if (!name) { folderInput.hidden = true; return; }
        const base = buildAssetsPane.currentFolderPath || '';
        addFolder(base ? `${base}/${name}` : name);
        folderInput.value = '';
        folderInput.hidden = true;
    };
    q('#asset-folder-add').addEventListener('click', () => { folderInput.hidden = false; folderInput.focus(); });
    folderInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitFolderInput(); if (e.key === 'Escape') folderInput.hidden = true; });
    folderInput.addEventListener('blur', commitFolderInput);
    q('#asset-cancel').addEventListener('click', () => { clearEditor(); if (editor) editor.hidden = true; });
    q('#asset-add').addEventListener('click', () => {
        const url = q('#asset-url').value.trim();
        if (!url) return;
        addAsset({ name: q('#asset-name').value.trim(), tag: q('#asset-tag').value.trim(), path: q('#asset-path').value.trim(), url, category: q('#asset-category')?.value || '' });
        clearEditor(); if (editor) editor.hidden = true;
    });
    q('#asset-file').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
            const url = await fileToDataUrl(file);
            addAsset({ name: q('#asset-name').value.trim() || file.name, tag: q('#asset-tag').value.trim(), path: q('#asset-path').value.trim(), url, category: q('#asset-category')?.value || '' });
            clearEditor(); if (editor) editor.hidden = true;
        } catch (err) { console.warn('[overlay] 读取文件失败：', err); }
        e.target.value = '';
    });
    q('#asset-export').addEventListener('click', () => downloadText('overlay-assets.json', exportAssets()));
    modal('#asset-modal-close').addEventListener('click', closeAssetModal);
    modal('#asset-modal-save').addEventListener('click', () => {
        if (!editingAssetId) return;
        updateAsset(editingAssetId, {
            name: modal('#asset-modal-name').value.trim(),
            path: modal('#asset-modal-path').value.trim(),
            tag: modal('#asset-modal-tag').value.trim(),
            category: modal('#asset-modal-category')?.value || '',
            url: modal('#asset-modal-url').value.trim(),
        });
        closeAssetModal();
    });
    q('#asset-import-file').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try { importAssets(await file.text()); }
        catch (err) { console.warn('[overlay] 导入素材失败：', err); }
        e.target.value = '';
    });
    subAssets(renderAssetGrid);
    renderAssetGrid();
}

function downloadText(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function renameFolderInline(input, oldPath) {
    const nextName = input.value.trim();
    if (!nextName) { renderAssetGrid(); return; }
    const parts = oldPath.split('/').filter(Boolean);
    parts[parts.length - 1] = nextName;
    renameFolderPath(oldPath, parts.join('/'));
}

function renderAssetGrid() {
    const grid = q('#asset-grid');
    if (!grid) return;
    const folder = buildAssetsPane.currentFolderPath || '';
    const view = listByFolder(folder);
    const list = listAssets().filter((a) => a.kind !== 'folder');
    const count = q('#asset-count');
    if (count) count.textContent = list.length ? `(${list.length})` : '';
    const crumb = q('#asset-breadcrumb');
    if (crumb) {
        crumb.innerHTML = '';
        const rootBtn = document.createElement('button');
        rootBtn.type = 'button'; rootBtn.textContent = '素材库';
        rootBtn.addEventListener('click', () => { buildAssetsPane.currentFolderPath = ''; renderAssetGrid(); });
        crumb.appendChild(rootBtn);
        let acc = '';
        for (const part of folder.split('/').filter(Boolean)) {
            acc = acc ? `${acc}/${part}` : part;
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = part;
            b.addEventListener('click', () => { buildAssetsPane.currentFolderPath = b.dataset.path; renderAssetGrid(); });
            b.dataset.path = acc;
            crumb.append(' / ', b);
        }
    }
    grid.innerHTML = '';
    if (!view.folders.length && !view.items.length) {
        const e = document.createElement('div');
        e.className = 'ov-asset-empty'; e.textContent = '暂无素材。';
        grid.appendChild(e); return;
    }
    for (const f of view.folders) {
        const cell = document.createElement('div');
        cell.className = 'ov-asset-cell ov-asset-folder';
        cell.dataset.path = f.path;
        const previews = listFolderPreviewUrls(f.path, 5);
        const mosaic = document.createElement('div');
        mosaic.className = 'ov-asset-folder-mosaic' + (previews.length ? '' : ' ov-empty');
        mosaic.dataset.n = String(Math.min(5, Math.max(1, previews.length || 1)));
        if (previews.length) {
            for (const url of previews) {
                const img = document.createElement('img');
                img.src = url;
                img.alt = '';
                img.loading = 'lazy';
                img.onerror = () => { img.style.visibility = 'hidden'; };
                mosaic.appendChild(img);
            }
        } else {
            mosaic.innerHTML = '<i class="fa-solid fa-folder"></i>';
        }
        const name = document.createElement('input');
        name.className = 'ov-asset-folder-name ov-text';
        name.value = f.name;
        name.addEventListener('click', (e) => e.stopPropagation());
        name.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); renameFolderInline(name, f.path); }
            if (e.key === 'Escape') renderAssetGrid();
        });
        name.addEventListener('blur', () => renameFolderInline(name, f.path));
        const menuBtn = document.createElement('button');
        menuBtn.type = 'button';
        menuBtn.className = 'ov-asset-folder-menu';
        menuBtn.title = '更多';
        menuBtn.innerHTML = '<i class="fa-solid fa-ellipsis"></i>';
        const menu = document.createElement('div');
        menu.className = 'ov-asset-folder-dropdown';
        menu.hidden = true;
        const delItem = document.createElement('button');
        delItem.type = 'button';
        delItem.className = 'ov-asset-folder-drop-item ov-danger';
        delItem.textContent = '删除文件夹';
        delItem.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.hidden = true;
            const n = countAssetsInFolder(f.path);
            if (n > 0) {
                if (!confirm(`文件夹「${f.name}」内有 ${n} 个素材，确定删除文件夹及全部内容？`)) return;
            }
            removeFolder(f.path);
            if ((buildAssetsPane.currentFolderPath || '') === f.path
                || String(buildAssetsPane.currentFolderPath || '').startsWith(f.path + '/')) {
                buildAssetsPane.currentFolderPath = '';
            }
            renderAssetGrid();
        });
        menu.appendChild(delItem);
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = menu.hidden;
            document.querySelectorAll('#st-overlay-root .ov-asset-folder-dropdown').forEach((d) => { d.hidden = true; });
            menu.hidden = !open;
        });
        cell.addEventListener('click', (e) => {
            if (e.target === name || menuBtn.contains(e.target) || menu.contains(e.target)) return;
            buildAssetsPane.currentFolderPath = f.path;
            renderAssetGrid();
        });
        cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('ov-drop'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('ov-drop'));
        cell.addEventListener('drop', (e) => {
            e.preventDefault(); cell.classList.remove('ov-drop');
            const id = e.dataTransfer.getData('text/plain');
            if (id) moveAssetToFolder(id, f.path);
        });
        cell.append(mosaic, name, menuBtn, menu);
        grid.appendChild(cell);
    }
    for (const a of view.items) {
        const cell = document.createElement('div');
        cell.className = 'ov-asset-cell' + (a.visible === false ? ' ov-asset-hidden' : '');
        cell.draggable = true;
        cell.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', a.id));
        const img = document.createElement('img');
        img.className = 'ov-asset-img ov-clickable'; img.src = a.url; img.alt = a.name;
        img.title = '点击全屏预览/修改素材';
        img.onerror = () => { img.style.visibility = 'hidden'; };
        img.addEventListener('click', () => buildAssetsPane.openAssetModal?.(a));
        const name = document.createElement('div');
        name.className = 'ov-asset-name'; name.textContent = a.name;
        const meta = document.createElement('div');
        meta.className = 'ov-asset-tag';
        const cat = a.category ? ('category:' + a.category) : '';
        meta.textContent = [cat, a.tag || ''].filter(Boolean).join(' · ') || assetRefPath(a);
        const path = document.createElement('div');
        path.className = 'ov-asset-path'; path.textContent = a.path || '';
        const eye = document.createElement('button');
        eye.className = 'ov-asset-eye'; eye.type = 'button';
        eye.title = a.visible === false ? '已隐藏于路径目录 · 点击显示' : '显示于路径目录 · 点击隐藏';
        eye.innerHTML = a.visible === false ? '<i class="fa-solid fa-eye-slash"></i>' : '<i class="fa-solid fa-eye"></i>';
        eye.addEventListener('click', (e) => { e.stopPropagation(); setAssetVisible(a.id, a.visible === false); });
        const del = document.createElement('button');
        del.className = 'ov-asset-del'; del.type = 'button'; del.textContent = '✕'; del.title = '删除';
        del.addEventListener('click', () => removeAsset(a.id));
        cell.append(img, name, meta, path, eye, del);
        grid.appendChild(cell);
    }
}

// ===== Log 查看器 =====
function wireLog() {
    const box = q('#ov-log');
    const head = q('#ov-log-head');
    const body = q('#ov-log-body');
    const clearBtn = q('#ov-log-clear');
    if (!box || !head || !body) return;
    head.addEventListener('click', (e) => {
        if (e.target === clearBtn) return; // 清空按钮不切折叠
        const open = box.dataset.open === 'true';
        box.dataset.open = open ? 'false' : 'true';
        if (!open) renderLog();
    });
    if (clearBtn) clearBtn.addEventListener('click', (e) => { e.stopPropagation(); clearLog(); });
    subLog(() => { updateLogCount(); if (box.dataset.open === 'true') renderLog(); });
    updateLogCount();
}
function updateLogCount() {
    const c = q('#ov-log-count');
    if (c) c.textContent = String(getEntries().length);
}
function renderLog() {
    const body = q('#ov-log-body');
    if (!body) return;
    const entries = getEntries();
    body.innerHTML = '';
    for (const e of entries) {
        const row = document.createElement('div');
        row.className = `ov-log-row ov-log-${e.level}`;
        row.textContent = e.msg;
        body.appendChild(row);
    }
    body.scrollTop = body.scrollHeight;
}

// —— 绑定助手 ——
function bindCheckbox(sel, key, s, after) { const el = q(sel); if (!el) return; el.checked = !!s[key]; el.addEventListener('change', () => { setSetting(key, el.checked); after?.(); }); }
function bindRange(sel, key, s, after) { const el = q(sel); if (!el) return; el.value = String(s[key]); el.addEventListener('input', () => { setSetting(key, Number(el.value)); after?.(); }); }
function bindSelect(sel, key, s, after) { const el = q(sel); if (!el) return; el.value = String(s[key]); el.addEventListener('change', () => { setSetting(key, el.value); after?.(); }); }
function bindSeg(sel, key, s, after) {
    const wrap = q(sel); if (!wrap) return;
    const btns = Array.from(wrap.querySelectorAll('button'));
    const mark = () => btns.forEach((b) => b.classList.toggle('ov-on', b.dataset.v === String(getSettings()[key])));
    mark();
    btns.forEach((b) => b.addEventListener('click', () => { setSetting(key, b.dataset.v); mark(); after?.(); }));
}
function flash(el, msg, restore) { const o = el.textContent; el.textContent = msg; setTimeout(() => (el.textContent = restore ?? o), 1400); }

/**
 * 装配 UI。需在 initOverlay() 之后调用。
 * @param {{onInjectProtocolChange?:(b:boolean)=>void}} opts
 */
export function wireUI(opts = {}) {
    _onInject = opts.onInjectProtocolChange;
    _onChrome = opts.onChromeChange;
    _onMacro = opts.onMacroChange;
    wireControls();
    buildSettingsPane();
    buildTestPane();
    buildAssetsPane();
    wireLog();
    toggleCollapseCaret();
    qAll('.ov-collapse').forEach((d) => d.addEventListener('toggle', toggleCollapseCaret));
    applyComposerArrow();
    activateTab('settings');
    applyCurrentSettings();
    // 点空白关文件夹菜单
    if (!wireUI._folderMenuBound) {
        wireUI._folderMenuBound = true;
        document.addEventListener('click', (e) => {
            if (e.target.closest?.('.ov-asset-folder-menu, .ov-asset-folder-dropdown')) return;
            document.querySelectorAll('#st-overlay-root .ov-asset-folder-dropdown').forEach((d) => { d.hidden = true; });
        });
    }
    console.info('[overlay] 抽屉装配完成（设置/测试/素材/道具/背包 + 日志）。');
}
