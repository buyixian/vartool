// server.js
const express = require('express');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const schedule = require('node-schedule');
const lunarCalendar = require('chinese-lunar-calendar'); // 导入整个模块
const fs = require('fs').promises; // 使用 fs.promises 进行异步文件操作
const path = require('path');
const { Writable } = require('stream'); // 引入 Writable 用于收集流数据
const crypto = require('crypto'); // 新增：用于生成 UUID

// 加载环境变量
dotenv.config({ path: 'config.env' });

// --- 新增：图片转译和缓存相关 ---
const imageModelName = process.env.ImageModel;
const imagePromptText = process.env.ImagePrompt;
const imageCacheFilePath = path.join(__dirname, 'imagebase64.json');
let imageBase64Cache = {}; // 内存缓存
const imageModelOutputMaxTokens = parseInt(process.env.ImageModelOutput, 10) || 1024; 
const imageModelThinkingBudget = parseInt(process.env.ImageModelThinkingBudget, 10); 
const enableBase64Cache = (process.env.Base64Cache || "True").toLowerCase() === "true"; 
const imageModelAsynchronousLimit = parseInt(process.env.ImageModelAsynchronous, 10) || 1; 
// --- 图片转译和缓存相关结束 ---

// --- 读取系统提示词转换规则 ---
const detectors = [];
for (const key in process.env) {
    if (/^Detector\d+$/.test(key)) {
        const index = key.substring(8); 
        const outputKey = `Detector_Output${index}`;
        if (process.env[outputKey]) {
            detectors.push({
                detector: process.env[key],
                output: process.env[outputKey]
            });
            console.log(`加载转换规则: "${process.env[key]}" -> "${process.env[outputKey]}"`);
        } else {
            console.warn(`警告: 找到 ${key} 但未找到对应的 ${outputKey}`);
        }
    }
}
if (detectors.length > 0) {
    console.log(`共加载了 ${detectors.length} 条系统提示词转换规则。`);
} else {
    console.log('未加载任何系统提示词转换规则。');
}
// --- 转换规则读取结束 ---

// --- 读取全局上下文转换规则 ---
const superDetectors = [];
for (const key in process.env) {
    if (/^SuperDetector\d+$/.test(key)) {
        const index = key.substring(13); 
        const outputKey = `SuperDetector_Output${index}`;
        if (process.env[outputKey]) {
            superDetectors.push({
                detector: process.env[key],
                output: process.env[outputKey]
            });
            console.log(`加载全局上下文转换规则: "${process.env[key]}" -> "${process.env[outputKey]}"`);
        } else {
            console.warn(`警告: 找到 ${key} 但未找到对应的 ${outputKey}`);
        }
    }
}
if (superDetectors.length > 0) {
    console.log(`共加载了 ${superDetectors.length} 条全局上下文转换规则。`);
} else {
    console.log('未加载任何全局上下文转换规则。');
}
// --- 全局上下文转换规则读取结束 ---

const app = express();
// 修正 Port 的读取，使用大写 P，并提供默认值
const port = process.env.Port || 8000; 
const apiKey = process.env.API_Key; 
const apiUrl = process.env.API_URL; 
const serverKey = process.env.Key; 
// const systemInfo = process.env.VarSystemInfo; // 将由 Varxxx 通用逻辑处理
const weatherInfoPath = process.env.VarWeatherInfo || 'Weather.txt'; 
const weatherModel = process.env.WeatherModel;
const weatherPromptTemplate = process.env.WeatherPrompt; 
// const city = process.env.VarCity; // 将由 Varxxx 通用逻辑处理
const emojiPromptTemplate = process.env.VarEmojiPrompt; 
// const userInfo = process.env.VarUser; // 将由 Varxxx 通用逻辑处理

let cachedWeatherInfo = ''; 
const cachedEmojiLists = new Map(); 

app.use(express.json({ limit: '300mb' })); 
app.use(express.urlencoded({ limit: '300mb', extended: true })); 

const imageAuthMiddleware = (req, res, next) => {
    const pathSegmentWithKey = req.params.pathSegmentWithKey; 
    const serverImageKeyForAuth = process.env.Image_Key;

    if (pathSegmentWithKey && pathSegmentWithKey.startsWith('pw=')) {
        const requestImageKey = pathSegmentWithKey.substring(3); 
        if (requestImageKey === serverImageKeyForAuth) {
            next(); 
        } else {
            return res.status(401).type('text/plain').send('Unauthorized: Invalid key for image access.');
        }
    } else {
        return res.status(400).type('text/plain').send('Bad Request: Invalid image access path format.');
    }
};

app.use('/:pathSegmentWithKey/images', imageAuthMiddleware, express.static(path.join(__dirname, 'image')));
console.log(`受保护的图片服务已启动，访问路径格式: /pw=YOUR_IMAGE_KEY/images/...`);

