# Overlay Sandbox

给 SillyTavern 套一层全屏的视觉小说阅读器。同一段对话，用读galgame的方式读。

它不改动 SillyTavern 的任何原生 DOM，也不改写聊天记录——只是把 `chat` 里已有的内容重新渲染成一屏一屏的舞台：背景、立绘、CG、正文面板、可点选项。关掉它，你的聊天还是原来的样子。

## 这是什么

SillyTavern 原生是聊天气泡流。这个扩展提供另一种读法：把每条 AI 回复当作一个「楼层」，楼层内再按舞台标签切成若干「片段」，一屏显示一段，滚轮换片段、跨楼层，左右键前后翻。AI 只要在回复里夹几个标签，就能控制背景图、角色立绘和表情、全屏 CG、背景音乐、可点击的道具和选项。

不写标签的普通回复不受影响，交回 SillyTavern 原生显示。

## 环境要求

- SillyTavern（较新版本，需要 `SillyTavern.getContext()` 暴露 `chat` / `eventSource` / `messageFormatting` / `saveSettingsDebounced`）
- 现代 Chromium 或 Firefox

## 安装

把整个文件夹放进你的用户扩展目录：

```
<SillyTavern 根目录>/data/<你的用户名>/extensions/st-overlay-sandbox/
```

然后刷新 SillyTavern。扩展列表里会出现 "Overlay Sandbox"。

> 注意：SillyTavern 注入扩展 CSS 时不带版本串，`<link>` 已存在就跳过重注。**更新本扩展后必须 Ctrl+Shift+R 硬刷新**，普通 F5 拿到的是缓存的旧样式。

## 打开

四种方式任选：

- 屏幕右上角的浮动入口按钮（可自由拖动，位置记忆在 localStorage）
- 快捷键 `Ctrl/Cmd + Shift + O`
- `/overlay` slash 命令：`/overlay show|hide|toggle|clear`
- 设置里可开启的虚拟按键（可停靠到发送键左侧）

## 舞台标签

让 AI 输出下面这些标签即可驱动舞台。**回复第一行包含 `[OV:VN]` 才进入 VN 模式**，否则走原生显示。

```html
[OV:VN]
<scene bg="雨夜 · 废弃教学楼走廊 · 冷白应急灯" fade="8s"/>
<narration>雨水沿着破裂的窗缝渗进来，在地砖上拖出一条发亮的线。</narration>
<say char="米拉" pos="left" emo="戒备">「别踩那滩水。它刚才在往回流。」</say>
<item img="裂纹学生证" pos="float-right" clickable="true" action="（调查 学生证）">一张被雨泡软的学生证。</item>
```

| 标签 | 作用 |
|---|---|
| `<scene bg= fade=/>` | 切换背景，可指定淡入时长 |
| `<narration>` | 旁白段落 |
| `<say char= pos= emo=>` | 角色台词；`pos` 定左右立绘位，`emo` 定表情图 |
| `<cg>` | 全屏 CG |
| `<item img= pos= clickable= action= reveal=>` | 道具浮层，可点击、可回填动作文本 |
| `<opt>` | 可点击的分支选项，点击后填入输入框 |
| `<bgm>` `<sfx>` `<voice>` | 背景音乐 / 音效 / 语音 |
| `<think>` | 思维链，收进顶部横条，不混进正文 |
| `<overlay>{JSON}</overlay>` | 素材库增删等结构化指令 |

完整的内置提示词见 [`protocol.js`](protocol.js) 的 `PROTOCOL_TEXT_CN` / `PROTOCOL_TEXT_EN`，示例见 [`VN_PROMPT.md`](VN_PROMPT.md)，媒体格式说明见 [`MEDIA_FORMATS.md`](MEDIA_FORMATS.md)。

开启「设置 → 注入 AI 上下文」后，协议说明会自动进入 AI 的上下文；也可以用宏 `{{sandbox_prompt}}` 在预设里自行摆放位置，用 `{{material}}` 注入当前素材库清单。

## 主要功能

