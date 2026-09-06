// reader.js — 阅读器核心（视觉小说一屏一片段引擎）
// 职责：把 ST 聊天的 AI 楼层解析成舞台片段，一屏只渲一个片段；提供导航与流式呈现。
//   楼层模型：floors[] = ctx.chat 里 !is_user && !is_system 的 AI 楼层。
//   片段：每个标签 = 一屏（见 stage-parser.js）。
//   导航：左键 下一片段 / 右键 上一片段（楼层头停）/ 滚轮带阻尼跨楼层 / 跳转条跳片段。
//   渲染：只格式化当前片段（根除全量重渲卡顿）；bg/sprite/cg 经 assets.resolveImage（M1 占位）。
//   流式：空窗期等待态 → 首 token 打字机入场 → 累积全文逐字跟随 → 定稿。
//
// 性能：不重复格式化历史；只在进入某片段时 messageFormatting 一次。

import { q, getStage, getRoot, getShell, insertIntoComposer } from './overlay.js';
import { parseStageMessage, isVnStageMessage, splitThinking } from './stage-parser.js';
import { splitBracketSegments } from './text-coloring.js';
import { isDuplicateAssistantFloor } from './floor-filter.js';
import { resolveImage, placeholderLabel, clearTestImages } from './assets.js';
import { getSetting } from './settings.js';
import { setItems } from './inventory.js';

let ctxRef = null;

// —— 模型状态 ——
let floors = [];            // [{ chatIndex, fragments, sceneCarry }]
let pos = { floorIdx: 0, fragIdx: 0 };
const parseCache = new Map(); // chatIndex → { sig, parsed }

// —— 流式/打字机状态 ——
let waiting = false;        // 空窗期（发送后→首 token 前）
let typing = false;         // 打字机进行中
let typeTimer = null;       // requestAnimationFrame id
let typeLastHtml = '';      // 当前打字机的完整目标 HTML（补完用：闭包外可瞬间写入）
let renderedTextKey = '';   // 当前正文可见 HTML；媒体更新未改变正文时避免重复写 DOM
let streamedThisGen = false; // 本次生成是否走过流式（走过则定稿不重播打字机）
let streamMode = 'unknown';  // 'plain' 不接管，让 ST 原生显示；'vn' 才进 overlay 流式
let liveStreamActive = false; // 本轮实时生成仍在进行
let liveViewActive = false;   // 当前屏是否正在查看实时生成楼层
let liveFullText = '';        // 后台持续保存最新流，回到实时楼层时一次恢复

export function hasLiveGeneration() {
    return liveStreamActive || liveViewActive;
}

/** 该 chat 下标是否已经作为「定稿楼层」进过 floors[]。
 *  bridge 的流式轮询用它区分两件长得很像的事：「新回复正在生成」与「已定稿的末楼被事后改写」
 *  （生图/生视频插件在正文定稿之后才把 <img>/<video> 写进 mes）。 */
export function hasFloorForChatIndex(i) {
    const idx = Number(i);
    if (!Number.isInteger(idx) || idx < 0) return false;
    return floors.some((f) => f.chatIndex === idx);
}
let liveThinkingText = '';    // 推理事件与正文事件分离时，保留本轮已收到的思维链

// —— 滚轮阻尼 / 切楼层滑动 ——
// 两档阻力：VN 楼层内切片段为「轻」；跨楼层（普通楼层切换 / VN 首末片段再滚）为「强」。
let wheelAccum = 0;
let wheelDir = 0;             // 当前累积方向（+1 向下 / -1 向上）；换向清零
let wheelCooldown = false;
let sliding = false;          // 切楼层滑动动画进行中（锁住滚轮）
const WHEEL_FRAG_COOLDOWN_MS = 160;
const WHEEL_COOLDOWN_MS = 360;
// 跨楼层阻力阈值（强）：由设置 wheelStrength 控制（越大越「重」）；
// 楼层内切片段阈值（轻）按比例派生（约 1/3，下限 120）。
function floorThreshold() {
    const n = Number(getSetting('wheelStrength'));
    return Number.isFinite(n) && n > 0 ? n : 640;
}
function fragThreshold() {
    return Math.max(120, Math.round(floorThreshold() / 3));
}
// 滚动条渐显：滚动时加 .ov-scrolling，静止 ~900ms 移除。
let scrollHideTimer = null;
function flashScrollbar() {
    const el = q('#ov-panel-text');
    if (!el) return;
    el.classList.add('ov-scrolling');
    clearTimeout(scrollHideTimer);
    scrollHideTimer = setTimeout(() => { const e = q('#ov-panel-text'); if (e) e.classList.remove('ov-scrolling'); }, 900);
}

// —— 音频播放（bgm 持续；sfx/voice 随片段触发）——
let bgmAudio = null;
let bgmSrc = '';
let sfxAudio = null;
let voiceAudio = null;
// 来源标记，取值 '' | 'test'。测试预览（合成楼层）起的音频回到正文时要单独停掉：
// BGM 按协议一直放到被下一条 <bgm> 换掉，没人显式停它就会一直盖在真实聊天上。
// sfx/voice 通常一响即止，但两者都允许 loop="true"，所以一并记。
let bgmOrigin = '';
let sfxOrigin = '';
let voiceOrigin = '';
function stopOneAudio(a) { try { if (a) { a.pause(); a.currentTime = 0; } } catch (_) {} }
function audioVolume(a) {
    const local = Number(a?.volume);
    const lv = Number.isFinite(local) && local >= 0 ? Math.min(1, local) : 1;
    return Math.max(0, Math.min(1, (Number(getSetting('audioVolume')) || 0) / 100)) * lv;
}
function playAudio(a, slot) {
    if (!getSetting('audioEnabled') || !a || !a.src) return;
    // 正在渲染的楼层是合成楼层 → 这段音频归测试预览所有
    const origin = currentFloor()?.synthetic ? 'test' : '';
    if (slot === 'bgm' && bgmAudio && bgmSrc === a.src) { bgmAudio.volume = audioVolume(a); bgmOrigin = origin; renderAudioState(a, slot); return; }
    const el = new Audio(a.src);
    el.volume = audioVolume(a);
    el.loop = !!a.loop;
    if (slot === 'bgm') { stopOneAudio(bgmAudio); bgmAudio = el; bgmSrc = a.src; bgmOrigin = origin; }
    else if (slot === 'voice') { stopOneAudio(voiceAudio); voiceAudio = el; voiceOrigin = origin; }
    else { stopOneAudio(sfxAudio); sfxAudio = el; sfxOrigin = origin; }
    renderAudioState(a, slot);
    el.play().catch((e) => console.warn('[overlay] 音频播放被浏览器阻止：', e));
}
function renderAudioState(a, slot) {
    const root = getRoot();
    if (!root) return;
    let bar = q('#ov-audio-state');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'ov-audio-state';
        bar.className = 'ov-audio-state';
        root.querySelector('.ov-stage')?.appendChild(bar);
    }
    bar.hidden = false;
    bar.innerHTML = `<span>▶</span><b>${htmlEscape(slot.toUpperCase())}</b><em>${htmlEscape(a.caption || a.src || '')}</em><span>🔊 ${Math.round(audioVolume(a) * 100)}%</span>`;
}
function hideAudioState() {
    const bar = q('#ov-audio-state');
    if (bar) bar.hidden = true;
}

/** 停掉测试预览起的音频，真实楼层起的一概不动。
 *  @param {string} [keepBgmSrc] 若当前测试 BGM 正是这个 src 就留着——测试面板改一个字就
 *    重渲染一次，同一首曲子没必要每次从头切一刀。 */
function stopTestAudio(keepBgmSrc = '') {
    let stopped = false;
    if (bgmOrigin === 'test' && bgmSrc !== keepBgmSrc) {
        stopOneAudio(bgmAudio); bgmAudio = null; bgmSrc = ''; bgmOrigin = ''; stopped = true;
    }
    if (sfxOrigin === 'test') { stopOneAudio(sfxAudio); sfxAudio = null; sfxOrigin = ''; stopped = true; }
    if (voiceOrigin === 'test') { stopOneAudio(voiceAudio); voiceAudio = null; voiceOrigin = ''; stopped = true; }
    if (stopped) hideAudioState();
}

/** 摘掉测试预览留在共享状态里的一切。合成楼层本身由调用方摘，这里管的是四类跨楼层残留：
 *  HUD 组件、音频槽、上传的测试图（resolveImage 里优先级最高，会盖住真实楼层的同名图位）、
 *  以及按剩下的真实楼层重算道具栏。
 *  注意这四样都不随楼层导航自动复位——共享 store 里没有「属于哪一楼」的概念，
 *  所以每条离开预览的路径都得显式调一次。 */
function clearTestResidue() {
    clearTestHud();
    stopTestAudio();
    clearTestImages();
    try { setItems(floors.flatMap((f) => f.items || [])); } catch (_) {}
}

function playFragmentAudio(frag) {
    if (!getSetting('audioEnabled')) { stopOneAudio(sfxAudio); stopOneAudio(voiceAudio); return; }
    const list = Array.isArray(frag?.audio) ? frag.audio : [];
    for (const a of list) {
        if (a.kind === 'bgm') playAudio(a, 'bgm');
        else if (a.kind === 'voice') playAudio(a, 'voice');
        else if (a.kind === 'sfx') playAudio(a, 'sfx');
    }
}

function getCtx() {
    try {
        return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
    } catch (_) { return null; }
}

/** 启动阅读器：注入 ctx，接线导航。 */
export function initReader(ctx) {
    ctxRef = ctx || getCtx();
    wireNavigation();
    rebuild();
}

// —— 楼层与片段构建 ——

/** 重建楼层模型（CHAT_CHANGED / 首次 / 删除后）。
 *  @param {boolean} animate 是否对落点片段播打字机
 *  @param {'last'|'first'|'preserve'} landing 落点：'last'=最新楼层末片段（默认，流式/打开用）；
 *         'first'=最新楼层首片段（非流式新回复，从头读起）；'preserve'=刷新后保留当前楼层/片段
 *  @param {{ skipStreamingTail?: boolean, preserveScroll?: boolean }} [opts] skipStreamingTail=true 时跳过 chat 末条正在生成的 AI 楼
 *         （生成中打开 overlay 用，避免半成品 mes/思维链进 floors） */
