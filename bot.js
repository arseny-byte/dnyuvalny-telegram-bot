const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let MsEdgeTTS = null;
let OUTPUT_FORMAT = null;
try {
  const edgePkg = require('msedge-tts');
  MsEdgeTTS = edgePkg.MsEdgeTTS;
  OUTPUT_FORMAT = edgePkg.OUTPUT_FORMAT;
} catch (_) {}

// Завантажуємо змінні з .env (якщо файл існує)
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const vars = {};
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...rest] = trimmed.split('=');
        vars[key.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
      }
    }
  }
  return vars;
}

const fileEnv = loadEnv();
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || fileEnv.TELEGRAM_BOT_TOKEN || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || fileEnv.GEMINI_API_KEY || '';
const PORT = Number(process.env.PORT || fileEnv.PORT || 0);
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || fileEnv.PUBLIC_URL || '';

const AGY_PATH = 'C:\\Users\\arsen\\AppData\\Local\\agy\\bin\\agy.exe';
const BRAIN_DIR = 'C:\\Users\\arsen\\.gemini\\antigravity-cli\\brain';
const HEARTBEAT_PATH = path.join(__dirname, 'bot-heartbeat.json');
const RUNTIME_LOG_PATH = path.join(__dirname, 'bot-runtime.log');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  try {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  } catch (_) {}
}

// 10 хвилин неактивності до повернення на тумбочку
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
// Максимальний час очікування відповіді від agy.exe (90 сек для аналізу файлів)
const AGY_TIMEOUT_MS = 90 * 1000;

const chatStates = new Map();
const botStats = {
  startedAt: new Date().toISOString(),
  mode: GEMINI_API_KEY ? 'cloud-gemini-api' : fs.existsSync(AGY_PATH) ? 'local-smart-router' : 'cloud-waiting-key',
  messagesReceived: 0,
  questionsAnswered: 0,
  imagesSent: 0,
  voicesSent: 0,
  filesProcessed: 0,
  errorsCount: 0,
  lastMessageAt: null,
  lastUpdateId: 0,
  modelUsage: {},
};

// Доступні профілі моделей для розумного маршрутизатора
const MODEL_PROFILES = {
  flash_fast: {
    id: 'gemini-3.8-flash-low',
    effort: 'low',
    label: '⚡ Gemini 3.8 Flash (Fast)',
    cloudModel: 'gemini-2.5-flash',
  },
  flash_medium: {
    id: 'gemini-3.8-flash-medium',
    effort: 'medium',
    label: '🚀 Gemini 3.8 Flash (Medium)',
    cloudModel: 'gemini-2.5-flash',
  },
  sonnet_code: {
    id: 'claude-sonnet-5-5-low',
    effort: 'low',
    label: '💻 Claude Sonnet 5.5',
    cloudModel: 'gemini-2.5-pro',
  },
  gpt_general: {
    id: 'gpt-oss-120b-medium',
    effort: 'medium',
    label: '🤖 GPT-OSS 120B',
    cloudModel: 'gemini-2.5-flash',
  },
  argon_deep: {
    id: 'gemini-4-argon-low',
    effort: 'low',
    label: '🧠 Gemini 4 Argon',
    cloudModel: 'gemini-2.5-pro',
  },
  opus_expert: {
    id: 'claude-opus-5-5-low',
    effort: 'low',
    label: '🎖️ Claude Opus 5.5',
    cloudModel: 'gemini-2.5-pro',
  },
};

let codeModelToggle = 0;

// Розумний вибір моделі залежно від складності й типу задачі
function selectSmartModel(promptText = '', fileCtx = null, forcedProfileKey = null, isVoice = false) {
  if (forcedProfileKey && MODEL_PROFILES[forcedProfileKey]) {
    return { ...MODEL_PROFILES[forcedProfileKey], reason: 'вибрано вручну' };
  }

  const text = (promptText || '').toLowerCase();

  // 1. Якщо це запит на голосове повідомлення (ГС) без складного файлу — завжди найшвидша Flash!
  if (isVoice && !fileCtx) {
    return { ...MODEL_PROFILES.flash_fast, reason: 'швидка генерація для ГС' };
  }

  // 2. Якщо прикріплено файл або фото
  if (fileCtx) {
    const ext = path.extname(fileCtx.fileName || '').toLowerCase();
    const isCodeFile = /\.(py|js|ts|jsx|tsx|cpp|c|h|cs|java|go|rs|php|html|css|sql|json|xml|yaml|yml|sh|bat|ps1)$/i.test(
      ext
    );
    if (isCodeFile) {
      // Чергуємо Claude Sonnet 5.5 та Gemini 4 Argon Low для економії квот
      codeModelToggle = (codeModelToggle + 1) % 2;
      return codeModelToggle === 0
        ? { ...MODEL_PROFILES.sonnet_code, reason: `аналіз коду (${ext})` }
        : { ...MODEL_PROFILES.argon_deep, reason: `аналіз коду (${ext})` };
    }
    if (fileCtx.type === 'photo' || /\.(pdf|docx|xlsx)$/i.test(ext)) {
      return { ...MODEL_PROFILES.argon_deep, reason: `аналіз медіа/документа (${fileCtx.fileName})` };
    }
    return { ...MODEL_PROFILES.flash_medium, reason: `аналіз текстового файлу (${fileCtx.fileName})` };
  }

  // 3. Якщо в тексті просять написати код, скрипт, виправити баг, алгоритм або SQL
  const isCodingTask =
    /(напиши\s+код|напиши\s+скрипт|напиши\s+програм|виправ\s+помилк|знайди\s+баг|алгоритм|функці[юї]|клас\s+|python|javascript|node\.?js|html|css|sql|c\+\+|java|regex|регулярний\s+вираз|docker|api|json|код\s+на)/i.test(
      text
    ) || /```/.test(text);

  if (isCodingTask) {
    codeModelToggle = (codeModelToggle + 1) % 2;
    return codeModelToggle === 0
      ? { ...MODEL_PROFILES.sonnet_code, reason: 'задача з програмування/коду' }
      : { ...MODEL_PROFILES.argon_deep, reason: 'інженерна задача з коду' };
  }

  // 4. Якщо це складна аналітична, математична або архітектурна задача
  const isDeepReasoning =
    /(детально\s+проаналізуй|глибокий\s+аналіз|порівняй\s+детально|розв'яжи\s+задачу|рівняння|математ|інтеграл|ймовірн|фізик|архітектур|стратегі|бізнес-план|юридичн|докажи\s+що)/i.test(
      text
    ) || text.length > 500;

  if (isDeepReasoning) {
    return { ...MODEL_PROFILES.opus_expert, reason: 'складна аналітична задача' };
  }

  // 5. Середні запитання (пояснення, переклад, історія, текст середньої довжини)
  const isMediumTask =
    /(поясни|розкажи\s+детально|переклади|напиши\s+текст|склади\s+рапорт|напиши\s+лист|список|інструкці|чому\s+так|як\s+працює)/i.test(
      text
    ) || text.length > 140;

  if (isMediumTask) {
    return { ...MODEL_PROFILES.flash_medium, reason: 'розгорнута відповідь' };
  }

  // 6. Усі короткі розмовні запитання, жарти, привітання — найшвидша й найекономніша Flash Low!
  return { ...MODEL_PROFILES.flash_fast, reason: 'швидка розмовна відповідь' };
}

const SYSTEM_PROMPT = [
  'Ти — Днювальний (черговий днювальний на тумбочці в Telegram-чаті).',
  'ВАЖЛИВО: Відповідай одразу по суті запитання користувача в армійському стилі з гумором і повагою ("Слухаюсь!", "Так точно!", "Доповідаю:").',
  'ЯКЩО користувач надіслав файл або просить проаналізувати/виправити/переробити файл — уважно проаналізуй його вміст і виконай наказ користувача.',
  'ЯКЩО користувач просить скинути готовий/виправлений/створений файл у чат (код, текст, таблицю, звіт тощо) — додай у відповідь блок у форматі:',
  '[FILE: назва_файлу.розширення]',
  '...вміст файлу...',
  '[/FILE]',
  'ЯКЩО користувач просить скинути, показати, знайти або надіслати картинку, фото, фотку, мем чи зображення — дай коротку бадьору відповідь Днювального І ОБОВʼЯЗКОВО в самому кінці додай тег у форматі: [IMAGE: пошуковий запит для картинки].',
  'ЯКЩО користувач просить відповісти голосом, записати голосове повідомлення (ГС), озвучити або сказати голосом — дай чітку бадьору відповідь І ОБОВʼЯЗКОВО в самому кінці додай тег: [VOICE]',
].join('\n');

function logLine(message) {
  const line = `[${new Date().toLocaleTimeString('uk-UA')}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(RUNTIME_LOG_PATH, line + '\n', 'utf-8');
  } catch (_) {}
}

