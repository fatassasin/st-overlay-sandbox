// settings.js — 扩展设置持久化
// 职责：在 ST 的 extension_settings 里维护本扩展的配置块，提供 get/set/save。
// 说明：第三方扩展无法直接 import ST 脚本模块，故通过 SillyTavern.getContext() 取
//       extensionSettings 与 saveSettingsDebounced。设置 key 取扩展文件夹名，
//       extension_settings 是自由形态对象，扩展自行写入即可持久化。

// extension_settings 里的 key（与扩展文件夹名一致）。
export const SETTINGS_KEY = 'st-overlay-sandbox';

// 默认设置：新增字段时由 loadSettings() 补齐，避免旧用户配置缺键。
export const DEFAULT_SETTINGS = {
    // —— 行为 ——
    autoShow: true,         // 收到舞台标签/指令时自动弹出 overlay
    injectProtocol: true,   // 把舞台协议提示词注入 AI 上下文（教 AI 用标签输出）
    customProtocol: '',     // 用户自定义协议文本（非空则覆盖内置 PROTOCOL_TEXT；空=用内置）
    protocolLanguage: 'cn', // 内置协议语言：'cn' | 'en'，默认中文
    injectDepth: 0,         // 注入深度（setExtensionPrompt depth）：0=贴近最新
    injectRole: 'system',   // 注入 role：'system' | 'user' | 'assistant'
    injectMacro: '{{sandbox_prompt}}', // 自定义函数/宏名（注册为可在预设里引用的宏）
    materialMacro: '{{material}}', // 素材路径目录宏（path + category:xx）
    stripTags: true,        // 在酒馆原生气泡里剥掉舞台标签（prompt 格式时让酒馆正常显示）

    // —— 阅读器外观（多数映射到 CSS 自定义属性，应用极廉价）——
    renderHtml: true,       // 渲染 HTML（必备）：开=messageFormatting 实时 HTML；关=转义纯文本
    fontFamily: 'sans',     // 'serif' | 'sans' | 'mono' | 'cn-serif' | 'kai' | 'rounded'
    fontSize: 19,           // px，正文字号 → --ov-font-size
    lineHeight: 1.7,        // 行高 → --ov-line-height
    spacing: 'cozy',        // 界面间距预设 'compact' | 'cozy' | 'roomy' → 内距/片段间距
    panelWidth: 91,         // 正文面板宽度，占屏幕宽度百分比 → --ov-panel-width
    scheme: 'mono',         // 配色（黑底内的强调色）'mono' | 'amber' | 'jade' | 'rose'
    followTextColor: true,  // 正文跟随 SillyTavern 主题变量
    followEmphasisColor: true, // 粗体跟随 SillyTavern 主题变量
    followQuoteColor: true, // 中英文引号跟随 SillyTavern 主题变量
    followBracketColor: true, // 括号跟随 SillyTavern 主题变量
    followItalicColor: true, // 斜体跟随 SillyTavern 主题变量
    followReplyColor: false, // 顶部「我的输入」回显跟随 SillyTavern 正文色（与「正文」同一变量）
    quoteColor: '',         // 中英文引号自定义色
    textColor: '',          // 正文自定义色
    emphasisColor: '',      // Markdown 粗体自定义色
    bracketColor: '',       // 括号段自定义色
    italicColor: '',        // Markdown 斜体自定义色
    replyColor: '#b8b8b8',  // 顶部「我的输入」回显自定义色
    textBgEnabled: true,    // 文本背景总开关（开且当前有生成背景图时才显示）
    textBgColor: '#000000', // 文本背景色（每条文本块衬底）→ --ov-text-bg
    textBgOpacity: 41,      // 文本背景不透明度 0..100（需 textBgEnabled + 有 bg 图）
    textBrightness: 100,    // 正文亮度 %（filter brightness）→ --ov-text-brightness
    textContrast: 100,      // 正文对比度 %（filter contrast）→ --ov-text-contrast
    lighting: 'dim',        // 灯光 'off' | 'dim' | 'glow' —— 暗角/辉光/亮度
    backgroundGlowEnabled: true, // 背景泛光开关
    backgroundGlowBrightness: 95, // 背景泛光亮度 %
    notify: 'toast',        // 通知方式 'toast' | 'inline' | 'off'
    typewriter: true,       // 打字机逐字揭示（非流式时生效；流式自动让位）
    typewriterSpeed: 150,   // 打字速度滑条·普通正文（越小越慢；内部换算 151-value = ms/字）
    typewriterSpeedVn: 96,  // 打字速度滑条·VN 楼层（同上换算）

    // —— 导航 / 界面行为 ——
    showFloorMeta: false,   // 顶栏左上角显示楼层号（酒馆 mesid）
    wheelStrength: 1120,    // 跨楼层滚轮力度阈值（越大越「重」）；片段阈值按比例派生
    composerAutohide: true, // 输入框默认隐藏，鼠标移到底部热区/聚焦时显示
    composerHotzone: 136,   // 输入框唤起热区高度 px（鼠标下移到距底部多少 px 才唤起；越大越易唤起）
    composerArrow: true,    // 底部显示小箭头提示「鼠标下移唤起输入框」
    composerArrowSize: 24,  // 底部提示箭头宽度 px → --ov-arrow-size
    composerArrowHeight: 7, // 底部提示箭头形状高度 px → --ov-arrow-height（扁长可调）
    composerArrowBottom: 10, // 底部提示箭头离屏幕底部距离 px → --ov-arrow-bottom
    // 未发送的输入框草稿（不在设置面板里露出；由 bridge.js 读写）。
    // 存这里是为了跟着 ST 落进后端 settings.json：刷新、关浏览器、重启后端都不丢。
    composerDraft: '',      // 草稿正文
    composerDraftAt: 0,     // 草稿写入时间戳；与 localStorage 那份比新旧，取新的
    // —— 顶部「上一条我的输入」回显（与底部输入框整套上下镜像）——
    replyAutohide: true,    // 回显胶囊默认隐藏，鼠标移到顶部热区时显示
    replyHotzone: 36,       // 顶部唤起热区高度 px → --ov-reply-hotzone
    replyArrow: true,       // 顶部显示朝下小箭头提示「鼠标上移看我的输入」
    replyArrowSize: 28,     // 顶部提示箭头宽度 px → --ov-reply-arrow-size
    replyArrowHeight: 12,   // 顶部提示箭头形状高度 px → --ov-reply-arrow-height
    replyArrowTop: 6,       // 顶部提示箭头离屏幕顶部距离 px → --ov-reply-arrow-top
    replyTop: 4,            // 回显胶囊离屏幕顶部距离 px → --ov-reply-top（顶栏默认折叠，故可贴顶）
    replyMaxHeight: 30,     // 回显胶囊正文最大高度 vh，超出内部滚动 → --ov-reply-maxh
    topFade: 0,             // 正文顶部虚化高度 vh：0=不虚化 → --ov-top-fade
    topbarAutohide: true,   // 右上角图标默认折叠，悬停顶部才显；关掉则常驻
    jumpbarAutohide: true,  // 右侧楼层按钮默认折叠，悬停右侧热区才显；关掉则常驻
    jumpbarInset: 14,       // 右侧楼层滑动条距右边缘 px → --ov-jumpbar-inset
    idleDim: true,          // 无操作自动黑屏（鼠标/键盘静止到时长后 3s 渐黑，动一下瞬间还原）
    idleDimDelay: 600,      // 无操作多少秒后开始渐黑
    bottomFade: 11,         // 底部黑框高度（vh 单位）：0=完全无黑框；>0 控制正文面板离底部多远 + 虚化遮罩高度
    panelPlate: 80,         // 面板底色浓度 0..100：正文面板与输入框的衬底/描边/投影强度（乘在「灯光」预设上）
    // 出厂 80 就是旧刻度的满格（80 × 1.25 = 1.0 倍灯光预设），滑到 100 比旧上限再浓 25%。
    panelPlateScale: 2,     // panelPlate 的刻度版本；见 loadSettings() 的重标定迁移，不在面板里露出
    topTextHeight: 100,     // 顶部文本高度 px：正文第一行从屏幕顶部向下的偏移（框定文字起始位置）→ --ov-text-top
    vnTextHeight: 32,       // 视觉小说正文显示区高度（vh 占屏）→ --ov-panel-maxh（固定高度、内部滚动）
    plainTextMaxHeight: 16, // 兼容旧 key：底部文本高度（vh），0=无额外底部留白 → --ov-plain-bottom-gap
    pointerNavigation: true, // 左右键导航开关：开=保持当前切楼/切片；关=左右键不导航
    audioEnabled: true,     // 音频标签（bgm/sfx/voice）总开关
    audioVolume: 80,        // 音频总音量 %
    fullscreen: true,       // 记忆上次全屏开关，open() 时恢复
    thinkingLine: true,     // 思维链顶部横条
    keyButtonEnabled: true, // 显示可移动虚拟按键
    keyButtonCode: 'AltRight',
    keyButtonKey: 'Alt',
    keyButtonDocked: true,  // 放到输入框发送键左侧
};

