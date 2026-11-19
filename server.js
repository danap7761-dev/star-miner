// Star Miner — бэкенд (zero-dependency Node.js)
// Прогресс, рейтинг, рефералка, стрик, ежедневные задания.
// Запуск: BOT_TOKEN=xxx node server.js   (DEMO_MODE=1 — для теста без Telegram)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const DEMO_MODE = process.env.DEMO_MODE !== '0'; // по умолчанию разрешён тестовый uid
const DB_FILE = path.join(__dirname, 'data.json');
const GAME_DIR = path.join(__dirname, 'game');

let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : { users: {} };
function persist() { fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);

function getUser(uid) {
  if (!db.users[uid]) db.users[uid] = {
    coins: 0, up: {}, best: 0, streak: 0,
    lastDay: null, taskDay: null, refClaimed: false
  };
  return db.users[uid];
}

// --- Валидация Telegram WebApp initData ---
function validInit(data) {
  if (!BOT_TOKEN || !data) return false;
  try {
    const pairs = data.split('&').filter(p => !p.startsWith('hash='));
    const hash = new URLSearchParams(data).get('hash');
    const dataCheckString = pairs.sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    return calc === hash;
  } catch (e) { return false; }
}

// --- Публичное состояние пользователя ---
function publicState(uid) {
  const u = getUser(uid);
  const lb = Object.entries(db.users)
    .map(([id, v]) => ({ uid: id, best: v.best || 0 }))
    .sort((a, b) => b.best - a.best)
    .slice(0, 10);
  return {
    ok: true,
    coins: u.coins, up: u.up, best: u.best, streak: u.streak,
    taskDone: u.taskDay === today(), lb
  };
}

// --- Применить стрик и рефералку при сохранении ---
function applyBonuses(u, uid, ref) {
  let msg = null;
  const t = today();
  if (u.lastDay !== t) {
    u.streak = (u.lastDay === yesterday()) ? u.streak + 1 : 1;
    u.lastDay = t;
    if (u.streak > 1) {
      const bonus = 50 * u.streak;
      u.coins += bonus;
      msg = `🔥 Стрик ${u.streak} дней! +${bonus} 🪙`;
    }
  }
  if (ref && String(ref) !== String(uid) && !u.refClaimed) {
    u.refClaimed = true;
    u.coins += 200;
    const inviter = db.users[String(ref)];
    if (inviter) inviter.coins += 200;
    msg = (msg ? msg + ' ' : '') + '🎁 +200 🪙 за друга!';
  }
  return msg;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');

  // --- API ---
  if (url.pathname === '/api/state' && req.method === 'GET') {
    const uid = url.searchParams.get('uid');
    if (!uid) return send(res, { ok: false }, 400);
    return send(res, publicState(uid));
  }

  if (url.pathname === '/api/save' && req.method === 'POST') {
    const b = await body(req);
    const uid = String(b.uid || '');
    if (!uid) return send(res, { ok: false }, 400);
    // Без initData в проде не пускаем (если выключен DEMO_MODE)
    if (!DEMO_MODE && !validInit(b.initData)) return send(res, { ok: false, error: 'bad initData' }, 403);
    if (DEMO_MODE && !validInit(b.initData) && uid !== 'demo' && !/^\d+$/.test(uid)) {
      return send(res, { ok: false, error: 'bad uid' }, 403);
    }
    const u = getUser(uid);
    u.coins = Math.max(0, u.coins + (Number(b.coins) || 0));
    if (b.up && typeof b.up === 'object') u.up = b.up;
    if (Number(b.best) > (u.best || 0)) u.best = Number(b.best);
    const bonus = applyBonuses(u, uid, b.ref);
    persist();
    return send(res, { ok: true, bonus, state: publicState(uid) });
  }

  if (url.pathname === '/api/score' && req.method === 'POST') {
    const b = await body(req);
    const u = getUser(String(b.uid || ''));
    if (Number(b.score) > (u.best || 0)) u.best = Number(b.score);
    persist();
    return send(res, { ok: true, state: publicState(String(b.uid)) });
  }

  if (url.pathname === '/api/task' && req.method === 'POST') {
    const b = await body(req);
    const u = getUser(String(b.uid || ''));
    if (u.taskDay === today()) return send(res, { ok: false, error: 'already done' });
    u.taskDay = today();
    u.coins += 150;
    persist();
    return send(res, { ok: true, state: publicState(String(b.uid)) });
  }

  // --- Статика игры ---
  if (req.method === 'GET') {
    let fp = path.join(GAME_DIR, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fp.startsWith(GAME_DIR)) return send(res, { ok: false }, 403);
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      res.setHeader('Content-Type', fp.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain');
      return res.end(fs.readFileSync(fp));
    }
  }
  send(res, { ok: false }, 404);
});

function send(res, obj, code = 200) { res.statusCode = code; res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); });
}

server.listen(PORT, () => console.log(`Star Miner server: http://localhost:${PORT} (demo mode: ${DEMO_MODE})`));

// ---------- Telegram-бот (long polling, в том же процессе) ----------
const GAME_URL = process.env.GAME_URL || '';
const tgApi = (method, payload) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  }).then(r => r.json());

if (BOT_TOKEN && GAME_URL) {
  let offset = 0;
  (async function poll() {
    try {
      const r = await tgApi('getUpdates', { offset, timeout: 30 });
      if (r.ok) for (const upd of r.result) {
        offset = upd.update_id + 1;
        const msg = upd.message || upd.edited_message;
        if (!msg || !msg.text || !msg.text.startsWith('/start')) continue;
        const ref = msg.text.split(' ')[1];
        const url = GAME_URL + '?ref=' + (ref || msg.chat.id);
        tgApi('sendMessage', {
          chat_id: msg.chat.id,
          text: '🚀 Star Miner\n\nСобирай монеты, уворачивайся от астероидов, качай бустеры и зови друзей — каждому по +200 🪙!',
          reply_markup: { inline_keyboard: [[{ text: '▶️ Играть', web_app: { url } }]] }
        });
      }
    } catch (e) { /* сеть мигнула — повторим */ }
    setTimeout(poll, 100);
  })();
  console.log('Бот активен. Кнопка «Играть» ведёт на ' + GAME_URL);
} else if (!BOT_TOKEN) {
  console.log('Бот выключен: задай BOT_TOKEN (и GAME_URL для кнопки «Играть»).');
}
