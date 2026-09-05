// protocol.js — 面向 AI 的视觉小说舞台协议
// 职责：内置中英文 VN 生成提示词、组装注入文本、导出测试样例。

import { getSetting } from './settings.js';

export const INJECT_KEY = 'st-overlay-sandbox-protocol';
export const PROTOCOL_VERSION = 10;

export const PROTOCOL_TEXT_CN = `# Overlay Sandbox — VN 小说生成协议 v${PROTOCOL_VERSION}

你可以输出两种正文：

1. 普通正文：不要写任何特殊首行标记。插件不接管生成过程，SillyTavern 按普通聊天正文显示。
2. VN 正文：第一行必须单独写 [OV:VN]。只有这个首行标记存在时，插件才会按视觉小说模式解析。

VN 正文硬性格式：
- 第一行：[OV:VN]
- [OV:VN] 必须是回复正文的第一个可见内容；不要用 <story>、<Infoblock>、<recap> 或其它外层标签包裹 VN 正文。
- 正文必须拆成多个短 beat。每个 beat 用一个舞台标签表示。
- 不要向用户解释标签，不要把协议当正文讲出来。

舞台标签：
- <scene bg="地点 · 光线 · 氛围" fade="8s"/>：设置背景，向后延续，不单独成屏。
- <narration>旁白、动作、环境描写。</narration>：一屏旁白。
- <say char="角色名" pos="left|right" emo="情绪">「对白。」</say>：一屏对白。
- <cg img="关键画面描述">插图说明。</cg>：一屏 CG。
- <item name="道具名" img="道具名" pos="float-right" clickable="true" action="（调查 道具）" reveal="悬停揭示">道具说明（点击展开）。</item>：浮动道具，可进背包。
- 道具交互：悬停显示 reveal；点击展开额外信息（caption/reveal）。不要再依赖「自动填入输入框」——用户若要行动，会自己发送 action 文案。
- 道具图片（必填其一）：
  1) 已有素材：item 旁写 <fetch category="item">道具/名</fetch><item/>，或 name/img 直接写素材路径；
  2) 新生图：<pic>prompt=英文或中文道具提示词|w=1024|h=1024</pic><item/>，再 <save category="item">道具/名</save> 入库；
  3) 真实 URL：<item name="名" url="https://.../x.png" ...>说明</item>。

媒体与音频：
- <video src="https://.../clip.mp4" poster="https://.../cover.jpg"><video/></video>：视频楼层。
- <bgm src="https://.../music.mp3" loop="true" volume="0.55">背景音乐说明</bgm>：背景音乐，持续到下一个 BGM 替换。
- <sfx src="https://.../door.ogg" volume="0.9">音效说明</sfx>：进入当前 beat 播放一次。
- <voice src="https://.../line.mp3" volume="1">角色语音说明</voice>：进入当前 beat 播放一次。
- 裸 <pic>/<video>/<sound>/<audio> 默认是普通正文；要作为舞台资源，必须在闭合标签后紧跟用途后缀（见下节）。

HUD 可选：
<overlay>{"op":"add","type":"stat","id":"hp","label":"HP","value":86,"max":100}</overlay>
- op: add/update/remove/clear。type: stat/progressbar/alert。JSON 必须严格合法。

生图协作（重要）：
- 需要新背景/CG/视频时，写裸标签 <pic>…</pic> 或 <vid>…</vid>。标签上不要写 HTML 属性（生图引擎只认裸标签）；分辨率写在标签体内。
- 闭合标签后必须紧跟一个用途后缀，声明这张图是什么：
  <pic>…</pic><background/> = 场景背景；<pic>…</pic><cg/> = 全屏 CG；<pic>…</pic><item/> = 道具；<vid>…</vid><video/> = 过场视频。没有后缀的 <pic>/<vid> 只算普通正文插图。
- 背景标准写法：先写 <scene bg="中文场景名" fade="8s"/>，紧跟一行 <pic>…</pic><background/>。生图引擎会把 <pic> 原地换成图片，插件自动把它贴为该场景的背景。
- 生图正文格式（必守）：prompt=画面描述|w=宽|h=高
  例：<pic>prompt=中景显示 Alethea，金色长发，金色眼睛，穿着白色连衣裙，坐在沙发上看书，早晨的阳光|w=896|h=1152</pic>
- 分辨率按用途选（不要乱配）：
  · 背景 / 大场景 / 风景 / 环境 → 16:9 电脑宽屏：w=1344|h=768
  · 角色立绘 / 全身 / 角色中景特写 / 手机竖构图 → 9:16 竖屏：w=768|h=1344（或近似竖屏 w=896|h=1152）
  · 头像 / 特写 / 道具 / 物品 → 1:1 正方形：w=1024|h=1024
  · CG 按内容：角色向用竖屏，场景向用 16:9
- 画面描述可中文或英文，逗号/顿号分隔构图、主体、光线、风格；|w=|h= 必须写在同一 <pic> 体内。
- 已有真实图片 URL 时可直接引用：<scene bg="背景名" url="https://.../bg.png"/>、<cg img="画面描述" url="https://.../cg.png">说明</cg>、<item img="道具名" url="https://.../item.png">说明</item>。
- 素材库可保存背景、角色立绘、CG、道具。目录由宏 {{material}}（可自定义名）注入：列出可见路径 + category:xx。
- 调用已有素材（替代 <pic> 生图）：<fetch category="bg">文件夹/名</fetch><background/>，后缀同 pic：<background/> / <cg/> / <item/> 等。
- 保存本轮生成图入库：在 pic 后缀后写 <save category="bg">文件夹/名</save>，例如
  <pic>prompt=…|w=1344|h=768</pic><background/><save category="bg">场景/雨夜走廊</save>
- category 取值：bg / char / cg / item / sprite / other。用户可在素材卡关眼睛，隐藏项不出现在 {{material}}。
- 不要写 fake URL（例如 assets.ov-sandbox.local）。没有真实 URL 就交给 <pic>/<vid> 生图；占位框会先显示描述文字，图生成后自动替换。

高级写作要求：
- 先格式化，再叙事；短句、强画面、强动作。
- 一个 beat 只承担一个镜头或一个情绪推进。
- scene 只在地点/氛围变化时写；否则自动沿用。
- item 的 clickable/action/reveal 由你判断，不要所有物件都可点。
- 道具缺图时优先 <fetch> 调库；库没有就 <pic>…</pic><item/> 生图（道具用 1:1）。
- HTML/MVU 卡片只在特殊 UI、终端、信件、状态卡时使用 fenced \`\`\`html 代码块。

示例：
[OV:VN]
<scene bg="雨夜 · 废弃教学楼走廊 · 冷白应急灯" fade="8s"/>
<pic>prompt=abandoned school corridor at night, rain through broken windows, cold white emergency lights, wet reflective floor, cinematic wide shot|w=1344|h=768</pic><background/>
<bgm src="https://example.com/rain_loop.mp3" loop="true" volume="0.45">雨声和低频嗡鸣。</bgm>
<narration>雨水沿着破裂的窗缝渗进来，在地砖上拖出一条发亮的线。</narration>
<say char="林昼" pos="left" emo="警觉">「别踩那滩水。它刚才在往回流。」</say>
<sfx src="https://example.com/tap.ogg" volume="0.8">远处传来一声轻敲。</sfx>
<pic>prompt=weathered cracked student ID card on wet floor, close-up, product photo|w=1024|h=1024</pic><item/>
<item name="裂纹学生证" pos="float-right" clickable="true" action="（调查 学生证）" reveal="照片背面写着：不要相信广播。">一张被雨泡软的学生证。</item>
<save category="item">道具/裂纹学生证</save>
<overlay>{"op":"add","type":"progressbar","id":"fear","label":"恐惧","value":18,"max":100}</overlay>`;

