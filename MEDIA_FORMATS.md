# Overlay Sandbox 外部图片 / 视频 / 音频格式

核心规则：普通正文里的媒体标签默认仍是正文。只有带“用途后缀/角色”的媒体，才会被 Overlay Sandbox 当作舞台资源解析。

## 为什么要加用途后缀

你现在的正文可能包含：

```html
<vid>普通正文里引用的视频说明</vid>
<video src="...">普通正文里的 HTML 视频</video>
```

这不应该自动变成 VN 楼层。插件现在采用这个规则：

- 裸 `<pic>...</pic>` / `<vid>...</vid>` / `<video>...</video>` / `<sound>...</sound>`：正文。
- 带用途后缀：才是 Overlay 资源。

## 推荐写法

### 背景图

```html
<pic src="https://example.com/bg.jpg"><background/></pic>
```

或 ST 生成图的 title 元数据：

```html
<img src="https://example.com/bg.jpg" title="<pic background>夜晚的街道</pic>">
```

效果：设置背景层，后续片段沿用。

### CG / 插图楼层

```html
<pic src="https://example.com/cg.jpg"><cg/></pic>
```

或：

```html
<img src="https://example.com/cg.jpg" title="<pic cg>女主站在雨中</pic>">
```

效果：单独成为一个插图楼层。

### 视频楼层

```html
<video src="https://example.com/clip.mp4" poster="https://example.com/cover.jpg"><video/></video>
```

或：

```html
<video src="https://example.com/clip.mp4" title="<video cg>雨夜短片</video>"></video>
```

效果：像 CG 一样成为一个视频楼层。

### BGM

```html
<bgm src="https://example.com/rain.mp3" loop="true" volume="0.5">雨夜环境声</bgm>
```

效果：背景音乐持续播放，直到后续 BGM 替换。

### 音效

```html
<sfx src="https://example.com/door.ogg" volume="0.9">门锁咔哒</sfx>
```

也可用正文媒体式：

```html
<sound src="https://example.com/door.ogg"><sfx/></sound>
```

效果：进入当前片段时播放一次。

### 角色语音

```html
<voice src="https://example.com/line.mp3" volume="1">别出声。</voice>
```

效果：进入当前片段时播放一次，作为角色语音。

## MVU / UI 卡片渲染

MVU 卡片不走图片/视频/音频用途后缀；它走 HTML 渲染路径。把卡片写成一段 HTML，插件会放进沙盒 iframe 里渲染。

推荐用代码围栏，避免普通正文解析器误处理：

````markdown
```html
<div id="mvu-card"></div>
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<script>
  $('#mvu-card').load('https://raw.githubusercontent.com/vincentrong2005/Fatria/main/dist/性斗学园/变量更新UI/index.html');
</script>
```
````

也可以直接输出完整 HTML：

```html
<body>
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<script>
  $('body').load('https://raw.githubusercontent.com/vincentrong2005/Fatria/main/dist/性斗学园/变量更新UI/index.html');
</script>
</body>
```

注意：

- 你的示例里直接用 `$`，但没有加载 jQuery；需要先加 `<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>`，否则 `$ is not defined`。
- 远程 HTML 是否能加载，取决于对方服务器的 CORS、内容类型和网络可访问性。
- 插件会把 HTML 放进 sandbox iframe；脚本能运行，但不会直接获得 SillyTavern 主页面权限。
- 如果 MVU 卡片需要和 sandbox 输入框交互，可在卡片按钮上写 `data-action="..."`，插件会把它桥接成命令/插入输入。

- 背景：`background` / `bg` / `scene`
- CG / 插图 / 视频楼层：`cg` / `image` / `pic` / `video` / `vid`
- BGM：`bgm` / `music`
- 音效：`sfx` / `effect` / `sound`
- 语音：`voice`
- 道具/图标预留：`item` / `icon`

## 你的想法怎么落地

你设想的：

```html
<pic>...</pic><background>
```

建议改成自闭合后缀，避免它被当成正文标签：

```html
<pic src="..."><background/></pic>
```

或者更稳定地写在起始标签里：

```html
<pic background src="...">夜晚街道</pic>
```

这样“图片内容”和“图片用途”不会混淆。

## 安全兜底

如果没有用途后缀，整篇仍按普通正文显示，不拆成楼层，不自动播放音频。