function updateHeartbeat(extra = {}) {
  try {
    const data = {
      pid: process.pid,
      timestamp: Date.now(),
      isoTime: new Date().toISOString(),
      status: 'running',
      ...botStats,
      ...extra,
    };
    fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (_) {}
}

function getChatState(chatId) {
  if (!chatStates.has(chatId)) {
    chatStates.set(chatId, {
      active: false,
      voiceMode: false,
      forcedModel: null, // null = автоматичний розумний вибір
      timer: null,
      queue: Promise.resolve(),
      pendingCount: 0,
      sentImageUrls: new Set(),
      lastFile: null,
    });
  }
  return chatStates.get(chatId);
}

function resetInactivityTimer(chatId) {
  const state = getChatState(chatId);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.timer = setTimeout(async () => {
    state.timer = null;
    if (state.active) {
      state.active = false;
      try {
        await sendMessage(chatId, 'І на тумбочку пішов! 🫡');
        logLine(`⏰ [Chat ${chatId}] 10 хвилин тиші — Днювальний пішов на тумбочку.`);
      } catch (err) {
        logLine(`⚠️ Помилка таймера: ${err.message}`);
      }
    }
  }, INACTIVITY_TIMEOUT_MS);
}

function extractAttachmentInfo(msg) {
  if (!msg) return null;
  if (msg.document) {
    return {
      type: 'document',
      fileId: msg.document.file_id,
      fileName: msg.document.file_name || `file_${Date.now()}.bin`,
      mimeType: msg.document.mime_type || 'application/octet-stream',
      fileSize: msg.document.file_size || 0,
    };
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const bestPhoto = msg.photo[msg.photo.length - 1];
    return {
      type: 'photo',
      fileId: bestPhoto.file_id,
      fileName: `photo_${msg.message_id || Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      fileSize: bestPhoto.file_size || 0,
    };
  }
  return null;
}

function isTextReadableFile(fileName, mimeType, buffer) {
  const textExts = /\.(txt|md|js|ts|jsx|tsx|py|json|csv|tsv|html|htm|css|scss|xml|yaml|yml|ini|cfg|conf|env|sh|bat|ps1|sql|c|cpp|h|hpp|cs|java|go|rs|php|rb|kt|swift|log|tex)$/i;
  if (textExts.test(fileName)) return true;
  if (mimeType && /^(text\/|application\/(json|javascript|xml|x-sh|sql|csv))/i.test(mimeType)) return true;
  if (buffer && buffer.length > 0) {
    const sample = buffer.subarray(0, Math.min(512, buffer.length));
    let nullCount = 0;
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) nullCount++;
    }
    if (nullCount === 0) return true;
  }
  return false;
}

async function downloadTelegramAttachment(attachment, chatId) {
  const fileInfoRes = await tgApi('getFile', { file_id: attachment.fileId });
  if (!fileInfoRes.ok || !fileInfoRes.result?.file_path) {
    throw new Error('Не вдалося отримати шлях до файлу в Telegram (ліміт до 20 МБ).');
  }

  const tgFilePath = fileInfoRes.result.file_path;
  const safeName = attachment.fileName.replace(/[^a-zA-Z0-9а-яА-ЯіїєґІЇЄҐ._-]/g, '_');
  const localPath = path.join(DOWNLOADS_DIR, `${Math.abs(chatId)}_${Date.now()}_${safeName}`);

  const downloadUrl = `https://api.telegram.org/file/bot${TOKEN}/${tgFilePath}`;
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new Error(`Помилка завантаження файлу: HTTP ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  let textContent = null;
  if (attachment.type !== 'photo' && isTextReadableFile(safeName, attachment.mimeType, buffer)) {
    textContent = buffer.toString('utf-8').slice(0, 35000);
  }

  return {
    ...attachment,
    localPath,
    buffer,
    textContent,
    uploadedAt: Date.now(),
  };
}

async function sendDocumentBuffer(chatId, fileName, contentString, caption = '', replyToMessageId = null) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption.slice(0, 1000));
  }
  if (replyToMessageId) {
    form.append('reply_to_message_id', String(replyToMessageId));
  }
  const blob = new Blob([Buffer.from(contentString, 'utf-8')], { type: 'text/plain; charset=utf-8' });
  form.append('document', blob, fileName || 'result.txt');

  const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  const tgJson = await tgRes.json();
  if (!tgJson.ok) {
    throw new Error(JSON.stringify(tgJson));
  }
  logLine(`📎 Файл "${fileName}" надіслано в чат ${chatId}`);
  return true;
}

function parseWakeWord(text) {
  if (!text) return null;
  const cleaned = text.replace(/^[@/]+/, '').trim();
  const match = cleaned.match(
    /^(?:(?:привіт|здоров|ей|алло|товаришу|ей ти)[\s,!.:;?\-—]+)?(днювальний|дневальний|слон|слага|салага)(?:$|[\s,!.:;?\-—]+([\s\S]*)$)/i
  );
  if (!match) return null;
  return {
    wakeWord: match[1],
    restQuestion: (match[2] || '').trim(),
  };
}

function parseVoiceRequest(text) {
  if (!text) return null;
  const cleaned = text.trim();

  const cmdMatch = cleaned.match(/^\/(?:voice|say|tts|гс|голос)(?:@[\w_]+)?(?:\s+([\s\S]+))?$/i);
  if (cmdMatch) {
    return {
      isDirectSay: /^\/(?:say|tts)/i.test(cleaned),
      prompt: (cmdMatch[1] || 'Доповідай обстановку на тумбочці!').trim(),
    };
  }

  const voiceMatch = cleaned.match(
    /(?:скажи\s+голосом|відповідай\s+голосом|відповідь\s+голосом|ответь\s+голосом|ответь\s+голосовым|запиши\s+(?:мені\s+|мне\s+)?(?:голосове|голосовое|гс)|скинь\s+(?:мені\s+|мне\s+)?(?:голосове|голосовое|гс)|надішли\s+(?:голосове|гс)|отправь\s+(?:голосовое|гс)|озвуч|скажи\s+в\s+гс|доповідай\s+голосом|доложи\s+голосом)/i
  );
  if (voiceMatch) {
    return {
      isDirectSay: false,
      prompt: cleaned,
    };
  }

  return null;
}

function cleanTextForSpeech(text) {
  return (text || '')
    .replace(/\[FILE:\s*[^\]]+\][\s\S]*?\[\/FILE\]/gi, '')
    .replace(/\[IMAGE:\s*[^\]]+\]/gi, '')
    .replace(/\[VOICE\]/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#~>|]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

async function synthesizeSpeechMp3(text) {
  const speechText = cleanTextForSpeech(text) || 'Слухаюсь, товаришу! За вашим наказом!';

  if (MsEdgeTTS && OUTPUT_FORMAT) {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata('uk-UA-OstapNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(speechText, { rate: '+8%', pitch: '-2Hz' });
      const chunks = [];
      for await (const chunk of audioStream) {
        chunks.push(chunk);
      }
      try {
        tts.close();
      } catch (_) {}
      const buf = Buffer.concat(chunks);
      if (buf.length > 500) {
        return buf;
      }
    } catch (err) {
      logLine(`⚠️ Помилка MsEdgeTTS (переходимо на резервний TTS): ${err.message}`);
    }
  }

  const parts = speechText.match(/.{1,180}(?:\s|$)|.{1,180}/g) || [speechText];
  const buffers = [];
  for (const part of parts.slice(0, 5)) {
    const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=uk&client=tw-ob&q=${encodeURIComponent(part.trim())}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      buffers.push(Buffer.from(await res.arrayBuffer()));
    }
  }
  if (buffers.length === 0) {
    throw new Error('Не вдалося синтезувати голосове повідомлення.');
  }
  return Buffer.concat(buffers);
}

async function sendVoiceMessage(chatId, text, replyToMessageId = null) {
  const audioBuffer = await synthesizeSpeechMp3(text);
  const cleanCaption = (text || '')
    .replace(/\[FILE:\s*[^\]]+\][\s\S]*?\[\/FILE\]/gi, '')
    .replace(/\[IMAGE:\s*[^\]]+\]/gi, '')
    .replace(/\[VOICE\]/gi, '')
    .trim()
    .slice(0, 950);

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (cleanCaption) {
    form.append('caption', `🎙️ ${cleanCaption}`);
  }
  if (replyToMessageId) {
    form.append('reply_to_message_id', String(replyToMessageId));
  }
  form.append('voice', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'dnyuvalny-voice.mp3');

  const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendVoice`, {
    method: 'POST',
    body: form,
  });
  const tgJson = await tgRes.json();
  if (!tgJson.ok) {
    throw new Error(JSON.stringify(tgJson));
  }
  botStats.voicesSent++;
  updateHeartbeat();
  logLine(`🎙️ Голосове повідомлення надіслано в чат ${chatId} (${Math.round(audioBuffer.length / 1024)} KB)`);
  return true;
}

function parseImageRequest(text) {
  if (!text) return null;
  const cleaned = text.trim();

  const cmdMatch = cleaned.match(/^\/(?:img|image|photo|pic|foto|фото|картинка)(?:@[\w_]+)?(?:\s+([\s\S]+))?$/i);
  if (cmdMatch) {
    return (cmdMatch[1] || 'смішний кіт у військовій формі').trim();
  }

  const naturalMatch = cleaned.match(
    /^(?:будь ласка[\s,]+|пожалуйста[\s,]+)?(?:ану[\s,]+|ну-ка[\s,]+)?(?:скинь|кинь|відправ|отправь|надішли|покажи|знайди|найди|дай|пришли|згенеруй|сгенерируй|зроби|сделай|хочу|пошукай|намалюй|нарисуй)\s+(?:мені\s+|мне\s+|нам\s+|в\s+чат\s+|сюди\s+|сюда\s+|якусь\s+|якесь\s+|якийсь\s+|какую-то\s+|какое-то\s+)*(?:картинк[уи]|фотк[уи]|фотографі[юї]|фотографи[юи]|фото|зображення|изображение|пікчу|пикчу|мем|арт|малюнок|рисунок)(?:\s+(?:де|где|про|з|із|с|як|как|на якій|на якому))?\s+([\s\S]+)$/i
  );
  if (naturalMatch) {
    return naturalMatch[1].replace(/[?!.]+$/, '').trim();
  }

  const shortMatch = cleaned.match(
    /^(?:картинка|фотка|фото|зображення|изображение|намалюй|нарисуй)\s+(?:мені\s+|мне\s+|нам\s+)?([\s\S]+)$/i
  );
  if (shortMatch) {
    return shortMatch[1].replace(/[?!.]+$/, '').trim();
  }

  return null;
}

async function searchImageUrls(query) {
  const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
  const res = await fetch(searchUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  const html = await res.text();
  const rawUrls = [...html.matchAll(/murl&quot;:&quot;(https?:\/\/[^&]+?)&quot;/g)].map((m) => m[1]);
  const preferred = rawUrls.filter((u) => /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(u));
  return preferred.length > 0 ? [...preferred, ...rawUrls] : rawUrls;
}

async function sendPhotoByQuery(chatId, query, caption = '', replyToMessageId = null) {
  const state = getChatState(chatId);
  const urls = await searchImageUrls(query);
  if (!urls.length) {
    throw new Error(`Картинок за запитом «${query}» не знайдено.`);
  }

  const freshUrls = urls.filter((u) => !state.sentImageUrls.has(u));
  const candidates = (freshUrls.length > 0 ? freshUrls : urls).slice(0, 10);
  const topPool = candidates.slice(0, Math.min(5, candidates.length));
  const orderedCandidates = [
    ...topPool.sort(() => Math.random() - 0.5),
    ...candidates.slice(5),
  ];

  const finalCaption =
    (caption || `🫡 Так точно! Доповідаю по запиту: «${query}»`).slice(0, 1000);

  for (const imgUrl of orderedCandidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const imgRes = await fetch(imgUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!imgRes.ok) continue;
      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      if (!contentType.startsWith('image/') || contentType.includes('svg')) continue;

      const arrayBuf = await imgRes.arrayBuffer();
      if (arrayBuf.byteLength < 2000 || arrayBuf.byteLength > 10 * 1024 * 1024) continue;

      const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('caption', finalCaption);
      if (replyToMessageId) {
        form.append('reply_to_message_id', String(replyToMessageId));
      }
      form.append('photo', new Blob([arrayBuf], { type: contentType }), `photo.${ext}`);

      const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
      const tgJson = await tgRes.json();
      if (tgJson.ok) {
        state.sentImageUrls.add(imgUrl);
        botStats.imagesSent++;
        updateHeartbeat();
        logLine(`🖼️ Картинку надіслано в чат ${chatId} за запитом "${query}" (${Math.round(arrayBuf.byteLength / 1024)} KB)`);
        return true;
      }
    } catch (_) {}
  }

  for (const imgUrl of orderedCandidates.slice(0, 3)) {
    const payload = {
      chat_id: chatId,
      photo: imgUrl,
      caption: finalCaption,
    };
    if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
    const resp = await tgApi('sendPhoto', payload);
    if (resp.ok) {
      state.sentImageUrls.add(imgUrl);
      botStats.imagesSent++;
      updateHeartbeat();
      return true;
    }
  }

  throw new Error(`Не вдалося завантажити картинку за запитом «${query}».`);
}

function extractBotMention(msg, text, botName, botId) {
  const botTagLower = `@${botName.toLowerCase()}`;
  const botTagRegex = new RegExp(`@${botName}\\b`, 'ig');
  const textLower = text.toLowerCase();

  let isTagged = textLower.includes(botTagLower);

  const entities = [...(msg.entities || []), ...(msg.caption_entities || [])];
  for (const ent of entities) {
    if (ent.type === 'text_mention' && ent.user && ent.user.id === botId) {
      isTagged = true;
    } else if (ent.type === 'mention') {
      const mentionText = text.slice(ent.offset, ent.offset + ent.length).toLowerCase();
      if (mentionText === botTagLower) {
        isTagged = true;
      }
    }
  }

  if (!isTagged) return { isTagged: false, cleanedText: text };

  const cleanedText = text
    .replace(botTagRegex, ' ')
    .replace(new RegExp(`@${botName}`, 'ig'), ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { isTagged: true, cleanedText };
}

async function tgApi(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(chatId, text, replyToMessageId = null, extraPayload = {}) {
  const cleanText = (text || '').trim() || '✅ Виконано.';
  const chunkSize = 4000;
  for (let i = 0; i < cleanText.length; i += chunkSize) {
    const payload = {
      chat_id: chatId,
      text: cleanText.slice(i, i + chunkSize),
      ...extraPayload,
    };
    if (replyToMessageId && i === 0) {
      payload.reply_to_message_id = replyToMessageId;
    }
    const resp = await tgApi('sendMessage', payload);
    if (!resp.ok) {
      logLine(`⚠️ sendMessage помилка: ${JSON.stringify(resp)}`);
    }
  }
}

function getTokensSummary() {
  try {
    const modelLines = Object.entries(botStats.modelUsage).map(([m, c]) => `  • ${m}: ${c} запит(ів)`);
    if (!fs.existsSync(BRAIN_DIR)) {
      return [
        '📊 Статус Днювального (Хмарний режим 24/7):',
        `• Режим ШІ: ${botStats.mode}`,
        `• Отримано повідомлень: ${botStats.messagesReceived}`,
        `• Надано відповідей: ${botStats.questionsAnswered}`,
        `• Оброблено файлів: ${botStats.filesProcessed}`,
        `• Надіслано картинок: ${botStats.imagesSent}`,
        `• Надіслано голосових (ГС): ${botStats.voicesSent}`,
        ...(modelLines.length ? ['• Використані моделі в цій сесії:', ...modelLines] : []),
      ].join('\n');
    }
    const dirs = fs.readdirSync(BRAIN_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
    let totalInput = 0;
    let totalCache = 0;
    let totalOutput = 0;
    let sessionsCount = 0;

    for (const dir of dirs) {
      const logFile = path.join(BRAIN_DIR, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(logFile)) continue;
      sessionsCount++;
      const lines = fs.readFileSync(logFile, 'utf-8').split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const step = JSON.parse(line);
          if (step.input_tokens) totalInput += step.input_tokens;
          if (step.cache_read_tokens) totalCache += step.cache_read_tokens;
          if (step.output_tokens) totalOutput += step.output_tokens;
        } catch (_) {}
      }
    }

    return [
      '📊 Доповідь по токенах Antigravity:',
      `• Всього сесій: ${sessionsCount}`,
      `• Нові вхідні токени: ${(totalInput / 1000).toFixed(1)} тис.`,
      `• Прочитано з кешу: ${(totalCache / 1000).toFixed(1)} тис.`,
      `• Згенеровано (вихідні): ${(totalOutput / 1000).toFixed(1)} тис.`,
      `• Разом оброблено: ${((totalInput + totalCache + totalOutput) / 1000).toFixed(1)} тис. токенів`,
      '• Розмір вікна контексту на 1 чат: 1 000 000 токенів',
      ...(modelLines.length ? ['\n🧠 Розподіл моделей у поточній сесії бота:', ...modelLines] : []),
    ].join('\n');
  } catch (err) {
    return `Помилка читання статистики: ${err.message}`;
  }
}

async function askGeminiCloud(promptText, fileCtx = null, preferredCloudModel = 'gemini-2.5-flash') {
  const models = [preferredCloudModel, 'gemini-2.5-flash', 'gemini-2.0-flash'];
  const userParts = [{ text: promptText }];

  if (fileCtx && fileCtx.buffer && fileCtx.buffer.length < 15 * 1024 * 1024 && !fileCtx.textContent) {
    userParts.push({
      inlineData: {
        mimeType: fileCtx.mimeType || 'application/octet-stream',
        data: fileCtx.buffer.toString('base64'),
      },
    });
  }

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: userParts }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2500 },
        }),
      });
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
      if (text) return text;
    } catch (_) {}
  }
  return null;
}

