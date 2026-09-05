// bridge.js — ST 桥（前身 chat-mirror.js，瘦身为「只做桥」）
// 职责：把 ST 的聊天事件接到阅读器；把自有输入框代理回 ST 真实发送机制。
//   读：ctx.chat[] 由 reader 解析；本模块不渲染，只转发事件。
//   事件：USER/CHARACTER_MESSAGE_RENDERED、MESSAGE_UPDATED/EDITED/SWIPED/DELETED、
//        CHAT_CHANGED、STREAM_TOKEN_RECEIVED、GENERATION_STARTED/ENDED/STOPPED。
//   发送：写真实 #send_textarea，派发 input，点 #send_but；停止点 #mes_stop。
//   空窗期：发送/GENERATION_STARTED → reader.enterWaiting()；首 token 由 reader 解除。
//
// 设计原则：只读 ST、只代理操作 ST 公开控件；绝不改 ST 原 DOM 结构。

import { updateMessageBlock } from '../../../../script.js';
import { q, insertIntoComposer, show as showOverlay, isVisible } from './overlay.js';
import {
    initReader, rebuild, finalize, refreshIndex, onStream, enterWaiting,
    forceClearWaiting, abortLive, hasLiveGeneration, hasFloorForChatIndex, returnAfterStoppedReply,
    refreshReplyEcho,
} from './reader.js';
import { isVnStageMessage, splitThinking } from './stage-parser.js';
import { mergeStreamText } from './stream-merge.js';
import { getSetting, setSetting } from './settings.js';

// 真实 ST 控件选择器（已核实 index.html）
const ST_TEXTAREA = '#send_textarea';
const ST_SEND_BTN = '#send_but';
const ST_STOP_BTN = '#mes_stop';
const STOP_SETTLE_FALLBACK_MS = 10_000;

let ctxRef = null;
let streaming = false;
let lastOverlaySend = null;   // { text, beforeLen, userIndex }
let suppressDeleteRebuilds = 0;
let pendingStop = null;       // 点击停止瞬间锁定的本轮 user/AI 与正文快照
let pendingStopTimer = null;
let generationSeenVn = false;
let autoShowFiredThisGen = false; // 本轮新回复 autoShow 只触发一次
let streamBuffer = '';
let streamPollText = '';
let streamReasoningBaseline = '';
let receivedStreamToken = false;
let streamBaseline = { index: -1, text: '' };
let stopButtonObserver = null;

