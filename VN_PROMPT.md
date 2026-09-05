# Overlay Sandbox VN 小说生成提示词

## 中文（默认）

```text
[OV:VN]
```

只有第一行包含 `[OV:VN]` 的回复才会进入 VN 模式；普通正文不要写这个标记，让 SillyTavern 原生显示。

完整内置中文提示词见 `protocol.js` 的 `PROTOCOL_TEXT_CN`。

## English

```text
[OV:VN]
```

Only replies whose first line contains `[OV:VN]` enter VN mode. Normal prose should not include this marker and will be displayed by SillyTavern normally.

See `PROTOCOL_TEXT_EN` in `protocol.js` for the full built-in English prompt.

## 素材库 / Asset library

- 背景、角色立绘、CG、道具都可以保存到素材库；素材库条目包含名称、标签和路径/URL。
- 背景建议使用 `bg` / `background` 标签，并用稳定描述写入 `<scene bg="素材名或场景描述"/>`。
- 角色 Sprite 按 `char + emo` 区分：`米拉 · 戒备` 和 `米拉 · 缓和` 是两个独立表情图位。
- 道具和 CG 使用稳定 `img` 描述；已有素材优先复用，没有素材时再描述新素材需求。
- 注入宏/协议会把可用素材名、标签、路径发送给 AI；AI 应引用已有名称/标签，不要伪造本地路径。
- AI 可以提出素材维护格式，例如：

```html
<overlay>{"op":"asset_add","name":"米拉 · 缓和","tag":"sprite","url":"https://.../mira-soft.png"}</overlay>
<overlay>{"op":"asset_remove","name":"旧教室背景"}</overlay>
```

本轮只定义调用规则；真正自动生图、自动入库、自动删除需要后续接具体生图 API/命令，并由用户确认。

## 最小 VN 示例

```html
[OV:VN]
<think>先建立场景，再给用户一个可点击线索。</think>
<scene bg="雨夜 · 废弃教学楼走廊 · 冷白应急灯" fade="8s"/>
<narration>雨水沿着破裂的窗缝渗进来，在地砖上拖出一条发亮的线。</narration>
<say char="米拉" pos="left" emo="戒备">「别踩那滩水。它刚才在往回流。」</say>
<say char="米拉" pos="right" emo="缓和">「……好吧，我相信你一次。」</say>
<item img="裂纹学生证" pos="float-right" clickable="true" action="（调查 学生证）" reveal="照片背面写着：不要相信广播。">一张被雨泡软的学生证。</item>
```