app.use((req, res, next) => {
    console.log(`[${new Date().toLocaleString()}] Received ${req.method} request for ${req.url} from ${req.ip}`);
    next(); 
});
app.use((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${serverKey}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

async function updateAndLoadAgentEmojiList(agentName, dirPath, filePath) {
    console.log(`尝试更新 ${agentName} 表情包列表...`);
    let newList = '';
    let errorMessage = ''; 
    try {
        const files = await fs.readdir(dirPath);
        const imageFiles = files.filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file));
        newList = imageFiles.join('|');
        await fs.writeFile(filePath, newList);
        console.log(`${agentName} 表情包列表已更新并写入 ${filePath}`);
        errorMessage = newList; 
    } catch (error) {
        if (error.code === 'ENOENT') {
            errorMessage = `${agentName} 表情包目录 ${dirPath} 不存在，无法生成列表。`;
            console.error(errorMessage);
        } else {
            errorMessage = `更新或写入 ${agentName} 表情包列表 ${filePath} 时出错: ${error.message}`;
            console.error(errorMessage, error);
        }
        try {
            await fs.writeFile(filePath, errorMessage);
            console.log(`已创建空的 ${filePath} 文件，内容为错误信息。`);
        } catch (writeError) {
            console.error(`创建空的 ${filePath} 文件失败:`, writeError);
        }
        try {
            const oldList = await fs.readFile(filePath, 'utf-8');
            if (oldList !== errorMessage) {
                console.log(`从 ${filePath} 加载了旧的 ${agentName} 表情包列表。`);
                errorMessage = oldList; 
            }
        } catch (readError) {
            if (readError.code !== 'ENOENT') {
                console.error(`读取旧的 ${agentName} 表情包列表 ${filePath} 失败:`, readError);
            }
        }
    }
    return errorMessage; 
}

