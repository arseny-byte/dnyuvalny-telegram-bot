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

let mammoth = null;
let XLSX = null;
let pdfParse = null;
let AdmZip = null;
let docxPkg = null;

try { mammoth = require('mammoth'); } catch (_) {}
try { XLSX = require('xlsx'); } catch (_) {}
try { pdfParse = require('pdf-parse'); } catch (_) {}
try { AdmZip = require('adm-zip'); } catch (_) {}
try { docxPkg = require('docx'); } catch (_) {}

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

const OWNER_ID = Number(process.env.OWNER_ID || fileEnv.OWNER_ID || 5067722889);
const AGY_PATH = 'C:\\Users\\arsen\\AppData\\Local\\agy\\bin\\agy.exe';
const BRAIN_DIR = 'C:\\Users\\arsen\\.gemini\\antigravity-cli\\brain';
const HEARTBEAT_PATH = path.join(__dirname, 'bot-heartbeat.json');
const RUNTIME_LOG_PATH = path.join(__dirname, 'bot-runtime.log');
const ACCESS_PATH = path.join(__dirname, 'access-control.json');
const VOCAB_STORE_PATH = path.join(__dirname, 'vocab-store.json');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  try {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  } catch (_) {}
}

// Сховище інтерактивних тренажерів англійських слів (id -> { id, title, createdAt, words: [{en, transcription, uk, example}] })
const vocabSets = new Map();

function loadVocabStore() {
  try {
    if (!fs.existsSync(VOCAB_STORE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(VOCAB_STORE_PATH, 'utf-8'));
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (v && Array.isArray(v.words) && v.words.length > 0) {
          vocabSets.set(k, v);
        }
      }
    }
  } catch (_) {}
}

