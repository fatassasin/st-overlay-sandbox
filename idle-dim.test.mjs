// 无操作黑屏的计时状态机自检。
// 用真实的 idle-dim.js 源码 + 打桩的 settings/overlay 依赖跑，不复制被测逻辑。
//   node idle-dim.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DELAY_S = 1;                    // idle-dim 的 delayMs() 下限就是 1 秒，不能再短
const OVER = DELAY_S * 1000 + 120;    // 略超过时长，等它触发
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 打桩：把 idle-dim.js 原样复制到临时目录，旁边放假的 settings.js / overlay.js ——
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-dim-'));
fs.copyFileSync(new URL('./idle-dim.js', import.meta.url), path.join(dir, 'idle-dim.js'));
// 临时目录外没有 package.json，.js 会被当 CJS 解析 → 显式声明为 ESM
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');

const state = { idleDim: true, idleDimDelay: DELAY_S, visible: true };
fs.writeFileSync(path.join(dir, 'settings.js'), `
export function getSetting(k) { return globalThis.__idleState[k]; }
`);
fs.writeFileSync(path.join(dir, 'overlay.js'), `
export function isVisible() { return globalThis.__idleState.visible; }
export function q() { return globalThis.__dimEl; }
`);
globalThis.__idleState = state;
globalThis.__dimEl = { style: { opacity: '0', transitionDuration: '' } };

// 假 document：记下 idle-dim 注册的唤醒监听，供测试直接触发
const listeners = [];
globalThis.document = { addEventListener: (type, fn) => listeners.push({ type, fn }) };

const { initIdleDim, applyIdleDim } = await import(pathToFileURL(path.join(dir, 'idle-dim.js')).href);

const dim = globalThis.__dimEl;
const isDim = () => dim.style.opacity === '1';
const activity = () => listeners.forEach((l) => l.fn());

initIdleDim();
assert.ok(listeners.length > 0, '应当注册了唤醒监听');
assert.ok(listeners.every((l) => l.type !== 'click'), '只监听鼠标移动/按键类事件');

// 1) 静止到时长后变黑，且走 3 秒渐变
assert.equal(isDim(), false, '刚开始不该是黑的');
await WAIT(OVER);
assert.equal(isDim(), true, '静止超时后应当变黑');
assert.equal(dim.style.transitionDuration, '3s', '变黑走 3 秒渐变');

// 2) 有动作 → 瞬间还原（过渡时长清零）
activity();
assert.equal(isDim(), false, '动一下应立刻还原');
assert.equal(dim.style.transitionDuration, '0s', '还原不能有过渡');

// 3) 还原后重新计时，再次变黑
await WAIT(OVER);
assert.equal(isDim(), true, '唤醒后应重新开始计时并再次变黑');
activity();

// 4) 持续小动作 → 永不变黑（定时器按 lastActive 顺延，不是一次性触发）
for (let i = 0; i < 3; i++) { await WAIT(DELAY_S * 1000 * 0.5); activity(); assert.equal(isDim(), false, '持续操作期间不该变黑'); }

// 5) 关掉功能 → 不再变黑
state.idleDim = false;
applyIdleDim();
await WAIT(OVER);
assert.equal(isDim(), false, '功能关闭后不该变黑');

// 6) Sandbox 最小化 → 不再变黑（省得下次打开时残留黑幕）
state.idleDim = true;
state.visible = false;
applyIdleDim();
await WAIT(OVER);
assert.equal(isDim(), false, '界面隐藏时不该变黑');

// 7) 重新打开 → 恢复计时
state.visible = true;
applyIdleDim();
await WAIT(OVER);
assert.equal(isDim(), true, '重新打开后应恢复计时');

fs.rmSync(dir, { recursive: true, force: true });
console.log('idle dim checks passed');
process.exit(0);