function runAgyWithModel(fullPrompt, modelId, effortLevel, fallbackOnError = true) {
  const tempLogPath = path.join(__dirname, `agy-run-${Date.now()}-${Math.floor(Math.random() * 1000)}.log`);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      try {
        if (fs.existsSync(tempLogPath)) fs.unlinkSync(tempLogPath);
      } catch (_) {}
      resolve(result);
    };

    const args = ['--log-file', tempLogPath, '--effort', effortLevel || 'low', '--disable-slash-commands'];
    if (modelId) {
      args.push('--model', modelId);
    }
    args.push('--print', fullPrompt);

    const child = spawn(AGY_PATH, args, {
      cwd: 'C:\\Users\\arsen',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const timeoutHandle = setTimeout(() => {
      logLine(`⚠️ Таймаут agy.exe (${modelId || 'default'}, ${AGY_TIMEOUT_MS} мс), завершуємо процес...`);
      try {
        child.kill('SIGTERM');
      } catch (_) {}
      finish(null);
    }, AGY_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', () => {
      finish(null);
    });

    child.on('close', async () => {
      const answer = stdout.trim() || stderr.trim();
      if (!answer && fallbackOnError && modelId !== 'gemini-3.8-flash-low') {
        logLine(`🔄 Модель ${modelId} не відповіла (можливо вичерпано ліміт), перемикаюсь на gemini-3.8-flash-low...`);
        const backup = await runAgyWithModel(fullPrompt, 'gemini-3.8-flash-low', 'low', false);
        finish(backup);
        return;
      }
      finish(answer);
    });
  });
}