// --- 全新升级的 replaceCommonVariables 函数 ---
async function replaceCommonVariables(text, maidName, clientIp) { // maidName, clientIp 可能是旧版遗留，新逻辑中未直接使用
    if (text == null) {
        return ''; 
    }
    let processedText = String(text); 
    const now = new Date();

    // {{Date}} - 日期
    const date = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    processedText = processedText.replace(/\{\{Date\}\}/g, date);

    // {{Time}} - 时间
    const time = now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' });
    processedText = processedText.replace(/\{\{Time\}\}/g, time);

    // {{Today}}
    const today = now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' }).replace('星期', ''); // 移除 "星期"
    processedText = processedText.replace(/\{\{Today\}\}/g, today);
    
    // {{Festival}}
    const year = now.getFullYear();
    const month = now.getMonth() + 1; 
    const day = now.getDate();
    const lunarDate = lunarCalendar.getLunar(year, month, day); 
    let yearName = lunarDate.lunarYear.replace('年', ''); 
    let festivalInfo = `${yearName}${lunarDate.zodiac}年${lunarDate.dateStr}`; 
    if (lunarDate.solarTerm) { 
        festivalInfo += ` ${lunarDate.solarTerm}`;
    }
    processedText = processedText.replace(/\{\{Festival\}\}/g, festivalInfo);

    // {{WeatherInfo}}
    processedText = processedText.replace(/\{\{WeatherInfo\}\}/g, cachedWeatherInfo || '天气信息不可用');

    // --- 通用处理 {{Varxxx}} 占位符 ---
    for (const envKey in process.env) {
        if (envKey.startsWith('Var')) {
            const placeholder = `{{${envKey}}}`; 
            const value = process.env[envKey];
            processedText = processedText.replaceAll(placeholder, value || `未配置${envKey}`);
        }
    }
    // --- {{Varxxx}} 处理结束 ---

   // --- 动态处理 {{xx表情包}} 占位符 ---
   const emojiPlaceholderRegex = /\{\{(.+?表情包)\}\}/g;
   // 需要确保在循环外声明 emojiMatch，或者使用 Array.from 来避免迭代问题
   const allEmojiMatches = Array.from(processedText.matchAll(emojiPlaceholderRegex));
   for (const emojiMatch of allEmojiMatches) {
       const placeholder = emojiMatch[0]; 
       const emojiName = emojiMatch[1]; 
       const emojiList = cachedEmojiLists.get(emojiName); // 从缓存读取
       // replaceAll 确保如果一个占位符出现多次，都会被替换
       processedText = processedText.replaceAll(placeholder, emojiList || `${emojiName}列表不可用`);
   }

   // {{EmojiPrompt}} - 动态生成通用 Emoji 提示
   if (processedText.includes('{{EmojiPrompt}}')) {
       let finalEmojiPrompt = '';
       if (emojiPromptTemplate) {
           const generalEmojiList = cachedEmojiLists.get('通用表情包'); // 从缓存读取
           finalEmojiPrompt = emojiPromptTemplate.replace(/\{\{通用表情包\}\}/g, generalEmojiList || '通用表情包列表不可用');
           // 确保 EmojiPrompt 模板中的 {{Image_Key}} 也被替换
           if (process.env.Image_Key) {
               finalEmojiPrompt = finalEmojiPrompt.replaceAll('{{Image_Key}}', process.env.Image_Key);
           }
       }
       processedText = processedText.replace(/\{\{EmojiPrompt\}\}/g, finalEmojiPrompt);
   }

    // --- 处理 {{角色名日记本}} 占位符 (全新递归读取逻辑) ---
    const diaryPlaceholderRegexGlobal = /\{\{(.+?)日记本\}\}/g; // 使用全局正则
    let tempProcessedTextForDiary = processedText; 
    const diaryMatches = Array.from(tempProcessedTextForDiary.matchAll(diaryPlaceholderRegexGlobal)); 
    const processedCharactersForDiary = new Set();

    async function getAllTxtFilePaths(dirPath) {
        let txtFiles = [];
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    txtFiles = txtFiles.concat(await getAllTxtFilePaths(fullPath));
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.txt')) {
                    txtFiles.push(fullPath);
                }
            }
        } catch (error) {
            // console.warn(`[Diary] Warning: Could not read directory ${dirPath}: ${error.message}`);
        }
        return txtFiles;
    }

    function extractDateAndIndexForSort(filePath) {
        const fileName = path.basename(filePath, '.txt'); 
        const parts = fileName.split('(');
        const dayPart = parseInt(parts[0], 10);
        let indexPart = 0;
        if (parts.length > 1 && parts[1].endsWith(')')) {
            indexPart = parseInt(parts[1].slice(0, -1), 10);
        }

        const pathParts = filePath.split(path.sep);
        // 路径结构: .../dailynote/角色名/年/月/日.txt
        // 年份在倒数第三个(-3)，月份在倒数第二个(-2)
        const monthStr = pathParts[pathParts.length - 2];
        const yearStr = pathParts[pathParts.length - 3];
        const monthPart = parseInt(monthStr, 10);
        const yearPart = parseInt(yearStr, 10);

        if (isNaN(yearPart) || isNaN(monthPart) || isNaN(dayPart)) {
            return { year: 0, month: 0, day: 0, index: 0, originalPath: filePath, isValidDate: false };
        }
        return { year: yearPart, month: monthPart, day: dayPart, index: indexPart, originalPath: filePath, isValidDate: true };
    }

    for (const match of diaryMatches) {
        const placeholder = match[0]; 
        const characterName = match[1]; 

        if (processedCharactersForDiary.has(characterName)) {
            // 如果这个角色的日记占位符在文本中出现多次，后续的直接用已处理的内容替换
            // 需要找到第一次替换后的完整内容块
            const diaryBlockRegex = new RegExp(escapeRegExp(`【${characterName}日记本内容如下】`) + `([\\s\\S]*?)` + escapeRegExp(`【${characterName}日记本结束】`));
            const existingContentMatch = tempProcessedTextForDiary.match(diaryBlockRegex);
            if (existingContentMatch && existingContentMatch[0]) {
                 tempProcessedTextForDiary = tempProcessedTextForDiary.replaceAll(placeholder, existingContentMatch[0]);
            } else {
                // 如果找不到完整的内容块（理论上不应该），则使用一个通用提示
                tempProcessedTextForDiary = tempProcessedTextForDiary.replaceAll(placeholder, `【${characterName}日记本内容已在别处展示】`);
            }
            continue;
        }

        let diaryContent = `【${characterName}日记本内容为空或不存在】`; 
        const baseDiaryPath = path.join(__dirname, 'dailynote', characterName);

        try {
            const allTxtFileFullPaths = await getAllTxtFilePaths(baseDiaryPath);

            if (allTxtFileFullPaths.length > 0) {
                const sortedFileMeta = allTxtFileFullPaths.map(extractDateAndIndexForSort)
                    .filter(meta => meta.isValidDate) 
                    .sort((a, b) => {
                        if (a.year !== b.year) return a.year - b.year;
                        if (a.month !== b.month) return a.month - b.month;
                        if (a.day !== b.day) return a.day - b.day;
                        return a.index - b.index;
                    });

                const fileContents = [];
                for (const meta of sortedFileMeta) { // Iterate over sorted metadata
                    try {
                        const fileData = await fs.readFile(meta.originalPath, 'utf-8');
                        const datePrefix = `[${meta.year}/${meta.month}/${meta.day}${meta.index > 0 ? `(${meta.index})` : ''}]`;
                        fileContents.push(`${datePrefix}\n${fileData.trim()}`);
                    } catch (readError) {
                        console.error(`[Diary] 读取日记文件 ${meta.originalPath} 失败:`, readError);
                        fileContents.push(`[读取文件 ${path.basename(meta.originalPath)} 失败]`);
                    }
                }
                
                if (fileContents.length > 0) {
                    const joinedContent = fileContents.join('\n\n---\n\n');
                    if (joinedContent.trim()) {
                        diaryContent = `【${characterName}日记本内容如下】\n\n${joinedContent}\n\n【${characterName}日记本结束】`;
                    } else {
                        diaryContent = `【${characterName}日记本内容为空，但文件存在】`;
                    }
                }
            }
        } catch (error) {
            console.error(`[Diary] 遍历 ${characterName} 的日记目录 ${baseDiaryPath} 失败:`, error);
            diaryContent = `【读取${characterName}日记本失败，请检查服务器日志】`;
        }
        
        tempProcessedTextForDiary = tempProcessedTextForDiary.replaceAll(placeholder, diaryContent);
        processedCharactersForDiary.add(characterName);
    }
    processedText = tempProcessedTextForDiary; 
    // --- 日记本占位符处理结束 ---

    // --- 系统提示词转换 ---
    for (const rule of detectors) {
        if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
             processedText = processedText.replaceAll(rule.detector, rule.output);
        }
    }
    // --- 系统提示词转换结束 ---

    // --- 全局上下文转换 ---
    for (const rule of superDetectors) {
        if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
             processedText = processedText.replaceAll(rule.detector, rule.output);
        }
    }
    // --- 全局上下文转换结束 ---

    // 确保文本中最终不会残留 {{Image_Key}} 占位符 (例如从 VarEmojiPrompt 引入的)
    if (processedText && typeof processedText === 'string' && process.env.Image_Key) {
        processedText = processedText.replaceAll('{{Image_Key}}', process.env.Image_Key);
    }

    return processedText;
}