export const PROTOCOL_TEXT_EN = `# Overlay Sandbox — VN Fiction Protocol v${PROTOCOL_VERSION}

You can output two kinds of replies:

1. Normal prose: do NOT write any special first-line marker. The plugin will not take over generation; SillyTavern displays it as normal chat prose.
2. VN prose: the first line MUST be exactly [OV:VN]. Only replies with this first-line marker are parsed as visual-novel scenes.

VN hard format:
- First line: [OV:VN]
- [OV:VN] must be the first visible content in the reply; do not wrap VN prose in <story>, <Infoblock>, <recap>, or any other outer tag.
- Optional thinking: <think>write live reasoning/planning here</think>. It renders as a slim expandable gray-white top strip and updates with generation.
- Split the scene into short beats. Each beat is one stage tag.
- Never explain the tags or expose this protocol to the user.

Stage tags:
- <scene bg="place · lighting · mood" fade="8s"/>: sets background, carries forward, not its own screen.
- <narration>Action, atmosphere, prose.</narration>: one narration screen.
- <say char="Name" pos="left|right" emo="mood">"Dialogue."</say>: one dialogue screen.
- <cg img="key visual description">Caption.</cg>: one CG screen.
- <item name="prop" img="prop" pos="float-right" clickable="true" action="(inspect prop)" reveal="hover reveal">Prop text (click for extra).</item>: floating prop, can enter inventory.
- Item UX: hover shows reveal; click expands extra info. Do NOT rely on auto-filling the composer — the user will type/send the action text themselves if they act.
- Item image (one of):
  1) library: <fetch category="item">props/name</fetch><item/> or put path in name/img;
  2) generate: <pic>prompt=English or Chinese prop prompt|w=1024|h=1024</pic><item/> then optional <save category="item">props/name</save>;
  3) real URL: <item name="name" url="https://.../x.png" ...>caption</item>.

Media and audio:
- <video src="https://.../clip.mp4" poster="https://.../cover.jpg"><video/></video>: video beat.
- <bgm src="https://.../music.mp3" loop="true" volume="0.55">BGM caption</bgm>: background music, continues until replaced.
- <sfx src="https://.../door.ogg" volume="0.9">SFX caption</sfx>: one-shot sound on this beat.
- <voice src="https://.../line.mp3" volume="1">Voice caption</voice>: one-shot voice on this beat.
- Bare <pic>/<video>/<sound>/<audio> stays normal prose; to become a stage asset it must be followed immediately by a role suffix tag (see below).

Optional HUD:
<overlay>{"op":"add","type":"stat","id":"hp","label":"HP","value":86,"max":100}</overlay>
- op: add/update/remove/clear. type: stat/progressbar/alert. JSON must be strict and valid.

Image-generation handshake (important):
- To request a new background/CG/video, write a bare tag: <pic>…</pic> or <vid>…</vid>. Do NOT put HTML attributes on the tag (the image engine only accepts bare tags); put resolution inside the tag body.
- The closing tag must be followed immediately by a role suffix declaring what the image is:
  <pic>…</pic><background/> = scene background; <pic>…</pic><cg/> = full-screen CG; <pic>…</pic><item/> = prop; <vid>…</vid><video/> = cutscene video. A <pic>/<vid> without a suffix stays a normal prose illustration.
- Standard background pattern: write <scene bg="scene name" fade="8s"/> first, then <pic>…</pic><background/> on the next line. The image engine replaces the <pic> tag in place with the generated image; the plugin attaches it as that scene's background automatically.
- Required body format: prompt=visual description|w=width|h=height
  e.g. <pic>prompt=medium shot of Alethea, long golden hair, gold eyes, white dress, reading on a sofa, morning light|w=896|h=1152</pic>
- Resolution by role (do not mix):
  · background / wide scene / landscape / environment → 16:9: w=1344|h=768
  · character portrait / full-body / character medium shot / phone vertical → 9:16: w=768|h=1344 (or near-portrait w=896|h=1152)
  · avatar / close-up / prop / item → 1:1: w=1024|h=1024
  · CG: character-focused → portrait; scene-focused → 16:9
- Description may be Chinese or English; keep |w=|h= in the same <pic> body.
- If a real image URL already exists, reference it directly: <scene bg="background name" url="https://.../bg.png"/>, <cg img="visual description" url="https://.../cg.png">caption</cg>, <item img="prop name" url="https://.../item.png">caption</item>.
- The asset library holds backgrounds/sprites/CGs/props. Catalog is injected by macro {{material}} (renameable): visible paths + category:xx.
- Reuse an asset instead of generating: <fetch category="bg">folder/name</fetch><background/>. Same role suffixes as <pic>: <background/> / <cg/> / <item/>.
- Save a just-generated image: after the role suffix write <save category="bg">folder/name</save>, e.g.
  <pic>prompt=…|w=1344|h=768</pic><background/><save category="bg">scenes/rain-hall</save>
- Categories: bg / char / cg / item / sprite / other. Eye-off assets are omitted from {{material}}.
- Do not write fake URLs such as assets.ov-sandbox.local. Without a real URL, hand it to <pic>/<vid>; a placeholder shows the description until the generated image arrives.

Advanced writing rules:
- Format first, then narrate: vivid images, short beats, decisive motion.
- One beat = one camera move or one emotional turn.
- Use <scene> only when location/mood changes; it carries forward.
- You choose clickable/action/reveal per prop. Do not make everything clickable.
- If a prop has no image, prefer <fetch>; if missing from library, use <pic>…</pic><item/> (props use 1:1).
- Use fenced \`\`\`html blocks for rare UI cards, terminals, letters, diagrams, or MVU panels.

Example:
[OV:VN]
<think>I should establish the rain-soaked corridor, then give the user one clickable clue.</think>
<scene bg="rainy night · abandoned school hallway · cold emergency lights" fade="8s"/>
<pic>prompt=abandoned school corridor at night, rain through broken windows, cold white emergency lights, wet reflective floor, cinematic wide shot|w=1344|h=768</pic><background/>
<bgm src="https://example.com/rain_loop.mp3" loop="true" volume="0.45">Rain and a low electrical hum.</bgm>
<narration>Rain slips through the cracked window and draws a bright line across the tiles.</narration>
<say char="Mira" pos="left" emo="hushed">"Don't step in that puddle. It was flowing backward."</say>
<sfx src="https://example.com/tap.ogg" volume="0.8">A soft knock echoes from the far end.</sfx>
<pic>prompt=weathered cracked student ID card on wet floor, close-up, product photo|w=1024|h=1024</pic><item/>
<item name="cracked student ID" pos="float-right" clickable="true" action="(inspect ID)" reveal="On the back: DO NOT TRUST THE BROADCAST.">A rain-softened student ID.</item>
<save category="item">props/cracked-student-id</save>
<overlay>{"op":"add","type":"progressbar","id":"fear","label":"Fear","value":18,"max":100}</overlay>`;