let _loaded = false;

/** 取当前 ST context（可能为 null，调用方需判空） */
function ctx() {
    try {
        return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext()
            : null;
    } catch (_) {
        return null;
    }
}

/**
 * 取本扩展的设置对象（挂在 extension_settings[SETTINGS_KEY] 上）。
 * 若不存在则建空对象。不会写入磁盘，仅保证内存里有可写引用。
 */
function getStore() {
    const c = ctx();
    if (!c || !c.extensionSettings) return null;
    if (!c.extensionSettings[SETTINGS_KEY] || typeof c.extensionSettings[SETTINGS_KEY] !== 'object') {
        c.extensionSettings[SETTINGS_KEY] = {};
    }
    return c.extensionSettings[SETTINGS_KEY];
}

/**
 * 加载设置：把默认值合并进存储，补齐缺失键。需在 context 就绪后调用。
 * @returns {object|null} 当前生效的设置对象（null 表示 context 未就绪）
 */
export function loadSettings() {
    const store = getStore();
    if (!store) return null;
    let migrated = false;
    // 旧版 panelWidth 使用 px；按当前窗口宽度换算为 30..100%。
    const oldPanelWidth = Number(store.panelWidth);
    if (Number.isFinite(oldPanelWidth) && oldPanelWidth > 100) {
        const viewportWidth = typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1080;
        store.panelWidth = Math.max(30, Math.min(100, Math.round(oldPanelWidth / viewportWidth * 100)));
        migrated = true;
    }
    // 旧版“导航 / 选择”分段设置迁移到真正的布尔开关。
    if (store.pointerNavigation === undefined) {
        store.pointerNavigation = store.pointerMode !== 'select';
    }
    // 旧版总开关迁移为五个独立开关；保留旧字段但不再显示或读取。
    if (store.followStColors !== undefined) {
        for (const key of ['followTextColor', 'followEmphasisColor', 'followQuoteColor', 'followBracketColor', 'followItalicColor']) {
            if (store[key] === undefined) {
                store[key] = !!store.followStColors;
                migrated = true;
            }
        }
    }
    // 面板底色曾经寄生在 bottomFade 上：fadeK = bottomFade/16 同时缩放面板衬底、描边、投影和输入框底，
    // 于是一个叫「底部黑框高度」的 vh 滑条在背地里决定面板有没有边框——名字不提，分组也不在配色里，
    // 谁都找不到。新装（bottomFade 出厂 0）因此整块面板都不画，老配置却有，两台机器长得不一样。
    // 现在拆成独立的 panelPlate；老配置按当年的 fadeK 折算，升级后观感逐像素不变。
    if (store.panelPlate === undefined && store.bottomFade !== undefined) {
        const oldFade = Math.max(0, Number(store.bottomFade) || 0);
        store.panelPlate = Math.round(Math.min(1, oldFade / 16) * 100);
        migrated = true;
    }
    // 刻度 v2：滑条上限比原来多 25%（100 现在等于旧刻度的 125）。已存的值是旧刻度，
    // 数值区间又完全重合，光看数字分不出新旧，所以用 panelPlateScale 当版本标记。
    // 乘 0.8 换算回同一个 plateK，升级后观感逐像素不变；只有出厂默认从「旧满格」起步。
    if (store.panelPlate !== undefined && store.panelPlateScale !== 2) {
        const oldPlate = Math.max(0, Math.min(100, Number(store.panelPlate) || 0));
        store.panelPlate = Math.round(oldPlate * 0.8);
        store.panelPlateScale = 2;
        migrated = true;
    }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (store[key] === undefined) {
            store[key] = DEFAULT_SETTINGS[key];
        }
    }
    _loaded = true;
    if (migrated) save();
    return store;
}

/** 读取单个设置项；未加载或 context 未就绪时回退默认值 */
export function getSetting(key) {
    const store = getStore();
    if (store && store[key] !== undefined) return store[key];
    return DEFAULT_SETTINGS[key];
}

/** 读取全部设置（含默认兜底），返回新对象，调用方可安全读 */
export function getSettings() {
    const out = { ...DEFAULT_SETTINGS };
    const store = getStore();
    if (store) Object.assign(out, store);
    return out;
}

/**
 * 写入单个设置项并持久化（防抖）。
 * @param {string} key
 * @param {*} value
 */
export function setSetting(key, value) {
    const store = getStore();
    if (!store) return false;
    store[key] = value;
    save();
    return true;
}

/** 触发防抖保存（context 未就绪则跳过） */
export function save() {
    const c = ctx();
    if (c && typeof c.saveSettingsDebounced === 'function') {
        c.saveSettingsDebounced();
    }
}

export function isLoaded() {
    return _loaded;
}
