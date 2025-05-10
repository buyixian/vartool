# Var 中间层服务器工具箱

这是一个 Node.js 实现的中间层服务器，用于在客户端和后端 API 管理服务器之间添加动态变量处理、内容缓存、功能扩展等。主要用于实现方便AI使用的AI时钟，AI日程，AI记事本，AI图床与AI寄存器。可以通过该服务器实现多模态转化，AI表情包，AI跨客户端记忆等高级功能。

## 主要功能

*   **通用变量替换**: 拦截发往 `/v1/chat/completions` 的请求，自动替换请求体 JSON 中 `messages` 数组内字符串内容里的特定占位符变量（见下方“支持的变量”）。支持文本和 Vision 请求格式。
*   **多模态图片转译与缓存**:
    *   **功能开关**: 可通过 `config.env` 中的 `Base64Cache` (True/False) 参数启用或禁用此整个功能。禁用后，包含 Base64 图片的消息将不作处理直接转发。
    *   **自动转译**: 拦截包含 `image_url` (Base64 格式) 的用户消息，调用配置的 `ImageModel` 将图片转译为文本描述。
    *   **内容整合**: 转译后的文本以 `[检测到多模态数据，Var工具箱已自动提取图片信息，信息元如下——]\n[IMAGEXInfo: description]` 格式整合回用户消息的文本部分，并移除原始 `image_url`。
    *   **智能缓存**: 转译结果（包含唯一ID、描述、时间戳）缓存在本地 `imagebase64.json` 文件中，避免重复识别相同图片，节省 Token 和时间。
    *   **健壮性处理**: 图片识别包含重试机制（最多3次）和回复内容长度校验（至少50字符），以提高成功率和描述质量。
    *   **高级参数控制**: 支持通过 `config.env` 配置图片模型的最大输出Token数 (`ImageModelOutput`) 和思考预算 (`ImageModelThinkingBudget`)，以优化复杂图片的识别效果。
*   **天气获取与缓存**: 定时（每天凌晨4点和启动时）通过配置的 API 和模型获取指定城市的天气信息，并缓存到文件，供 `{{WeatherInfo}}` 变量使用。
*   **表情包系统**:
    *   **动态列表生成**: 启动时自动扫描 `image/` 目录下所有以 `表情包` 结尾的文件夹（如 `image/通用表情包`, `image/小克表情包`），生成表情包文件名列表并缓存。
    *   **提示词注入**: 通过 `{{VarEmojiPrompt}}` 变量将表情包的使用说明和通用表情包列表注入到提示词中。此提示词模板内部应使用 `{{通用表情包}}` 来引用通用表情包列表。
    *   **角色专属表情包**: 通过 `{{角色名表情包}}` 变量（如 `{{小克表情包}}`）注入特定角色的表情包列表。
*   **日记/记忆库系统**:
    *   **内容提取**: 自动检测并提取 AI 回复中被 `<<<DailyNoteStart>>>` 和 `<<<DailyNoteEnd>>>` 包裹的结构化日记内容。
    *   **文件存储**: 将提取的日记内容根据 `Maid:` 和 `Date:` 字段，保存到 `dailynote/角色名/日期.txt` 文件中。支持同日多条日记自动编号。
    *   **内容注入**: 通过 `{{角色名日记本}}` 变量（如 `{{小克日记本}}`）将指定角色存储的所有日记内容注入到提示词中。
*   **系统提示词转换**: 启动时加载 `config.env` 中定义的 `DetectorX` 和 `Detector_OutputX` 规则，在处理请求时自动将匹配到的 `DetectorX` 文本替换为对应的 `Detector_OutputX` 文本。
*   **全局上下文转换**: 类似于系统提示词转换，启动时加载 `config.env` 中定义的 `SuperDetectorX` 和 `SuperDetector_OutputX` 规则。这些规则应用于所有通过 `replaceCommonVariables` 函数处理的文本，实现更广泛的文本替换。
*   **本地静态文件服务 (带鉴权)**: 通过 `/pw=YOUR_IMAGE_KEY/images/` 路径提供 `image/` 目录下的静态文件访问。`YOUR_IMAGE_KEY` 对应 `config.env` 中的 `Image_Key` 值。
*   **请求转发**: 将处理（变量替换、提示词转换等）后的请求转发给配置的后端 API 服务器。
*   **认证**: 通过 Bearer Token 对访问中间层的客户端请求进行认证。