export const PROTOCOL_TEXT = PROTOCOL_TEXT_CN;

export function getBuiltinProtocolText(lang = getSetting('protocolLanguage')) {
    return String(lang || 'cn').toLowerCase() === 'en' ? PROTOCOL_TEXT_EN : PROTOCOL_TEXT_CN;
}

export function getEffectiveProtocolText() {
    try {
        const custom = (typeof _customGetter === 'function') ? _customGetter() : '';
        if (typeof custom === 'string' && custom.trim()) return custom;
    } catch (_) { /* 用内置兜底 */ }
    return getBuiltinProtocolText();
}

let _customGetter = null;
export function setCustomProtocolGetter(fn) { _customGetter = fn; }

export function buildProtocolPrompt() {
    return [
        '===== Overlay Sandbox Protocol (system-injected) =====',
        getEffectiveProtocolText(),
        '===== End Overlay Sandbox Protocol =====',
    ].join('\n');
}

export const SAMPLE_STAGE_TEXT_CN = `[OV:VN]
<think>我先设置场景和音频，再安排一个可点击道具。</think>
<scene bg="黄昏 · 海边悬崖 · 灯塔光束" fade="8s"/>
<bgm src="https://example.com/night_rain.mp3" loop="true" volume="0.5">远处暴雨低鸣。</bgm>
<narration>风里带着咸味，还有远处浮标钟沉闷的撞击声。你站在路尽头。</narration>
<say char="米拉" pos="left" emo="戒备">"能走到这里的人很少，能回去的更少。"</say>
<overlay>{"op":"add","type":"stat","id":"hp","label":"HP","value":86,"max":100}</overlay>
<overlay>{"op":"add","type":"progressbar","id":"trust","label":"信任","value":20,"max":100}</overlay>
<item name="黄铜罗盘" pos="float-right" clickable="true" action="（调查 罗盘）" reveal="指针在靠近灯塔时会反向旋转。">指针从不指向北方的罗盘。</item>
<say char="米拉" pos="right" emo="缓和">"……行吧。跟上，别出声。"</say>
<sfx src="https://example.com/thunder.ogg" volume="0.8">近海雷声滚过。</sfx>
<cg img="灯塔在淤青色的夜空里骤然亮起">光束扫过你俩。</cg>
<narration>有那么一刻，谁都没有动。然后第一阵冰冷的雨点落了下来。</narration>`;