export function rebuild(animate = false, landing = 'last', opts = {}) {
    const c = ctxRef || getCtx();
    const preserveScroll = landing === 'preserve' || !!opts.preserveScroll;
    const savedScrollTop = preserveScroll ? (q('#ov-panel-text')?.scrollTop || 0) : 0;
    const prev = floors[pos.floorIdx] ? { chatIndex: floors[pos.floorIdx].chatIndex, fragIdx: pos.fragIdx } : null;
    clearTestImages();   // 真实重建：清掉测试 Tab 上传的图，避免污染真实聊天
    clearTestHud();      // 同理清掉测试灌进状态条的组件（真实消息创建的按 origin 保留）
    stopTestAudio();     // 同理停掉测试起的 BGM/SFX（真实楼层起的按 origin 保留）
    floors = [];
    if (c && Array.isArray(c.chat)) {
        let sceneCarry = undefined;
        let previousAssistant = null;
        // 生成中跳过末条 AI：它的 mes 是半成品，且可能夹带 reasoning 原文
        let skipIdx = -1;
        if (opts && opts.skipStreamingTail) {
            for (let i = c.chat.length - 1; i >= 0; i--) {
                const m = c.chat[i];
                if (m && !m.is_user && !m.is_system) { skipIdx = i; break; }
            }
        }
        for (let i = 0; i < c.chat.length; i++) {
            if (i === skipIdx) continue;
            const msg = c.chat[i];
            if (!msg) continue;
            if (msg.is_user) { previousAssistant = null; continue; }
            if (msg.is_system) continue;
            if (isDuplicateAssistantFloor(previousAssistant, msg)) continue;
            const parsed = parseFloor(i, msg);
            // 跨楼层结转 scene：本楼无 scene 则继承上一楼最后 scene
            // lastScene：仅有背景/<pic background> 等不成屏标记时 fragments 为空，仍要继承场景
            if (parsed.lastScene && parsed.lastScene.bg) sceneCarry = parsed.lastScene;
            for (const f of parsed.fragments) {
                if (f.scene && f.scene.bg) sceneCarry = f.scene;
                else if (!f.scene) f.scene = sceneCarry;
            }
            // 无正文片段的楼（纯背景 pic 等）不进 floors，不占一屏
            if (!parsed.fragments.length) continue;
            floors.push({ chatIndex: i, fragments: parsed.fragments, items: parsed.items, plain: !!parsed.plain, thinking: parsed.thinking || '' });
            previousAssistant = msg;
        }
    }
    // 汇总全部道具喂背包（跨楼层累计）
    try { setItems(floors.flatMap((f) => f.items || [])); } catch (_) {}
    if (floors.length === 0) {
        // 生成中且尚无历史楼：空舞台，等 onStream 填
        if (opts && opts.skipStreamingTail) {
            renderEmpty();
            // renderEmpty 会 hideThinking；调用方随后 onStream 会再画思维链
            return;
        }
        renderEmpty();
        return;
    }
    const lastFloor = floors.length - 1;
    if (landing === 'preserve' && prev) {
        const floorIdx = floors.findIndex((f) => f.chatIndex === prev.chatIndex);
        if (floorIdx >= 0) pos = { floorIdx, fragIdx: Math.min(prev.fragIdx, lastFragIdx(floorIdx)) };
        else pos = { floorIdx: lastFloor, fragIdx: lastFragIdx(lastFloor) };
    } else {
        // 'last' 只对普通楼层有意义（像聊天一样看到最新）；VN 楼层落「最后一屏」等于跳过整场戏，
        // 故 VN 楼层任何入口（打开/刷新/定稿）一律从首片段读起。
        const landFirst = landing === 'first' || !(floors[lastFloor] && floors[lastFloor].plain);
        pos = { floorIdx: lastFloor, fragIdx: landFirst ? 0 : lastFragIdx(lastFloor) };
    }
    // animate 仅在新回复「首片段」入场时才有意义；落到末片段（流式已逐字看完）一律瞬显，绝不重播打字机。
    // skipStreamingTail 时也不要 animate 历史末楼；并保留 stream/thinking 供随后 onStream 接管
    const effectiveAnimate = animate && landing === 'first' && !(opts && opts.skipStreamingTail);
    const keepLive = !!(opts && opts.skipStreamingTail);
    renderCurrent(effectiveAnimate, { keepStream: keepLive, keepThinking: keepLive, preserveScroll });
    if (preserveScroll) {
        const panelText = q('#ov-panel-text');
        if (panelText) panelText.scrollTop = savedScrollTop;
    }
}

/** 解析一个楼层（带缓存：chatIndex + mes 长度签名） */
function parseFloor(chatIndex, msg) {
    const mes = typeof msg.mes === 'string' ? msg.mes : '';
    const sig = `${chatIndex}:${mes.length}`;
    const cached = parseCache.get(chatIndex);
    if (cached && cached.sig === sig) return cached.parsed;
    const parsed = parseStageMessage(mes);
    parseCache.set(chatIndex, { sig, parsed });
    return parsed;
}

function lastFragIdx(floorIdx) {
    const f = floors[floorIdx];
    return f && f.fragments.length ? f.fragments.length - 1 : 0;
}

function currentFloor() { return floors[pos.floorIdx] || null; }
function currentFragment() {
    const fl = currentFloor();
    return fl && fl.fragments[pos.fragIdx] ? fl.fragments[pos.fragIdx] : null;
}

function latestRenderableFragment(parsed) {
    if (!parsed || !Array.isArray(parsed.fragments) || !parsed.fragments.length) return null;
    const last = parsed.fragments[parsed.fragments.length - 1];
    return last && last.kind === 'plain' ? last : (parsed.fragments.filter((f) => f.kind !== 'cg' && f.kind !== 'video').pop() || last);
}

// —— 渲染 ——

function renderEmpty() {
    const root = getRoot();
    if (root && root.dataset.html === 'true') root.dataset.html = 'false';
    setText('');
    setSpeaker('');
    renderBg(undefined);
    clearSprites();
    hideCg();
    renderItems([]);
    hideThinking();
    hideAudioState();
    updateJumpbar();
    updateFloorMeta();
}

/** 切片段前的统一复位：停打字机、滚回顶、清滚轮阻尼累积/冷却、隐藏跨楼层提示。
 *  根因：测试预览等路径会留下 scrollTop / wheel 累积 / inline-HTML 残态，泄漏到下一段正文
 *  使其「滚不动」。所有切换都过 renderCurrent，故在此处修一次，所有路径受益。 */
function resetStageState({ keepStream = false, preserveScroll = false } = {}) {
    // 正在出字时切到新片段：先补完当前屏的完整文本（避免半截字闪掉），再由 renderCurrent 写新片段。
    // keepStream：生成中打开时 rebuild 历史楼，不要冲掉正在追字的流式打字机（随后 onStream 会接管）。
    if (!keepStream) {
        finishTypewriterInstantly();
        stopTypewriter();
        stopStreamTypewriter();
    } else {
        stopTypewriter();
    }
    const el = q('#ov-panel-text');
    if (el && !preserveScroll) el.scrollTop = 0;
    wheelAccum = 0; wheelDir = 0; wheelCooldown = false;
    hideAudioState();  // 音频状态条只在声明它的片段显示；playFragmentAudio 会按需重新亮起
    hideFloorHints();
    const el2 = q('#ov-panel-text');
    if (el2) el2.style.setProperty('--ov-damp-y', '0px');
}

/** 渲染当前片段到舞台各层。animate=true 时正文走打字机（仅前进/新内容）。
 *  opts.keepStream：生成中打开时跳过对 stream typewriter 的清场；opts.keepThinking 保留思维链 bar。 */
function renderCurrent(animate = false, opts = {}) {
    // 离开测试预览：合成楼层永远挂在 floors[] 末尾，一旦导航落到它前面的真实楼层，
    // 就说明用户已经切回正文，这时把它摘掉。否则它会一直挂着，翻回末尾还能再看到
    // 已经作废的测试内容，而 exitTestPreview 只在切离「测试」Tab 时才触发——
    // 而 #test-render 渲染完就直接 closeDrawer()，那条路径根本不经过 Tab 切换。
    // HUD 组件 / 音频 / 测试图 / 道具栏都不随导航自动复位，统一交给 clearTestResidue，
    // 它按 origin 定点清，真实楼层的状态条和 BGM 留着。
    const tail = floors[floors.length - 1];
    if (tail && tail.synthetic && pos.floorIdx < floors.length - 1) { floors.pop(); clearTestResidue(); }
    resetStageState({ keepStream: !!opts.keepStream, preserveScroll: !!opts.preserveScroll });
    const frag = currentFragment();
    if (!frag) { renderEmpty(); return; }

    const fl = currentFloor();
    const isPlain = !!(fl && fl.plain) || frag.kind === 'plain';
    const root = getRoot();
    if (root) root.dataset.plain = isPlain ? 'true' : 'false';
    if (!opts.keepThinking) hideThinking();

    if (isPlain) {
        // 普通楼层：无舞台标签 → 不做视觉小说处理，整条作为一片完整正文显示。
        renderBg(undefined);          // 纯黑背景，不渲场景占位
        clearSprites();
        hideCg();
        setSpeaker('');
        renderText(frag, animate, fl ? fl.chatIndex : undefined);  // 普通正文也走打字机（受打字速度控制），animate 由调用方决定
        renderItems([]);              // 普通楼层无道具浮层
        const hint = q('#ov-advance-hint');
        if (hint) hint.style.opacity = '0';
        updateJumpbar();
        updateFloorMeta();
        return;
    }

    // 背景层（scene 结转）
    renderBg(frag.scene);

    // 立绘层
    clearSprites();
    if (frag.kind === 'say') renderSprite(frag);

    // cg / video 层
    if (frag.kind === 'video') renderVideo(frag);
    else if (frag.kind === 'cg') renderCg(frag);
    else hideCg();

    // 说话人
    setSpeaker(frag.kind === 'say' ? (frag.speaker || '') : '');

    // 正文（打字机或瞬显）。renderText 内部先停掉上一片段的打字机，故可放心每次都渲。
    renderText(frag, animate, fl ? fl.chatIndex : undefined);

    // 道具浮层
    renderItems(frag.items || []);

    playFragmentAudio(frag);

    // 推进提示：楼层末片段给「向下滚轮」暗示
    const hint = q('#ov-advance-hint');
    if (hint) hint.style.opacity = (pos.fragIdx >= lastFragIdx(pos.floorIdx)) ? '0.5' : '0.85';

    updateJumpbar();
    updateFloorMeta();
}

function htmlEscape(s) {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
}

// 思维链展开时跟随最新一行；用户手动滚开就停，滚回底部自动恢复跟随。
let thinkingStick = true;

function hideThinking() {
    const bar = q('#ov-thinking');
    if (bar) bar.hidden = true;
    thinkingStick = true;   // 下一轮推理重新从跟随态开始
}

function renderThinking(text) {
    const root = getRoot();
    if (!root) return;
    let bar = q('#ov-thinking');
    const t = String(text || '').trim();
    if (!t) { if (bar) bar.hidden = true; return; }
    if (!bar) {
        bar = document.createElement('details');
        bar.id = 'ov-thinking';
        bar.className = 'ov-thinking';
        // 骨架建一次就复用：整块重写 innerHTML 会把 scrollTop 清零，用户翻阅时每来一个 token 都被弹回顶部。
        bar.innerHTML = '<summary><i></i><span></span><b>展开</b></summary><div></div>';
        const body = bar.querySelector('div');
        // scroll 而非 wheel：滚动条拖拽、触屏、键盘一并覆盖。
        //   自动滚底也会触发它，但那时正好贴底，判定结果仍是 true，不会误停。
        body.addEventListener('scroll', () => {
            thinkingStick = body.scrollHeight - body.scrollTop - body.clientHeight <= 4;
        }, { passive: true });
        root.querySelector('.ov-stage')?.appendChild(bar);
    }
    const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    bar.hidden = false;
    bar.querySelector('summary span').textContent = lines.slice(-2).join(' / ');
    const body = bar.querySelector('div');
    const keep = body.scrollTop;
    body.innerHTML = htmlEscape(t).replace(/\n/g, '<br>');
    // 写 innerHTML 会把 scrollTop 归零，同一任务内立刻改回去，中间态不会被渲染也不会派发 scroll。
    body.scrollTop = thinkingStick ? body.scrollHeight : keep;
}