## 配置 (`config.env`)

所有配置项都在 `config.env` 文件中：

*   `API_Key`: 后端 API 管理服务器的访问密钥。
*   `API_URL`: 后端 API 管理服务器的地址 (例如 `http://localhost:3000`)。
*   `Image_Key`: 用于图片服务路径鉴权的密钥。
*   `Port`: 中间层服务器监听的端口 (例如 `5890`)。
*   `Key`: 客户端访问中间层服务器所需的认证密钥 (例如 `123456`)。
*   `VarSystemInfo`: 自定义系统信息变量 (`{{VarSystemInfo}}`) 的值。
*   `VarWeatherInfo`: 缓存天气信息的文件路径 (默认为 `Weather.txt`)。
*   `VarCity`: 获取天气的目标城市 (`{{VarCity}}`)。
*   `VarUser`: 自定义用户信息变量 (`{{VarUser}}`) 的值。
*   `VarEmojiPrompt`: 表情包使用说明的提示语模板 (内部应使用 `{{通用表情包}}` 变量引用通用表情包列表, 并使用 `{{Image_Key}}` 变量构建正确的图片URL)。
*   `VarHttpUrl`, `VarHttpsUrl`, `VarDdnsUrl`: 用户自定义的URL变量，可通过 `{{VarHttpUrl}}` 等形式在提示词中使用。
*   `WeatherModel`: 用于获取天气的后端 API 模型名称。
*   `WeatherPrompt`: 获取天气时发送给模型的提示语模板 (支持 `{{Date}}`, `{{VarCity}}` 变量)。
*   `WeatherModelMaxTokens`: 天气模型请求的 `max_tokens` 值。
*   `Base64Cache`: 布尔值 (True/False)，用于启用或禁用 Base64 图片转译和缓存功能。默认为 True。
*   `ImageModel`: 用于图片转译的多模态模型名称。
*   `ImagePrompt`: 指导图片转译模型工作的提示文本。
*   `ImageModelOutput`: 图片识别模型请求中 `max_tokens` 的值 (默认为 `1024`)。
*   `ImageModelContent`: 图片识别模型的上下文窗口大小信息 (目前仅供参考，不直接用于API请求参数)。
*   `ImageModelThinkingBudget`: 图片识别模型进行 CoT 推理的预算值。如果设置，会作为 `extra_body: {"thinking_config": {"thinking_budget": VALUE}}` 添加到请求中。
*   `DetectorX`: 需要被检测和替换的系统提示词片段 (X为数字)。
*   `Detector_OutputX`: 用于替换 `DetectorX` 的目标文本 (X为对应数字)。
*   `SuperDetectorX`: 需要被检测和替换的全局上下文文本片段 (X为数字)。
*   `SuperDetector_OutputX`: 用于替换 `SuperDetectorX` 的目标文本 (X为对应数字)。
*   `ImageModelAsynchronous`: 用于定义获取图像描述的并发上限。
请根据你的实际环境修改 `config.env` 文件。**不要在 `config.env` 或任何公开的文档中包含真实的密钥。**

## 安装

在项目根目录下打开终端，运行以下命令安装依赖：

```bash
npm install
```
(确保 `node-fetch`, `dotenv`, `express`, `node-schedule`, `chinese-lunar-calendar`, `crypto` 已在 `package.json` 中声明或通过 `npm install <package-name>` 安装。)

## 运行

有两种方式启动服务器：

1.  **直接运行**:
    ```bash
    node server.js
    ```
2.  **使用脚本 (Windows)**:
    双击运行 `start_server.bat` 文件 (如果存在)。

服务器启动后会监听在 `config.env` 中配置的 `Port` 上。

## 工具脚本

### 图片重新识别脚本 (`reidentify_image.js`)