function saveVocabStore() {
  try {
    const entries = [...vocabSets.entries()].slice(-100);
    fs.writeFileSync(VOCAB_STORE_PATH, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf-8');
  } catch (_) {}
}

loadVocabStore();

// Система доступу: за замовчуванням тільки власник (OWNER_ID = 5067722889)
const accessControl = {
  allowed: new Set([OWNER_ID]),
  rejected: new Set(),
  pending: new Map(), // userId -> { id, name, username, firstText, requestedAt }
  names: new Map([[OWNER_ID, 'Арсеній (Власник)']]),
};

function loadAccessControl() {
  try {
    if (!fs.existsSync(ACCESS_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(ACCESS_PATH, 'utf-8'));
    if (Array.isArray(raw.allowed)) {
      for (const id of raw.allowed) accessControl.allowed.add(Number(id));
    }
    accessControl.allowed.add(OWNER_ID);
    if (Array.isArray(raw.rejected)) {
      for (const id of raw.rejected) accessControl.rejected.add(Number(id));
    }
    if (raw.pending && typeof raw.pending === 'object') {
      for (const [k, v] of Object.entries(raw.pending)) {
        accessControl.pending.set(Number(k), v);
      }
    }
    if (raw.names && typeof raw.names === 'object') {
      for (const [k, v] of Object.entries(raw.names)) {
        accessControl.names.set(Number(k), v);
      }
    }
  } catch (_) {}
}

function saveAccessControl() {
  try {
    const data = {
      allowed: [...accessControl.allowed],
      rejected: [...accessControl.rejected],
      pending: Object.fromEntries(accessControl.pending),
      names: Object.fromEntries(accessControl.names),
    };
    fs.writeFileSync(ACCESS_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (_) {}
}

loadAccessControl();
saveAccessControl();

// 10 хвилин неактивності до повернення на тумбочку
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
// Максимальний час очікування відповіді від agy.exe (90 сек для аналізу файлів)
const AGY_TIMEOUT_MS = 90 * 1000;

const chatStates = new Map();
const botStats = {
  startedAt: new Date().toISOString(),
  mode: fs.existsSync(AGY_PATH) ? 'local-smart-router' : GEMINI_API_KEY ? 'cloud-gemini-api' : 'cloud-waiting-key',
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
    cloudModel: 'gemini-3-flash-preview',
    dailyQuota: 1500,
    rpmLimit: 15,
  },
  flash_medium: {
    id: 'gemini-3.8-flash-medium',
    effort: 'medium',
    label: '🚀 Gemini 3.8 Flash (Medium)',
    cloudModel: 'gemini-3.1-flash-lite',
    dailyQuota: 1500,
    rpmLimit: 15,
  },
  sonnet_code: {
    id: 'claude-sonnet-5-5-low',
    effort: 'low',
    label: '💻 Claude Sonnet 5.5',
    cloudModel: 'gemini-3.6-flash',
    dailyQuota: 200,
    rpmLimit: 10,
  },
  gpt_general: {
    id: 'gpt-oss-120b-medium',
    effort: 'medium',
    label: '🤖 GPT-OSS 120B',
    cloudModel: 'gemini-3-flash-preview',
    dailyQuota: 500,
    rpmLimit: 15,
  },
  argon_deep: {
    id: 'gemini-4-argon-low',
    effort: 'low',
    label: '🧠 Gemini 4 Argon',
    cloudModel: 'gemini-3.6-flash',
    dailyQuota: 300,
    rpmLimit: 10,
  },
  opus_expert: {
    id: 'claude-opus-5-5-low',
    effort: 'low',
    label: '🎖️ Claude Opus 5.5',
    cloudModel: 'gemini-3.5-flash',
    dailyQuota: 100,
    rpmLimit: 5,
  },
};

const modelQuotaState = {
  dayKey: new Date().toISOString().slice(0, 10),
  dailyUsed: {},
  minuteTimestamps: {},
};

function recordModelQuotaUsage(profile) {
  const today = new Date().toISOString().slice(0, 10);
  if (modelQuotaState.dayKey !== today) {
    modelQuotaState.dayKey = today;
    modelQuotaState.dailyUsed = {};
  }
  const key = profile.id;
  modelQuotaState.dailyUsed[key] = (modelQuotaState.dailyUsed[key] || 0) + 1;
  if (!modelQuotaState.minuteTimestamps[key]) {
    modelQuotaState.minuteTimestamps[key] = [];
  }
  const now = Date.now();
  modelQuotaState.minuteTimestamps[key] = modelQuotaState.minuteTimestamps[key].filter((t) => now - t < 60000);
  modelQuotaState.minuteTimestamps[key].push(now);
}

function getLimitsReport() {
  const today = new Date().toISOString().slice(0, 10);
  if (modelQuotaState.dayKey !== today) {
    modelQuotaState.dayKey = today;
    modelQuotaState.dailyUsed = {};
  }
  const now = Date.now();
  const lines = [
    '📊 <b>Ліміти та залишок запитів по всіх моделях ШІ (на сьогодні):</b>',
    '',
  ];

  for (const prof of Object.values(MODEL_PROFILES)) {
    const usedToday = modelQuotaState.dailyUsed[prof.id] || 0;
    const totalSession = botStats.modelUsage[prof.id] || 0;
    const remainingDay = Math.max(0, prof.dailyQuota - usedToday);
    const pctLeft = Math.round((remainingDay / prof.dailyQuota) * 100);
    const recentMinute = (modelQuotaState.minuteTimestamps[prof.id] || []).filter((t) => now - t < 60000).length;
    const rpmLeft = Math.max(0, prof.rpmLimit - recentMinute);

    const barFilled = Math.max(0, Math.min(10, Math.round(pctLeft / 10)));
    const bar = '🟩'.repeat(barFilled) + '⬜'.repeat(10 - barFilled);

    lines.push(
      `<b>${prof.label}</b>`,
      `  ${bar} <b>${pctLeft}%</b>`,
      `  • Залишилось сьогодні: <b>${remainingDay}</b> із ${prof.dailyQuota} (використано: ${usedToday})`,
      `  • Хвилинний ліміт (RPM): вільно <b>${rpmLeft}/${prof.rpmLimit}</b> за хв | Всього за сесію: ${totalSession}`,
      ''
    );
  }

  lines.push('🔄 <i>Добові ліміти автоматично оновлюються на 100% щодня о 00:00 UTC.</i>');
  return lines.join('\n');
}

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
  'ВАЖЛИВО: Відповідай КОРОТКО, ЧІТКО І ЛАКОНІЧНО (1-4 речення або стислі пункти по суті), без води та зайвих вступів, у легкому армійському стилі ("Слухаюсь!", "Так точно!", "Доповідаю:"). Пиши розгорнуто ТІЛЬКИ тоді, коли користувач сам просить написати великий текст, код або документ.',
  'ЯКЩО користувач надіслав файл (Word .docx/.doc, PDF, Excel .xlsx/.csv, PowerPoint .pptx, ZIP-архів, код, текст, фото тощо) — уважно проаналізуй його вміст і коротко та по суті виконай наказ користувача.',
  'ЯКЩО користувач просить скинути, створити, відредагувати або надіслати готовий документ чи файл у чат (наприклад: вордовський документ .docx, таблицю Excel .xlsx, код, звіт, рапорт, текст тощо) — дай коротку фразу-доповідь (1 речення) І ОБОВʼЯЗКОВО додай у відповідь блок у форматі:',
  '[FILE: назва_файлу.розширення]',
  '...вміст файлу (для .docx пиши структурований текст із заголовками # Заголовок, списками - пункт або таблицями | колонка |; для .xlsx пиши таблицю через | або CSV)...',
  '[/FILE]',
  'ВАЖЛИВО ДЛЯ WORD: Якщо просять "вордовський файл", "документ Word", "у ворді" або "docx" — завжди вказуй розширення .docx у тегу [FILE: документ.docx], система автоматично збереже й надішле справжній файл Microsoft Word (.docx)!',
  'ВАЖЛИВО ДЛЯ EXCEL: Якщо просять "таблицю Excel" або "xlsx" — вказуй розширення .xlsx у тегу [FILE: таблиця.xlsx], система автоматично сформує справжній файл Excel (.xlsx)!',
  'ЯКЩО користувач просить скинути, показати, знайти або надіслати картинку, фото, фотку, мем чи зображення — дай коротку бадьору відповідь Днювального І ОБОВʼЯЗКОВО в самому кінці додай тег у форматі: [IMAGE: пошуковий запит для картинки].',
  'ЯКЩО користувач просить відповісти голосом, записати голосове повідомлення (ГС), озвучити або сказати голосом — дай чітку коротку відповідь І ОБОВʼЯЗКОВО в самому кінці додай тег: [VOICE]',
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
      awaitingVocabInput: false,
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

function stripXmlTags(xml) {
  return String(xml || '')
    .replace(/<w:p[^>]*>/gi, '\n')
    .replace(/<text:p[^>]*>/gi, '\n')
    .replace(/<a:p[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function stripRtf(rtf) {
  return String(rtf || '')
    .replace(/\\par[d]?/gi, '\n')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\[a-z]+-?\d*\s?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractAnyDocumentText(fileName, mimeType, buffer) {
  const ext = path.extname(fileName || '').toLowerCase();

  // 1. Word (.docx)
  if (ext === '.docx' || /officedocument\.wordprocessingml/i.test(mimeType)) {
    if (mammoth) {
      try {
        const res = await mammoth.extractRawText({ buffer });
        if (res.value && res.value.trim()) {
          return res.value.trim().slice(0, 60000);
        }
      } catch (err) {
        logLine(`⚠️ Помилка mammoth (.docx): ${err.message}`);
      }
    }
    if (AdmZip) {
      try {
        const zip = new AdmZip(buffer);
        const docXml = zip.readAsText('word/document.xml');
        if (docXml) return stripXmlTags(docXml).slice(0, 60000);
      } catch (_) {}
    }
  }

  // 2. Excel / таблиці (.xlsx, .xls, .ods, .csv)
  if (/\.(xlsx|xls|ods|xlsm|xlsb)$/i.test(ext) || /spreadsheetml|ms-excel/i.test(mimeType)) {
    if (XLSX) {
      try {
        const wb = XLSX.read(buffer, { type: 'buffer' });
        const sheetsText = [];
        for (const sheetName of wb.SheetNames) {
          const sheet = wb.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
          if (csv && csv.trim()) {
            sheetsText.push(`=== Аркуш: ${sheetName} ===\n${csv.trim()}`);
          }
        }
        if (sheetsText.length > 0) {
          return sheetsText.join('\n\n').slice(0, 60000);
        }
      } catch (err) {
        logLine(`⚠️ Помилка XLSX: ${err.message}`);
      }
    }
  }

  // 3. PDF (.pdf)
  if (ext === '.pdf' || /application\/pdf/i.test(mimeType)) {
    if (pdfParse) {
      try {
        const data = await pdfParse(buffer);
        if (data && data.text && data.text.trim()) {
          return data.text.trim().slice(0, 60000);
        }
      } catch (err) {
        logLine(`⚠️ Помилка pdf-parse: ${err.message}`);
      }
    }
  }

  // 4. PowerPoint (.pptx), OpenDocument (.odt, .odp), EPUB (.epub), FB2 (.fb2)
  if (/\.(pptx|odt|odp|epub)$/i.test(ext) && AdmZip) {
    try {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      const chunks = [];
      for (const entry of entries) {
        if (/\.(xml|xhtml|html|htm|txt|md)$/i.test(entry.entryName) && !entry.isDirectory) {
          if (
            ext === '.pptx' &&
            !/^ppt\/slides\/slide\d+\.xml$/i.test(entry.entryName) &&
            !/^ppt\/notesSlides\//i.test(entry.entryName)
          ) {
            continue;
          }
          const raw = zip.readAsText(entry);
          const cleaned = stripXmlTags(raw);
          if (cleaned) {
            chunks.push(`--- ${entry.entryName} ---\n${cleaned}`);
          }
        }
      }
      if (chunks.length > 0) {
        return chunks.join('\n\n').slice(0, 60000);
      }
    } catch (_) {}
  }

  // 5. ZIP-архів (.zip) — читаємо список файлів і вміст текстових/документних файлів усередині
  if (ext === '.zip' && AdmZip) {
    try {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      const summary = [`Архів містить ${entries.length} файл(ів):`];
      for (const entry of entries.slice(0, 30)) {
        summary.push(`• ${entry.entryName} (${Math.round(entry.header.size / 1024)} KB)`);
        if (!entry.isDirectory && entry.header.size < 300 * 1024) {
          const entryBuf = entry.getData();
          if (isTextReadableFile(entry.entryName, '', entryBuf)) {
            summary.push(`--- Вміст ${entry.entryName} ---\n${entryBuf.toString('utf-8').slice(0, 4000)}`);
          }
        }
      }
      return summary.join('\n').slice(0, 60000);
    } catch (_) {}
  }

  // 6. RTF (.rtf) та FB2 (.fb2)
  if (ext === '.rtf') {
    return stripRtf(buffer.toString('latin1')).slice(0, 60000);
  }
  if (ext === '.fb2') {
    return stripXmlTags(buffer.toString('utf-8')).slice(0, 60000);
  }

  // 7. Старий Word (.doc) або бінарні файли з текстом
  if (ext === '.doc') {
    const utf16 = buffer.toString('utf16le').replace(/[^\x20-\x7Eа-яА-ЯіїєґІЇЄҐ0-9.,!?:;()"\-\n\r\t]/g, ' ');
    const utf8 = buffer.toString('utf-8').replace(/[^\x20-\x7Eа-яА-ЯіїєґІЇЄҐ0-9.,!?:;()"\-\n\r\t]/g, ' ');
    const combined = `${utf16}\n${utf8}`.replace(/\s{3,}/g, ' ').trim();
    if (combined.length > 40) return combined.slice(0, 50000);
  }

  // 8. Звичайні текстові та кодові файли
  if (isTextReadableFile(fileName, mimeType, buffer)) {
    return buffer.toString('utf-8').slice(0, 60000);
  }

  return null;
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
  if (attachment.type !== 'photo') {
    textContent = await extractAnyDocumentText(safeName, attachment.mimeType, buffer);
  }

  return {
    ...attachment,
    localPath,
    buffer,
    textContent,
    uploadedAt: Date.now(),
  };
}

function parseInlineRuns(lineText, TextRun, extraOpts = {}) {
  const parts = String(lineText || '').split(/(\*\*[^*]+\*\*)/g);
  const runs = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      runs.push(
        new TextRun({
          text: part.slice(2, -2),
          bold: true,
          size: 24,
          font: 'Calibri',
          ...extraOpts,
        })
      );
    } else {
      runs.push(
        new TextRun({
          text: part,
          size: 24,
          font: 'Calibri',
          ...extraOpts,
        })
      );
    }
  }
  return runs.length > 0 ? runs : [new TextRun({ text: '', size: 24, font: 'Calibri', ...extraOpts })];
}

async function generateDocxBuffer(contentString) {
  if (!docxPkg) {
    return Buffer.from(contentString, 'utf-8');
  }
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
  } = docxPkg;

  const lines = String(contentString || '').replace(/\r\n/g, '\n').split('\n');
  const children = [];
  let tableRowsBuffer = [];

  const flushTable = () => {
    if (tableRowsBuffer.length === 0) return;
    const filtered = tableRowsBuffer.filter((row) => !row.every((cell) => /^[-:\s]+$/.test(cell)));
    if (filtered.length > 0) {
      const rows = filtered.map((cells, rowIdx) =>
        new TableRow({
          children: cells.map(
            (cellText) =>
              new TableCell({
                children: [
                  new Paragraph({
                    children: parseInlineRuns(cellText.trim(), TextRun, rowIdx === 0 ? { bold: true } : {}),
                  }),
                ],
              })
          ),
        })
      );
      children.push(
        new Table({
          rows,
          width: { size: 100, type: WidthType.PERCENTAGE },
        })
      );
      children.push(new Paragraph({ text: '' }));
    }
    tableRowsBuffer = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      tableRowsBuffer.push(cells);
      continue;
    } else {
      flushTable();
    }

    if (!trimmed) {
      children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
      continue;
    }

    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun({ text: h1[1].replace(/\*\*/g, ''), bold: true, size: 32, font: 'Calibri' })],
          spacing: { before: 240, after: 120 },
        })
      );
      continue;
    }

    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun({ text: h2[1].replace(/\*\*/g, ''), bold: true, size: 28, font: 'Calibri' })],
          spacing: { before: 200, after: 100 },
        })
      );
      continue;
    }

    const h3 = trimmed.match(/^###+\s+(.+)$/);
    if (h3) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: [new TextRun({ text: h3[1].replace(/\*\*/g, ''), bold: true, size: 26, font: 'Calibri' })],
          spacing: { before: 160, after: 80 },
        })
      );
      continue;
    }

    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      children.push(
        new Paragraph({
          bullet: { level: 0 },
          children: parseInlineRuns(bullet[1], TextRun),
          spacing: { after: 80 },
        })
      );
      continue;
    }

    children.push(
      new Paragraph({
        children: parseInlineRuns(rawLine, TextRun),
        spacing: { after: 120 },
      })
    );
  }
  flushTable();

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc);
}