// 辅助函数，用于在 RegExp 中转义特殊字符
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
}

// --- 天气获取与缓存逻辑 ---
async function fetchAndUpdateWeather() {
    console.log('尝试获取最新的天气信息...');
    if (!apiUrl || !apiKey || !weatherModel || !weatherPromptTemplate) {
        console.error('获取天气所需的配置不完整 (API_URL, API_Key, WeatherModel, WeatherPrompt)');
        cachedWeatherInfo = '天气服务配置不完整';
        return;
    }
    try {
        const now = new Date();
        const date = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
        let prompt = weatherPromptTemplate.replace(/\{\{Date\}\}/g, date);
        prompt = prompt.replace(/\{\{VarCity\}\}/g, process.env.VarCity || '默认城市');

        const weatherModelMaxTokens = parseInt(process.env.WeatherModelMaxTokens, 10); 
        const apiPayload = { 
            model: weatherModel,
            messages: [{ role: 'user', content: prompt }]
        };
        if (weatherModelMaxTokens && !isNaN(weatherModelMaxTokens) && weatherModelMaxTokens > 0) {
            apiPayload.max_tokens = weatherModelMaxTokens;
            console.log(`[WeatherFetch] 天气 API 调用使用 MaxTokens: ${weatherModelMaxTokens}`);
        }
        const response = await fetch(`${apiUrl}/v1/chat/completions`, { 
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(apiPayload), 
        });
        if (!response.ok) {
            let errorBody = '';
            try { errorBody = await response.text(); } catch (e) { /* ignore */ }
            throw new Error(`天气 API 调用失败: ${response.status} ${response.statusText}. Body: ${errorBody}`);
        }
        const data = await response.json(); 
        const weatherContent = data.choices?.[0]?.message?.content || ''; 
        console.log('Final extracted content:', weatherContent); 
        const match = weatherContent.match(/\[WeatherInfo:(.*?)\]/s); 
        if (match && match[1]) {
            cachedWeatherInfo = match[1].trim();
            console.log('天气信息已更新并缓存。');
            try {
                await fs.writeFile(weatherInfoPath, cachedWeatherInfo);
                console.log(`天气信息已写入 ${weatherInfoPath}`);
            } catch (writeError) {
                console.error(`写入天气文件 ${weatherInfoPath} 失败:`, writeError);
            }
        } else {
            console.warn('从 API 返回结果中未能提取到 [WeatherInfo:...] 格式的天气信息。原始返回:', weatherContent);
            cachedWeatherInfo = '未能从API获取有效天气信息';
        }
    } catch (error) {
        console.error('获取或处理天气信息时出错:', error);
        cachedWeatherInfo = `获取天气信息时出错: ${error.message}`;
    }
}

