// stream-merge.js — 流式正文快照合并（纯函数，无 DOM/ST 依赖，便于测试）

/**
 * 把新读到的一份「正文快照」并进已累积的 streamBuffer。
 *
 * ponytail: 所有调用方（watchdog 轮询 chat[].mes / 打开 overlay 时重接）读到的都是
 * ST 的**累积全文**，不是增量分片，所以永远不需要拼接——找不到重叠时以新全文为准即可。
 * 旧写法在重叠搜索落空时返回 `prev + next.slice(overlap)`：生图插件把 <img>/<video>
 * 插进正文中段后，next 不再以 prev 为前缀、重叠也降到 0，整段正文就被再追加一遍，
 * 有几张图/几段视频就重复几遍（只影响 sandbox 显示，不落盘）。
 *
 * @param {string} prev 已累积的正文
 * @param {string} next 最新读到的正文全文
 * @returns {string}
 */
export function mergeStreamText(prev, next) {
    prev = String(prev || '');
    next = String(next || '');
    if (!next) return prev;
    if (prev.includes(next)) return prev; // 迟到/被截断的旧快照，别把正文缩回去
    return next;
}