**阅读**
一屏一片段，滚轮带阻尼地切片段与跨楼层，左右键导航，右侧楼层跳转条。流式生成时逐字跟随，出字速度由设置控制而非网络速度。支持跨屏拖选文本（选中状态下滚轮照常滚动）。

**舞台**
分层渲染：背景 → 左右立绘 → 全屏 CG → 正文面板 → 道具浮层。背景泛光、暗角灯光、正文亮度对比度均可调。

**输入**
底部自有输入框，代理回 SillyTavern 原生输入框发送，与之双向同步。默认自动隐藏，鼠标移到底部热区唤起。未发送的草稿会持久化——刷新、关浏览器、重启后端都不丢。顶部对称位置有一颗只读胶囊，悬停显示「产生当前这一楼的那条我的输入」。

**素材与道具**
素材库管理背景 / 立绘 / CG / 道具的名称、标签与路径，AI 通过名称引用而不是伪造本地路径。背包与道具面板，点击可把文本插入输入框。

**外观**
字体、字号、行高、间距、面板宽度；正文 / 粗体 / 引号 / 括号 / 斜体 / 输入回显六个语义色，每个都可以独立跟随 SillyTavern 主题变量或自定义。无操作自动黑屏、全屏、顶部虚化等。

## 开发

跑单元测试（Node 原生 test runner，无需装依赖）：

```bash
node --test
```

语法检查全部模块：

```bash
for f in *.js; do cp "$f" "/tmp/${f%.js}.mjs"; node --check "/tmp/${f%.js}.mjs"; done
```

不依赖 SillyTavern 的前端测试页（ES module 必须经 HTTP 加载，不能直接双击）：

```bash
python -m http.server 8000
# 打开 http://localhost:8000/test.html
```

## 文件结构

| 文件 | 职责 |
|---|---|
| `manifest.json` | 扩展声明 |
| `index.js` | 入口：装配、浮动入口、快捷键、slash 命令、协议注入 |
| `overlay.js` | 全屏容器与分层舞台外壳（light DOM，样式以 `#st-overlay-root` 前缀隔离） |
| `reader.js` | 阅读器核心：楼层 / 片段模型、渲染、导航、流式与打字机 |
| `bridge.js` | 与 SillyTavern 的桥：事件订阅、流式接管、输入代理、草稿持久化 |
| `stage-parser.js` | 舞台标签解析器 |
| `ui.js` | 设置抽屉与各面板 |
| `settings.js` | 设置持久化（`extension_settings`） |
| `protocol.js` | AI 协议文本与注入 |
| `assets.js` / `assets-store.js` | 素材库 |
| `props.js` / `inventory.js` | 道具与背包 |
| `parser.js` / `components.js` | `<overlay>` JSON 指令与 HUD 组件 |
| `media-capture.js` | 媒体抓取 |
| `draggable.js` | 浮动锚点拖动 |
| `idle-dim.js` | 无操作黑屏 |
| `stream-merge.js` | 流式文本合并 |
| `text-coloring.js` / `floor-filter.js` | 文本着色 / 楼层过滤 |
| `logger.js` | 日志 |
| `style.css` | 全部样式 |
| `server-plugin/` | 可选的配套 SillyTavern 服务端插件 |

## 已知限制

- 仅在 Chromium 上做过实际使用；Firefox 路径写了兼容但未系统测试。
- 正文顶部虚化目前只作用于普通正文模式。
- 更新后必须硬刷新，见上方安装小节。

## License

Copyright (c) 2026 Shawn

本项目采用 [CC BY-NC 4.0](LICENSE)（署名 — 非商业性使用 4.0 国际）授权：

- **可以**自由复制、分发、修改、二次创作
- **必须**保留署名，并注明是否作了修改
- **不得**用于主要以商业利益或金钱报酬为目的的用途

完整条款以 [`LICENSE`](LICENSE) 的英文原文为准，摘要见 <https://creativecommons.org/licenses/by-nc/4.0/deed.zh>。

> 注：CC BY-NC 不是 OSI 认定的开源许可证。个人自用、分享、改着玩都没问题，但它不允许商业使用，因此本扩展**不能**被收进任何商业整合包或付费分发。若你需要商业授权，请开 issue 联系。