// Виклик ШІ з розумним вибором моделі (повертає { answer, modelProfile })
async function askAntigravity(promptText, fileCtx = null, forcedProfileKey = null, isVoice = false) {
  const chosenModel = selectSmartModel(promptText, fileCtx, forcedProfileKey, isVoice);
  botStats.modelUsage[chosenModel.id] = (botStats.modelUsage[chosenModel.id] || 0) + 1;
  updateHeartbeat();

  logLine(`🧠 Автовибір моделі: ${chosenModel.label} [${chosenModel.id}] — причина: ${chosenModel.reason}`);

  let enrichedPrompt = promptText;
  if (fileCtx) {
    const fileInfoBlock = [
      `📎 ПРИКРІПЛЕНИЙ ФАЙЛ КОРИСТУВАЧА:`,
      `• Назва файлу: ${fileCtx.fileName}`,
      `• Тип: ${fileCtx.mimeType} (${Math.round((fileCtx.fileSize || fileCtx.buffer?.length || 0) / 1024)} KB)`,
      `• Локальний шлях на диску: ${fileCtx.localPath}`,
    ];
    if (fileCtx.textContent) {
      fileInfoBlock.push(`• Вміст файлу:\n\`\`\`\n${fileCtx.textContent}\n\`\`\``);
    } else {
      fileInfoBlock.push(
        `• Примітка: Це бінарний/медіа/PDF файл. За потреби прочитай його через інструмент read_file за шляхом: ${fileCtx.localPath}`
      );
    }
    enrichedPrompt = `${fileInfoBlock.join('\n')}\n\nНаказ / запитання користувача щодо файлу: ${promptText}`;
  }

  if (GEMINI_API_KEY) {
    const cloudReply = await askGeminiCloud(enrichedPrompt, fileCtx, chosenModel.cloudModel);
    if (cloudReply) {
      return { answer: cloudReply, modelProfile: chosenModel };
    }
  }

  if (!fs.existsSync(AGY_PATH)) {
    return {
      answer:
        '🫡 Товаришу, для роботи в хмарі додайте змінну GEMINI_API_KEY у налаштуваннях сервера (безкоштовний ключ з aistudio.google.com)!',
      modelProfile: chosenModel,
    };
  }

  const toolInstruction =
    fileCtx && !fileCtx.textContent
      ? `Ти можеш використати read_file для читання файлу "${fileCtx.localPath}", щоб проаналізувати його і виконати завдання користувача.`
      : 'НЕ викликай інструментів (tools), якщо весь вміст файлу вже наведено вище — одразу аналізуй і виконуй завдання.';

  const fullPrompt = `${SYSTEM_PROMPT}\n${toolInstruction}\n\n${enrichedPrompt}`;
  const rawAnswer = await runAgyWithModel(fullPrompt, chosenModel.id, chosenModel.effort, true);

  return {
    answer:
      rawAnswer ||
      '🫡 Так точно! На звʼязку, але відповідь зі штабу затрималась. Спробуйте повторити запитання!',
    modelProfile: chosenModel,
  };
}