此脚本用于对 `imagebase64.json` 缓存中已有的图片条目进行强制重新识别，并用新的结果覆盖旧的描述。

**用途**:
当发现某个图片的缓存描述不理想时，可以使用此脚本来尝试获取一个更好的描述。

**使用方法**:
1.  确保已安装依赖。
2.  在项目根目录下打开终端。
3.  执行命令: `node reidentify_image.js <IMAGE_ID>`
    *   `<IMAGE_ID>` 是 `imagebase64.json` 文件中，目标图片条目的 `id` 字段的值。

脚本会加载配置，找到指定 ID 的图片，使用 `ImageModel` 进行重新识别，然后更新缓存文件。

### 清理旧图片缓存脚本 (`purge_old_cache.js`)

此脚本用于清理 `imagebase64.json` 缓存文件中超过指定天数（默认为90天）的旧条目。

**用途**:
定期清理旧的图片缓存，以控制 `imagebase64.json` 文件的大小。

**使用方法**:
1.  在项目根目录下打开终端。
2.  执行命令: `node purge_old_cache.js`
    *   可以在脚本内部修改 `MAX_AGE_DAYS` 常量来调整最大缓存天数。

建议定期运行此脚本。

## 图像缓存编辑器 (image_cache_editor.html)
为了更方便地管理和优化由服务端 `server.js` 生成的图像Base64转译文本缓存 (`imagebase64.json`)，我们引入了一个轻量级的本地HTML工具：`image_cache_editor.html`。
该工具完全基于HTML、CSS和JavaScript实现，**无需任何外部依赖或服务器部署**，直接在现代浏览器中打开即可使用。
### 功能亮点：
1.  **加载JSON缓存文件**：
    *   通过标准的“选择文件”对话框，可以轻松加载本地的 `imagebase64.json` 文件。
    *   内置JSON解析和基本的错误处理，确保加载文件的有效性。
2.  **可视化图像列表**：
    *   加载成功后，工具会以网格布局（默认为一行4张图片）清晰展示缓存中的每一条图像记录。
    *   每个条目均以卡片形式呈现，包含以下信息：
        *   **时间戳 (Timestamp)**：显示该缓存条目的生成时间。
        *   **图像预览 (Image Preview)**：直接将Base64编码的图像数据渲染出来，方便快速识别。
            *   支持常见的图像格式（JPEG, PNG, GIF, WEBP），并会尝试根据Base64头部猜测MIME类型。
            *   若图像加载失败（如格式不支持或数据损坏），会显示错误提示。
        *   **可编辑的描述文本域 (Editable Description Textarea)**：
            *   展示AI自动转译的图像描述文本 (`description`)。
            *   该文本域支持多行文本，并能正确渲染和编辑包含换行符 (`\n`) 的内容。
            *   用户可以直接在此处对描述进行人工修改、优化或补充。
        *   **Base64 Key (部分显示)**：显示对应图像Base64数据的前30个字符，方便与原始JSON数据进行核对。
3.  **交互功能**：
    *   **点击图片放大预览 (Click to Enlarge)**：点击卡片中的图像预览图，会弹出一个模态框（Modal），以更大的尺寸显示该图片，方便查看细节。
        *   支持通过点击关闭按钮、点击模态框外部或按 `ESC` 键关闭放大预览。
4.  **保存更改**：
    *   编辑完所有需要修改的描述后，点击“保存更改到新文件”按钮。
    *   工具会将当前界面上所有修改（主要是 `description` 字段）同步回内存中的数据结构。
    *   然后，它会将更新后的完整JSON数据打包成一个新的 `.json` 文件 (默认为 `imagebase64_updated.json`)，并触发浏览器下载。
    *   **注意**：此工具不会直接覆盖原始文件，而是生成一个新文件，以确保数据安全。用户需要手动用新文件替换旧文件（如果确认无误）。