function getCtx() {
    try {
        return (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
    } catch (_) { return null; }
}

// —— 输入代理 ——

/** 把文本发给 ST：写真实 textarea，派发 input，再点发送 */
function proxySend(text) {
    const ta = document.querySelector(ST_TEXTAREA);
    const btn = document.querySelector(ST_SEND_BTN);
    if (!ta || !btn || btn.disabled) {
        console.warn('[overlay] 未找到可用的 ST 输入框/发送按钮，无法代理发送。');
        return false;
    }
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
    return true;
}

function proxyStop() {
    const stop = document.querySelector(ST_STOP_BTN);
    if (stop) stop.click();
}

function resolveUserIndex() {
    const c = ctxRef || getCtx();
    const send = lastOverlaySend;
    if (!c || !Array.isArray(c.chat) || !send) return -1;
    if (Number.isInteger(send.userIndex) && c.chat[send.userIndex]?.is_user) return send.userIndex;
    const start = Math.max(0, Number(send.beforeLen) || 0);
    for (let i = c.chat.length - 1; i >= start; i--) {
        const m = c.chat[i];
        if (m && m.is_user && String(m.mes || '').trim() === String(send.text || '').trim()) {
            send.userIndex = i;
            return i;
        }
    }
    return -1;
}

function resolveAssistantIndex(userIndex, hintedIndex = -1) {
    const c = ctxRef || getCtx();
    if (!c || !Array.isArray(c.chat)) return -1;
    const liveIndex = Number(getCtx()?.streamingProcessor?.messageId);
    for (const index of [Number(hintedIndex), liveIndex]) {
        if (Number.isInteger(index) && index > userIndex && c.chat[index] && !c.chat[index].is_user) return index;
    }
    for (let i = c.chat.length - 1; i > userIndex; i--) {
        const m = c.chat[i];
        if (m && !m.is_user && !m.is_system) return i;
    }
    return -1;
}

function hasVisibleStoppedContent(text) {
    let body = splitThinking(String(text || '')).text;
    body = body
        .replace(/^\s*(?:<!--\s*OV:VN\s*-->|<ov-vn\s*\/?>|\[OV:VN\]|\[VN\])\s*/i, '')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .trim();
    return body !== '' && body !== '...';
}

async function deleteOverlayMessage(index, { rebuildAfter = true } = {}) {
    const c = ctxRef || getCtx();
    if (!c || !Array.isArray(c.chat) || index < 0 || index >= c.chat.length) return true;
    if (typeof c.deleteMessage === 'function') {
        const target = c.chat[index];
        const beforeLen = c.chat.length;
        if (!rebuildAfter) suppressDeleteRebuilds++;
        await c.deleteMessage(index, undefined, false);
        // ST 在该楼层尚无 DOM 时会直接返回；此时仍要删掉 chat 中的空楼层。
        if (c.chat.length === beforeLen && c.chat[index] === target) {
            if (!rebuildAfter) suppressDeleteRebuilds = Math.max(0, suppressDeleteRebuilds - 1);
            c.chat.splice(index, 1);
            if (typeof c.saveChat === 'function') await c.saveChat();
        }
    } else {
        c.chat.splice(index, 1);
        if (typeof c.saveChat === 'function') await c.saveChat();
        const et = c.event_types || c.eventTypes;
        if (c.eventSource && et?.MESSAGE_DELETED) {
            if (!rebuildAfter) suppressDeleteRebuilds++;
            await c.eventSource.emit(et.MESSAGE_DELETED, c.chat.length);
        }
    }
    if (rebuildAfter) rebuild();
    return true;
}

function capturePendingStop() {
    const c = ctxRef || getCtx();
    const userIndex = resolveUserIndex();
    if (!c || !Array.isArray(c.chat) || userIndex < 0) return null;
    const aiIndex = resolveAssistantIndex(userIndex);
    const aiText = aiIndex >= 0
        ? (streamBuffer || stripStreamBaseline(String(c.chat[aiIndex]?.mes || ''), aiIndex))
        : streamBuffer;
    return {
        userIndex,
        aiIndex,
        aiText: String(aiText || ''),
        userText: String(lastOverlaySend?.text || c.chat[userIndex]?.mes || ''),
        keep: hasVisibleStoppedContent(aiText),
        settled: false,
    };
}

function restoreStoppedComposer(text) {
    const input = q('#ov-input');
    if (!input) return;
    input.value = String(text || '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
}

async function settlePendingStop(hintedAiIndex = -1) {
    const stop = pendingStop;
    if (!stop || stop.settled) return;
    stop.settled = true;
    if (pendingStopTimer) clearTimeout(pendingStopTimer);
    pendingStopTimer = null;

    try {
        const c = ctxRef || getCtx();
        const aiIndex = resolveAssistantIndex(stop.userIndex, hintedAiIndex >= 0 ? hintedAiIndex : stop.aiIndex);
        endGeneration();

        if (stop.keep) {
            const msg = c?.chat?.[aiIndex];
            if (msg && !msg.is_user) {
                msg.mes = stop.aiText;
                const swipeId = Number(msg.swipe_id);
                if (Array.isArray(msg.swipes) && Number.isInteger(swipeId) && swipeId >= 0) {
                    msg.swipes[swipeId] = stop.aiText;
                }
                updateMessageBlock(aiIndex, msg);
                if (typeof c.saveChat === 'function') await c.saveChat();
            }
            abortLive();
            lastOverlaySend = null;
            returnAfterStoppedReply(true);
            restoreStoppedComposer(stop.userText);
            return;
        }

        abortLive();
        if (aiIndex >= 0) await deleteOverlayMessage(aiIndex, { rebuildAfter: false });
        if (c?.chat?.[stop.userIndex]?.is_user) {
            await deleteOverlayMessage(stop.userIndex, { rebuildAfter: false });
        }
        lastOverlaySend = null;
        returnAfterStoppedReply(false);
        restoreStoppedComposer(stop.userText);
    } finally {
        if (pendingStop === stop) pendingStop = null;
    }
}

function schedulePendingStopSettlement(delay = STOP_SETTLE_FALLBACK_MS, hintedAiIndex = -1) {
    if (!pendingStop) return;
    if (pendingStopTimer) clearTimeout(pendingStopTimer);
    pendingStopTimer = setTimeout(() => {
        pendingStopTimer = null;
        settlePendingStop(hintedAiIndex).catch((error) => console.error('[overlay] 中止回复收尾失败：', error));
    }, delay);
}

function stopWithPolicy() {
    if (pendingStop) return;
    pendingStop = capturePendingStop();
    proxyStop();
}

function recordSentUserIndex(arg) {
    if (!lastOverlaySend) return;
    const c = ctxRef || getCtx();
    if (!c || !Array.isArray(c.chat)) return;
    const n = Number(arg);
    if (Number.isInteger(n) && c.chat[n]?.is_user) { lastOverlaySend.userIndex = n; return; }
    resolveUserIndex();
}

function textFromPayload(payload) {
    if (payload == null) return '';
    if (typeof payload === 'string') return payload;
    if (typeof payload === 'object') {
        return String(payload.text ?? payload.token ?? payload.mes ?? payload.message ?? payload.content ?? '');
    }
    return String(payload);
}

function latestAssistantText() {
    const c = ctxRef || getCtx();
    let chatIndex = -1;
    let chatText = '';
    if (c && Array.isArray(c.chat)) {
        for (let i = c.chat.length - 1; i >= 0; i--) {
            const m = c.chat[i];
            if (m && !m.is_user && !m.is_system) { chatIndex = i; chatText = String(m.mes || ''); break; }
        }
    }
    return { index: chatIndex, text: chatText };
}

function stripStreamBaseline(text, index = streamBaseline.index) {
    let out = String(text || '');
    if (index === streamBaseline.index && streamBaseline.text && out.startsWith(streamBaseline.text)) {
        out = out.slice(streamBaseline.text.length).trimStart();
    }
    return out;
}

function currentStreamText() {
    const cur = latestAssistantText();
    return stripStreamBaseline(cur.text, cur.index);
}

function currentReasoning() {
    // getContext() is fresh; ctxRef captured at init has a stale streamingProcessor.
    const live = getCtx();
    const r0 = live?.streamingProcessor?.reasoningHandler?.reasoning || '';
    if (streaming) {
        // 生成期间只接受本轮 streamingProcessor 的 reasoning，禁止回退到旧 chat/DOM。
        const liveReasoning = String(r0 || '');
        return liveReasoning && liveReasoning !== streamReasoningBaseline ? liveReasoning : '';
    }
    if (r0) return String(r0);
    const c = live || ctxRef;
    if (!c || !Array.isArray(c.chat)) return '';
    for (let i = c.chat.length - 1; i >= 0; i--) {
        const m = c.chat[i];
        if (!m || m.is_user) continue;
        const r = m.extra?.reasoning || m.extra?.reasoning_display_text || '';
        if (r) return String(r);
    }
    const el = document.querySelector('#chat .mes:last-child .mes_reasoning');
    return el?.textContent?.trim() || '';
}

function withReasoning(text) {
    if (/<think\b/i.test(String(text || ''))) return text;
    const r = currentReasoning();
    return r ? `<think>${r}</think>\n${text}` : text;
}

function ensureStreamBaseline() {
    if (streamBaseline.index < 0 && !streamBaseline.text) {
        // 不要把当前半成品 mes 当 baseline 前缀：
        // 否则 strip 会把累积全文切成碎片，mergeStreamText 再拼回去时容易重复刷屏。
        // 新楼 baseline 前缀为空；swipe/续写由 markGenerating 在 GENERATION_STARTED 写好。
        const c = ctxRef || getCtx();
        const last = c && Array.isArray(c.chat) ? c.chat[c.chat.length - 1] : null;
        streamBaseline = last && !last.is_user && !last.is_system
            ? { index: c.chat.length - 1, text: '' }
            : { index: -1, text: '' };
    }
}

// 会改写「已定稿末楼」的正常轮次：轮询给它们开实时楼是对的（见 pollStreamingMessage 的守卫）。
const REWRITE_TAIL_GEN_TYPES = new Set(['swipe', 'regenerate', 'continue']);
// GENERATION_STARTED 之后由 markGenerating 记下的本轮类型；endGeneration 清空。
let genTypeThisRound = '';

/** GENERATION_STARTED 处理器。ST 的事件签名是 (type, options, dryRun)。
 *  必须挑轮次：这个事件对「每一次 Generate」都发，不只是产出可见回复的那一次——
 *  只为算 token 的 dryRun、impersonate、以及插件在后台取词的轮次都会走到这里。
 *  放它们进来把 streaming 置回 true、把 watchdog 重新开起来，watchdog 的 pollStreamingMessage
 *  就会把「已经定稿的末楼正文」当成流式输出重新喂给 onStream，onStream 见 liveStreamActive
 *  是 false 便当作新一轮开场，凭空复活一个实时楼 = 末楼重复（真楼有图、实时楼没图）、
 *  底部 <opt> 消失、左上角停在「生成中」。若那种后台轮次不显示 ST 的停止按钮，
 *  watchdog 的 `_genWatchdogSawGenerating` 还等不到 true→false，就再也不会自己收场。
 *
 *  故用白名单而非黑名单：认不出的 type 一律不跟播，宁可少一次实时预览，也不让它开场。
 *  被跳过的轮次若真渲染出了角色消息，由 CHARACTER_MESSAGE_RENDERED 里的兜底补 rebuild，
 *  不会丢楼（代价：那一轮没有流式预览，例如 ask_command）。
 *  注：具体是哪个生图/生视频插件、用的哪种 type，未在本机实测确认；
 *      真正兜住这个 bug 的是 pollStreamingMessage 里那道「末楼已定稿就不许开场」的守卫。 */
function markGenerating(type, _options, dryRun) {
    if (dryRun) return;
    if (typeof type === 'string' && !REWRITE_TAIL_GEN_TYPES.has(type) && type !== 'normal') return;
    genTypeThisRound = typeof type === 'string' ? type : '';
    // 在切换 streaming 前记录旧 reasoning，避免把上一轮内容当作本轮首 token。
    streamReasoningBaseline = currentReasoning();
    // 用「发送前 chat 长度」作基线：流式期间只把长度超过该基线的 AI 楼层正文当新生成，
    // 绝不把上一段 AI 回复重新当流式喂给 reader（根除「发送后旧回复被打字机重播」）。
    const c = ctxRef || getCtx();
    const baselineLen = c && Array.isArray(c.chat) ? c.chat.length : 0;
    const last = c && Array.isArray(c.chat) ? c.chat[baselineLen - 1] : null;
    streaming = true;
    generationSeenVn = false;
    autoShowFiredThisGen = false;
    streamBuffer = '';
    streamPollText = '';
    receivedStreamToken = false;
    pollStreamingMessage._lastLive = '';
    streamBaseline = last && !last.is_user && !last.is_system
        ? { index: baselineLen - 1, text: String(last.mes || '') }
        : { index: -1, text: '' };
    // 新一轮生成：立刻藏掉上一轮思维链（否则会误显旧 think 直到新 token 到达）
    try {
        const bar = q('#ov-thinking');
        if (bar) bar.hidden = true;
    } catch (_) {}

    startGenWatchdog();
}

function markSending() {
    markGenerating();
    enterWaiting();
}

/** 统一的生成结束复位：ST 停显 #mes_stop 却漏发 END/STOP 时由 watchdog 调用，绝不永久卡「生成中」。 */
function endGeneration() {
    const wasGenerating = streaming;
    streaming = false;
    genTypeThisRound = '';
    generationSeenVn = false;
    autoShowFiredThisGen = false;
    streamBuffer = '';
    streamPollText = '';
    streamReasoningBaseline = '';
    receivedStreamToken = false;
    streamBaseline = { index: -1, text: '' };
    toggleStopBtn(false);
    stopGenWatchdog();
    forceClearWaiting();
    return wasGenerating;
}

function finishGeneration() {
    // 停止时由 settlePendingStop 使用点击瞬间的快照收尾，不能先把迟到正文定稿。
    const shouldFinalize = endGeneration() || hasLiveGeneration();
    if (pendingStop) {
        schedulePendingStopSettlement();
        return;
    }
    if (shouldFinalize) finalize();
    lastOverlaySend = null;
}

let _genWatchdog = null;
let _genWatchdogSawGenerating = false;
function emitStreamText(text) {
    const liveText = withReasoning(text);
    const split = splitThinking(liveText);
    const isVn = isVnStageMessage(split.text);
    // 仅新回复首次识别到 VN 时自动打开一次（用户关掉后本轮不再弹）
    if (isVn && getSetting('autoShow') && !autoShowFiredThisGen && !isVisible()) {
        autoShowFiredThisGen = true;
        showOverlay();
    } else if (isVn) {
        autoShowFiredThisGen = true; // 已打开或已弹过，本轮不再触发
    }
    onStream(liveText);
    if (!generationSeenVn) {
        if (isVn || split.thinking) {
            generationSeenVn = true;
        } else {
            forceClearWaiting();
            generationSeenVn = true;
        }
    }
}

function pollStreamingMessage() {
    // 只在本轮生成真的在进行时才读 chat 半成品。少了这条，任何让 watchdog 活过
    // streaming=false 的路径都会把「别人改了 chat[].mes」当成流式输出喂给 onStream，
    // 而 onStream 会把 liveStreamActive 重新置 true、凭空造出一个实时楼。
    // 生图插件回写 <img>/<video> 就是这种「事后改正文」。
    if (!streaming) return;
    const c = ctxRef || getCtx();
    const lastIdx = c && Array.isArray(c.chat) ? c.chat.length - 1 : -1;
    // 轮询只负责「跟播已经开场的这一轮」，不负责开场。
    // 末楼已经作为定稿楼层进过 floors[]、而此刻又没有实时楼在跑 —— 这两条同时成立时，
    // mes 的这次变化只可能是事后改写（生图/生视频插件回写 <img>/<video>），不是新回复。
    // 放它进 emitStreamText → onStream，就会开出一个与末楼重复的实时楼：
    // 真楼有图、复活的实时楼没图，尾部 <opt> 也缺。交给 MESSAGE_UPDATED 走 refreshIndex 才对。
    // 例外是 swipe/regenerate/continue：它们本来就写在已定稿的末楼上，必须放行。
    if (!hasLiveGeneration()
        && !REWRITE_TAIL_GEN_TYPES.has(genTypeThisRound)
        && hasFloorForChatIndex(lastIdx)) return;
    const last = c && Array.isArray(c.chat) ? c.chat[lastIdx] : null;
    // 始终把最新 reasoning 合进去（API 原生思维链不在 mes 里，只在 streamingProcessor / extra）
    const text = last && !last.is_user && !last.is_system
        ? stripStreamBaseline(String(last.mes || ''), lastIdx)
        : '';
    let mesChanged = false;
    if (text && text !== streamPollText) {
        streamPollText = text;
        streamBuffer = mergeStreamText(streamBuffer, text);
        mesChanged = true;
    }
    const live = withReasoning(streamBuffer || text);
    // 无正文也无思维链 → 跳过；mes/reasoning 任一变才 emit
    if (!live) return;
    if (!mesChanged && live === pollStreamingMessage._lastLive) return;
    pollStreamingMessage._lastLive = live;
    emitStreamText(streamBuffer || text);
}

function startGenWatchdog() {
    stopGenWatchdog();
    _genWatchdogSawGenerating = isStGenerating();
    _genWatchdog = setInterval(() => {
        // 收到 ST 的累积 token 后不再混入 chat 半成品，避免正文重复追加。
        if (!receivedStreamToken) pollStreamingMessage();
        // 只把 ST 停止按钮真实经历过「显示→隐藏」当作漏发结束事件。
        // 发送后按钮尚未出现不等于生成结束，不能用固定超时定稿到上一条回复。
        const generatingNow = isStGenerating();
        if (generatingNow) _genWatchdogSawGenerating = true;
        else if (_genWatchdogSawGenerating) finishGeneration();
    }, 250);
}
function stopGenWatchdog() {
    if (_genWatchdog) { clearInterval(_genWatchdog); _genWatchdog = null; }
}

// 生成中到达的消息更新先攒着，空闲后补刷（生图插件回写 <img> 常落在这个窗口里）。
// ponytail: 用 300ms 轮询而不是挂到每条结束路径上——结束路径有 4 条（RENDERED/ENDED/STOPPED/watchdog），
//   轮询只有一处、漏不了；要更即时再改成结束时主动 flush。
const pendingRefreshIndices = new Set();
let pendingRefreshTimer = null;
// ST 已空闲却还挂着实时楼 → 那一楼是本轮结束时没收干净的旧快照。
// 它的正文来自 ST 的流式累积文本，永远不含生图插件事后回写的 <img>/<video>，
// 若快照停在中途还会缺尾部的 <opt>；跟真实末楼并排就是「末楼重复、一楼有图一楼没图、选项消失」。
// 生图回写正是最容易撞上这个窗口的时机，补刷前先把它收掉。
function collapseStaleLiveFloor() {
    if (streaming || isStGenerating()) return;
    if (hasLiveGeneration()) finalize();
}

function refreshIndexWhenIdle(i) {
    const idx = Number(i);
    if (!Number.isInteger(idx)) return;
    if (!streaming && !isStGenerating()) { collapseStaleLiveFloor(); refreshIndex(idx); return; }
    pendingRefreshIndices.add(idx);
    if (pendingRefreshTimer) return;
    pendingRefreshTimer = setInterval(() => {
        if (streaming || isStGenerating()) return;
        clearInterval(pendingRefreshTimer);
        pendingRefreshTimer = null;
        collapseStaleLiveFloor();
        const idxs = [...pendingRefreshIndices];
        pendingRefreshIndices.clear();
        for (const n of idxs) refreshIndex(n);
    }, 300);
}

function runSlash(command) {
    const cmd = String(command || '');
    const sendCmd = /^\/send\s+([\s\S]*?)\|\/trigger\s*$/.test(cmd);
    const c = ctxRef || getCtx();
    if (c && typeof c.executeSlashCommandsWithOptions === 'function') {
        try { c.executeSlashCommandsWithOptions(cmd, {}); if (sendCmd) markSending(); return true; }
        catch (e) { console.warn('[overlay] HTML 选项命令执行失败：', e); }
    }
    const m = cmd.match(/^\/send\s+([\s\S]*?)\|\/trigger\s*$/);
    const ok = m ? proxySend(m[1]) : false;
    if (ok) markSending();
    return ok;
}

function wireHtmlBridge() {
    if (wireHtmlBridge.bound) return;
    wireHtmlBridge.bound = true;
    window.addEventListener('message', (e) => {
        const d = e && e.data || {};
        if (!d || !d.ovSandbox) return;
        if (d.ovSandbox === 'insert') insertIntoComposer(d.value);
        else if (d.ovSandbox === 'command') runSlash(d.value);
    });
}

/** 切换输入区「发送/停止」 */
function toggleStopBtn(showStop) {
    const send = q('#ov-send');
    const stop = q('#ov-stop');
    if (send) send.style.display = showStop ? 'none' : '';
    if (stop) stop.style.display = showStop ? '' : 'none';
}
/** Sandbox 的发送/停止图标只镜像 ST 真实停止按钮，不再猜测生成事件。 */
function wireStopButtonMirror() {
    const stStop = document.querySelector(ST_STOP_BTN);
    if (!stStop || stopButtonObserver) return;
    const sync = () => toggleStopBtn(isStGenerating());
    stopButtonObserver = new MutationObserver(sync);
    stopButtonObserver.observe(stStop, { attributes: true, attributeFilter: ['style', 'class'] });
    sync();
}

// —— 未发送草稿的持久化 ——
// 目标：刷新、关掉浏览器、重启后端，输入框里的字都还在。
// 两处同时写，各补对方的短板：
//   localStorage      —— 每次按键同步落盘，浏览器直接被关/崩溃也不丢；但换浏览器、清站点数据就没了。
//   extension_settings —— 跟着 ST 的防抖存盘进后端 settings.json，跨浏览器跨设备都在；
//                        代价是防抖窗口内（停手前）的最后几秒还没落盘。
// 两份都带时间戳，恢复时取新的那一份。
const DRAFT_LS_KEY = 'st-overlay-composer-draft';

/** 读 localStorage 那份草稿；坏数据一律当没有 */
function readLocalDraft() {
    try {
        const o = JSON.parse(localStorage.getItem(DRAFT_LS_KEY) || 'null');
        if (o && typeof o.text === 'string') return { text: o.text, ts: Number(o.ts) || 0 };
    } catch (_) { /* 存储不可用或 JSON 坏了：退回只用设置那份 */ }
    return null;
}

/** 双写草稿。setSetting 内部是 saveSettingsDebounced，连续输入只会在停手后落一次盘。 */
function writeDraft(text) {
    const ts = Date.now();
    try { localStorage.setItem(DRAFT_LS_KEY, JSON.stringify({ text, ts })); } catch (_) {}
    setSetting('composerDraft', text);
    setSetting('composerDraftAt', ts);
}

/** 取两处里较新的那份草稿文本 */
function loadDraft() {
    const local = readLocalDraft();
    const remoteTs = Number(getSetting('composerDraftAt')) || 0;
    const remoteText = String(getSetting('composerDraft') || '');
    if (!local) return remoteText;
    return local.ts >= remoteTs ? local.text : remoteText;
}

/**
 * 用户消息落地后清掉同一份草稿。
 * 沙盒自己发送时 doSend 已经清过；这一条覆盖的是「在酒馆原生输入框里按发送」——
 * 那条路径不经过 doSend，不清的话下次加载会把已经发出去的话又恢复回输入框。
 * @param {number} i 消息下标
 */
function dropDraftIfSent(i) {
    const c = ctxRef || getCtx();
    const msg = c && Array.isArray(c.chat) ? c.chat[Number(i)] : null;
    if (!msg || !msg.is_user) return;
    const sent = String(msg.mes || '').trim();
    if (!sent || sent !== loadDraft().trim()) return;
    writeDraft('');
    const input = q('#ov-input');
    if (input && input.value.trim() === sent) input.value = '';
}

/** 接线自有输入框 + 与 ST #send_textarea 双向同步 */
function wireComposer() {
    const input = q('#ov-input');
    const send = q('#ov-send');
    const stop = q('#ov-stop');
    if (!input) return;

    const autosize = () => {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    };
    input.addEventListener('input', autosize);
    // 每敲一下就落盘。insertIntoComposer（点道具/选项插入文本）也会派发 input，一并覆盖。
    input.addEventListener('input', () => writeDraft(input.value));

    // —— 按需同步：输入框平时独立，发送/打开 Sandbox 时才同步 ——
    let syncing = false;
    let draftRestored = false;   // 刚从存储恢复、还没和 ST 的输入框对过账
    const stTa = () => document.querySelector(ST_TEXTAREA);
    const pushToSt = () => {
        const ta = stTa();
        if (!ta || syncing || ta.value === input.value) return;
        syncing = true;
        ta.value = input.value;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        syncing = false;
    };
    const pullFromSt = () => {
        const ta = stTa();
        if (!ta || syncing || input.value === ta.value) return;
        // 刚恢复完草稿的第一次拉取要挡掉：页面刚加载时 ST 的输入框必然是空的，
        // 照拉不误会把草稿瞬间冲没。反过来把草稿推给 ST，两边对齐。
        // 只挡这一次——之后 ST 那边变空是真的被清空（用户在酒馆原生输入框发了消息），该拉就拉。
        if (draftRestored && !ta.value && input.value) { draftRestored = false; pushToSt(); return; }
        draftRestored = false;
        syncing = true;
        input.value = ta.value;
        autosize();
        syncing = false;
        // 用户在酒馆原生输入框里写的字，进了沙盒就同样算草稿，一起持久化
        writeDraft(input.value);
    };
    // 打开/切换 Sandbox 时由 refreshOnOpen() 调用；不再监听 ST 输入或轮询。
    wireComposer._syncFromSt = pullFromSt;
    // 关闭 Sandbox 时写回 ST；输入过程中保持独立，避免双向同步拖慢删除/改字。
    wireComposer._syncToSt = pushToSt;

    // —— 恢复上次没发出去的草稿 ——
    // 必须早于任何 pullFromSt。同时写回 ST 的输入框（仅当那边是空的，不覆盖 ST 已有内容），
    // 这样两边一开始就一致，后续同步不会互相冲掉。
    const saved = loadDraft();
    if (saved && !input.value) {
        input.value = saved;
        autosize();
        draftRestored = true;
        const ta = stTa();
        if (ta && !ta.value) {
            ta.value = saved;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            draftRestored = false;   // 已经对齐，不需要后面那道保护
        }
    }

    const doSend = async () => {
        const text = input.value.trim();
        if (!text) return;
        const c = ctxRef || getCtx();
        const nextSend = { text, beforeLen: Array.isArray(c?.chat) ? c.chat.length : 0, userIndex: null };
        // 先登记本次 user 文本，再触发 ST 的异步发送处理。
        lastOverlaySend = nextSend;
        if (proxySend(text)) {
            input.value = '';
            autosize();
            // 发出去了才清草稿；proxySend 失败时原文留在框里，草稿也跟着留着
            writeDraft('');
            markSending();
        } else {
            lastOverlaySend = null;
        }
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    if (send) send.addEventListener('click', doSend);
    if (stop) stop.addEventListener('click', stopWithPolicy);
}

/** 启动桥：绑 ST 事件，接线输入框。需在 context 就绪后调用。 */
export function initBridge(ctx) {
    ctxRef = ctx || getCtx();
    wireComposer();
    wireStopButtonMirror();
    wireHtmlBridge();
    initReader(ctxRef);

    if (!ctxRef) { console.warn('[overlay] 桥：无 context，跳过事件绑定。'); return; }
    const es = ctxRef.eventSource;
    const et = ctxRef.event_types || ctxRef.eventTypes;
    if (!es || !et) { console.warn('[overlay] 桥：无事件源。'); return; }

    es.on(et.USER_MESSAGE_RENDERED, (i) => {
        recordSentUserIndex(i);
        dropDraftIfSent(i);
        // 用户消息此刻才真正进 chat：把顶部回显重取一次，否则整轮生成都顶着上上条输入。
        refreshReplyEcho();
    });
    es.on(et.CHARACTER_MESSAGE_RENDERED, (i) => {
        if (pendingStop) {
            // ST 在此事件返回后仍会继续访问刚完成的消息；下一轮任务再删，避免删早导致核心收尾报错。
            schedulePendingStopSettlement(0, Number(i));
            return;
        }
        // 兜底：markGenerating 判定本轮不产出可见回复（quiet/impersonate/dryRun）而没有跟进，
        // 但它真的渲染出了一条角色消息。此时 streaming 与实时楼都是 false，
        // finishGeneration 里的 shouldFinalize 也是假、不会重建，这条就永远补不进 floors[]。
        // 先照常让 finishGeneration 做它那份复位，再补一次 rebuild 把消息收进来。
        const untracked = !streaming && !hasLiveGeneration();
        finishGeneration();
        if (untracked) refreshIndexWhenIdle(i);
    });
    // 流式期间 ST 会频繁 MESSAGE_UPDATED：若此时 rebuild 半成品，会把同一条复制进正文/泄漏思维链。
    // 但不能直接丢弃——生图插件是在正文定稿「之后」才把 <img>/<video> 写进 mes 并发这一条更新，
    // 若那一刻 ST 恰好还显示着停止按钮，事件被丢掉就再也没有重建时机 = 沙盒不显示最新生成的图。
    // 故：生成中先攒下来，等真正空闲再补刷。
    es.on(et.MESSAGE_UPDATED, refreshIndexWhenIdle);
    es.on(et.MESSAGE_EDITED, refreshIndexWhenIdle);
    es.on(et.MESSAGE_SWIPED, refreshIndexWhenIdle);
    es.on(et.MESSAGE_DELETED, () => { if (suppressDeleteRebuilds > 0) { suppressDeleteRebuilds--; return; } if (!isStGenerating()) forceClearWaiting(); rebuild(); });
    es.on(et.MESSAGE_SWIPE_DELETED, () => { if (!isStGenerating()) forceClearWaiting(); rebuild(); });
    es.on(et.CHAT_CHANGED, () => { if (!isStGenerating()) forceClearWaiting(); rebuild(); });
    es.on(et.MORE_MESSAGES_LOADED, () => { if (!isStGenerating()) forceClearWaiting(); rebuild(); });

    if (et.GENERATION_STARTED) es.on(et.GENERATION_STARTED, markGenerating);
    if (et.STREAM_REASONING_DONE) es.on(et.STREAM_REASONING_DONE, (reasoning) => {
        if (streaming && reasoning) onStream(`<think>${reasoning}</think>\n${streamBuffer}`);
    });
    es.on(et.STREAM_TOKEN_RECEIVED, (full) => {
        // 结束事件之后可能还有一个已排队的迟到 token；不能让它把飞机重新改成红方框。
        if (!streaming || pendingStop) return;

        ensureStreamBaseline();
        // 推理阶段正文可能仍为空，但 reasoningHandler 已更新；不能因空正文跳过本次事件。
        let seg = textFromPayload(full);
        if (seg) seg = stripStreamBaseline(seg);
        const reasoning = currentReasoning();
        if (!seg && !reasoning) return;
        receivedStreamToken = true;
        if (seg) {
            // ST 的 STREAM_TOKEN_RECEIVED 是累积全文，直接替换可避免重复合并和回闪。
            streamBuffer = seg;
            streamPollText = streamBuffer;
        }
        emitStreamText(streamBuffer);
    });
    es.on(et.GENERATION_ENDED, finishGeneration);
    es.on(et.GENERATION_STOPPED, () => {
        endGeneration();
        if (pendingStop) {
            schedulePendingStopSettlement();
            return;
        }
        if (hasLiveGeneration()) finalize();
    });

    console.info('[overlay] 桥已绑定 ST 事件。');
}

/** 读 ST 原生「停止生成」按钮是否可见 → 判断当前是否真在生成。
 *  ST 生成时把 #mes_stop 从默认 display:none 切成 flex；空闲则相反。
 *  只认「计算样式 display 非 none 且在布局中」——用 && 而非 ||，
 *  否则隐藏按钮（display:none→offsetParent 也为 null）会被第二个条件误判成「可见」→ 生成中卡住。 */
function isStGenerating() {
    const stop = document.querySelector(ST_STOP_BTN);
    if (!stop) return false;
    if (getComputedStyle(stop).display === 'none') return false;  // 明确隐藏 = 没在生成
    return stop.offsetParent !== null;                            // 且确实在布局中显示
}

/** 打开 overlay 时刷新。
 *  空闲：重建到最新。
 *  生成中：不要用半成品 mes 做 rebuild（会把思维链/正文搅进楼层，或与 onStream 叠成「一条复制 N 遍」）；
 *          重接 streamBuffer + 直接 onStream 续播。历史楼层仍 rebuild，但跳过正在生成的末楼。 */
export function refreshOnOpen() {
    wireComposer._syncFromSt?.();
    const gen = isStGenerating();
    streaming = gen;
    toggleStopBtn(gen);
    // ST 停止按钮的显隐会晚一帧落定；用真实状态复核，避免空闲时残留停止方块。
    requestAnimationFrame(() => {
        const actual = isStGenerating();
        if (!actual && (streaming || hasLiveGeneration())) finishGeneration();
        else toggleStopBtn(actual);
    });
    if (!gen) {
        forceClearWaiting();
        stopGenWatchdog();
        rebuild(false, 'last');
        return;
    }
    // —— 生成中打开 ——
    // 1) 以当前末条 AI 正文重接 buffer（覆盖可能为空/过期的内存态）
    const cur = latestAssistantText();
    // baseline：若还没建过，用「末条之前」作基线；已有则保留
    if (streamBaseline.index < 0 && !streamBaseline.text) {
        const c = ctxRef || getCtx();
        if (c && Array.isArray(c.chat) && cur.index > 0) {
            // 找 cur 之前最近的 AI 楼当 baseline（swipe/续写时 mes 会带旧文前缀）
            streamBaseline = { index: cur.index, text: '' };
        }
    }
    const text = stripStreamBaseline(cur.text, cur.index);
    if (text) {
        streamBuffer = mergeStreamText(streamBuffer, text);
        streamPollText = streamBuffer;
    }
    startGenWatchdog();
    // 2) 重建历史，但跳过正在生成的末条 AI（避免半成品进 floors + 思维链泄漏进正文）
    rebuild(false, 'last', { skipStreamingTail: true });
    // 3) 历史在后台重建完后再进入空白实时楼层，确保上一楼不会垫在生成态下面。
    enterWaiting();
    // 4) 用 live stream 接管当前屏（思维链进 bar，正文进打字机）
    const live = streamBuffer || text || '';
    if (live || currentReasoning()) {
        emitStreamText(live);
    }
}

/** 最小化/关闭时调用：非生成中则强清「生成中」等待态，避免残留到下次打开。 */
export function clearWaitingOnClose() {
    wireComposer._syncToSt?.();
    if (!isStGenerating()) { forceClearWaiting(); stopGenWatchdog(); }
}