function renderText(frag, animate = false, chatIndex) {
    const el = q('#ov-panel-text');
    if (!el) return;
    stopTypewriter();              // 切片段先停掉上一段动画

    // 先跑格式化（含 ST regex 脚本——messageFormatting 用真实 chatIndex 才让 AI_OUTPUT regex 生效）。
    const html = formatFrag(frag, chatIndex);
    // <cg> 的标题独立于正文：不进 messageFormatting，也不进下面的 HTML 块检测（那条只该看正文）。
    const titleHtml = cgTitleHtml(frag);
    const full = titleHtml + html;
    const renderKey = `${chatIndex ?? -1}:${frag.kind}:${full}`;
    if (!animate && renderKey === renderedTextKey) return;
    // 媒体/背景已就位、正文其实没变 → 文本层不动（重设 innerHTML 会把流式打字机清屏）。
    //   生成图落地那一帧 rebuild 正好走这里：各层照常重渲贴图，正文不被波及。
    if (!animate) {
        const prevKey = renderedTextKey;
        renderedTextKey = renderKey;
        if (q('#ov-panel-text') && prevKey.split(':').slice(2).join(':') === full) return;
    } else {
        renderedTextKey = renderKey;
    }

    // regex/代码块产出的 HTML（选项框等酒馆外部美化）→ 一律内联接在正文底部，跟随内容高度，绝不占满全屏。
    //   插件自己的 UI 走舞台标签（scene/say/cg/item），不经过这条 HTML 检测路径。
    const detected = detectHtmlFromFormatted(html);
    if (detected) {
        renderProseWithHtml(el, titleHtml + detected.prose, detected.html);
        return;
    }

    clearHtmlFrame(el);
    // 打字机仅在「新回复首片段入场」时播放；含 regex HTML 块的片段绝不走打字机（会破坏 iframe 按钮交互），
    // 回看历史 / 跳转条 / 已流式过的末片段一律瞬显。
    const hasHtmlBlock = !!(detected || (frag && frag.kind === 'plain' && isHtmlBlock(html)));
    if (animate && getSetting('typewriter') && frag.kind !== 'cg' && !hasHtmlBlock) {
        runTypewriter(el, html, frag.kind !== 'plain');   // 这一支排除了 cg，titleHtml 必为空
    } else {
        el.innerHTML = full;
    }
}

/** 是否为完整 HTML 文档（<!DOCTYPE html> 或 <html>…</html>）。 */
function isFullDoc(s) {
    return typeof s === 'string' && /<html[\s>]/i.test(s) && /<\/html>/i.test(s);
}

// —— iframe 沙箱 HTML 渲染（借 Amily2 模式：iframe srcdoc + sandbox + 自动调高）——

/** 构建在 iframe 里嵌的完整 HTML 文档。复用 Amily2 模式：透明背景、dark color-scheme、
 *  测量高度经 postMessage 发回父窗口调高、vh 修正。 */
function buildWrappedHtmlDoc(innerHtml) {
    const isFullDoc = /<html/i.test(innerHtml) && /<\/html>/i.test(innerHtml);

    const measureScript = `<script>(function(){
var raf,last=0;function send(f){if(raf&&!f)return;raf=1;requestAnimationFrame(function(){raf=0;
var d=document,h=Math.max(d.body.scrollHeight||0,d.body.offsetHeight||0,d.documentElement.scrollHeight||0);
if(Math.abs(h-last)<2)return;last=h;parent.postMessage({ovHtmlHeight:h,force:!!f},'*');
});}
send(1);document.addEventListener('DOMContentLoaded',function(){send(1)},{once:1});
window.addEventListener('load',function(){send(1)},{once:1});
new ResizeObserver(function(){send(0)}).observe(document.body);
})();<\/script>`;

    const bridgeScript = `<script>(function(){
function send(type,value){parent.postMessage({ovSandbox:type,value:String(value||'')},'*');}
// 指针进了 iframe，父页面的 mousemove 就断了，底部输入框的唤起热区会失联。
// 把 iframe 内坐标转发上去，父页面加上 iframe 的 rect.top 还原成视口坐标。
document.addEventListener('mousemove',function(e){parent.postMessage({ovPointerY:e.clientY},'*');},true);
window.triggerSlash=function(command){send('command',command);};
document.addEventListener('click',function(e){
var el=e.target&&e.target.closest&&e.target.closest('[data-action]'); if(!el)return;
var v=el.getAttribute('data-action')||el.getAttribute('data-text')||''; v=v.trim(); if(!v)return;
e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
send(el.classList&&el.classList.contains('action-btn-copy')?'insert':'command', el.classList&&el.classList.contains('action-btn-copy')?v:'/send '+v+'|/trigger');
},true);
})();<\/script>`;

    // 完整文档：把桥接/测高脚本注进 </body>（否则 iframe 收不到高度、内联时高度停在 0）。
    const injected = `${bridgeScript}${measureScript}`;
    const wrapped = isFullDoc
        ? (/<\/body>/i.test(innerHtml)
            ? innerHtml.replace(/<\/body>/i, `${injected}</body>`)
            : innerHtml.replace(/<\/html>/i, `${injected}</html>`))
        : `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="color-scheme" content="dark light"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>html,body{margin:0;padding:0;background:transparent;color:#e7e7ea;font-family:system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif}body{overflow:hidden}</style>${bridgeScript}${measureScript}</head><body>${innerHtml}</body></html>`;
    return wrapped;
}

/** 在正文容器里建/复用 iframe srcdoc，注 Amily2 模式的完整文档。iframe 自动调高。
/** 片段 HTML（选项界面等）：正文散文照常渲染，HTML 作为一个「内联块」接在正文底部，
 *  按内容自动调高（不占满全屏）。这解决「渲染后的按钮占了一整个屏幕」的问题。 */
function renderProseWithHtml(el, proseHtml, blockHtml) {
    const root = getRoot();
    if (root) root.dataset.html = 'inline';
    el.innerHTML = '';
    if (proseHtml && proseHtml.trim()) {
        const prose = document.createElement('div');
        prose.className = 'ov-prose';
        prose.innerHTML = proseHtml;
        el.appendChild(prose);
    }
    const iframe = document.createElement('iframe');
    iframe.className = 'ov-html-frame ov-html-inline';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('scrolling', 'no');
    iframe.style.cssText = 'width:100%;border:none;background:transparent;display:block;height:0';
    el.appendChild(iframe);
    iframe.srcdoc = buildWrappedHtmlDoc(blockHtml);
}

/** 离开 HTML 楼层：清除 iframe 和标记 */
function clearHtmlFrame(el) {
    const root = getRoot();
    if (root && root.dataset.html && root.dataset.html !== 'false') root.dataset.html = 'false';
    const iframe = el && el.querySelector && el.querySelector('iframe.ov-html-frame');
    if (iframe) iframe.remove();
}

/** 把片段正文格式化为 HTML（受「渲染 HTML」开关 gate）。
 *  @param {object} frag
 *  @param {number} [chatIndex] 真实楼层 mesid；传给 messageFormatting 让 AI_OUTPUT regex 按楼层生效。
 *         合成测试楼层（chatIndex<0 或 undefined）回退 -1。 */
function formatFrag(frag, chatIndex) {
    const raw = frag.raw || '';
    const c = ctxRef || getCtx();
    let html = '';
    if (!getSetting('renderHtml')) {
        const div = document.createElement('div');
        div.textContent = raw;
        html = div.innerHTML;
    } else {
        const messageId = (typeof chatIndex === 'number' && chatIndex >= 0) ? chatIndex : -1;
        if (c && typeof c.messageFormatting === 'function') {
            try { html = c.messageFormatting(raw, c.name2 || '', false, false, messageId); }
            catch (_) { /* 退化纯文本 */ }
        }
        if (!html) {
            const div = document.createElement('div');
            div.textContent = raw;
            html = div.innerHTML;
        }
    }
    return ensureTextBlocks(markBracketText(html));
}

/** `<cg img="标题">正文</cg>` 的 img 属性 → 正文面板顶部的标题行。
 *  生图产出的 CG（stage-parser 的 genmedia 分支）里 img 与 raw 是同一句 prompt，
 *  照搬会把同一句话上下各印一遍；省掉 img 属性时解析器也拿 caption 兜底当 img。
 *  两种情况都表现为 img === raw，所以相同就不出标题。 */
function cgTitleHtml(frag) {
    if (!frag || frag.kind !== 'cg') return '';
    const title = String(frag.img || '').trim();
    if (!title || title === String(frag.raw || '').trim()) return '';
    const p = document.createElement('p');
    p.className = 'ov-cg-title';
    p.textContent = title;   // img 是原样的属性串，必须转义
    return p.outerHTML;
}

/** 给普通文本节点里的成对括号段套语义色；代码块保持原样。 */
function markBracketText(html) {
    const host = document.createElement('div');
    host.innerHTML = String(html || '');
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
        if (node.parentElement?.closest('pre, code, script, style, textarea')) continue;
        const parts = splitBracketSegments(node.data);
        if (!parts.some((part) => part.bracket)) continue;
        const fragment = document.createDocumentFragment();
        for (const part of parts) {
            if (!part.bracket) { fragment.append(document.createTextNode(part.text)); continue; }
            const span = document.createElement('span');
            span.className = 'ov-bracket';
            span.textContent = part.text;
            fragment.append(span);
        }
        node.replaceWith(fragment);
    }
    return host.innerHTML;
}

/** 无块级子节点时包一层 <p>，让「文本背景」能贴在每条文本上（裸文本节点套不到背景）。 */
function ensureTextBlocks(html) {
    const s = String(html || '').trim();
    if (!s) return html || '';
    const tmp = document.createElement('div');
    tmp.innerHTML = s;
    const BLOCK = /^(P|DIV|BLOCKQUOTE|UL|OL|H[1-6]|PRE|TABLE|SECTION|ARTICLE|HR|FIGURE)$/i;
    const hasBlock = Array.from(tmp.children).some((el) => BLOCK.test(el.tagName));
    if (hasBlock) return tmp.innerHTML;
    if (!(tmp.textContent || '').trim()) return tmp.innerHTML;
    return `<p class="ov-text-block">${tmp.innerHTML}</p>`;
}

/**
 * 在「已格式化」的 HTML 产物里检测可渲染的 HTML（Amily2 模式：格式化跑完之后再检测）。
 * 命中返回 { html, prose }，否则 null。
 *   - html:  要在 iframe 里渲染的 HTML（选项框/美化框，来自酒馆 regex 或 ```html 代码块）
 *   - prose: HTML 块【之外】的正文散文（先渲散文、再把 HTML 块接在其下）
 * 一律内联（跟随内容高度、接正文底部），不再有「整页界面」路径——插件自己的 UI 走舞台标签。
 */
function detectHtmlFromFormatted(html) {
    if (!html || typeof html !== 'string') return null;
    const text = html.trim();
    if (!text) return null;

    // 1) 代码围栏：messageFormatting 会把 ```html 包成 <pre><code class="language-html">…
    const tmp = document.createElement('div');
    tmp.innerHTML = text;
    const codeBlocks = tmp.querySelectorAll('pre > code');
    for (const code of codeBlocks) {
        const content = (code.textContent || '').trim();
        if (!content || !isHtmlBlock(content)) continue;
        const pre = code.closest('pre');
        if (pre) pre.remove();
        const prose = tmp.innerHTML.trim();
        return { html: content, prose };
    }

    // 2) 整段就是裸 HTML 文档 / 含 <style>/<script> 的大段（regex 注入的选项框常见形态）
    if (isHtmlBlock(text)) {
        return { html: text, prose: '' };
    }

    return null;
}

/** 判断一段文本是否是可渲染的 HTML 块（完整文档 / 含 script / 含 style / 含 data-action 按钮等交互控件）。 */
function isHtmlBlock(content) {
    if (!content) return false;
    return /^\s*<!doctype\s+html/i.test(content)
        || /^\s*<html[\s>]/i.test(content)
        || /<script\b/i.test(content)
        || /<style[\s>]/i.test(content)
        || /<div[^>]*data-action/i.test(content)
        || /<button\b/i.test(content);
}

// —— 各层渲染助手 ——