### 使用方法：
1.  直接用浏览器打开 `image_cache_editor.html` 文件。
2.  点击“选择文件”按钮，选择您的 `imagebase64.json` 文件进行加载。
3.  在加载出的图像列表中，找到您想要编辑的条目。
4.  查看图片预览，并在对应的“图像描述”文本框中修改或优化描述内容。
5.  （可选）点击图片进行放大预览，确认图像细节。
6.  完成所有编辑后，点击“保存更改到新文件”按钮。
7.  浏览器将提示您下载名为 `imagebase64_updated.json` 的文件，其中包含了您所有的修改。


## 支持的变量

在发送给中间层服务器的 JSON 请求体 `messages` 数组的字符串内容中，可以使用以下占位符变量：

*   `{{Date}}`: 当前日期 (格式: YYYY/M/D)。
*   `{{Time}}`: 当前时间 (格式: H:MM:SS)。
*   `{{Today}}`: 当天星期几 (中文)。
*   `{{Festival}}`: 农历日期、生肖、节气。
*   `{{VarSystemInfo}}`: `config.env` 中定义的 `VarSystemInfo` 值。
*   `{{WeatherInfo}}`: 当前缓存的天气预报文本。
*   `{{VarCity}}`: `config.env` 中定义的 `VarCity` 值。
*   `{{VarUser}}`: `config.env` 中定义的 `VarUser` 值。
*   `{{VarEmojiPrompt}}`: 动态生成的表情包使用说明，内部包含 `{{通用表情包}}` 和 `{{Image_Key}}`。
*   `{{通用表情包}}`: 通用表情包文件名列表 (由 `|` 分隔)，通常在 `{{VarEmojiPrompt}}` 内部使用。
*   `{{角色名表情包}}`: 特定角色表情包文件名列表 (由 `|` 分隔，例如 `{{小克表情包}}`)。
*   `{{角色名日记本}}`: 指定角色存储的所有日记内容 (例如 `{{小克日记本}}`)。
*   `{{VarHttpUrl}}`, `{{VarHttpsUrl}}`, `{{VarDdnsUrl}}`: `config.env` 中定义的对应 URL 值。
*   `{{Image_Key}}`: `config.env` 中定义的 `Image_Key` 值，主要用于在提示词中构建图片URL。

**注意**: 系统提示词转换、全局上下文转换和图片转译（如果 `Base64Cache=True`）是自动进行的，不需要特定变量来触发。

## 请求与响应示例

**请求示例 (发送给中间层，包含图片)**:

```json
POST /v1/chat/completions HTTP/1.1
Host: localhost:5890
Content-Type: application/json
Authorization: Bearer your_auth_key_here

{
  "model": "your-target-model",
  "messages": [
    {
      "role": "system",
      "content": "今天是 {{Date}} {{Time}} {{Today}} {{Festival}}。\n城市: {{VarCity}}\n天气: {{WeatherInfo}}\n用户信息: {{VarUser}}\n系统信息: {{VarSystemInfo}}\n{{VarEmojiPrompt}}"
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "这张图片里是什么？{{VarUser}}觉得它怎么样？"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,/9j/4AAQSk... (Base64字符串)"
          }
        }
      ]
    }
  ]
}
```
如果 `Base64Cache=True`，中间层处理后，发往后端API的请求中，上述 `user` 消息的 `content` 会变成类似：
```json
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "这张图片里是什么？莱恩，人类，男性。觉得它怎么样？\n[检测到多模态数据，Var工具箱已自动提取图片信息，信息元如下——]\n[IMAGE1Info: 这是一张包含[详细描述]的图片...]"
        }
      ]
    }
```
如果 `Base64Cache=False`，则 `image_url` 部分会原样保留并发送给目标模型。


**AI 回复中包含日记的示例 (由 AI 生成)**:

```text
你好！今天天气[具体天气信息]。
<<<DailyNoteStart>>>
Maid: 小克
Date: 2025.5.5
Content: 今天主人问我天气了，我很开心能帮到他。天气信息已经告诉他了。希望他今天过得愉快喵！
<<<DailyNoteEnd>>>
```

中间层服务器会自动检测 `<<<DailyNoteStart>>>` 和 `<<<DailyNoteEnd>>>` 之间的内容，并将其保存到 `dailynote/小克/2025.5.5.txt` 文件中。