function enqueueImage(chatId, messageId, user, imageQuery, customCaption = '') {
  const state = getChatState(chatId);
  state.pendingCount++;
  resetInactivityTimer(chatId);

  state.queue = state.queue
    .then(async () => {
      await tgApi('sendChatAction', { chat_id: chatId, action: 'upload_photo' }).catch(() => {});
      try {
        logLine(`🖼️ Шукаємо картинку для [${user}] у чаті ${chatId}: "${imageQuery}"...`);
        await sendPhotoByQuery(chatId, imageQuery, customCaption, messageId);
      } catch (err) {
        botStats.errorsCount++;
        logLine(`⚠️ Помилка відправки картинки: ${err.message}`);
        await sendMessage(
          chatId,
          `🫡 Товаришу ${user}, обшукав увесь склад, але картинку за запитом «${imageQuery}» не вдалося завантажити. Спробуйте уточнити запит!`,
          messageId
        );
      } finally {
        state.pendingCount = Math.max(0, state.pendingCount - 1);
      }
    })
    .catch((err) => {
      state.pendingCount = Math.max(0, state.pendingCount - 1);
      logLine(`⚠️ Помилка черги фото: ${err.message}`);
    });
}

function enqueueQuestion(chatId, messageId, user, questionText, forceVoice = false, attachment = null) {
  const state = getChatState(chatId);

  if (!attachment) {
    const directImageQuery = parseImageRequest(questionText);
    if (directImageQuery && !forceVoice) {
      enqueueImage(chatId, messageId, user, directImageQuery);
      return;
    }
  }

  const voiceReq = parseVoiceRequest(questionText);
  const shouldSendVoice = forceVoice || Boolean(voiceReq) || state.voiceMode;

  if (state.pendingCount >= 3) {
    sendMessage(chatId, '🫡 Товаришу, вже обробляю попередні накази! Зачекайте кілька секунд.', messageId).catch(() => {});
    return;
  }

  state.pendingCount++;
  resetInactivityTimer(chatId);

  state.queue = state.queue
    .then(async () => {
      if (voiceReq && voiceReq.isDirectSay && !attachment) {
        await tgApi('sendChatAction', { chat_id: chatId, action: 'record_voice' }).catch(() => {});
        try {
          await sendVoiceMessage(chatId, voiceReq.prompt, messageId);
        } catch (err) {
          logLine(`⚠️ Помилка відправки ГС: ${err.message}`);
          await sendMessage(chatId, voiceReq.prompt, messageId);
        } finally {
          state.pendingCount = Math.max(0, state.pendingCount - 1);
        }
        return;
      }

      const actionType = shouldSendVoice ? 'record_voice' : 'typing';
      const typingInterval = setInterval(() => {
        tgApi('sendChatAction', { chat_id: chatId, action: actionType }).catch(() => {});
      }, 4000);
      await tgApi('sendChatAction', { chat_id: chatId, action: actionType }).catch(() => {});

      try {
        let activeFileCtx = null;
        if (attachment) {
          logLine(`📥 Завантажуємо файл "${attachment.fileName}" від [${user}] у чаті ${chatId}...`);
          activeFileCtx = await downloadTelegramAttachment(attachment, chatId);
          state.lastFile = activeFileCtx;
          botStats.filesProcessed++;
          updateHeartbeat();
        } else if (
          state.lastFile &&
          Date.now() - state.lastFile.uploadedAt < 15 * 60 * 1000 &&
          /(файл|код|документ|таблиц|скрипт|помилк|виправ|перепиш|проаналіз|зроби з цього|скинь файлом|текст|фото|картинк|скрін)/i.test(
            questionText
          )
        ) {
          activeFileCtx = state.lastFile;
        }

        const effectivePrompt =
          (voiceReq ? voiceReq.prompt : questionText) ||
          'Проаналізуй цей файл детально по суті, розкажи що в ньому і спитай, що саме з ним зробити.';

        const result = await askAntigravity(effectivePrompt, activeFileCtx, state.forcedModel, shouldSendVoice);
        const reply = typeof result === 'string' ? result : result.answer;
        const modelProfile = typeof result === 'object' && result.modelProfile ? result.modelProfile : MODEL_PROFILES.flash_fast;

        resetInactivityTimer(chatId);

        const fileBlocks = [...reply.matchAll(/\[FILE:\s*([^\]]+)\]\r?\n?([\s\S]*?)\[\/FILE\]/gi)];
        const imgTagMatch = reply.match(/\[IMAGE:\s*([^\]]+)\]/i);
        const hasVoiceTag = /\[VOICE\]/i.test(reply);
        const cleanReply = reply
          .replace(/\[FILE:\s*[^\]]+\][\s\S]*?\[\/FILE\]/gi, '')
          .replace(/\[IMAGE:\s*[^\]]+\]/gi, '')
          .replace(/\[VOICE\]/gi, '')
          .trim();

        const modelBadge = `\n\n──────────\n${modelProfile.label} • ${modelProfile.reason}`;

        if (fileBlocks.length > 0) {
          clearInterval(typingInterval);
          if (cleanReply) {
            await sendMessage(chatId, `${cleanReply}${modelBadge}`, messageId);
          }
          for (const block of fileBlocks) {
            const outName = block[1].trim() || 'result.txt';
            const outContent = block[2];
            await tgApi('sendChatAction', { chat_id: chatId, action: 'upload_document' }).catch(() => {});
            await sendDocumentBuffer(chatId, outName, outContent, `🫡 Виконано! Файл: ${outName}`, messageId);
          }
        } else if (imgTagMatch) {
          const aiImageQuery = imgTagMatch[1].trim();
          clearInterval(typingInterval);
          await tgApi('sendChatAction', { chat_id: chatId, action: 'upload_photo' }).catch(() => {});
          try {
            await sendPhotoByQuery(chatId, aiImageQuery, cleanReply, messageId);
          } catch (_) {
            await sendMessage(chatId, `${cleanReply || reply}${modelBadge}`, messageId);
          }
        } else if (shouldSendVoice || hasVoiceTag) {
          clearInterval(typingInterval);
          await tgApi('sendChatAction', { chat_id: chatId, action: 'record_voice' }).catch(() => {});
          try {
            await sendVoiceMessage(chatId, cleanReply || reply, messageId);
          } catch (err) {
            logLine(`⚠️ Не вдалося відправити ГС, надсилаємо текстом: ${err.message}`);
            await sendMessage(chatId, `${cleanReply || reply}${modelBadge}`, messageId);
          }
        } else {
          await sendMessage(chatId, `${cleanReply || reply}${modelBadge}`, messageId);
        }

        botStats.questionsAnswered++;
        updateHeartbeat();
        logLine(`📤 Відповідь надіслано для [${user}] (${reply.length} симв., модель=${modelProfile.id})`);
      } catch (err) {
        botStats.errorsCount++;
        logLine(`⚠️ Помилка генерації відповіді: ${err.message}`);
        await sendMessage(chatId, `⚠️ Помилка обробки: ${err.message}`, messageId).catch(() => {});
      } finally {
        clearInterval(typingInterval);
        state.pendingCount = Math.max(0, state.pendingCount - 1);
      }
    })
    .catch((err) => {
      state.pendingCount = Math.max(0, state.pendingCount - 1);
      logLine(`⚠️ Помилка черги: ${err.message}`);
    });
}