function renderBg(scene) {
    const bg = q('#ov-bg');
    if (!bg) return;
    const desc = scene && scene.bg ? scene.bg : '';
    const img = scene?.url ? { url: scene.url } : (scene ? resolveImage('bg', scene) : null);
    const hasRealImg = !!(img && img.url);
    if (hasRealImg) {
        bg.style.backgroundImage = `url("${img.url}")`;
        bg.classList.remove('ov-placeholder');
        bg.textContent = '';
    } else {
        // M1 占位：深色渐变 + 场景描述淡字
        bg.style.backgroundImage = '';
        bg.classList.add('ov-placeholder');
        bg.textContent = desc;
    }
    // 文本背景仅在「有生成背景图」时显示：由 applyCurrentSettings 读 data-has-bg-img
    const root = getRoot();
    if (root) {
        root.dataset.hasBgImg = hasRealImg ? 'true' : 'false';
        try {
            // 动态 import 避免循环；失败则直接改 CSS 变量
            import('./ui.js').then((m) => m.applyCurrentSettings?.()).catch(() => refreshTextBgVars(root, hasRealImg));
        } catch (_) { refreshTextBgVars(root, hasRealImg); }
    }
    // fade 入场时长
    const fade = scene && scene.fade ? parseFade(scene.fade) : 0.6;
    bg.style.transition = `opacity ${fade}s ease`;
}

/** renderBg 后刷新文本背景 CSS（不走整套 apply 时的兜底） */
function refreshTextBgVars(root, hasRealImg) {
    if (!root) return;
    const on = !!getSetting('textBgEnabled') && hasRealImg;
    const op = Math.max(0, Math.min(100, Number(getSetting('textBgOpacity')) || 0)) / 100;
    let bg = 'transparent';
    if (on && op > 0) {
        const hex = String(getSetting('textBgColor') || '#000000').trim() || '#000000';
        const m = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
        bg = m
            ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${op})`
            : `rgba(0,0,0,${op})`;
    }
    root.style.setProperty('--ov-text-bg', bg);
    root.style.setProperty('--ov-text-bg-pad', on && op > 0 ? '10px 14px' : '0px');
    root.style.setProperty('--ov-text-bg-radius', on && op > 0 ? '12px' : '0px');
    root.style.setProperty('--ov-text-bg-gap', on && op > 0 ? '0.7em' : '0px');
    root.dataset.textBg = on ? 'true' : 'false';
}

function parseFade(s) {
    const m = String(s).match(/([\d.]+)/);
    const n = m ? parseFloat(m[1]) : 0.6;
    return Math.max(0.2, Math.min(20, n));
}

function renderSprite(frag) {
    const side = frag.pos === 'right' ? 'right' : 'left';
    const el = q(side === 'right' ? '#ov-sprite-right' : '#ov-sprite-left');
    if (!el) return;
    const img = resolveImage('sprite', { char: frag.speaker, emo: frag.emo });
    if (img && img.url) {
        el.style.backgroundImage = `url("${img.url}")`;
        el.classList.remove('ov-placeholder');
        el.textContent = '';
    } else {
        el.classList.add('ov-placeholder');
        el.textContent = placeholderLabel('sprite', { char: frag.speaker, emo: frag.emo });
    }
    el.classList.add('ov-active');
}

function clearSprites() {
    for (const id of ['#ov-sprite-left', '#ov-sprite-right']) {
        const el = q(id);
        if (el) { el.classList.remove('ov-active'); el.textContent = ''; el.style.backgroundImage = ''; }
    }
}

function renderCg(frag) {
    const cg = q('#ov-cg');
    if (!cg) return;
    const img = frag.url ? { url: frag.url } : resolveImage('cg', { img: frag.img, caption: frag.raw });
    cg.hidden = false;
    cg.classList.add('ov-active');
    if (img && img.url) {
        cg.style.backgroundImage = `url("${img.url}")`;
        cg.classList.remove('ov-placeholder');
        cg.innerHTML = '';
    } else {
        cg.style.backgroundImage = '';
        cg.classList.add('ov-placeholder');
        cg.innerHTML = `<span class="ov-cg-label"></span><span class="ov-cg-loading">生成中</span>`;
        cg.querySelector('.ov-cg-label').textContent = placeholderLabel('cg', { img: frag.img, caption: frag.raw });
    }
}

function renderVideo(frag) {
    const cg = q('#ov-cg');
    if (!cg) return;
    cg.hidden = false;
    cg.classList.add('ov-active');
    cg.classList.remove('ov-placeholder');
    cg.style.backgroundImage = '';
    cg.innerHTML = '';
    const v = document.createElement('video');
    v.className = 'ov-media-video';
    v.controls = true;
    v.playsInline = true;
    v.preload = 'metadata';
    v.src = frag.url || '';
    if (frag.poster) v.poster = frag.poster;
    cg.appendChild(v);
}

function hideCg() {
    const cg = q('#ov-cg');
    if (cg) {
        cg.querySelectorAll('video').forEach((v) => { try { v.pause(); v.removeAttribute('src'); v.load?.(); } catch (_) {} });
        cg.classList.remove('ov-active'); cg.hidden = true; cg.innerHTML = ''; cg.style.backgroundImage = '';
    }
}

function renderItems(items) {
    const box = q('#ov-items');
    if (!box) return;
    box.innerHTML = '';
    for (const it of items) {
        const el = document.createElement('div');
        el.className = 'ov-item-float';
        el.dataset.pos = it.pos || 'float-right';
        const cap = document.createElement('div');
        cap.className = 'ov-item-cap';
        cap.textContent = it.caption || it.img || '';
        const ph = document.createElement('div');
        ph.className = 'ov-item-ph ov-placeholder';
        // 道具图：显式 url（fetch/pic）优先；否则 resolveImage/素材库；否则占位名。
        const img = it.url ? { url: it.url } : resolveImage('item', { img: it.img, caption: it.caption });
        if (img && img.url) {
            ph.classList.remove('ov-placeholder');
            ph.style.backgroundImage = `url("${img.url}")`;
            ph.textContent = '';
        } else {
            ph.textContent = it.img || '';
        }
        el.appendChild(ph);
        el.appendChild(cap);

        // hover → reveal；click → 钉住 reveal，并把 action 文案填进输入框（只填不发，
        // 用户可以改词或直接删掉）。收起时不填，避免反复点击把同一句话堆进去。
        const disabled = it.clickable === false;
        if (!disabled) {
            el.classList.add('ov-clickable');
            const ensureReveal = () => {
                let r = el.querySelector('.ov-item-reveal');
                if (!r) {
                    r = document.createElement('div');
                    r.className = 'ov-item-reveal';
                    el.appendChild(r);
                }
                return r;
            };
            el.addEventListener('mouseenter', () => {
                if (!it.reveal || el.classList.contains('ov-item-open')) return;
                const r = ensureReveal();
                r.textContent = it.reveal;
                r.hidden = false;
                el.classList.add('ov-revealed');
            });
            el.addEventListener('mouseleave', () => {
                if (el.classList.contains('ov-item-open')) return;
                const r = el.querySelector('.ov-item-reveal');
                if (r) r.hidden = true;
                el.classList.remove('ov-revealed');
            });
            el.addEventListener('click', (ev) => {
                ev.stopPropagation();
                finishTypewriterInstantly();
                const open = el.classList.toggle('ov-item-open');
                // 只钉住 reveal。caption 已经常驻在 .ov-item-cap 上，再展开一遍就是把
                // 用户已经看着的那句话重复一次；reveal 才是「点了才该看到」的内容。
                if (it.reveal) {
                    const r = ensureReveal();
                    r.textContent = it.reveal;
                    r.hidden = !open;
                    el.classList.toggle('ov-revealed', open);
                }
                // insertIntoComposer 是追加式的，所以只在展开这一侧填，收起不填
                if (open && it.action) insertIntoComposer(it.action);
            });
        } else {
            el.classList.add('ov-item-locked');
        }

        box.appendChild(el);
    }
}

function setSpeaker(name) {
    const el = q('#ov-speaker');
    if (!el) return;
    el.textContent = name || '';
    el.style.display = name ? '' : 'none';
}

function setText(html) {
    const el = q('#ov-panel-text');
    if (el) el.innerHTML = html || '';
    renderedTextKey = '';
}

// —— 跳转条 / 楼层元信息 ——

function updateJumpbar() {
    const bar = q('#ov-jumpbar');
    if (!bar) return;
    const fl = currentFloor();
    const hasPrev = liveViewActive ? floors.length > 0 : pos.floorIdx > 0;
    const hasNext = !liveViewActive && (pos.floorIdx < floors.length - 1 || liveStreamActive);
    // VN 楼层多片段时显示片段点；普通楼层无片段点。两端始终放圆箭头（显式切楼层入口）。
    const showDots = !liveViewActive && !isPlainMode() && fl && fl.fragments.length > 1;

    if (!hasPrev && !hasNext && !showDots) { bar.hidden = true; bar.innerHTML = ''; return; }
    bar.hidden = false;

    // 圆点拖动 scrub 中：只更新 .ov-current，别整栏重建（否则 pointer 断）
    const scrubbing = bar.querySelector('.ov-jump-dots.ov-scrubbing');
    if (scrubbing) {
        scrubbing.querySelectorAll('.ov-jump-dot').forEach((d, i) => {
            d.classList.toggle('ov-current', i === pos.fragIdx);
        });
        const up = bar.querySelector('.ov-arrow-up');
        const down = bar.querySelector('.ov-arrow-down');
        if (up) { up.disabled = !hasPrev; up.classList.toggle('ov-disabled', !hasPrev); }
        if (down) { down.disabled = !hasNext; down.classList.toggle('ov-disabled', !hasNext); }
        return;
    }

    bar.innerHTML = '';

    // 顶部圆箭头：上一楼层
    bar.appendChild(buildArrow('up', hasPrev));
    // 中部片段点（可按住上下拖切换）
    if (showDots) bar.appendChild(buildFragDots(fl.fragments.length));
    // 底部圆箭头：下一楼层
    bar.appendChild(buildArrow('down', hasNext));
}

/** 本楼片段圆点：点击跳片段；按住在点列上下拖 = 进度条式切换。 */
function buildFragDots(n) {
    const wrap = document.createElement('div');
    wrap.className = 'ov-jump-dots';
    wrap.title = '拖动切换片段';
    for (let i = 0; i < n; i++) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'ov-jump-dot' + (i === pos.fragIdx ? ' ov-current' : '');
        dot.title = `片段 ${i + 1}`;
        dot.dataset.i = String(i);
        wrap.appendChild(dot);
    }

    const idxFromY = (clientY) => {
        const rect = wrap.getBoundingClientRect();
        if (rect.height <= 0 || n <= 1) return 0;
        const t = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        return Math.round(t * (n - 1));
    };
    const goFrag = (i) => {
        if (i === pos.fragIdx) return;
        if (finishTypewriterInstantly()) return;
        pos.fragIdx = i;
        renderCurrent(false);
    };

    let dragging = false;
    let last = -1;
    let startY = 0;
    let moved = false;
    const onMove = (e) => {
        if (!dragging) return;
        if (Math.abs(e.clientY - startY) > 4) moved = true;
        const i = idxFromY(e.clientY);
        if (i !== last) { last = i; goFrag(i); }
    };
    const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove('ov-scrubbing');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        // 纯点击（几乎没拖）→ 点哪个跳哪个
        if (!moved && e && e.target && e.target.closest) {
            const d = e.target.closest('.ov-jump-dot');
            if (d && d.dataset.i != null) goFrag(Number(d.dataset.i));
        }
    };
    wrap.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        moved = false;
        startY = e.clientY;
        last = -1;
        wrap.classList.add('ov-scrubbing');
        wrap.setPointerCapture?.(e.pointerId);
        onMove(e);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    });
    return wrap;
}

/** 构建圆润箭头：点击或「点住下滑/上滑」跳到上/下一楼层。disabled 时灰显不可用。 */
function buildArrow(dir, enabled) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ov-jump-arrow ov-arrow-${dir}` + (enabled ? '' : ' ov-disabled');
    btn.title = dir === 'up' ? '上一条聊天' : '下一条聊天';
    btn.innerHTML = dir === 'up' ? '▲' : '▼';
    if (!enabled) { btn.disabled = true; return btn; }

    const go = () => { if (finishTypewriterInstantly()) return; dir === 'down' ? next() : prev(); };

    // 点击即切；另支持「按住并朝箭头方向滑动」触发（更有操控感）。
    let startY = null, fired = false;
    btn.addEventListener('pointerdown', (e) => {
        startY = e.clientY; fired = false;
        btn.setPointerCapture?.(e.pointerId);
    });
    btn.addEventListener('pointermove', (e) => {
        if (startY === null || fired) return;
        const dy = e.clientY - startY;
        const want = dir === 'down' ? dy > 18 : dy < -18; // 朝箭头方向滑动一定距离
        if (want) { fired = true; go(); }
    });
    btn.addEventListener('pointerup', (e) => {
        const moved = startY !== null && Math.abs(e.clientY - startY) > 6;
        startY = null;
        if (!fired && !moved) go(); // 纯点击
    });
    return btn;
}