// --- 日记处理函数 ---
async function handleDailyNote(noteBlockContent) {
    const lines = noteBlockContent.trim().split('\n');
    let maidName = null;
    let dateString = null;
    let contentLines = [];
    let isContentSection = false;

    for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith('Maid:')) {
            maidName = trimmedLine.substring(5).trim();
            isContentSection = false; 
        } else if (trimmedLine.startsWith('Date:')) {
            dateString = trimmedLine.substring(5).trim();
            isContentSection = false;
        } else if (trimmedLine.startsWith('Content:')) {
            isContentSection = true;
            const firstContentPart = trimmedLine.substring(8).trim();
            if (firstContentPart) {
                contentLines.push(firstContentPart);
            }
        } else if (isContentSection) {
            contentLines.push(line); 
        }
    }
    const contentText = contentLines.join('\n').trim(); 
    if (!maidName || !dateString || !contentText) {
        console.error('[handleDailyNote] 无法从日记块中完整提取 Maid, Date, 或 Content:', { maidName, dateString, contentText: contentText.substring(0,100)+ '...' });
        return;
    }

    // 使用 Date 对象来解析和格式化日期，确保路径正确
    const dateParts = dateString.match(/(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
    if (!dateParts) {
        console.error(`[handleDailyNote] 无法解析日期字符串: ${dateString}`);
        return;
    }
    const year = dateParts[1];
    const month = dateParts[2]; // getMonth() is 0-indexed, but here we have actual month
    const day = dateParts[3];

    const dirPath = path.join(__dirname, 'dailynote', maidName, String(year), String(month));
    const baseFileNameWithoutExt = String(day); // 文件名只用“日”
    const fileExtension = '.txt';
    let finalFileName = `${baseFileNameWithoutExt}${fileExtension}`; 
    let filePath = path.join(dirPath, finalFileName);
    let counter = 1;

    try {
        await fs.mkdir(dirPath, { recursive: true });
        while (true) {
            try {
                await fs.access(filePath, fs.constants.F_OK); 
                finalFileName = `${baseFileNameWithoutExt}(${counter})${fileExtension}`; 
                filePath = path.join(dirPath, finalFileName);
                counter++;
            } catch (err) {
                if (err.code === 'ENOENT') {
                    break; 
                } else {
                    console.error(`[handleDailyNote] 检查文件 ${filePath} 存在性时发生意外错误:`, err);
                    throw err; 
                }
            }
        }
        await fs.writeFile(filePath, `[${year}/${month}/${day}] - ${maidName}\n${contentText}`); 
        console.log(`[handleDailyNote] 日记文件写入成功: ${filePath}`); 
    } catch (error) {
        console.error(`[handleDailyNote] 处理日记文件 ${filePath} 时捕获到错误:`, error);
    }
}

// --- 代理路由 ---
async function saveImageCache() {
    try {
        await fs.writeFile(imageCacheFilePath, JSON.stringify(imageBase64Cache, null, 2));
    } catch (error) {
        console.error(`保存图片 Base64 缓存到 ${imageCacheFilePath} 失败:`, error);
    }
}

async function translateImageAndCache(base64DataWithPrefix, imageIndexForLabel) {
    const base64PrefixPattern = /^data:image\/[^;]+;base64,/;
    const pureBase64Data = base64DataWithPrefix.replace(base64PrefixPattern, '');
    const imageMimeType = (base64DataWithPrefix.match(base64PrefixPattern) || ['data:image/jpeg;base64,'])[0].replace('base64,', '');
    const cachedEntry = imageBase64Cache[pureBase64Data];
    if (cachedEntry) {
        const description = typeof cachedEntry === 'string' ? cachedEntry : cachedEntry.description;
        console.log(`[ImageCache] 命中缓存 (ID: ${typeof cachedEntry === 'object' ? cachedEntry.id : 'N/A - old format'})，图片 ${imageIndexForLabel + 1}`);
        return `[IMAGE${imageIndexForLabel + 1}Info: ${description}]`;
    }
    console.log(`[ImageTranslate] 开始转译图片 ${imageIndexForLabel + 1}，调用 API...`);
    if (!imageModelName || !imagePromptText || !apiKey || !apiUrl) {
        console.error('图片转译所需的配置不完整 (ImageModel, ImagePrompt, API_Key, API_URL)');
        return `[IMAGE${imageIndexForLabel + 1}Info: 图片转译服务配置不完整]`;
    }
    const maxRetries = 3;
    let attempt = 0;
    let lastError = null;
    while (attempt < maxRetries) {
        attempt++;
        console.log(`[ImageTranslate] 图片 ${imageIndexForLabel + 1}，尝试 #${attempt}`);
        try {
            const payload = {
                model: imageModelName,
                messages: [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: imagePromptText },
                            { type: "image_url", image_url: { url: `${imageMimeType}base64,${pureBase64Data}` } }
                        ]
                    }
                ],
                max_tokens: imageModelOutputMaxTokens, 
            };
            if (imageModelThinkingBudget && !isNaN(imageModelThinkingBudget) && imageModelThinkingBudget > 0) {
                payload.extra_body = { 
                    thinking_config: {
                        thinking_budget: imageModelThinkingBudget
                    }
                };
                console.log(`[ImageTranslate] 使用 Thinking Budget: ${imageModelThinkingBudget}`);
            }
            const fetchResponse = await fetch(`${apiUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify(payload),
            });
            if (!fetchResponse.ok) {
                const errorText = await fetchResponse.text();
                throw new Error(`API 调用失败 (尝试 ${attempt}): ${fetchResponse.status} ${fetchResponse.statusText} - ${errorText}`);
            }
            const result = await fetchResponse.json();
            const description = result.choices?.[0]?.message?.content?.trim();
            if (description && description.length >= 50) { 
                console.log(`[ImageTranslate] 图片 ${imageIndexForLabel + 1} 转译成功且内容足够 (尝试 #${attempt})。长度: ${description.length}`);
                const cleanedDescription = description.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
                if (description.length !== cleanedDescription.length) {
                    console.warn(`[ImageTranslate] 清理了描述中的特殊字符。原长度: ${description.length}, 清理后长度: ${cleanedDescription.length}. Base64Key (头30): ${pureBase64Data.substring(0,30)}`);
                }
                const newCacheEntry = {
                    id: crypto.randomUUID(),
                    description: cleanedDescription, 
                    timestamp: new Date().toISOString()
                };
                imageBase64Cache[pureBase64Data] = newCacheEntry;
                await saveImageCache(); 
                return `[IMAGE${imageIndexForLabel + 1}Info: ${description}]`;
            } else if (description) { 
                lastError = new Error(`描述过短 (长度: ${description.length}, 少于50字符) (尝试 ${attempt})。内容: ${description.substring(0,100)}...`);
                console.warn(`[ImageTranslate] 图片 ${imageIndexForLabel + 1} ${lastError.message}`);
            } else { 
                lastError = new Error(`转译结果中未找到描述 (尝试 ${attempt})。原始返回: ${JSON.stringify(result)}`);
                console.warn(`[ImageTranslate] 图片 ${imageIndexForLabel + 1} ${lastError.message}`);
            }
        } catch (error) {
            lastError = error; 
            console.error(`[ImageTranslate] 图片 ${imageIndexForLabel + 1} 转译时出错 (尝试 #${attempt}):`, error.message);
        }
        if (attempt < maxRetries) {
            console.log(`[ImageTranslate] 图片 ${imageIndexForLabel + 1}，将在500ms后重试...`);
            await new Promise(resolve => setTimeout(resolve, 500)); 
        }
    }
    console.error(`[ImageTranslate] 图片 ${imageIndexForLabel + 1} 在 ${maxRetries} 次尝试后转译失败。最后错误: ${lastError ? lastError.message : '未知错误'}`);
    return `[IMAGE${imageIndexForLabel + 1}Info: 图片转译在 ${maxRetries} 次尝试后失败: ${lastError ? lastError.message.substring(0,150) : '未知错误'}...]`;
}