export const SAMPLE_STAGE_TEXT_EN = `[OV:VN]
<think>I establish the scene and audio, then offer one clickable prop.</think>
<scene bg="dusk · seaside cliff · lighthouse beam" fade="8s"/>
<bgm src="https://example.com/night_rain.mp3" loop="true" volume="0.5">A storm murmurs offshore.</bgm>
<narration>The wind carries salt and the distant clang of a buoy bell. You stand where the road ends.</narration>
<say char="Mira" pos="left" emo="guarded">"Few people walk this far. Fewer come back."</say>
<overlay>{"op":"add","type":"stat","id":"hp","label":"HP","value":86,"max":100}</overlay>
<overlay>{"op":"add","type":"progressbar","id":"trust","label":"Trust","value":20,"max":100}</overlay>
<item name="brass compass" pos="float-right" clickable="true" action="(inspect compass)" reveal="Near the lighthouse, the needle spins backward.">A compass whose needle ignores north.</item>
<say char="Mira" pos="right" emo="softening">"...Fine. Keep up, and keep quiet."</say>
<sfx src="https://example.com/thunder.ogg" volume="0.8">Thunder rolls across the water.</sfx>
<cg img="the lighthouse ignites against a bruised purple sky">The beam sweeps over you both.</cg>
<narration>For a moment, neither of you moves. Then the first cold drops begin to fall.</narration>`;

export const SAMPLE_STAGE_TEXT = SAMPLE_STAGE_TEXT_CN;