/**
 * 找出「产生当前楼的那条用户输入」。
 * floors[] 只装 AI 消息（rebuild 里 is_user 直接 continue），用户消息不在其中，
 * 所以只能回 ctx.chat 里往前扫。
 * @returns {{msg: object, index: number}|null} null = 没有可显示的输入
 */
function findReplySource() {
    const c = getCtx();
    const chat = (c && c.chat) || [];
    let i;
    if (liveViewActive) {
        // 实时楼不是 floors[] 的条目（liveViewActive 是独立状态位）。
        // chat 末尾可能已被推入正在生成的 AI 消息，也可能还没推——两种都要落到它前面那条输入。
        i = chat.length - 1;
        const last = chat[i];
        if (last && !last.is_user && !last.is_system) i--;
    } else {
        const fl = floors[pos.floorIdx];
        const ci = fl && typeof fl.chatIndex === 'number' ? fl.chatIndex : -1;
        if (ci < 0) return null;   // 合成测试楼（chatIndex: -1），没有对应的真实输入
        i = ci - 1;
    }
    // 中间可能夹着 system 消息；撞到另一条 AI 消息说明本楼不是由用户输入直接触发的（连续 AI 楼）
    for (; i >= 0; i--) {
        const m = chat[i];
        if (!m) return null;
        if (m.is_system) continue;
        return m.is_user ? { msg: m, index: i } : null;
    }
    return null;
}

/** 顶部只读回显：填入产生当前楼的那条用户输入；没有就给外壳打 ov-reply-empty，整套顶部机制撤掉。 */
function updateReplyEcho() {
    const shell = getShell();
    const box = q('#ov-reply-text');
    if (!shell || !box) return;
    const found = findReplySource();
    if (!found) {
        shell.classList.add('ov-reply-empty');
        shell.classList.remove('ov-reply-show');
        box.textContent = '';
        return;
    }
    shell.classList.remove('ov-reply-empty');
    const { msg, index } = found;
    const raw = msg.mes || '';
    const c = getCtx();
    // 不能复用 formatFrag：它把 isUser 写死为 false，用户消息要按用户身份跑 regex 与样式。
    if (getSetting('renderHtml') && c && typeof c.messageFormatting === 'function') {
        try {
            box.innerHTML = c.messageFormatting(raw, msg.name || c.name1 || '', !!msg.is_system, true, index);
            return;
        } catch (_) { /* 落到纯文本 */ }
    }
    box.textContent = raw;
}

/** 顶部回显重取一次（由 bridge 在 USER_MESSAGE_RENDERED 时调）。
 *  发送后 enterWaiting() 会立刻跑一遍 updateFloorMeta，但那一刻 ST 还没把用户消息推进 chat——
 *  proxySend 只是点了发送键就同步返回，ST 的入链是异步的——findReplySource 只能摸到上一条输入。
 *  之后首个 token 到达时，onStream 的 startsSession 分支又因为 enterWaiting 已经把
 *  liveStreamActive 置真而判假、不会再刷，于是整轮生成都顶着上上条输入。这里补一刀。 */
export function refreshReplyEcho() {
    updateReplyEcho();
}

function updateFloorMeta() {
    // 顶栏楼层号和顶部回显都是「跟随当前显示楼层」，同一批调用点，放一起避免漏更新
    updateReplyEcho();
    const el = q('#ov-floor-meta');
    if (!el) return;
    if (!getSetting('showFloorMeta')) { el.textContent = ''; el.style.display = 'none'; return; }
    el.style.display = '';
    if (liveViewActive) { el.textContent = '生成中'; return; }
    if (!floors.length) { el.textContent = ''; return; }
    const fl = floors[pos.floorIdx];
    const mesid = fl && typeof fl.chatIndex === 'number' && fl.chatIndex >= 0 ? fl.chatIndex : null;
    el.textContent = mesid !== null ? `#${mesid}` : `${pos.floorIdx + 1} / ${floors.length}`;
}

// —— 导航 ——

function isPlainMode() {
    const root = getRoot();
    return !!(root && root.dataset.plain === 'true');
}

/**
 * 「下一步」(左键 / 下一帧)：
 *   VN 楼层：未到末片段 → 下一片段；已到末片段 → 切下一楼层。
 *   普通楼层：直接切下一楼层（整楼一屏，无片段）。
 */
function next() {
    const fl = currentFloor();
    if (!fl) return;
    if (liveViewActive) { pulseHint(); return; }
    if (finishTypewriterInstantly()) return;  // 正在出字：先补完当前屏，下次再推进
    if (!isPlainMode() && pos.fragIdx < lastFragIdx(pos.floorIdx)) { pos.fragIdx++; renderCurrent(true); return; }
    if (pos.floorIdx < floors.length - 1) slideToFloor(1);
    else if (liveStreamActive) resumeLiveView();
    else pulseHint();
}

/**
 * 「上一步」(右键 / 上一帧)：
 *   VN 楼层：未到首片段 → 上一片段；已到首片段 → 切上一楼层。
 *   普通楼层：直接切上一楼层。
 *   正在出字也直接回退（不先补完当前屏）——回退是放弃当前屏，renderCurrent/slideToFloor 会自行停打字机。
 */
function prev() {
    if (liveViewActive) { leaveLiveView(); return; }
    if (!isPlainMode() && pos.fragIdx > 0) { pos.fragIdx--; renderCurrent(false); return; }
    if (pos.floorIdx > 0) slideToFloor(-1);
    else pulseHint();
}

function pulseHint() {
    const hint = q('#ov-advance-hint');
    if (!hint) return;
    hint.classList.remove('ov-pulse');
    void hint.offsetWidth;
    hint.classList.add('ov-pulse');
}

function wireNavigation() {
    const stage = getStage();
    if (!stage) return;

    let clickStart = null;
    let selectLock = null;
    let lastPointer = null;      // 指针最后停在哪；滚轮补选区末端时要用
    const unlockSelectionScroll = () => { selectLock = null; };
    stage.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || isInteractive(e.target)) return;
        clickStart = { x: e.clientX, y: e.clientY };
        const text = e.target.closest && e.target.closest('#ov-panel-text');
        selectLock = text ? { el: text, y: text.scrollTop, active: false } : null;
    }, { passive: true });
    stage.addEventListener('pointermove', (e) => {
        lastPointer = { x: e.clientX, y: e.clientY };
        if (!selectLock || !clickStart) return;
        if (Math.hypot(e.clientX - clickStart.x, e.clientY - clickStart.y) > 6) selectLock.active = true;
    }, { passive: true });
    stage.addEventListener('pointerup', unlockSelectionScroll, { passive: true });
    stage.addEventListener('pointercancel', unlockSelectionScroll, { passive: true });

    /** 屏幕坐标 → 折叠 Range。Chromium/WebKit 与 Firefox 的 API 名字不同，都兜一下。 */
    const caretAt = (x, y) => {
        if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
        if (document.caretPositionFromPoint) {
            const p = document.caretPositionFromPoint(x, y);
            if (!p) return null;
            const r = document.createRange();
            r.setStart(p.offsetNode, p.offset);
            r.collapse(true);
            return r;
        }
        return null;
    };
    /**
     * 滚轮滚完把选区末端拉到指针此刻所指的位置。
     * 浏览器只在 mousemove 时更新拖选末端；用滚轮翻屏时指针没动过，不补这一下，
     * 选区就停在滚动前那个字上，「滚过去接着选」等于空转。
     * 浏览器如果本来就跟上了，这里算出的是同一个落点，重复设一次没有副作用。
     * @param {HTMLElement} el 正文容器；落点必须在它里面，否则不动选区
     */
    const extendSelectionToPointer = (el) => {
        if (!lastPointer) return;
        try {
            const sel = window.getSelection && window.getSelection();
            if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return;
            const r = caretAt(lastPointer.x, lastPointer.y);
            // 指针可能悬在正文外（面板留白、叠层）：那里的落点不能拿来当选区末端
            if (!r || !el.contains(r.startContainer)) return;
            sel.extend(r.startContainer, r.startOffset);
        } catch (_) { /* 不支持 extend 或节点不可扩选：交回浏览器原生行为 */ }
    };

    // 左键：单击导航；拖动留给原生文本选择。
    stage.addEventListener('click', (e) => {
        if (isInteractive(e.target)) return;
        hideCopyFab();
        const sel = window.getSelection ? String(window.getSelection() || '') : '';
        const dragged = clickStart && Math.hypot(e.clientX - clickStart.x, e.clientY - clickStart.y) > 6;
        clickStart = null;
        unlockSelectionScroll();
        if (dragged) return;  // 拖动=选择/滚动手势，不推进
        // 只有本次手势真的在造选区（双击选词/Shift 扩选）才算选择意图；
        // 静止单击不可能产生选区——窗口里残留的旧选区（点在 user-select:none 区域不会被清除）不该吞掉推进。
        if (sel.trim() && (e.detail > 1 || e.shiftKey)) return;
        if (!getSetting('pointerNavigation')) return;
        if (finishTypewriterInstantly()) return;  // 正在出字：先补完当前屏，下次再推进
        next();
    });
    // 右键：有选区则复制；无选区则回退。
    stage.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (isInteractive(e.target)) return;
        const sel = window.getSelection ? String(window.getSelection() || '') : '';
        if (sel.trim()) {
            showCopyFab(e.clientX, e.clientY, sel);
            return;
        }
        hideCopyFab();
        if (getSetting('pointerNavigation')) prev();
    });

    // 滚轮：统一与左右键同义——在楼层内翻片段 / 滚动正文；到边界后带阻尼跨楼层。
    //   两档阻力：VN 楼层内切片段=轻（fragThreshold）；跨楼层=强（floorThreshold，由 wheelStrength 设置）。
    const textEl = () => q('#ov-panel-text');
    stage.addEventListener('wheel', (e) => {
        // 在抽屉 / 背包面板 / 日志 / 展开的思维链等可滚动叠层上滚动 → 放行原生滚动，不劫持成翻页/切楼层。
        if (e.target.closest && e.target.closest('.ov-drawer, .ov-log-body, .ov-thinking[open]')) {
            wheelAccum = 0; clearDampFeedback(); return;
        }
        if (sliding || wheelCooldown) { e.preventDefault(); return; }
        const down = e.deltaY > 0;            // 向下=前进/更新楼层；向上=回退/更旧楼层
        // 换向：累加器清零重计（避免反向时残留触发）
        if (wheelDir !== 0 && ((down && wheelDir < 0) || (!down && wheelDir > 0))) { wheelAccum = 0; clearDampFeedback(); hideFloorHints(); }
        wheelDir = down ? 1 : -1;

        // 正文能沿滚动方向原生滚动（长文未到边界）→ 代滚正文 scrollTop（不只放行原生：
        //   鼠标在正文宽度两侧时 target 是 stage/panel，原生不会滚 .ov-panel-text）。
        const te = textEl();
        // 是否正按着左键拉选区。拖选常常要跨屏，滚轮就是把选区拉到下一屏的手段，必须让它真的滚起来。
        const selecting = !!(te && selectLock && selectLock.active && selectLock.el === te);
        let atTop = true, atBottom = true;
        if (te) {
            atTop = te.scrollTop <= 1;
            atBottom = te.scrollTop + te.clientHeight >= te.scrollHeight - 2;
            const scrollable = te.scrollHeight - te.clientHeight > 2;
            const canScrollNative = scrollable && ((down && !atBottom) || (!down && !atTop));
            if (canScrollNative) {
                e.preventDefault();
                te.scrollTop += e.deltaY;
                // 锚点跟着这次滚动一起挪。selectLock 本来是夹住浏览器选区 auto-scroll 的飞滚，
                // 不挪的话上一行刚加完 scrollTop，te0 的 scroll 监听立刻把它弹回原位 = 拖选时滚轮完全失效。
                if (selecting) { selectLock.y = te.scrollTop; extendSelectionToPointer(te); }
                wheelAccum = 0; clearDampFeedback(); hideFloorHints(); flashScrollbar();
                return;
            }
        }

        // 拖选到正文尽头：吞掉滚轮就停，绝不往下走跨楼层那套——换楼会重建正文，
        // 正在拉的选区当场没了，而用户此刻的意图明摆着是「继续选」。
        if (selecting) {
            e.preventDefault();
            wheelAccum = 0; clearDampFeedback(); hideFloorHints();
            return;
        }

        // 到边界（或正文不可滚）：吞掉滚动，按模式分档。
        e.preventDefault();

        // 实时生成视为历史楼层之后的独立一楼：向上回历史，向下撞墙。
        if (liveViewActive) {
            showFloorHint(down);
            accumulateCrossFloor(e, down);
            return;
        }

        // 普通楼层：正文已到边界才换楼（边界硬门），否则不动。
        if (isPlainMode()) {
            if (down && pos.floorIdx >= floors.length - 1 && !liveStreamActive) {
                wheelAccum = 0; clearDampFeedback(); hideFloorHints();
                return;
            }
            showFloorHint(down);
            accumulateCrossFloor(e, down);
            return;
        }

        // VN 楼层：未到首/末片段 → 轻阻力切片段；到边缘 → 强阻力跨楼层。
        const atFloorEdge = down ? (pos.fragIdx >= lastFragIdx(pos.floorIdx)) : (pos.fragIdx <= 0);
        if (!atFloorEdge) {
            hideFloorHints();
            const fragT = fragThreshold();
            wheelAccum += Math.abs(e.deltaY);
            applyDampFeedback(wheelAccum / fragT, down, false);
            if (wheelAccum >= fragT) {
                wheelAccum = 0; clearDampFeedback();
                if (finishTypewriterInstantly()) {  // 正在出字：先补完当前屏，下次滚轮再推进
                    wheelCooldown = true;
                    setTimeout(() => { wheelCooldown = false; }, WHEEL_FRAG_COOLDOWN_MS);
                    return;
                }
                if (down) { pos.fragIdx++; renderCurrent(true); }
                else { pos.fragIdx--; renderCurrent(false); }
                wheelCooldown = true;
                setTimeout(() => { wheelCooldown = false; }, WHEEL_FRAG_COOLDOWN_MS);
            }
            return;
        }
        // 楼层边缘 → 强阻力跨楼层（仅当有目标楼层时给提示）
        showFloorHint(down);
        accumulateCrossFloor(e, down);
    }, { passive: false });

    // 原生滚动（拖滚动条/触控板惯性）也触发滚动条渐显
    const te0 = textEl();
    if (te0) {
        te0.addEventListener('scroll', flashScrollbar, { passive: true });
        // 拖动选择文本期间锁住 scrollTop：浏览器选区 auto-scroll 会把正文向下飞滚，这里夹回。
        te0.addEventListener('scroll', () => {
            if (selectLock && selectLock.active && selectLock.el === te0) te0.scrollTop = selectLock.y;
        }, { passive: true });
    }
}