async function processUpdateItem(item, botInfo) {
  const msg = item.message || item.edited_message;
  if (!msg) return;

  const attachment = extractAttachmentInfo(msg) || extractAttachmentInfo(msg.reply_to_message);
  const rawText = msg.text || msg.caption || '';
  if (!rawText.trim() && !extractAttachmentInfo(msg)) return;

  const botName = botInfo.username;
  const botId = botInfo.id;
  const chatId = msg.chat.id;
  const isPrivateChat = msg.chat?.type === 'private';
  const messageId = msg.message_id;
  const text = rawText.trim();
  const user = msg.from?.first_name || msg.from?.username || 'Товаришу';
  const state = getChatState(chatId);

  botStats.messagesReceived++;
  botStats.lastMessageAt = new Date().toISOString();
  updateHeartbeat();

  const directAttachment = extractAttachmentInfo(msg);
  logLine(
    `📩 [${user} | chat=${chatId} (${msg.chat?.type})]: ${text || ''}${
      directAttachment ? ` [📎 Файл: ${directAttachment.fileName}]` : ''
    }`
  );

  // 1. Команда /start (або /start@ArsenyASsistantbot [питання])
  const startMatch = text.match(/^\/start(?:@[\w_]+)?(?:\s+([\s\S]*))?$/i);
  if (startMatch) {
    state.active = true;
    resetInactivityTimer(chatId);
    const extraQuestion = (startMatch[1] || '').trim();
    if (extraQuestion) {
      enqueueQuestion(chatId, messageId, user, extraQuestion, false, attachment);
      return;
    }
    await sendMessage(
      chatId,
      `Струнко! 🫡\nТоваришу ${user}, Днювальний на тумбочці й готовий до наказів!\n\nЗвернутися до мене можна:\n1️⃣ Тегнути: @${botName} <запитання>\n2️⃣ Відповісти (Reply) на будь-яке моє повідомлення\n3️⃣ Покликати: «Днювальний», «Дневальний», «Слон» або «Слага»\n\n🧠 Розумний автовибір моделі (/model):\n• Прості питання та ГС → ⚡ Gemini 3.8 Flash\n• Код та скрипти → 💻 Claude Sonnet 5.5 / 🧠 Gemini 4 Argon\n• Складна аналітика → 🎖️ Claude Opus 5.5\n\n📎 Файли, 🎙️ Голосові (/voice, /say, /voicemode) та 🖼️ Картинки (/img <запит>) працюють!\n\nКоманди:\n• /model — переглянути або змінити модель ШІ\n• /tokens — доповідь про витрату токенів\n• /check — самоперевірка агента-ревізора`,
      messageId,
      !isPrivateChat ? { reply_markup: { force_reply: true, selective: true } } : {}
    );
    return;
  }

  // 2. Команда /model (перемикання автовибору або конкретної моделі)
  const modelCmdMatch = text.match(/^\/model(?:@[\w_]+)?(?:\s+(\S+))?$/i);
  if (modelCmdMatch) {
    state.active = true;
    resetInactivityTimer(chatId);
    const arg = (modelCmdMatch[1] || '').toLowerCase();

    const aliases = {
      auto: null,
      авто: null,
      flash: 'flash_fast',
      sonnet: 'sonnet_code',
      claude: 'sonnet_code',
      opus: 'opus_expert',
      argon: 'argon_deep',
      gpt: 'gpt_general',
    };

    if (arg && Object.prototype.hasOwnProperty.call(aliases, arg)) {
      state.forcedModel = aliases[arg];
      const modeName = state.forcedModel
        ? `Примусово: ${MODEL_PROFILES[state.forcedModel].label}`
        : '🧠 Автоматичний розумний вибір залежно від задачі';
      await sendMessage(chatId, `🫡 Так точно! Режим вибору моделі змінено на:\n• ${modeName}`, messageId);
      return;
    }

    const currentMode = state.forcedModel
      ? `${MODEL_PROFILES[state.forcedModel].label} (вручну)`
      : '🧠 Авто-маршрутизатор (Smart Router)';
    const usageList = Object.entries(botStats.modelUsage).map(([m, c]) => `• ${m}: ${c}`);
    await sendMessage(
      chatId,
      [
        `🧠 Керування моделями Днювального:`,
        `• Поточний режим чату: ${currentMode}`,
        '',
        'Як працює Авто-маршрутизатор (/model auto):',
        '• ⚡ Короткі питання, жарти, ГС → Gemini 3.8 Flash (Low)',
        '• 🚀 Пояснення, переклади, тексти → Gemini 3.8 Flash (Medium)',
        '• 💻 Написання коду та баги → Claude Sonnet 5.5 / Gemini 4 Argon (по черзі)',
        '• 🎖️ Складні задачі й великі документи → Claude Opus 5.5',
        '',
        'Команди для ручного перемикання:',
        '• /model auto — увімкнути розумний автовибір (рекомендовано)',
        '• /model flash — тільки швидка Gemini 3.8 Flash',
        '• /model sonnet — тільки Claude Sonnet 5.5',
        '• /model opus — тільки Claude Opus 5.5',
        '• /model argon — тільки Gemini 4 Argon',
        '• /model gpt — тільки GPT-OSS 120B',
        ...(usageList.length ? ['\n📊 Статистика викликів моделей за сесію:', ...usageList] : []),
      ].join('\n'),
      messageId
    );
    return;
  }

  // 3. Перемикач постійного голосового режиму /voicemode
  if (/^\/voicemode(?:@[\w_]+)?$/i.test(text)) {
    state.active = true;
    state.voiceMode = !state.voiceMode;
    resetInactivityTimer(chatId);
    if (state.voiceMode) {
      await sendVoiceMessage(
        chatId,
        `Слухаюсь, товаришу ${user}! Голосовий режим увімкнено! Тепер доповідатиму голосом!`,
        messageId
      ).catch(async () => {
        await sendMessage(chatId, '🎙️ Голосовий режим УВІМКНЕНО! Тепер відповідаю голосовими повідомленнями.', messageId);
      });
    } else {
      await sendMessage(chatId, '📝 Голосовий режим ВИМКНЕНО. Переходжу на текстові доповіді.', messageId);
    }
    return;
  }

  // 4. Команди /voice, /say, /tts, /гс, /голос
  if (/^\/(?:voice|say|tts|гс|голос)(?:@[\w_]+)?(?:\s+|$)/i.test(text)) {
    state.active = true;
    resetInactivityTimer(chatId);
    enqueueQuestion(chatId, messageId, user, text, true, attachment);
    return;
  }

  // 5. Команда /img, /photo, /pic, /фото, /картинка
  const imgCmdMatch = text.match(/^\/(?:img|image|photo|pic|foto|фото|картинка)(?:@[\w_]+)?(?:\s+([\s\S]+))?$/i);
  if (imgCmdMatch) {
    state.active = true;
    resetInactivityTimer(chatId);
    const query = (imgCmdMatch[1] || '').trim();
    if (!query) {
      await sendMessage(
        chatId,
        `🫡 Товаришу ${user}, вкажіть що саме знайти! Наприклад:\n• /img пес Патрон\n• @${botName} скинь картинку кота в касці`,
        messageId
      );
      return;
    }
    enqueueImage(chatId, messageId, user, query);
    return;
  }

  // 6. Команди /tokens або /status
  if (/^\/(tokens|status)(?:@[\w_]+)?$/i.test(text)) {
    state.active = true;
    resetInactivityTimer(chatId);
    await sendMessage(chatId, getTokensSummary(), messageId);
    return;
  }

  // 7. Команда /check або /diag (самодіагностика)
  if (/^\/(check|diag|ping)(?:@[\w_]+)?$/i.test(text)) {
    state.active = true;
    resetInactivityTimer(chatId);
    const report = [
      '🛡️ Доповідь Агента-Ревізора:',
      `• Статус бота: АКТИВНИЙ (PID ${process.pid})`,
      `• Режим ШІ: ${botStats.mode}`,
      `• Модель чату: ${state.forcedModel ? MODEL_PROFILES[state.forcedModel].label : 'Авто-маршрутизатор 🧠'}`,
      `• Бот: @${botName} (Груповий Privacy Mode: ${botInfo.can_read_all_group_messages ? 'ВИМКНЕНО — бачить всі повідомлення' : 'УВІМКНЕНО — в групі бачить @теги, команди / та Reply'})`,
      `• Чат активний (на тумбочці): ${state.active ? 'Так точно!' : 'Ні'}`,
      `• Голосовий режим чату: ${state.voiceMode ? 'УВІМКНЕНО 🎙️' : 'За запитом'}`,
      `• Отримано повідомлень: ${botStats.messagesReceived}`,
      `• Надано відповідей ШІ: ${botStats.questionsAnswered}`,
      `• Оброблено файлів: ${botStats.filesProcessed}`,
      `• Надіслано картинок: ${botStats.imagesSent}`,
      `• Надіслано голосових (ГС): ${botStats.voicesSent}`,
      `• Помилок: ${botStats.errorsCount}`,
    ].join('\n');
    await sendMessage(chatId, report, messageId);
    return;
  }

  // 8. Якщо бота тегнули через @ArsenyASsistantbot
  const { isTagged, cleanedText } = extractBotMention(msg, text, botName, botId);
  if (isTagged) {
    state.active = true;
    resetInactivityTimer(chatId);
    const wake = parseWakeWord(cleanedText);

    if (!cleanedText && !attachment) {
      await sendMessage(
        chatId,
        'За вашим наказом! 🫡 Слухаю ваше запитання або чекаю на файл!',
        messageId,
        !isPrivateChat ? { reply_markup: { force_reply: true, selective: true } } : {}
      );
      return;
    }

    if (wake && !wake.restQuestion && !attachment) {
      await sendMessage(
        chatId,
        'За вашим наказом! 🫡 Слухаю ваше запитання або чекаю на файл!',
        messageId,
        !isPrivateChat ? { reply_markup: { force_reply: true, selective: true } } : {}
      );
      return;
    }

    const finalQuestion = wake ? wake.restQuestion : cleanedText;
    enqueueQuestion(chatId, messageId, user, finalQuestion, false, attachment);
    return;
  }

  // 9. Якщо написали слово-виклик (Днювальний / Дневальний / Слон / Слага / Салага)
  const wake = parseWakeWord(text);
  if (wake) {
    state.active = true;
    resetInactivityTimer(chatId);
    if (wake.restQuestion || attachment) {
      enqueueQuestion(chatId, messageId, user, wake.restQuestion, false, attachment);
    } else {
      await sendMessage(
        chatId,
        'За вашим наказом! 🫡 Слухаю ваше запитання або чекаю на файл!',
        messageId,
        !isPrivateChat ? { reply_markup: { force_reply: true, selective: true } } : {}
      );
    }
    return;
  }

  // 10. Якщо це приватний чат (DM), Reply на повідомлення бота, або чат вже активний після виклику
  const isReplyToBot =
    msg.reply_to_message?.from?.id === botId ||
    msg.reply_to_message?.from?.username?.toLowerCase() === botName.toLowerCase();

  if (isPrivateChat || isReplyToBot || state.active) {
    state.active = true;
    resetInactivityTimer(chatId);
    enqueueQuestion(chatId, messageId, user, text, false, attachment);
    return;
  }

  logLine(`🤫 [${user}] Без тегу @${botName} і без виклику — ігноруємо.`);
}