app.post('/v1/chat/completions', async (req, res) => {
    try {
        const originalBody = req.body;
        let globalImageIndexForLabel = 0; 
        if (enableBase64Cache) {
            console.log('[Base64Cache] 功能已启用，开始处理图片...');
            if (originalBody.messages && Array.isArray(originalBody.messages)) {
                for (let i = 0; i < originalBody.messages.length; i++) {
                    const msg = originalBody.messages[i];
                if (msg.role === 'user' && Array.isArray(msg.content)) {
                    const imagePartsToTranslate = [];
                    const contentWithoutImages = []; 
                    for (const part of msg.content) {
                        if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string' && part.image_url.url.startsWith('data:image')) {
                            imagePartsToTranslate.push(part.image_url.url);
                        } else {
                            contentWithoutImages.push(part);
                        }
                    }
                    if (imagePartsToTranslate.length > 0) {
                        const allTranslatedImageTexts = [];
                        console.log(`[ImageAsync] 准备处理 ${imagePartsToTranslate.length} 张图片，并发上限: ${imageModelAsynchronousLimit}`);
                        for (let j = 0; j < imagePartsToTranslate.length; j += imageModelAsynchronousLimit) { // Changed i to j
                            const chunkToTranslate = imagePartsToTranslate.slice(j, j + imageModelAsynchronousLimit);
                            console.log(`[ImageAsync] 处理批次: ${Math.floor(j / imageModelAsynchronousLimit) + 1}, 图片数量: ${chunkToTranslate.length}`);
                            const translationPromisesInChunk = chunkToTranslate.map((base64Url) =>
                                translateImageAndCache(base64Url, globalImageIndexForLabel++) 
                            );
                            const translatedTextsInChunk = await Promise.all(translationPromisesInChunk);
                            allTranslatedImageTexts.push(...translatedTextsInChunk);
                        }
                        console.log(`[ImageAsync] 所有图片处理完成，共获得 ${allTranslatedImageTexts.length} 条描述。`);
                        let userTextPart = contentWithoutImages.find(p => p.type === 'text');
                        if (!userTextPart) {
                            userTextPart = { type: 'text', text: '' };
                            contentWithoutImages.unshift(userTextPart); 
                        }
                        userTextPart.text = (userTextPart.text ? userTextPart.text.trim() + '\n' : '') + '[检测到多模态数据，Var工具箱已自动提取图片信息，信息元如下——]\n' + allTranslatedImageTexts.join('\n');
                        msg.content = contentWithoutImages; 
                        }
                    }
                }
            }
            console.log('[Base64Cache] 图片处理完成。');
        } else {
            console.log('[Base64Cache] 功能已禁用，跳过图片转译和缓存处理。');
        }
        if (originalBody.messages && Array.isArray(originalBody.messages)) {
            originalBody.messages = await Promise.all(originalBody.messages.map(async (msg) => {
                const newMessage = JSON.parse(JSON.stringify(msg)); 
                if (newMessage.content && typeof newMessage.content === 'string') {
                    newMessage.content = await replaceCommonVariables(newMessage.content);
                } else if (Array.isArray(newMessage.content)) {
                    newMessage.content = await Promise.all(newMessage.content.map(async (part) => {
                        if (part.type === 'text' && typeof part.text === 'string') {
                            const newPart = JSON.parse(JSON.stringify(part));
                            newPart.text = await replaceCommonVariables(newPart.text);
                            return newPart;
                        }
                        return part;
                    }));
                }
                return newMessage;
            }));
        }
        const response = await fetch(`${apiUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`, 
                ...(req.headers['user-agent'] && { 'User-Agent': req.headers['user-agent'] }),
                ...(req.headers['accept'] && { 'Accept': req.headers['accept'] }),
            },
            body: JSON.stringify(originalBody), 
        });
        res.status(response.status);
        response.headers.forEach((value, name) => {
            if (!['content-encoding', 'transfer-encoding', 'connection', 'content-length', 'keep-alive'].includes(name.toLowerCase())) {
                 res.setHeader(name, value);
            }
        });
        const chunks = []; 
        response.body.on('data', (chunk) => {
            chunks.push(chunk); 
            res.write(chunk);   
        });
        response.body.on('end', () => {
            res.end(); 
            const responseBuffer = Buffer.concat(chunks);
            const responseString = responseBuffer.toString('utf-8');
            let fullAiResponseText = '';
            let successfullyParsed = false;
            const lines = responseString.trim().split('\n');
            let sseContent = '';
            const looksLikeSSE = lines.some(line => line.startsWith('data: '));
            if (looksLikeSSE) {
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonData = line.substring(5).trim();
                        if (jsonData === '[DONE]') continue;
                        try {
                            const parsedData = JSON.parse(jsonData);
                            const contentChunk = parsedData.choices?.[0]?.delta?.content || parsedData.choices?.[0]?.message?.content || '';
                            if (contentChunk) {
                                sseContent += contentChunk;
                            }
                        } catch (e) { /* ignore */ }
                    }
                }
                if (sseContent) {
                    fullAiResponseText = sseContent;
                    successfullyParsed = true;
                    console.log('[DailyNote Check] 成功从 SSE 流中提取内容。');
                }
            }
            if (!successfullyParsed) {
                try {
                    const parsedJson = JSON.parse(responseString);
                    const jsonContent = parsedJson.choices?.[0]?.message?.content;
                    if (jsonContent && typeof jsonContent === 'string') {
                        fullAiResponseText = jsonContent;
                        successfullyParsed = true;
                        console.log('[DailyNote Check] 成功从 JSON 响应中提取内容。');
                    } else {
                        console.warn('[DailyNote Check] JSON 响应格式不符合预期，无法提取 message.content。');
                    }
                } catch (e) {
                    if (!looksLikeSSE) {
                        console.warn('[DailyNote Check] 响应不是有效的 JSON 对象。无法提取内容。原始响应 (前500字符):', responseString.substring(0, 500));
                    } else {
                        console.log('[DailyNote Check] SSE 流解析未提取到有效内容。');
                    }
                }
            }
            let match = null; 
            if (successfullyParsed && fullAiResponseText) {
                const dailyNoteRegex = /<<<DailyNoteStart>>>(.*?)<<<DailyNoteEnd>>>/s;
                match = fullAiResponseText.match(dailyNoteRegex); 
            } else if (!successfullyParsed) {
                console.log('[DailyNote Check] 未能成功解析响应内容，跳过日记标记检查。');
            }
            if (match && match[1]) {
                const noteBlockContent = match[1].trim(); 
                console.log('[DailyNote Check] 找到结构化日记标记，准备处理...'); 
                handleDailyNote(noteBlockContent).catch(err => {
                    console.error("处理结构化日记时发生未捕获错误:", err);
                });
            } else {
                 console.log('[DailyNote Check] 未找到结构化日记标记。'); 
            }
        });
        response.body.on('error', (err) => {
            console.error('API 响应流错误:', err);
            if (!res.writableEnded) {
                res.status(500).end('API response stream error');
            }
        });
    } catch (error) {
        console.error('处理请求或转发时出错:', error);
        if (!res.headersSent) {
             res.status(500).json({ error: 'Internal Server Error', details: error.message });
        } else {
             console.error("Headers already sent, cannot send error JSON.");
             res.end();
        }
    }
});