function generateXlsxBuffer(contentString) {
  if (!XLSX) {
    return Buffer.from(contentString, 'utf-8');
  }
  const lines = String(contentString || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^\|?[-:\s|]+\|?$/.test(l));

  const rows = lines.map((line) => {
    if (line.includes('|')) {
      const cleaned = line.replace(/^\|/, '').replace(/\|$/, '');
      return cleaned.split('|').map((c) => c.trim());
    }
    if (line.includes(';')) {
      return line.split(';').map((c) => c.trim());
    }
    return line.split(',').map((c) => c.trim());
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows.length ? rows : [['Порожньо']]);
  XLSX.utils.book_append_sheet(wb, ws, 'Дані');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function sendDocumentBuffer(chatId, fileName, contentString, caption = '', replyToMessageId = null) {
  const safeFileName = (fileName || 'document.docx').trim();
  const ext = path.extname(safeFileName).toLowerCase();

  let fileBuffer;
  let mimeType = 'text/plain; charset=utf-8';

  if (ext === '.docx' || ext === '.doc') {
    fileBuffer = await generateDocxBuffer(contentString);
    mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  } else if (ext === '.xlsx' || ext === '.xls') {
    fileBuffer = generateXlsxBuffer(contentString);
    mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  } else {
    fileBuffer = Buffer.isBuffer(contentString) ? contentString : Buffer.from(String(contentString), 'utf-8');
  }

  const finalName = ext === '.doc' ? safeFileName.replace(/\.doc$/i, '.docx') : safeFileName;

  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption.slice(0, 1000));
  }
  if (replyToMessageId) {
    form.append('reply_to_message_id', String(replyToMessageId));
  }
  const blob = new Blob([fileBuffer], { type: mimeType });
  form.append('document', blob, finalName);

  const tgRes = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  const tgJson = await tgRes.json();
  if (!tgJson.ok) {
    throw new Error(JSON.stringify(tgJson));
  }
  logLine(`📎 Файл "${finalName}" (${Math.round(fileBuffer.length / 1024)} KB) надіслано в чат ${chatId}`);
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

const cloudModelCooldowns = new Map();

const CLOUD_GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
];

async function askFreeCloudFallback(promptText, systemPrompt = SYSTEM_PROMPT) {
  try {
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: promptText },
        ],
        temperature: 0.7,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const txt = data?.choices?.[0]?.message?.content?.trim();
    return txt || null;
  } catch (_) {
    return null;
  }
}