/** 强阻力累积 → 达到跨楼层阈值则滑动切楼层。无更多楼层则只给弹性反馈。 */
function accumulateCrossFloor(e, down) {
    const toHistory = liveViewActive && !down && floors.length > 0;
    const toLive = !liveViewActive && down && liveStreamActive && pos.floorIdx >= floors.length - 1;
    const target = pos.floorIdx + (down ? 1 : -1);
    if (!toHistory && !toLive && (target < 0 || target >= floors.length)) {
        // 没有更多楼层：给一点「撞墙」弹性，不切，不显提示
        hideFloorHints();
        applyDampFeedback(0.4, down, true);
        clearTimeout(accumulateCrossFloor._t);
        accumulateCrossFloor._t = setTimeout(clearDampFeedback, 140);
        return;
    }
    const floorT = floorThreshold();
    wheelAccum += Math.abs(e.deltaY);
    applyDampFeedback(wheelAccum / floorT, down, true);
    if (wheelAccum >= floorT) {
        wheelAccum = 0;
        if (finishTypewriterInstantly()) return; // 正在出字：先补完当前屏，下次滚轮再跨楼层
        if (toHistory) leaveLiveView();
        else if (toLive) resumeLiveView();
        else slideToFloor(down ? 1 : -1);
    }
}

// —— 跨楼层提示条（到边界继续滚动切楼层时淡入；切换/换向/超时后淡出） ——
let hintHideTimer = null;
function showFloorHint(down) {
    const toHistory = liveViewActive && !down && floors.length > 0;
    const toLive = !liveViewActive && down && liveStreamActive && pos.floorIdx >= floors.length - 1;
    const target = pos.floorIdx + (down ? 1 : -1);
    if (!toHistory && !toLive && (target < 0 || target >= floors.length)) { hideFloorHints(); return; }
    const id = down ? '#ov-floor-hint-bottom' : '#ov-floor-hint-top';
    const other = down ? '#ov-floor-hint-top' : '#ov-floor-hint-bottom';
    const el = q(id), oe = q(other);
    if (oe) { oe.classList.remove('ov-on'); oe.hidden = true; }
    if (el) { el.hidden = false; void el.offsetWidth; el.classList.add('ov-on'); }
    clearTimeout(hintHideTimer);
    hintHideTimer = setTimeout(hideFloorHints, 1100);
}
function hideFloorHints() {
    clearTimeout(hintHideTimer);
    for (const id of ['#ov-floor-hint-top', '#ov-floor-hint-bottom']) {
        const el = q(id);
        if (el) { el.classList.remove('ov-on'); setTimeout(() => { if (el && !el.classList.contains('ov-on')) el.hidden = true; }, 220); }
    }
}

// 阻尼反馈：正文跟手向滚动方向漂移（CSS translateY(var(--ov-damp-y))，不破坏布局）。
//   strong=true（跨楼层）位移更大、阻力感更明显；false（切片段）轻微。
function applyDampFeedback(ratio, down, strong) {
    const el = q('#ov-panel-text');
    if (!el) return;
    const max = strong ? 26 : 12;
    // 阻尼跟手：正文朝「继续滚动的方向」漂移（被拉住/难以再滚的手感），而非反向。
    //   向下滚 = 内容继续上移（translateY 负）；向上滚 = 内容继续下移（正）。原来符号反了，故看起来「反着滚」。
    const shift = Math.min(max, ratio * max) * (down ? -1 : 1);
    el.style.setProperty('--ov-damp-y', `${shift}px`);
    el.style.opacity = String(1 - Math.min(strong ? 0.32 : 0.18, ratio * (strong ? 0.32 : 0.18)));
}
function clearDampFeedback() {
    const el = q('#ov-panel-text');
    if (!el) return;
    el.style.setProperty('--ov-damp-y', '0px');
    el.style.opacity = '';
}

/**
 * 滑动切楼层（滚轮触发）：当前正文带拖影朝滚动方向飞出 → 瞬间切到目标楼层开头 → 新正文从反向滑入。
 * dir>0 去更新楼层，dir<0 去更旧楼层。落点一律为目标楼层开头（fragIdx 0、scrollTop 0）。
 */
function slideToFloor(dir) {
    const target = pos.floorIdx + (dir > 0 ? 1 : -1);
    if (target < 0 || target >= floors.length) { clearDampFeedback(); return; }
    const el = q('#ov-panel-text');
    if (!el) { pos.floorIdx = target; pos.fragIdx = 0; renderCurrent(false); return; }

    sliding = true;
    wheelCooldown = true;
    wheelAccum = 0; wheelDir = 0;
    hideFloorHints();
    finishTypewriterInstantly();  // 滑出动画里别显示半截字：先补完当前屏

    const outName = dir > 0 ? 'ov-slide-out-down' : 'ov-slide-out-up'; // 跟手方向飞出（带拖影模糊）
    const inName  = dir > 0 ? 'ov-slide-in-up'    : 'ov-slide-in-down'; // 新内容从反向滑入

    // 1) 飞出（短促）
    el.style.removeProperty('--ov-damp-y');
    el.style.opacity = '';
    el.style.animation = `${outName} 0.13s ease forwards`;

    setTimeout(() => {
        // 2) 切到目标楼层开头
        pos.floorIdx = target;
        pos.fragIdx = 0;
        el.style.animation = 'none';
        // 前进（向下/向更新楼层）→ 播打字机（受打字速度控制，这样普通/小说楼层滚动前进时也能看到出字）；
        // 后退（回看旧楼层）→ 瞬显不磨蹭。关打字机则始终瞬显（renderText 内部再 gate）。
        renderCurrent(dir > 0);
        const t = q('#ov-panel-text');
        if (t) {
            t.scrollTop = 0;
            // 3) 新正文从反向滑入
            void t.offsetWidth;
            t.style.animation = `${inName} 0.16s ease`;
            setTimeout(() => { if (t) t.style.animation = ''; }, 170);
        }
        sliding = false;
        setTimeout(() => { wheelCooldown = false; }, WHEEL_COOLDOWN_MS);
    }, 130);
}

// —— 选择模式：右键弹出的复制按钮（定位到光标处；复制右键时捕获的选中文本） ——
//   关键：复制的文本在【右键那一刻】捕获（此时选区还在）。若等到 fab 的 click 再读 getSelection，
//   button 的 mousedown 已把焦点移走、选区被清空 → 偶发「未选中」。故 mousedown 也 preventDefault 保住选区。
let copyFabBound = false;
let _copyText = '';
function searchSelectedText(text) {
    const q = String(text || '').trim();
    if (!q) return;
    window.open(`https://www.google.com/search?q=${encodeURIComponent(q)}`, '_blank', 'noopener,noreferrer');
}