async function initialize() {
    console.log('开始初始化表情包列表...');
    const imageDir = path.join(__dirname, 'image');
    try {
        const entries = await fs.readdir(imageDir, { withFileTypes: true });
        const emojiDirs = entries.filter(entry => entry.isDirectory() && entry.name.endsWith('表情包'));
        if (emojiDirs.length === 0) {
            console.warn(`警告: 在 ${imageDir} 目录下未找到任何以 '表情包' 结尾的文件夹。`);
        } else {
            console.log(`找到 ${emojiDirs.length} 个表情包目录，开始加载...`);
            await Promise.all(emojiDirs.map(async (dirEntry) => {
                const emojiName = dirEntry.name;
                const dirPath = path.join(imageDir, emojiName);
                const filePath = path.join(__dirname, `${emojiName}.txt`);
                console.log(`正在处理 ${emojiName}... 目录: ${dirPath}, 列表文件: ${filePath}`);
                try {
                    const listContent = await updateAndLoadAgentEmojiList(emojiName, dirPath, filePath);
                    cachedEmojiLists.set(emojiName, listContent.split('|')); // 存为数组
                    console.log(`${emojiName} 列表已加载并缓存。`);
                } catch (loadError) {
                    console.error(`加载 ${emojiName} 列表时出错:`, loadError);
                    cachedEmojiLists.set(emojiName, [`${emojiName}列表加载失败`]);
                }
            }));
            console.log('所有表情包列表加载完成。');
        }
    } catch (error) {
        console.error(`读取 image 目录 ${imageDir} 时出错:`, error);
    }
    console.log('表情包列表初始化结束。');
    console.log('开始初始化图片 Base64 缓存...');
    try {
        const data = await fs.readFile(imageCacheFilePath, 'utf-8');
        imageBase64Cache = JSON.parse(data);
        console.log(`从 ${imageCacheFilePath} 加载了 ${Object.keys(imageBase64Cache).length} 条图片缓存。`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`${imageCacheFilePath} 文件不存在，将创建新的缓存。`);
            imageBase64Cache = {}; 
            try {
                await fs.writeFile(imageCacheFilePath, JSON.stringify(imageBase64Cache, null, 2));
                console.log(`已创建空的 ${imageCacheFilePath} 文件。`);
            } catch (writeError) {
                console.error(`创建空的 ${imageCacheFilePath} 文件失败:`, writeError);
            }
        } else {
            console.error(`读取图片缓存文件 ${imageCacheFilePath} 失败:`, error);
            imageBase64Cache = {};
        }
    }
    console.log('图片 Base64 缓存初始化结束。');
    try {
        cachedWeatherInfo = await fs.readFile(weatherInfoPath, 'utf-8');
        console.log(`从 ${weatherInfoPath} 加载了缓存的天气信息。`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`${weatherInfoPath} 文件不存在，将尝试首次获取天气信息。`);
            await fetchAndUpdateWeather();
        } else {
            console.error(`读取天气文件 ${weatherInfoPath} 失败:`, error);
            cachedWeatherInfo = '读取天气缓存失败';
        }
    }
    schedule.scheduleJob('0 4 * * *', fetchAndUpdateWeather);
    console.log('已安排每天凌晨4点自动更新天气信息。');
}

app.listen(port, async () => { // port 变量已在顶部修正为 process.env.Port
    console.log(`中间层服务器正在监听端口 ${port}`);
    console.log(`API 服务器地址: ${apiUrl}`);
    await initialize(); 
});