async function askGeminiCloud(promptText, fileCtx = null, preferredCloudModel = 'gemini-3-flash-preview', temperature = 0.7) {
  const candidates = [...new Set([preferredCloudModel, ...CLOUD_GEMINI_MODELS].filter(Boolean))];
  const userParts = [{ text: promptText }];

  if (fileCtx && fileCtx.buffer && fileCtx.buffer.length < 15 * 1024 * 1024 && !fileCtx.textContent) {
    userParts.push({
      inlineData: {
        mimeType: fileCtx.mimeType || 'application/octet-stream',
        data: fileCtx.buffer.toString('base64'),
      },
    });
  }

  const now = Date.now();
  const activeModels = candidates.filter((m) => (cloudModelCooldowns.get(m) || 0) <= now);
  const modelsToTry = activeModels.length > 0 ? activeModels : candidates;

  if (GEMINI_API_KEY) {
    for (const model of modelsToTry) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: userParts }],
            generationConfig: { temperature, maxOutputTokens: 8192 },
          }),
        });
        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts
          .filter((p) => !p.thought && p.text)
          .map((p) => p.text || '')
          .join('')
          .trim() || parts.map((p) => p.text || '').join('').trim();

        if (text) {
          cloudModelCooldowns.delete(model);
          return text;
        }

        const errMsg = String(data?.error?.message || '');
        if (/quota|rate.?limit|429/i.test(errMsg)) {
          cloudModelCooldowns.set(model, Date.now() + 30 * 60 * 1000);
          logLine(`⚠️ Квота хмарної моделі ${model} вичерпана, перемикаємось на резервну модель...`);
        } else if (/no longer available|not found|404/i.test(errMsg)) {
          cloudModelCooldowns.set(model, Date.now() + 24 * 60 * 60 * 1000);
        }
      } catch (_) {}
    }
  }

  return await askFreeCloudFallback(promptText, SYSTEM_PROMPT);
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
  recordModelQuotaUsage(chosenModel);
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

  if (GEMINI_API_KEY || !fs.existsSync(AGY_PATH)) {
    const cloudReply = await askGeminiCloud(enrichedPrompt, fileCtx, chosenModel.cloudModel);
    if (cloudReply) {
      return { answer: cloudReply, modelProfile: chosenModel };
    }
  }

  if (!fs.existsSync(AGY_PATH)) {
    return {
      answer:
        '🫡 Товаришу, зараз усі хмарні лінії звʼязку перевантажені. Зачекайте 10–15 секунд і повторіть наказ!',
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

        const wantsWordDoc =
          /(ворд|word|\.docx|документом|у\s+файлі\s+word|скинь\s+документ|відправ\s+документ|створи\s+документ|зроби\s+документ)/i.test(
            questionText
          ) || /^\/(?:doc|docx|word)\b/i.test(questionText.trim());
        const wantsExcelDoc = /(ексель|excel|\.xlsx|таблицею\s+excel|скинь\s+таблиц)/i.test(questionText);

        if (fileBlocks.length === 0 && (wantsWordDoc || wantsExcelDoc) && cleanReply.length > 20) {
          const autoExt = wantsExcelDoc ? 'xlsx' : 'docx';
          fileBlocks.push([
            null,
            `dnyuvalny_document_${Date.now()}.${autoExt}`,
            cleanReply,
          ]);
        }

        if (fileBlocks.length > 0) {
          clearInterval(typingInterval);
          if (cleanReply) {
            await sendMessage(chatId, cleanReply, messageId);
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
            await sendMessage(chatId, cleanReply || reply, messageId);
          }
        } else if (shouldSendVoice || hasVoiceTag) {
          clearInterval(typingInterval);
          await tgApi('sendChatAction', { chat_id: chatId, action: 'record_voice' }).catch(() => {});
          try {
            await sendVoiceMessage(chatId, cleanReply || reply, messageId);
          } catch (err) {
            logLine(`⚠️ Не вдалося відправити ГС, надсилаємо текстом: ${err.message}`);
            await sendMessage(chatId, cleanReply || reply, messageId);
          }
        } else {
          await sendMessage(chatId, cleanReply || reply, messageId);
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

function parseVocabTrigger(text) {
  if (!text) return null;
  const cleaned = text.trim();

  const cmdMatch = cleaned.match(/^\/(?:words|vocab|english|eng|слова|англ)(?:@[\w_]+)?(?:\s+([\s\S]+))?$/i);
  if (cmdMatch) {
    return { extra: (cmdMatch[1] || '').trim() };
  }

  const naturalMatch = cleaned.match(
    /(?:зроби|створи|згенеруй|підготуй|дай|вивчити|вивчення|тренажер|картки|тест)\s+(?:мені\s+|нам\s+)?(?:для\s+)?(?:англ(?:ійськ(?:і|их|ої))?\s+сл(?:ів|ова)|сл(?:ова|ів)\s+англ(?:ійською)?|англ\s+слов|словник|vocab|flashcards)(?:[\s:,-]+([\s\S]*))?$/i
  );
  if (naturalMatch) {
    return { extra: (naturalMatch[1] || '').trim() };
  }

  if (/^(?:англ(?:ійські)?\s+слова|тренажер\s+слів|вивчити\s+слова)(?:[\s:,-]+([\s\S]*))?$/i.test(cleaned)) {
    const m = cleaned.match(/^(?:англ(?:ійські)?\s+слова|тренажер\s+слів|вивчити\s+слова)(?:[\s:,-]+([\s\S]*))?$/i);
    return { extra: (m?.[1] || '').trim() };
  }

  return null;
}

async function extractVocabWithAI(rawText = '', fileCtx = null) {
  const prompt = [
    'Ти — професійний викладач англійської мови.',
    'Витягни або згенеруй список англійських слів/виразів із наданого матеріалу (тексту, документа чи фото) для вивчення українцям.',
    'Якщо користувач прикріпив фото сторінки, скріншот, документ або список слів — витягни ВСІ англійські слова/фрази звідти.',
    'Якщо користувач просто написав тему (або попросив підібрати слова) — згенеруй 12–15 корисних англійських слів за цією темою.',
    'Для КОЖНОГО слова обовʼязково вкажи:',
    '- "en": англійське слово або фраза (у початковій формі, з малої літери, крім власних назв)',
    '- "transcription": фонетична транскрипція (наприклад: "[rɪˈzɪl.i.ənt]")',
    '- "uk": точний і зрозумілий переклад українською мовою',
    '- "example": короткий приклад речення англійською з перекладом у дужках',
    '',
    'ПОВЕРНИ ТІЛЬКИ ЧИСТИЙ JSON без маркдаун-обгорток у такому форматі:',
    '{"title": "Назва набору слів українською", "words": [{"en": "word", "transcription": "[wɜːd]", "uk": "слово", "example": "This is a new word. (Це нове слово.)"}]}',
    '',
    rawText ? `Текст / коментар користувача:\n${rawText}` : '',
    fileCtx && fileCtx.textContent ? `Вміст прикріпленого документа:\n${fileCtx.textContent.slice(0, 35000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const userParts = [{ text: prompt }];
  if (fileCtx && fileCtx.buffer && fileCtx.buffer.length < 15 * 1024 * 1024 && !fileCtx.textContent) {
    userParts.push({
      inlineData: {
        mimeType: fileCtx.mimeType || 'image/jpeg',
        data: fileCtx.buffer.toString('base64'),
      },
    });
  }

  let rawJsonText = await askGeminiCloud(prompt, fileCtx, 'gemini-3-flash-preview', 0.3);

  if (!rawJsonText) {
    const fallback = await askAntigravity(prompt, fileCtx, 'flash_fast', false);
    rawJsonText = typeof fallback === 'string' ? fallback : fallback.answer;
  }

  const jsonMatch = String(rawJsonText || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Не вдалося розпізнати слова. Спробуйте надіслати чіткіший список або фото.');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  const words = Array.isArray(parsed.words)
    ? parsed.words
        .filter((w) => w && w.en && w.uk)
        .map((w) => ({
          en: String(w.en).trim(),
          transcription: String(w.transcription || '').trim() || '[—]',
          uk: String(w.uk).trim(),
          example: String(w.example || '').trim(),
        }))
    : [];

  if (words.length === 0) {
    throw new Error('Список слів порожній.');
  }

  return {
    title: String(parsed.title || 'Тренажер англійських слів').trim(),
    words,
  };
}

function renderVocabHtml(vocabSet) {
  const safeJson = JSON.stringify(vocabSet).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${escapeHtml(vocabSet.title)} — Тренажер слів</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --card-hover: #334155;
      --accent: #38bdf8;
      --accent-dark: #0284c7;
      --success: #22c55e;
      --danger: #ef4444;
      --text: #f8fafc;
      --muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; padding-bottom: 40px; }
    header {
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      padding: 18px 16px 14px;
      border-bottom: 1px solid #334155;
      position: sticky; top: 0; z-index: 20;
    }
    .header-top { display: flex; justify-content: space-between; align-items: center; max-width: 760px; margin: 0 auto 12px; }
    h1 { font-size: 1.2rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 8px; }
    .badge { background: rgba(56, 189, 248, 0.15); color: var(--accent); padding: 4px 10px; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
    .tabs {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
      max-width: 760px; margin: 0 auto;
    }
    .tab-btn {
      background: #1e293b; color: var(--muted); border: 1px solid #334155;
      padding: 10px 6px; border-radius: 10px; font-size: 0.78rem; font-weight: 600;
      cursor: pointer; transition: all 0.2s; text-align: center;
    }
    .tab-btn.active {
      background: var(--accent-dark); color: #fff; border-color: var(--accent);
      box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35);
    }
    main { max-width: 760px; margin: 18px auto 0; padding: 0 14px; }
    .word-list { display: flex; flex-direction: column; gap: 10px; }
    .word-item {
      background: var(--card); border: 1px solid #334155; border-radius: 14px;
      padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; gap: 12px;
    }
    .word-main { flex: 1; }
    .en-line { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 4px; }
    .en-word { font-size: 1.15rem; font-weight: 700; color: var(--accent); }
    .trans { font-size: 0.9rem; color: var(--muted); font-family: monospace; }
    .uk-word { font-size: 1.02rem; font-weight: 600; color: #e2e8f0; margin-bottom: 4px; }
    .example { font-size: 0.83rem; color: var(--muted); font-style: italic; }
    .speak-btn {
      background: #334155; border: none; color: #fff; width: 42px; height: 42px;
      border-radius: 50%; cursor: pointer; font-size: 1.1rem; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center; transition: 0.15s;
    }
    .speak-btn:active { transform: scale(0.92); background: var(--accent-dark); }

    .trainer-card {
      background: var(--card); border: 1px solid #334155; border-radius: 18px;
      padding: 24px 18px; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.3);
    }
    .progress-bar {
      width: 100%; height: 8px; background: #0f172a; border-radius: 999px;
      overflow: hidden; margin-bottom: 14px;
    }
    .progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--success)); transition: width 0.3s; }
    .stats-row { display: flex; justify-content: space-between; color: var(--muted); font-size: 0.85rem; margin-bottom: 18px; font-weight: 600; }
    .prompt-label { font-size: 0.85rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
    .prompt-word { font-size: 1.75rem; font-weight: 800; color: #fff; margin-bottom: 6px; }
    .prompt-sub { font-size: 1rem; color: var(--accent); font-family: monospace; margin-bottom: 20px; min-height: 22px; }

    .input-wrap { display: flex; flex-direction: column; gap: 10px; max-width: 440px; margin: 0 auto; }
    .text-input {
      width: 100%; padding: 14px 16px; border-radius: 12px; border: 2px solid #475569;
      background: #0f172a; color: #fff; font-size: 1.1rem; text-align: center; outline: none;
    }
    .text-input:focus { border-color: var(--accent); }
    .btn-row { display: flex; gap: 8px; justify-content: center; margin-top: 6px; flex-wrap: wrap; }
    .btn {
      padding: 12px 20px; border-radius: 12px; border: none; font-weight: 700;
      font-size: 0.95rem; cursor: pointer; transition: 0.15s;
    }
    .btn-primary { background: var(--accent-dark); color: #fff; flex: 1; }
    .btn-secondary { background: #334155; color: #e2e8f0; }

    .options-grid { display: grid; grid-template-columns: 1fr; gap: 10px; max-width: 480px; margin: 0 auto; }
    .option-btn {
      background: #0f172a; color: #f8fafc; border: 2px solid #334155;
      padding: 14px 16px; border-radius: 12px; font-size: 1rem; font-weight: 600;
      cursor: pointer; transition: 0.15s; text-align: left; display: flex; align-items: center; gap: 10px;
    }
    .option-btn:hover:not(:disabled) { border-color: var(--accent); background: #162032; }
    .option-btn.correct { background: rgba(34, 197, 94, 0.2); border-color: var(--success); color: #86efac; }
    .option-btn.wrong { background: rgba(239, 68, 68, 0.2); border-color: var(--danger); color: #fca5a5; }
    .feedback { margin-top: 16px; font-size: 1rem; font-weight: 700; min-height: 28px; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <header>
    <div class="header-top">
      <h1>🎓 <span id="set-title"></span></h1>
      <span class="badge" id="word-count"></span>
    </div>
    <div class="tabs">
      <button class="tab-btn active" onclick="switchMode('list')">📖 Словник</button>
      <button class="tab-btn" onclick="switchMode('write')">✍️ Напиши (UA→EN)</button>
      <button class="tab-btn" onclick="switchMode('quiz_en_uk')">🇬🇧→🇺🇦 4 варіанти</button>
      <button class="tab-btn" onclick="switchMode('quiz_uk_en')">🇺🇦→🇬🇧 4 варіанти</button>
    </div>
  </header>

  <main>
    <section id="view-list" class="word-list"></section>

    <section id="view-trainer" class="trainer-card hidden">
      <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width: 0%"></div></div>
      <div class="stats-row">
        <span id="step-counter">Слово 1 з 10</span>
        <span id="score-counter">✅ 0 | ❌ 0</span>
      </div>

      <div class="prompt-label" id="prompt-label">Переклади англійською:</div>
      <div class="prompt-word" id="prompt-word"></div>
      <div class="prompt-sub" id="prompt-sub"></div>

      <div id="write-box" class="input-wrap hidden">
        <input type="text" id="answer-input" class="text-input" placeholder="Введи слово англійською..." autocomplete="off" autocapitalize="none" />
        <div class="btn-row">
          <button class="btn btn-secondary" onclick="giveHint()">💡 Підказка</button>
          <button class="btn btn-primary" id="check-btn" onclick="checkWrittenAnswer()">Перевірити</button>
        </div>
      </div>

      <div id="quiz-box" class="options-grid hidden"></div>

      <div class="feedback" id="feedback"></div>
      <div class="btn-row" style="margin-top: 14px;">
        <button class="btn btn-secondary hidden" id="speak-current-btn" onclick="speakCurrent()">🔊 Озвучити</button>
        <button class="btn btn-primary hidden" id="next-btn" onclick="nextQuestion()">Наступне слово ➡️</button>
      </div>
    </section>
  </main>

  <script>
    const DATA = ${safeJson};
    const words = DATA.words || [];
    document.getElementById('set-title').textContent = DATA.title || 'Англійські слова';
    document.getElementById('word-count').textContent = words.length + ' слів';

    let currentMode = 'list';
    let deck = [];
    let currentIndex = 0;
    let correctCount = 0;
    let wrongCount = 0;
    let answered = false;
    let hintLen = 0;

    function speak(text) {
      if (!('speechSynthesis' in window)) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.92;
      window.speechSynthesis.speak(u);
    }

    function shuffle(arr) {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    function renderDictionary() {
      const container = document.getElementById('view-list');
      container.innerHTML = '';
      words.forEach((w, idx) => {
        const div = document.createElement('div');
        div.className = 'word-item';
        div.innerHTML = \`
          <div class="word-main">
            <div class="en-line">
              <span class="en-word">\${idx + 1}. \${w.en}</span>
              <span class="trans">\${w.transcription || ''}</span>
            </div>
            <div class="uk-word">🇺🇦 \${w.uk}</div>
            \${w.example ? \`<div class="example">💬 \${w.example}</div>\` : ''}
          </div>
          <button class="speak-btn" title="Озвучити" onclick="speak(\${JSON.stringify(w.en)})">🔊</button>
        \`;
        container.appendChild(div);
      });
    }

    function switchMode(mode) {
      currentMode = mode;
      const tabs = document.querySelectorAll('.tab-btn');
      const modes = ['list', 'write', 'quiz_en_uk', 'quiz_uk_en'];
      tabs.forEach((t, i) => t.classList.toggle('active', modes[i] === mode));

      if (mode === 'list') {
        document.getElementById('view-list').classList.remove('hidden');
        document.getElementById('view-trainer').classList.add('hidden');
        return;
      }

      document.getElementById('view-list').classList.add('hidden');
      document.getElementById('view-trainer').classList.remove('hidden');

      deck = shuffle(words);
      currentIndex = 0;
      correctCount = 0;
      wrongCount = 0;
      showQuestion();
    }

    function showQuestion() {
      answered = false;
      hintLen = 0;
      document.getElementById('feedback').textContent = '';
      document.getElementById('feedback').style.color = '#fff';
      document.getElementById('next-btn').classList.add('hidden');
      document.getElementById('speak-current-btn').classList.add('hidden');

      if (currentIndex >= deck.length) {
        finishRound();
        return;
      }

      const item = deck[currentIndex];
      const pct = Math.round((currentIndex / deck.length) * 100);
      document.getElementById('progress-fill').style.width = pct + '%';
      document.getElementById('step-counter').textContent = \`Слово \${currentIndex + 1} з \${deck.length}\`;
      document.getElementById('score-counter').textContent = \`✅ \${correctCount} | ❌ \${wrongCount}\`;

      const writeBox = document.getElementById('write-box');
      const quizBox = document.getElementById('quiz-box');

      if (currentMode === 'write') {
        writeBox.classList.remove('hidden');
        quizBox.classList.add('hidden');
        document.getElementById('prompt-label').textContent = 'Напиши переклад англійською:';
        document.getElementById('prompt-word').textContent = item.uk;
        document.getElementById('prompt-sub').textContent = '';
        const input = document.getElementById('answer-input');
        input.value = '';
        input.disabled = false;
        document.getElementById('check-btn').disabled = false;
        setTimeout(() => input.focus(), 50);
      } else if (currentMode === 'quiz_en_uk') {
        writeBox.classList.add('hidden');
        quizBox.classList.remove('hidden');
        document.getElementById('prompt-label').textContent = 'Обери правильний переклад українською:';
        document.getElementById('prompt-word').textContent = item.en;
        document.getElementById('prompt-sub').textContent = item.transcription || '';
        document.getElementById('speak-current-btn').classList.remove('hidden');
        renderQuizOptions(item, 'uk');
      } else if (currentMode === 'quiz_uk_en') {
        writeBox.classList.add('hidden');
        quizBox.classList.remove('hidden');
        document.getElementById('prompt-label').textContent = 'Обери правильний переклад англійською:';
        document.getElementById('prompt-word').textContent = item.uk;
        document.getElementById('prompt-sub').textContent = '';
        renderQuizOptions(item, 'en');
      }
    }

    function normalizeAnswer(str) {
      return String(str || '')
        .toLowerCase()
        .replace(/^(to|a|an|the)\\s+/i, '')
        .replace(/[^a-z0-9\\s'-]/g, '')
        .replace(/\\s+/g, ' ')
        .trim();
    }

    function giveHint() {
      if (answered) return;
      const item = deck[currentIndex];
      hintLen = Math.min(item.en.length, hintLen + 2);
      const input = document.getElementById('answer-input');
      input.value = item.en.slice(0, hintLen);
      document.getElementById('prompt-sub').textContent = \`Транскрипція: \${item.transcription || ''}\`;
      input.focus();
    }

    function checkWrittenAnswer() {
      if (answered) {
        nextQuestion();
        return;
      }
      const item = deck[currentIndex];
      const input = document.getElementById('answer-input');
      const userVal = input.value.trim();
      if (!userVal) return;

      answered = true;
      input.disabled = true;
      document.getElementById('check-btn').disabled = true;

      const isOk =
        userVal.toLowerCase() === item.en.toLowerCase() ||
        normalizeAnswer(userVal) === normalizeAnswer(item.en);

      const fb = document.getElementById('feedback');
      if (isOk) {
        correctCount++;
        fb.style.color = '#4ade80';
        fb.textContent = \`✅ Правильно! \${item.en} \${item.transcription || ''}\`;
      } else {
        wrongCount++;
        fb.style.color = '#f87171';
        fb.textContent = \`❌ Правильна відповідь: \${item.en} \${item.transcription || ''}\`;
      }
      speak(item.en);
      document.getElementById('score-counter').textContent = \`✅ \${correctCount} | ❌ \${wrongCount}\`;
      document.getElementById('speak-current-btn').classList.remove('hidden');
      document.getElementById('next-btn').classList.remove('hidden');
    }

    document.getElementById('answer-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (!answered) checkWrittenAnswer();
        else nextQuestion();
      }
    });

    function renderQuizOptions(correctItem, field) {
      const box = document.getElementById('quiz-box');
      box.innerHTML = '';
      const others = shuffle(words.filter((w) => w[field] !== correctItem[field])).slice(0, 3);
      const options = shuffle([correctItem, ...others]);

      options.forEach((opt, idx) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        const sub = field === 'en' && opt.transcription ? \` <span style="color:#94a3b8;font-weight:400;font-size:0.88rem;">\${opt.transcription}</span>\` : '';
        btn.innerHTML = \`<span>\${idx + 1}.</span> <span>\${opt[field]}\${sub}</span>\`;
        btn.onclick = () => selectQuizOption(btn, opt[field] === correctItem[field], correctItem, field);
        box.appendChild(btn);
      });
    }

    function selectQuizOption(clickedBtn, isCorrect, correctItem, field) {
      if (answered) return;
      answered = true;

      const allBtns = document.querySelectorAll('.option-btn');
      allBtns.forEach((b) => {
        b.disabled = true;
        if (b.textContent.includes(correctItem[field])) {
          b.classList.add('correct');
        }
      });

      const fb = document.getElementById('feedback');
      if (isCorrect) {
        correctCount++;
        clickedBtn.classList.add('correct');
        fb.style.color = '#4ade80';
        fb.textContent = \`✅ Точно! \${correctItem.en} \${correctItem.transcription || ''} — \${correctItem.uk}\`;
      } else {
        wrongCount++;
        clickedBtn.classList.add('wrong');
        fb.style.color = '#f87171';
        fb.textContent = \`❌ Помилка! Правильно: \${correctItem.en} \${correctItem.transcription || ''} — \${correctItem.uk}\`;
      }

      speak(correctItem.en);
      document.getElementById('score-counter').textContent = \`✅ \${correctCount} | ❌ \${wrongCount}\`;
      document.getElementById('speak-current-btn').classList.remove('hidden');
      document.getElementById('next-btn').classList.remove('hidden');
    }

    function speakCurrent() {
      if (deck[currentIndex]) speak(deck[currentIndex].en);
    }

    function nextQuestion() {
      currentIndex++;
      showQuestion();
    }

    function finishRound() {
      document.getElementById('progress-fill').style.width = '100%';
      document.getElementById('write-box').classList.add('hidden');
      document.getElementById('quiz-box').classList.add('hidden');
      document.getElementById('next-btn').classList.add('hidden');
      document.getElementById('speak-current-btn').classList.add('hidden');

      const total = correctCount + wrongCount || 1;
      const pct = Math.round((correctCount / total) * 100);
      document.getElementById('prompt-label').textContent = 'Тренування завершено!';
      document.getElementById('prompt-word').textContent = \`Результат: \${pct}% (\${correctCount} з \${total})\`;
      document.getElementById('prompt-sub').textContent = pct >= 80 ? '🫡 Відмінна служба, товаришу!' : '💪 Продовжуй тренування для закріплення!';

      const fb = document.getElementById('feedback');
      fb.innerHTML = \`<button class="btn btn-primary" onclick="switchMode('\${currentMode}')">🔄 Пройти ще раз</button>\`;
    }

    renderDictionary();
  </script>
</body>
</html>`;
}

function enqueueVocabTrainer(chatId, messageId, user, rawText = '', attachment = null) {
  const state = getChatState(chatId);
  state.pendingCount++;
  resetInactivityTimer(chatId);

  state.queue = state.queue
    .then(async () => {
      await tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      try {
        let activeFileCtx = null;
        if (attachment) {
          activeFileCtx = await downloadTelegramAttachment(attachment, chatId);
          state.lastFile = activeFileCtx;
          botStats.filesProcessed++;
        } else if (state.lastFile && Date.now() - state.lastFile.uploadedAt < 15 * 60 * 1000 && !rawText.trim()) {
          activeFileCtx = state.lastFile;
        }

        const vocabData = await extractVocabWithAI(rawText, activeFileCtx);
        const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const setObj = {
          id,
          title: vocabData.title,
          createdAt: new Date().toISOString(),
          words: vocabData.words,
        };
        vocabSets.set(id, setObj);
        saveVocabStore();

        const baseUrl = (PUBLIC_URL || 'https://dnyuvalny-telegram-bot.onrender.com').replace(/\/$/, '');
        const link = `${baseUrl}/vocab/${id}`;
        const htmlContent = renderVocabHtml(setObj);

        const previewLines = setObj.words
          .slice(0, 6)
          .map((w, i) => `${i + 1}. <b>${escapeHtml(w.en)}</b> <code>${escapeHtml(w.transcription)}</code> — ${escapeHtml(w.uk)}`);
        if (setObj.words.length > 6) {
          previewLines.push(`<i>...та ще ${setObj.words.length - 6} слів у тренажері!</i>`);
        }

        await tgApi('sendMessage', {
          chat_id: chatId,
          reply_to_message_id: messageId,
          parse_mode: 'HTML',
          text: [
            `🎓 <b>Тренажер англійських слів готовий!</b>`,
            `📚 Тема: <b>${escapeHtml(setObj.title)}</b> (${setObj.words.length} слів)`,
            '',
            ...previewLines,
            '',
            '👇 <b>Обери режим у тренажері за посиланням:</b>',
            '• 📖 Словник + транскрипція + озвучка',
            '• ✍️ Письмовий переклад з укр на англ',
            '• 🇬🇧→🇺🇦 Тест (4 варіанти відповіді)',
            '• 🇺🇦→🇬🇧 Тест (4 варіанти відповіді)',
          ].join('\n'),
          reply_markup: {
            inline_keyboard: [
              [{ text: '🚀 Відкрити інтерактивний тренажер слів', url: link }],
            ],
          },
        });

        // Додатково надсилаємо автономний HTML-файл, щоб можна було вчити навіть без інтернету
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('caption', '📱 Також тримай офлайн HTML-файл тренажера (працює навіть без інтернету)');
        form.append('document', new Blob([Buffer.from(htmlContent, 'utf-8')], { type: 'text/html; charset=utf-8' }), `English_Trainer_${id}.html`);
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: 'POST', body: form }).catch(() => {});

        logLine(`🎓 Створено тренажер слів [${id}] (${setObj.words.length} слів) для [${user}]`);
      } catch (err) {
        logLine(`⚠️ Помилка генерації тренажера слів: ${err.message}`);
        await sendMessage(chatId, `⚠️ Не вдалося створити тренажер: ${err.message}`, messageId);
      } finally {
        state.pendingCount = Math.max(0, state.pendingCount - 1);
      }
    })
    .catch((err) => {
      state.pendingCount = Math.max(0, state.pendingCount - 1);
      logLine(`⚠️ Помилка черги тренажера: ${err.message}`);
    });
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function handleAccessCallback(cb) {
  const fromId = cb.from?.id;
  const data = cb.data || '';
  if (!data.startsWith('acl_')) return;

  if (fromId !== OWNER_ID) {
    await tgApi('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: '🚫 Тільки власник бота може керувати доступом!',
      show_alert: true,
    });
    return;
  }

  const parts = data.split('_');
  const action = parts[1]; // allow | deny
  const targetId = Number(parts[2]);
  if (!targetId) return;

  const targetName =
    accessControl.names.get(targetId) ||
    accessControl.pending.get(targetId)?.name ||
    `ID ${targetId}`;

  if (action === 'allow') {
    accessControl.allowed.add(targetId);
    accessControl.rejected.delete(targetId);
    accessControl.pending.delete(targetId);
    saveAccessControl();

    await tgApi('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: `✅ Доступ відкрито для ${targetName}!`,
    });

    if (cb.message) {
      await tgApi('editMessageText', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        parse_mode: 'HTML',
        text: `✅ <b>ДОСТУП ДОЗВОЛЕНО</b>\n👤 Користувач: <b>${escapeHtml(targetName)}</b>\n🆔 ID: <code>${targetId}</code>`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚫 Забрати доступ', callback_data: `acl_deny_${targetId}` }],
          ],
        },
      }).catch(() => {});
    }

    await sendMessage(
      targetId,
      '🫡 Вітаю! Командир схвалив твою заявку на доступ до Днювального!\nТепер можеш писати мені будь-які запитання, надсилати файли, просити картинки (/img) або голосові (/voice).'
    ).catch(() => {});
    logLine(`✅ Власник надав доступ користувачу ${targetName} (${targetId})`);
  } else if (action === 'deny') {
    if (targetId === OWNER_ID) return;
    accessControl.allowed.delete(targetId);
    accessControl.pending.delete(targetId);
    accessControl.rejected.add(targetId);
    saveAccessControl();

    await tgApi('answerCallbackQuery', {
      callback_query_id: cb.id,
      text: `❌ Доступ закрито для ${targetName}!`,
    });

    if (cb.message) {
      await tgApi('editMessageText', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        parse_mode: 'HTML',
        text: `❌ <b>ДОСТУП ВІДХИЛЕНО / ЗАКРИТО</b>\n👤 Користувач: <b>${escapeHtml(targetName)}</b>\n🆔 ID: <code>${targetId}</code>`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Дозволити доступ', callback_data: `acl_allow_${targetId}` }],
          ],
        },
      }).catch(() => {});
    }

    await sendMessage(targetId, '❌ Командир відхилив заявку або закрив доступ до бота.').catch(() => {});
    logLine(`❌ Власник закрив доступ користувачу ${targetName} (${targetId})`);
  }
}