function showCopyFab(x, y, selText) {
    const fab = q('#ov-copy-fab');
    if (!fab) return;
    _copyText = String(selText || '');
    fab.style.left = `${x + 6}px`;
    fab.style.top = `${y - 18}px`;
    fab.hidden = false;
    void fab.offsetWidth;
    fab.classList.add('ov-on');
    // 一次接线（点击复制 + 自动隐藏）
    if (!copyFabBound) {
        copyFabBound = true;
        // 按下不夺取正文选区（否则选区被清 → 复制到空）
        fab.addEventListener('mousedown', (e) => e.preventDefault());
        fab.addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = e.target.closest && e.target.closest('button[data-act]');
            if (!btn) return;
            // 优先用右键时捕获的文本；为空再兜底读当前选区
            const live = window.getSelection ? String(window.getSelection() || '') : '';
            const text = _copyText.trim() ? _copyText : live;
            if (!text.trim()) { flashFab(fab, '未选中'); return; }
            if (btn.dataset.act === 'google') {
                searchSelectedText(text);
                hideCopyFab();
                return;
            }
            try { navigator.clipboard?.writeText(text); } catch (_) {}
            flashFab(fab, '✓');
            setTimeout(hideCopyFab, 350);
        });
        // 点别处自动隐藏
        document.addEventListener('pointerdown', (ev) => {
            if (fab.hidden) return;
            if (fab.contains(ev.target)) return;
            hideCopyFab();
        }, { passive: true });
    }
}
function hideCopyFab() {
    const fab = q('#ov-copy-fab');
    if (fab && !fab.hidden) { fab.classList.remove('ov-on'); fab.hidden = true; }
}
function flashFab(fab, text) {
    const icon = fab.querySelector('button[data-act="copy"] i');
    if (!icon) return;
    const prev = icon.className;
    if (text === '✓') {
        // 成功：打勾【原地】替换复制图标（不再浮在按钮上方），600ms 后复原
        icon.className = 'fa-solid fa-check';
        fab.classList.add('ov-flash-ok');
        setTimeout(() => { icon.className = prev; fab.classList.remove('ov-flash-ok'); }, 600);
    } else {
        // 其它反馈（未选中）：短暂用按钮上方小字，避免长文挤进小按钮
        fab.dataset.flash = text;
        setTimeout(() => { delete fab.dataset.flash; }, 600);
    }
}

function isInteractive(node) {
    let el = node;
    while (el && el !== document.body) {
        if (el.matches && el.matches('button, a, input, textarea, select, option, label, details, summary, audio, video, [contenteditable], [onclick], [data-action], [role="button"], [role="link"], [tabindex], .ov-clickable, .ov-jumpbar, .ov-drawer, .ov-composer, .ov-item-float, .ov-topbar-actions, .ov-topbar-wrap, iframe.ov-html-frame, .ov-html-frame, .ov-copy-fab')) return true;
        el = el.parentElement;
    }
    return false;
}

// —— 打字机 ——

/** 滑条值→每字延迟(ms)。语义：数值越小越慢，越大越快。
 *  value=1 → 150ms/字（最慢）；value=150 → 1ms/字（瞬显）。
 *  @param {boolean} vn true=VN 楼层用 typewriterSpeedVn，false=普通正文用 typewriterSpeed */
function typewriterDelay(vn) {
    const v = Number(getSetting(vn ? 'typewriterSpeedVn' : 'typewriterSpeed')) || 28;
    return Math.max(1, 151 - v);
}

/** 纯文本长度（HTML → textContent）。 */
function htmlTextLen(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    return (tmp.textContent || '').length;
}

/**
 * 把 HTML 截到前 n 个可见字符，保留标签结构（段落 / 引号色 / 强调）。
 * 超过 n 的文本节点清空，未触及的节点原样保留。
 */
function sliceHtmlByChars(html, n) {
    const root = document.createElement('div');
    root.innerHTML = html || '';
    let left = Math.max(0, n | 0);
    const walk = (node) => {
        if (left <= 0) {
            if (node.nodeType === 3) node.textContent = '';
            else if (node.nodeType === 1) {
                for (const child of Array.from(node.childNodes)) walk(child);
            }
            return;
        }
        if (node.nodeType === 3) {
            const t = node.textContent || '';
            if (t.length <= left) { left -= t.length; return; }
            node.textContent = t.slice(0, left);
            left = 0;
            return;
        }
        if (node.nodeType === 1) {
            for (const child of Array.from(node.childNodes)) walk(child);
        }
    };
    for (const child of Array.from(root.childNodes)) walk(child);
    return root.innerHTML;
}

function runTypewriter(el, html, vn) {
    stopTypewriter();
    typing = true;
    typeLastHtml = html;   // 记下完整目标，供导航/点击瞬间补完
    // 保留 HTML 结构逐字揭示（段落 / 引号色实时生效）；结束后写完整 HTML。
    const fullLen = htmlTextLen(html);
    const speed = typewriterDelay(vn);
    let shown = 0;
    let acc = 0;
    let last = performance.now();
    el.classList.add('ov-typing');
    el.innerHTML = '';
    const tick = (now) => {
        acc += now - last;
        last = now;
        const step = Math.floor(acc / speed);
        if (step < 1) { typeTimer = requestAnimationFrame(tick); return; }
        acc -= step * speed;
        shown = Math.min(fullLen, shown + step);
        if (shown >= fullLen) {
            stopTypewriter();
            el.innerHTML = html;
        } else {
            el.innerHTML = sliceHtmlByChars(html, shown);
            typeTimer = requestAnimationFrame(tick);
        }
    };
    typeTimer = requestAnimationFrame(tick);
}

/**
 * 瞬间补完正在出字的打字机（普通 + 流式）：把当前片段完整 HTML 一次性写入。
 * 用户要求：左键/滚轮/跳转/点击先「把当前屏出完」，下一次操作再真正推进。
 * @returns {boolean} 是否真的补完了正在出字的文本（用于让调用方吞掉本次动作）。
 */
function finishTypewriterInstantly() {
    let did = false;
    const el = q('#ov-panel-text');
    // 普通打字机进行中 → 写完整目标 HTML
    if ((typeTimer || typing) && typeLastHtml) {
        if (typeTimer) { cancelAnimationFrame(typeTimer); typeTimer = null; }
        typing = false;
        if (el) { el.innerHTML = typeLastHtml; el.classList.remove('ov-typing'); }
        did = true;
    }
    // 流式打字机进行中 → 写最新累积 HTML，并把游标推到「已追平」，避免下批 token 重打已显部分
    if (streamTypeTimer && streamLastHtml) {
        if (streamTypeTimer) { cancelAnimationFrame(streamTypeTimer); streamTypeTimer = null; }
        streamShown = streamTargetText.length;   // 视作已追平：后续 token 只追加新部分
        if (el) { el.innerHTML = streamLastHtml; el.classList.remove('ov-typing'); }
        did = true;
    }
    return did;
}

function stopTypewriter() {
    if (typeTimer) { cancelAnimationFrame(typeTimer); typeTimer = null; }
    typing = false;
    const el = q('#ov-panel-text');
    if (el) el.classList.remove('ov-typing');
}

// —— 流式 + 空窗期（由 bridge 调用）——

/** 进入空窗等待态（发送后→首 token 前） */
export function enterWaiting() {
    cancelStreamFrame();
    liveStreamActive = true;
    liveViewActive = true;
    liveFullText = '';
    liveThinkingText = '';
    streamedThisGen = false;
    streamMode = 'unknown';
    waiting = true;
    stopTypewriter();
    stopStreamTypewriter();
    const root = getRoot();
    if (root) { root.dataset.plain = 'false'; root.dataset.html = 'false'; }
    // 发送后立刻清掉上一轮思维链，避免误显旧回复的 think；新 token 再由 onStream 写入
    hideThinking();
    renderBg(undefined);
    clearSprites();
    hideCg();
    setSpeaker('');
    setText('');
    renderItems([]);
    const w = q('#ov-waiting');
    if (w) { w.hidden = false; w.classList.add('ov-on'); }
    const panel = q('#ov-panel');
    if (panel) panel.classList.add('ov-dimmed');
    updateJumpbar();
    updateFloorMeta();
}

/** 无条件清除「生成中」等待态（DOM + 标志），不依赖内存 waiting 标志。
 *  open()/minimize()/rebuild() 在非生成时调用，根除残留黑屏 + 「生成中」。
 *  关键：不再用 `if (waiting)` 门——内存标志可能与 DOM 视觉态失同步（标志 false 但 DOM 仍 ov-on/ov-dimmed）。 */
export function forceClearWaiting() {
    waiting = false;
    const w = q('#ov-waiting');
    if (w) { w.classList.remove('ov-on'); w.hidden = true; }
    const panel = q('#ov-panel');
    if (panel) panel.classList.remove('ov-dimmed');
}

/** 用户主动中止且删除本轮消息时，只清实时楼层，不重建到可能尚未删除的半成品。 */
export function abortLive() {
    cancelStreamFrame();
    liveStreamActive = false;
    liveViewActive = false;
    liveFullText = '';
    liveThinkingText = '';
    streamedThisGen = false;
    streamMode = 'unknown';
    stopStreamTypewriter();
    forceClearWaiting();
    hideThinking();
}

/** 停止生成后回到发送前的上一楼层。latestReplyKept=true 时跳过刚保留的截断 AI 楼。 */
export function returnAfterStoppedReply(latestReplyKept) {
    parseCache.clear();
    rebuild(false, 'last');
    if (!latestReplyKept || floors.length < 2) return;
    const floorIdx = floors.length - 2;
    pos = { floorIdx, fragIdx: lastFragIdx(floorIdx) };
    renderCurrent(false);
}

function exitWaiting() {
    waiting = false;
    const w = q('#ov-waiting');
    if (w) { w.classList.remove('ov-on'); setTimeout(() => { if (!waiting) w.hidden = true; }, 250); }
    const panel = q('#ov-panel');
    if (panel) panel.classList.remove('ov-dimmed');
    // 不在这里 hideThinking：推理阶段也靠 exitWaiting 退等待，隐藏会把思维链抹掉。
    // 思维链只在 finalize / 定稿重建时收起。
}

function renderLiveFragment(lastFrag, parsed) {
    const isPlain = !!parsed.plain || lastFrag.kind === 'plain';
    streamIsPlain = isPlain;
    const root = getRoot();
    if (root) root.dataset.plain = isPlain ? 'true' : 'false';
    if (isPlain) {
        renderBg(undefined); clearSprites(); hideCg(); setSpeaker(''); renderItems([]);
    } else {
        renderBg(lastFrag.scene);
        clearSprites();
        if (lastFrag.kind === 'say') renderSprite(lastFrag);
        if (lastFrag.kind === 'video') renderVideo(lastFrag);
        else if (lastFrag.kind === 'cg') renderCg(lastFrag);
        else hideCg();
        setSpeaker(lastFrag.kind === 'say' ? (lastFrag.speaker || '') : '');
        renderItems(lastFrag.items || []);
    }
    const el = q('#ov-panel-text');
    if (!el) return;
    renderedTextKey = '';
    // 流式期间若已能检出 regex HTML 块（选项按钮等）→ 立即交 iframe 内联渲染，按钮可点；
    //   绝不走逐字打字机（会把 HTML 当纯文本切片、按钮点不到、定稿后再重建会闪一下）。
    const html = formatFragLive(lastFrag);
    // 标题只在 </cg> 收尾、PAIR_RE 匹配成片段之后才出得来，流式中途没有属于正常表现。
    const titleHtml = cgTitleHtml(lastFrag);
    const detected = detectHtmlFromFormatted(html);
    if (detected) {
        stopStreamTypewriter();
        renderProseWithHtml(el, titleHtml + detected.prose, detected.html);
        return;
    }
    clearHtmlFrame(el);
    // 流式文本已经是 ST 的累积全文，直接替换，避免逐字追赶游标重置造成闪回。
    stopStreamTypewriter();
    el.innerHTML = titleHtml + html;
}

/** 流式累积全文 → 解析最新楼层、揭示最后片段（追看最新 beat）。
 *  出字速度：若开「打字机」，正文按 typewriterSpeed 逐字追赶（网络给多少字，打字机以设定速度慢慢追），
 *  这样「生成时的出字速度」由设置控制，而非网络速度；关打字机则来多少显多少（瞬显）。 */
let streamRaf = 0;
let streamPendingText = '';
function cancelStreamFrame() {
    if (streamRaf) cancelAnimationFrame(streamRaf);
    streamRaf = 0;
    streamPendingText = '';
}