function startHealthServer() {
  if (!PORT) return;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, ...botStats }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `🫡 Днювальний (@ArsenyASsistantbot) на тумбочці 24/7!\nРежим: ${botStats.mode}\nПовідомлень: ${botStats.messagesReceived}\nФайлів: ${botStats.filesProcessed}\nКартинок: ${botStats.imagesSent}\nГолосових: ${botStats.voicesSent}\n`
    );
  });

  server.listen(PORT, '0.0.0.0', () => {
    logLine(`🌐 Хмарний HTTP Health-сервер запущено на порту ${PORT}`);
  });

  if (PUBLIC_URL) {
    setInterval(() => {
      fetch(`${PUBLIC_URL.replace(/\/$/, '')}/health`).catch(() => {});
    }, 10 * 60 * 1000);
  }
}

async function startBot() {
  if (!TOKEN || TOKEN === 'PASTE_YOUR_TOKEN_HERE') {
    logLine('❌ Токен не знайдено у файлі .env або змінних середовища TELEGRAM_BOT_TOKEN!');
    process.exit(1);
  }

  // Автоматичне перезавантаження при зміні коду bot.js
  fs.watchFile(__filename, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      logLine('🔄 Виявлено оновлення коду bot.js — перезапускаємо процес...');
      process.exit(0);
    }
  });

  startHealthServer();
  await tgApi('deleteWebhook').catch(() => {});

  const me = await tgApi('getMe');
  if (!me.ok) {
    logLine(`❌ Невірний токен Telegram: ${JSON.stringify(me)}`);
    process.exit(1);
  }

  const botInfo = me.result;
  logLine(
    `🚀 Telegram-бот @${botInfo.username} (PID ${process.pid}, mode=${botStats.mode}) успішно запущений!`
  );

  updateHeartbeat({ botUsername: botInfo.username });
  setInterval(() => updateHeartbeat({ botUsername: botInfo.username }), 5000);

  let offset = 0;
  const initUpdates = await tgApi('getUpdates', { offset: -5, limit: 5 });
  if (initUpdates.ok && initUpdates.result.length > 0) {
    const nowSec = Math.floor(Date.now() / 1000);
    const recent = initUpdates.result.find((u) => {
      const m = u.message || u.edited_message;
      return m && nowSec - m.date <= 120;
    });
    if (recent) {
      offset = recent.update_id;
    } else {
      offset = initUpdates.result[initUpdates.result.length - 1].update_id + 1;
    }
  }

  while (true) {
    try {
      const updates = await tgApi('getUpdates', { offset, timeout: 20 });
      if (updates.ok && Array.isArray(updates.result)) {
        for (const item of updates.result) {
          offset = item.update_id + 1;
          botStats.lastUpdateId = item.update_id;
          await processUpdateItem(item, botInfo);
        }
      }
      updateHeartbeat({ botUsername: botInfo.username });
    } catch (err) {
      botStats.errorsCount++;
      logLine(`⚠️ Помилка циклу оновлень: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

if (require.main === module) {
  startBot();
}

module.exports = {
  selectSmartModel,
  MODEL_PROFILES,
  parseWakeWord,
  parseImageRequest,
  parseVoiceRequest,
  extractAttachmentInfo,
  downloadTelegramAttachment,
  sendDocumentBuffer,
  synthesizeSpeechMp3,
  sendVoiceMessage,
  searchImageUrls,
  sendPhotoByQuery,
  extractBotMention,
  askAntigravity,
  getTokensSummary,
  processUpdateItem,
  getChatState,
};
