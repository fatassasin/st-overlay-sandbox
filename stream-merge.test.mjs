import assert from 'node:assert/strict';
import { mergeStreamText } from './stream-merge.js';

// 流式增长：新全文以旧文为前缀 → 取新全文
assert.equal(mergeStreamText('', '第一段'), '第一段');
assert.equal(mergeStreamText('第一段', '第一段第二段'), '第一段第二段');

// 迟到的旧快照（更短且已被包含）→ 保持已累积的正文，不缩回去
assert.equal(mergeStreamText('第一段第二段', '第一段'), '第一段第二段');
assert.equal(mergeStreamText('第一段第二段', ''), '第一段第二段');

// 回归：生图插件把 <img>/<video> 插进正文中段后，快照不再以旧文为前缀。
// 每张图/每段视频都必须只留一份正文，绝不追加成两遍、三遍。
const body = '第一段正文。\n\n<pic>p1</pic>\n\n第二段正文。\n\n<pic>p2</pic>\n\n第三段正文。';
let buffer = mergeStreamText('', body);
let mes = body;
for (const [tag, url] of [['p1', 'a.png'], ['p2', 'b.png']]) {
    mes = mes.replace(`<pic>${tag}</pic>`, `<pic>${tag}</pic>\n<img src="${url}" title="&lt;pic&gt;${tag}&lt;/pic&gt;">`);
    buffer = mergeStreamText(buffer, mes);
    assert.equal(buffer, mes);
    assert.equal(buffer.match(/第一段正文/g).length, 1);
}

console.log('stream merge checks passed');