function leaveLiveView() {
    liveViewActive = false;
    forceClearWaiting();
    renderCurrent(false);
}

function resumeLiveView() {
    const text = liveFullText;
    const thinking = liveThinkingText;
    enterWaiting();
    liveFullText = text;
    liveThinkingText = thinking;
    if (text) onStream(text);
    else { updateJumpbar(); updateFloorMeta(); }
}

function hasVisibleStreamText(text) {
    return String(text || '')
        .replace(/^\s*<story\b[^>]*>/i, '')
        .replace(/^\s*(?:<!--\s*OV:VN\s*-->|<ov-vn\s*\/?>|\[OV:VN\]|\[VN\])/i, '')
        .replace(/<[^>]*>/g, '')
        .trim().length > 0;
}

export function onStream(fullText) {
    const startsSession = !liveStreamActive;
    liveStreamActive = true;
    if (startsSession) {
        liveViewActive = true;
        updateJumpbar();
        updateFloorMeta();
    }
    streamedThisGen = true;
    streamPendingText = String(fullText ?? '');
    liveFullText = streamPendingText;
    if (!liveViewActive) return;
    if (waiting) exitWaiting();
    // throttle 到 rAF，但总是渲染最新一批 token，不能丢掉 rAF 期间来的流式内容。
    if (streamRaf) return;
    streamRaf = requestAnimationFrame(() => {
        streamRaf = 0;
        const split = splitThinking(streamPendingText);
        if (split.thinking) liveThinkingText = split.thinking;
        renderThinking(liveThinkingText);
        if (!isVnStageMessage(split.text)) {
            streamMode = 'plain';
            forceClearWaiting();
            const raw = split.text.trim();
            // 仅思维链、尚无正文：只更新 thinking bar，不碰正文
            if (raw && hasVisibleStreamText(raw)) {
                hideThinking();
                renderLiveFragment({ kind: 'plain', raw, scene: undefined, items: [], audio: [] }, { plain: true });
            }
            return;
        }
        streamMode = 'vn';
        const parsed = parseStageMessage(split.text, { live: true });
        if (!parsed.fragments.length) return;
        // 流式期间显示「最新一条文字片段」，不是图片/道具等非文字尾片段。
        const lastFrag = latestRenderableFragment(parsed);
        if (!lastFrag || !hasVisibleStreamText(lastFrag.raw)) return;
        // 正文开始时收起思维链，避免正文与已结束的推理同时占屏。
        hideThinking();
        renderLiveFragment(lastFrag, parsed);
    });
}

// —— 流式打字机：网络累积全文进来，正文以 typewriterSpeed 逐字「追赶」到目标长度 ——
//   目标每轮更新为最新累积文本的纯文本；游标以设定速度前进，追上后等待新内容。
let streamTypeTimer = null; // requestAnimationFrame id
let streamTypeEl = null;     // 当前流式正文容器
let streamTargetText = '';   // 目标纯文本（最新累积）
let streamShown = 0;         // 已显示字符数
let streamLastHtml = '';     // 最新一版 HTML（定稿/追平后可用）
let streamFinalizePending = false; // 生成已结束，但正文还在按打字机速度追赶
let streamIsPlain = true;    // 本次流式是普通正文还是 VN（决定用哪根速度滑条）
function feedStreamTypewriter(el, html) {
    streamLastHtml = html;
    streamTypeEl = el;
    const full = (() => {
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        return tmp.textContent || '';
    })();
    // 若新目标比已显示还短（换片段/重解析），重置游标从头来
    if (!full.startsWith(streamTargetText.slice(0, streamShown))) streamShown = 0;
    streamTargetText = full;
    if (!streamTypeTimer) stepStreamTypewriter();
}
function stepStreamTypewriter() {
    let acc = 0;
    let last = performance.now();
    if (streamTypeEl) streamTypeEl.classList.add('ov-typing');
    const tick = (now) => {
        acc += now - last;
        last = now;
        // 速度每帧读取：流式中途 plain→vn 翻转（VN 标记后到）也能立即换到对应滑条
        const speed = typewriterDelay(!streamIsPlain);
        if (streamShown < streamTargetText.length) {
            const step = Math.floor(acc / speed);
            if (step < 1) { streamTypeTimer = requestAnimationFrame(tick); return; }
            acc -= step * speed;
            streamShown = Math.min(streamTargetText.length, streamShown + step);
            if (streamTypeEl) {
                // 追平前用 HTML 切片（段落/引号色实时）；追平后写完整 HTML
                if (streamShown >= streamTargetText.length) {
                    streamTypeEl.innerHTML = streamLastHtml;
                } else {
                    streamTypeEl.innerHTML = sliceHtmlByChars(streamLastHtml, streamShown);
                }
            }
            streamTypeTimer = requestAnimationFrame(tick);
        } else {
            streamTypeTimer = null;
            if (streamTypeEl) {
                streamTypeEl.innerHTML = streamLastHtml;
                streamTypeEl.classList.remove('ov-typing');
            }
            if (streamFinalizePending) {
                streamFinalizePending = false;
                stopStreamTypewriter();
                rebuild(false, 'last', { preserveScroll: true });
            }
        }
    };
    streamTypeTimer = requestAnimationFrame(tick);
}
function stopStreamTypewriter() {
    if (streamTypeTimer) { cancelAnimationFrame(streamTypeTimer); streamTypeTimer = null; }
    streamTypeEl = null; streamTargetText = ''; streamShown = 0; streamLastHtml = ''; streamPendingText = ''; streamFinalizePending = false;
    const el = q('#ov-panel-text');
    if (el) el.classList.remove('ov-typing');
}

/** 流式正文格式化（始终走 messageFormatting，受渲染 HTML 开关）。流式为合成楼层，无真实 chatIndex。 */
function formatFragLive(frag) {
    return formatFrag(frag, -1);
}

/** 生成结束/消息定稿：缓存失效→重建模型→定位最新。
 *  流式已逐字看到末片段 → 停在末片段瞬显、绝不重播打字机；
 *  非流式（全程无 token，如某些后端）→ 从首片段读起，仅当本楼「首片段且短」时播一次打字机入场。
 *  关键：animate 只在「本轮确实流式过」之外、且当前片段是最新楼首片段（全新回复刚定稿）时才为 true，
 *        回看历史 / 已流式过 / 跳到末片段 一律瞬显，根除「定稿后旧/新回复被打字机重播」。 */
export function finalize() {
    cancelStreamFrame();
    const wasFollowingLive = liveViewActive;
    liveStreamActive = false;
    liveViewActive = false;
    liveFullText = '';
    liveThinkingText = '';
    stopTypewriter();
    exitWaiting();
    hideThinking(); // 生成完收起思维链，再切正文
    parseCache.clear(); // 末楼内容已变，简单起见全清（量小）
    const wasStreamed = streamedThisGen;
    const mode = streamMode;
    streamMode = 'unknown';
    streamedThisGen = false;
    if (!wasFollowingLive) {
        stopStreamTypewriter();
        rebuild(false, 'preserve');
        return;
    }
    // 普通正文流式时，让 stream typewriter 按设置速度把剩余目标吐完；不要定稿瞬间重建成全文。
    if (wasStreamed && mode === 'plain' && streamTypeTimer) { streamFinalizePending = true; return; }
    stopStreamTypewriter();
    // 普通正文流式已逐字揭示 → 停在末片段；VN 新楼定稿后回到首片段，从头阅读。
    const animate = !wasStreamed;
    const landing = wasStreamed && mode !== 'vn' ? 'last' : 'first';
    rebuild(animate, landing, { preserveScroll: wasStreamed });
}

/** 某条消息被编辑/swipe：失效该条缓存并重建 */
export function refreshIndex(index) {
    parseCache.delete(Number(index));
    rebuild(false, 'preserve');
}

/** 跳到最新楼层最后片段（打开 overlay 时用）。最新一条正文按「打字速度」逐字揭示（用户要的效果）；
 *  但超长正文（>600 字）瞬显，避免重开界面时对着一大段历史正文逐字重播几分钟。 */
export function jumpToLatest() {
    if (!floors.length) { rebuild(); return; }
    pos = { floorIdx: floors.length - 1, fragIdx: lastFragIdx(floors.length - 1) };
    const frag = currentFragment();
    const short = frag && typeof frag.raw === 'string' && frag.raw.length <= 600;
    renderCurrent(!!short);
}

/**
 * 测试预览：把任意文本当作一个「合成楼层」追加到模型末尾并跳过去渲染，
 * 不触碰 ST 的 chat（纯本地预览，供「测试」标签页）。下次真实 rebuild 会覆盖掉它。
 * @param {string} mes 含舞台标签的文本
 */
export function loadTestMessage(mes) {
    floors = floors.filter((f) => !f.synthetic);
    clearTestHud();  // 先清上一轮测试的组件：新文本若删掉了某个 id，旧节点不该留在状态条里
    const parsed = parseStageMessage(String(mes ?? ''));
    if (!parsed.fragments.length) return;
    // 停掉上一轮测试的音频。新文本里最后一条 <bgm> 若和正在放的是同一首就留着，
    // 免得在测试面板里改一个字就把曲子从头切一刀。
    let nextBgm = '';
    for (const f of parsed.fragments) {
        for (const a of (f.audio || [])) if (a.kind === 'bgm' && a.src) nextBgm = a.src;
    }
    stopTestAudio(nextBgm);
    // scene 结转：继承当前末楼最后 scene
    let sceneCarry;
    for (let i = floors.length - 1; i >= 0 && !sceneCarry; i--) {
        const fr = floors[i].fragments;
        for (let j = fr.length - 1; j >= 0; j--) { if (fr[j].scene && fr[j].scene.bg) { sceneCarry = fr[j].scene; break; } }
    }
    for (const f of parsed.fragments) {
        if (f.scene && f.scene.bg) sceneCarry = f.scene;
        else if (!f.scene) f.scene = sceneCarry;
    }
    floors.push({ chatIndex: -1, fragments: parsed.fragments, items: parsed.items, synthetic: true, plain: !!parsed.plain });
    // HUD 指令也应用（喂状态条）
    try { applyTestHud(parsed.hudOps); } catch (_) {}
    try { setItems(floors.flatMap((f) => f.items || [])); } catch (_) {}
    pos = { floorIdx: floors.length - 1, fragIdx: 0 };
    renderCurrent(true);
}

/** 离开测试预览：丢弃合成楼层并从真实聊天重建，定位最新。
 *  供 ui.js 在关抽屉 / 切离测试 Tab 时调用，确保「回到正文」必走真实重建，
 *  不残留 synthetic 楼层 / inline-HTML / 滚动态。无 synthetic 时为 no-op。 */
export function exitTestPreview() {
    if (!floors.some((f) => f.synthetic)) return;
    floors = floors.filter((f) => !f.synthetic);
    clearTestResidue();
    rebuild(false, 'last');
}

// 延迟 import 避免循环：测试 HUD 应用走 parser。
// 缓存整个模块而不只是 applyAll——clearTestHud 要在同步的 renderCurrent 里调，
// 不能等 await。没缓存就意味着 applyTestHud 从没跑过，也就不可能有 test 组件，
// 这时直接 no-op 是对的。
let _parser = null;
async function applyTestHud(hudOps) {
    if (!hudOps || !hudOps.length) return;
    if (!_parser) _parser = await import('./parser.js');
    _parser.applyAll(hudOps, 'test');
}

/** 摘掉测试预览灌进 HUD 的组件（按 origin 定点清，不碰真实消息的状态条）。 */
function clearTestHud() {
    if (!_parser) return;
    try { _parser.clearByOrigin('test'); } catch (_) {}
}