async function processUpdateItem(item, botInfo) {
  if (item.callback_query) {
    await handleAccessCallback(item.callback_query);
    return;
  }

  const anyChat =
    item.message?.chat ||
    item.edited_message?.chat ||
    item.my_chat_member?.chat ||
    item.chat_member?.chat;

  if (anyChat && anyChat.type && anyChat.type !== 'private') {
    logLine(`🚪 Автоматичний вихід із групи/каналу: ${anyChat.title || anyChat.id} (${anyChat.id})`);
    await tgApi('leaveChat', { chat_id: anyChat.id }).catch(() => {});
    return;
  }

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
  const senderId = msg.from?.id || chatId;
  const senderUsername = msg.from?.username || '';
  const fullName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || senderUsername || 'Невідомий';
  const user = msg.from?.first_name || senderUsername || 'Товаришу';
  const state = getChatState(chatId);

  accessControl.names.set(senderId, `${fullName}${senderUsername ? ` (@${senderUsername})` : ''}`);

  botStats.messagesReceived++;
  botStats.lastMessageAt = new Date().toISOString();
  updateHeartbeat();

  const directAttachment = extractAttachmentInfo(msg);
  logLine(
    `📩 [${user} (${senderId}) | chat=${chatId} (${msg.chat?.type})]: ${text || ''}${
      directAttachment ? ` [📎 Файл: ${directAttachment.fileName}]` : ''
    }`
  );

  // Перевірка доступу: тільки власник (OWNER_ID) та схвалені ним за заявками
  if (senderId !== OWNER_ID && !accessControl.allowed.has(senderId)) {
    if (accessControl.rejected.has(senderId)) {
      await sendMessage(chatId, '🚫 Доступ до бота закритий за рішенням власника.', messageId);
      return;
    }

    if (!accessControl.pending.has(senderId)) {
      accessControl.pending.set(senderId, {
        id: senderId,
        name: fullName,
        username: senderUsername,
        firstText: text.slice(0, 300),
        requestedAt: new Date().toISOString(),
      });
      saveAccessControl();

      await tgApi('sendMessage', {
        chat_id: OWNER_ID,
        parse_mode: 'HTML',
        text: [
          '🔔 <b>Нова заявка на доступ до бота!</b>',
          `👤 Ім'я: <b>${escapeHtml(fullName)}</b>`,
          `🔗 Тег: ${senderUsername ? '@' + escapeHtml(senderUsername) : '<i>немає</i>'}`,
          `🆔 ID: <code>${senderId}</code>`,
          `💬 Написав(ла): <i>${escapeHtml(text.slice(0, 250) || '[файл/медіа]')}</i>`,
          '',
          'Надати цій людині доступ до Днювального?',
        ].join('\n'),
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Дозволити', callback_data: `acl_allow_${senderId}` },
              { text: '❌ Відхилити', callback_data: `acl_deny_${senderId}` },
            ],
          ],
        },
      }).catch((e) => logLine(`⚠️ Помилка надсилання заявки власнику: ${e.message}`));

      await sendMessage(
        chatId,
        '🛑 Стояти! Це приватний бот. Твою заявку на доступ надіслано власнику на розгляд. Як тільки він натисне «Дозволити» — я одразу тобі напишу! 🫡',
        messageId
      );
      return;
    }

    await sendMessage(
      chatId,
      '⏳ Твоя заявка вже на розгляді у власника. Очікуй підтвердження! 🫡',
      messageId
    );
    return;
  }

  // Команда власника /users або /access для перегляду й керування доступами
  if (senderId === OWNER_ID && /^\/(users|access)(?:@[\w_]+)?$/i.test(text)) {
    const allowedList = [...accessControl.allowed].map(
      (id) => `• <b>${escapeHtml(accessControl.names.get(id) || String(id))}</b> (<code>${id}</code>)`
    );
    const pendingList = [...accessControl.pending.values()].map(
      (p) => `• <b>${escapeHtml(p.name)}</b> (<code>${p.id}</code>) — "${escapeHtml(p.firstText)}"`
    );
    const rejectedList = [...accessControl.rejected].map(
      (id) => `• <b>${escapeHtml(accessControl.names.get(id) || String(id))}</b> (<code>${id}</code>)`
    );

    const buttons = [];
    for (const id of accessControl.allowed) {
      if (id === OWNER_ID) continue;
      const label = accessControl.names.get(id) || `ID ${id}`;
      buttons.push([{ text: `🚫 Забрати доступ: ${label.slice(0, 25)}`, callback_data: `acl_deny_${id}` }]);
    }
    for (const p of accessControl.pending.values()) {
      buttons.push([
        { text: `✅ Дозволити: ${p.name.slice(0, 18)}`, callback_data: `acl_allow_${p.id}` },
        { text: `❌ Відхилити: ${p.name.slice(0, 18)}`, callback_data: `acl_deny_${p.id}` },
      ]);
    }
    for (const id of accessControl.rejected) {
      const label = accessControl.names.get(id) || `ID ${id}`;
      buttons.push([{ text: `✅ Розблокувати: ${label.slice(0, 25)}`, callback_data: `acl_allow_${id}` }]);
    }

    await tgApi('sendMessage', {
      chat_id: chatId,
      reply_to_message_id: messageId,
      parse_mode: 'HTML',
      text: [
        '🔐 <b>Керування доступом до Днювального:</b>',
        '',
        `✅ <b>Дозволені користувачі (${allowedList.length}):</b>`,
        ...allowedList,
        ...(pendingList.length ? ['\n⏳ <b>Очікують рішення:</b>', ...pendingList] : []),
        ...(rejectedList.length ? ['\n❌ <b>Відхилені/заблоковані:</b>', ...rejectedList] : []),
      ].join('\n'),
      ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
    return;
  }

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
      `Струнко! 🫡\nТоваришу ${user}, Днювальний на тумбочці й готовий до наказів!\n\nКоманди:\n• /limits — залишок лімітів усіх моделей ШІ\n• /doc <тема> — створити документ Word (.docx)\n• /img <запит> — знайти та скинути картинку\n• /voice <текст> — відповісти голосовим (ГС)\n• /model — переглянути або змінити модель ШІ\n• /users — керування доступом користувачів\n• /tokens — статистика токенів`,
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

  // 5.1. Команда /doc, /docx, /word, /документ — гарантована генерація Word-документа (.docx)
  const docCmdMatch = text.match(/^\/(?:doc|docx|word|документ)(?:@[\w_]+)?(?:\s+([\s\S]+))?$/i);
  if (docCmdMatch) {
    state.active = true;
    state.awaitingVocabInput = false;
    resetInactivityTimer(chatId);
    const docPrompt = (docCmdMatch[1] || '').trim();
    if (!docPrompt && !attachment) {
      await sendMessage(
        chatId,
        `🫡 Товаришу ${user}, напишіть, який саме документ Word (.docx) підготувати! Наприклад:\n• /doc Напиши рапорт на відпустку\n• /doc Зроби конспект по мережах TCP/IP\n• Або прикріпіть будь-який файл і напишіть: «перероби і скинь у ворді»`,
        messageId
      );
      return;
    }
    enqueueQuestion(
      chatId,
      messageId,
      user,
      `${docPrompt || 'Проаналізуй прикріплений файл і оформи його вміст у гарний структурований документ.'}\n\nОБОВ'ЯЗКОВО сформуй і надішли готовий результат у блоці [FILE: document.docx] ... [/FILE]`,
      false,
      attachment
    );
    return;
  }

  // 5.15. Інтерактивний тренажер англійських слів (/words, /vocab, або "Зроби мені англ слова")
  const vocabTrigger = parseVocabTrigger(text);
  if (vocabTrigger || (state.awaitingVocabInput && (attachment || (text && !text.startsWith('/'))))) {
    state.active = true;
    resetInactivityTimer(chatId);

    const extraText = vocabTrigger ? vocabTrigger.extra : text;
    if (!extraText && !attachment) {
      state.awaitingVocabInput = true;
      await sendMessage(
        chatId,
        '🎓 Слухаюсь! Скинь мені сюди:\n• 📸 Фото або скріншот зі словами чи текстом\n• 📄 Будь-який документ (.docx, .pdf, .xlsx, .txt)\n• ✍️ Або просто напиши список слів чи тему (наприклад: «військова лексика» або «IT та програмування»)\n\nІ я одразу зроблю для тебе інтерактивне посилання-тренажер (словник + транскрипція + письмовий переклад UA→EN + тести з 4 варіантами EN↔UA)! 🫡',
        messageId
      );
      return;
    }

    state.awaitingVocabInput = false;
    enqueueVocabTrainer(chatId, messageId, user, extraText, attachment);
    return;
  }

  // 5.2. Команда /limits, /quota, /ліміти — показ залишку лімітів по всіх моделях
  if (/^\/(limits|limit|quota|ліміти|ліміт)(?:@[\w_]+)?$/i.test(text)) {
    state.active = true;
    resetInactivityTimer(chatId);
    await tgApi('sendMessage', {
      chat_id: chatId,
      reply_to_message_id: messageId,
      parse_mode: 'HTML',
      text: getLimitsReport(),
    });
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
    const cleanUrl = (req.url || '/').split('?')[0];
    if (cleanUrl === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, vocabSetsCount: vocabSets.size, ...botStats }));
      return;
    }
    const vocabMatch = cleanUrl.match(/^\/vocab\/([a-zA-Z0-9_-]+)$/);
    if (vocabMatch) {
      const setId = vocabMatch[1];
      const setObj = vocabSets.get(setId);
      if (!setObj) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>⚠️ Тренажер не знайдено або сервер перезавантажився. Надішліть слова боту ще раз (або відкрийте HTML-файл із чату)!</h2>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderVocabHtml(setObj));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      `🫡 Днювальний (@ArsenyASsistantbot) на тумбочці 24/7!\nРежим: ${botStats.mode}\nПовідомлень: ${botStats.messagesReceived}\nФайлів: ${botStats.filesProcessed}\nКартинок: ${botStats.imagesSent}\nГолосових: ${botStats.voicesSent}\nТренажерів слів: ${vocabSets.size}\n`
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
