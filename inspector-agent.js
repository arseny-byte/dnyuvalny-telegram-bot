const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  parseWakeWord,
  parseImageRequest,
  searchImageUrls,
  extractBotMention,
  askAntigravity,
} = require('./bot.js');

const BOT_SCRIPT = path.join(__dirname, 'bot.js');
const HEARTBEAT_PATH = path.join(__dirname, 'bot-heartbeat.json');
const INSPECTOR_LOCK_PATH = path.join(__dirname, 'inspector-lock.json');
const INSPECTOR_LOG = path.join(__dirname, 'inspector.log');

function logInspector(msg) {
  const line = `[${new Date().toLocaleTimeString('uk-UA')}] [РЕВІЗОР] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(INSPECTOR_LOG, line + '\n', 'utf-8');
  } catch (_) {}
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readHeartbeat() {
  try {
    if (!fs.existsSync(HEARTBEAT_PATH)) return null;
    return JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf-8'));
  } catch (_) {
    return null;
  }
}

// Автоматичний набір тестів (Self-Test) для перевірки всієї логіки бота
async function runDiagnostics(testAi = true) {
  logInspector('🔍 Починаю повну перевірку логіки бота Днювальний...');
  const results = [];

  const assertTest = (name, condition, details = '') => {
    const status = condition ? '✅ PASS' : '❌ FAIL';
    results.push({ name, passed: Boolean(condition), details });
    logInspector(`${status} | ${name}${details ? ` (${details})` : ''}`);
  };

  // Тест 1: Тег @ArsenyASsistantbot на початку
  const t1 = extractBotMention(
    { text: '@ArsenyASsistantbot привіт як справи?' },
    '@ArsenyASsistantbot привіт як справи?',
    'ArsenyASsistantbot',
    8990355674
  );
  assertTest(
    'Тег @ArsenyASsistantbot на початку речення',
    t1.isTagged && t1.cleanedText === 'привіт як справи?',
    `cleaned="${t1.cleanedText}"`
  );

  // Тест 2: Тег @ArsenyASsistantbot всередині речення
  const t2 = extractBotMention(
    { text: 'Скажи мені @arsenyassistantbot котра година' },
    'Скажи мені @arsenyassistantbot котра година',
    'ArsenyASsistantbot',
    8990355674
  );
  assertTest(
    'Тег @arsenyassistantbot (регістронезалежний, всередині тексту)',
    t2.isTagged && t2.cleanedText === 'Скажи мені котра година',
    `cleaned="${t2.cleanedText}"`
  );

  // Тест 3: Слово-виклик "Днювальний" з комою і питанням
  const w1 = parseWakeWord('Днювальний, що ти вмієш робити?');
  assertTest(
    'Виклик "Днювальний, що ти вмієш робити?"',
    w1 && w1.wakeWord.toLowerCase() === 'днювальний' && w1.restQuestion === 'що ти вмієш робити?',
    `rest="${w1?.restQuestion}"`
  );

  // Тест 4: Розпізнавання запиту на картинку ("скинь картинку кота в касці" та "/img танк")
  const imgQ1 = parseImageRequest('скинь картинку кота в касці');
  const imgQ2 = parseImageRequest('/img танк Оплот');
  assertTest(
    'Розпізнавання запитів на картинки (природна мова та /img)',
    imgQ1 === 'кота в касці' && imgQ2 === 'танк Оплот',
    `q1="${imgQ1}", q2="${imgQ2}"`
  );

  // Тест 5: Живий пошук картинок (searchImageUrls)
  try {
    const urls = await searchImageUrls('пес Патрон');
    assertTest('Пошук картинок у мережі (searchImageUrls)', urls.length > 0, `знайдено ${urls.length} URL`);
  } catch (e) {
    assertTest('Пошук картинок у мережі (searchImageUrls)', false, e.message);
  }

  // Тест 6: Живий виклик ШІ (agy.exe)
  if (testAi) {
    const startMs = Date.now();
    const aiReply = await askAntigravity('Відповідай двома словами: Перевірка пройдена!');
    const elapsed = Date.now() - startMs;
    assertTest(
      'Жива відповідь від ШІ Antigravity (agy.exe)',
      aiReply && !aiReply.startsWith('⚠️') && aiReply.length > 0,
      `${elapsed} мс, відповідь: "${aiReply.slice(0, 60).replace(/\r?\n/g, ' ')}"`
    );
  }

  const allPassed = results.every((r) => r.passed);
  logInspector(
    allPassed
      ? '🎯 Усі тести пройдено успішно!'
      : '⚠️ УВАГА: Деякі тести не пройшли перевірку!'
  );
  return { allPassed, results };
}

function startBotDetached(forceRestart = false) {
  const hb = readHeartbeat();
  if (!forceRestart && hb && isPidAlive(hb.pid) && Date.now() - hb.timestamp < 45000) {
    return hb.pid;
  }

  if (hb && isPidAlive(hb.pid)) {
    logInspector(`🔄 Зупиняємо попередній процес bot.js (PID ${hb.pid}) для перезапуску...`);
    try {
      process.kill(hb.pid, 'SIGTERM');
    } catch (_) {}
  }

  logInspector('🚀 Запускаю bot.js у фоновому режимі...');
  const child = spawn(process.execPath, [BOT_SCRIPT], {
    cwd: __dirname,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  child.unref();
  logInspector(`✅ Новий процес bot.js запущено (PID ${child.pid}).`);
  return child.pid;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    const res = await runDiagnostics(!args.includes('--fast'));
    if (args.includes('--restart')) {
      startBotDetached(true);
      await new Promise((r) => setTimeout(r, 3000));
    }
    process.exit(res.allPassed ? 0 : 1);
  }

  try {
    if (fs.existsSync(INSPECTOR_LOCK_PATH)) {
      const lock = JSON.parse(fs.readFileSync(INSPECTOR_LOCK_PATH, 'utf-8'));
      if (lock && lock.pid && lock.pid !== process.pid && isPidAlive(lock.pid)) {
        logInspector(`ℹ️ Інший екземпляр Агента-Ревізора вже працює (PID ${lock.pid}). Виходимо.`);
        process.exit(0);
      }
    }
    fs.writeFileSync(
      INSPECTOR_LOCK_PATH,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  } catch (_) {}

  logInspector(`🛡️ Агент-Ревізор запущений у режимі постійного нагляду (Watchdog, PID ${process.pid}).`);
  await runDiagnostics(false);
  startBotDetached(false);

  setInterval(() => {
    startBotDetached(false);
  }, 15000);
}

if (require.main === module) {
  main();
}

module.exports = { runDiagnostics, startBotDetached, readHeartbeat, isPidAlive };
