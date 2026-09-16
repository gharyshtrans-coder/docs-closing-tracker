// ============================================================
// РЕЕСТР ЗАКРЫТИЯ ДОКУМЕНТОВ
// Простой сервер на чистом Node.js (без npm-пакетов).
// Запуск:  node server.js
// Открыть: http://localhost:3000
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ---- НАСТРОЙКИ: поменяй PIN-коды здесь -----------------------
const PINS = {
  '1111': 'bolat',   // PIN для Болата
  '2222': 'buh',      // PIN для бухгалтера
};
// ---------------------------------------------------------------

const DATA_FILE = path.join(__dirname, 'invoices.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = __dirname;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- Работа с данными (JSON-файл как "база данных") ----------
function readInvoices() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    return [];
  }
}

function writeInvoices(invoices) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(invoices, null, 2), 'utf8');
}

function nextId(invoices) {
  return invoices.length ? Math.max(...invoices.map(i => i.id)) + 1 : 1;
}

// ---------- Вспомогательные функции для HTTP ----------
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const MAX = 20 * 1024 * 1024; // 20 МБ максимум на запрос (файлы в base64)
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error('Слишком большой файл'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/login.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  // защита от выхода за пределы папки public
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Страница не найдена');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ---------- Проверка PIN на защищённых запросах ----------
function checkRole(req, requiredRole, queryPin) {
  const pin = req.headers['x-pin'] || queryPin;
  const role = PINS[pin];
  if (!role) return null;
  if (requiredRole && role !== requiredRole) return null;
  return role;
}

// ---------- Основной обработчик ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    // ---- Вход по PIN ----
    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      const role = PINS[body.pin];
      if (!role) return sendJson(res, 401, { error: 'Неверный PIN' });
      return sendJson(res, 200, { role });
    }

    // ---- Получить список счетов (доступно обеим ролям) ----
    if (pathname === '/api/invoices' && req.method === 'GET') {
      if (!checkRole(req)) return sendJson(res, 401, { error: 'Нет доступа' });
      return sendJson(res, 200, readInvoices());
    }

    // ---- Создать новый счёт (только бухгалтер) ----
    if (pathname === '/api/invoices' && req.method === 'POST') {
      if (!checkRole(req, 'buh')) return sendJson(res, 403, { error: 'Только бухгалтер может выставлять счета' });
      const body = await readBody(req);
      if (!body.invoiceFileBase64) return sendJson(res, 400, { error: 'Прикрепите файл счёта' });

      const invoices = readInvoices();
      const id = nextId(invoices);
      const invoice = {
        id,
        client: body.client || 'Без названия',
        amount: Number(body.amount) || 0,
        issuedDate: new Date().toISOString().slice(0, 10),
        dueDate: body.dueDate || '',
        paid: false,
        paidDate: null,
        files: { invoice: null, avr: null, esf: null },
      };

      const safeName = `${id}_invoice_${Date.now()}_${(body.invoiceFileName || 'file').replace(/[^a-zA-Zа-яА-Я0-9._-]/g, '_')}`;
      const filePath = path.join(UPLOADS_DIR, safeName);
      const base64Data = body.invoiceFileBase64.split(',').pop();
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
      invoice.files.invoice = safeName;

      invoices.push(invoice);
      writeInvoices(invoices);
      return sendJson(res, 200, invoice);
    }

    // ---- Отметить счёт оплаченным (только Болат) ----
    const payMatch = pathname.match(/^\/api\/invoices\/(\d+)\/pay$/);
    if (payMatch && req.method === 'POST') {
      if (!checkRole(req, 'bolat')) return sendJson(res, 403, { error: 'Только Болат может отмечать оплату' });
      const id = Number(payMatch[1]);
      const invoices = readInvoices();
      const inv = invoices.find(i => i.id === id);
      if (!inv) return sendJson(res, 404, { error: 'Счёт не найден' });
      inv.paid = true;
      inv.paidDate = new Date().toISOString().slice(0, 10);
      writeInvoices(invoices);
      return sendJson(res, 200, inv);
    }

    // ---- Загрузить файл (АВР или ЭСФ), только бухгалтер ----
    const uploadMatch = pathname.match(/^\/api\/invoices\/(\d+)\/upload$/);
    if (uploadMatch && req.method === 'POST') {
      if (!checkRole(req, 'buh')) return sendJson(res, 403, { error: 'Только бухгалтер может загружать документы' });
      const id = Number(uploadMatch[1]);
      const body = await readBody(req); // { type: 'avr'|'esf', filename, dataBase64 }
      const invoices = readInvoices();
      const inv = invoices.find(i => i.id === id);
      if (!inv) return sendJson(res, 404, { error: 'Счёт не найден' });
      if (!['avr', 'esf', 'invoice'].includes(body.type)) return sendJson(res, 400, { error: 'Неверный тип документа' });

      const safeName = `${id}_${body.type}_${Date.now()}_${(body.filename || 'file').replace(/[^a-zA-Zа-яА-Я0-9._-]/g, '_')}`;
      const filePath = path.join(UPLOADS_DIR, safeName);
      const base64Data = (body.dataBase64 || '').split(',').pop();
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

      inv.files[body.type] = safeName;
      writeInvoices(invoices);
      return sendJson(res, 200, inv);
    }

    // ---- Скачать загруженный файл ----
    const fileMatch = pathname.match(/^\/api\/files\/(.+)$/);
    if (fileMatch && req.method === 'GET') {
      if (!checkRole(req, null, parsed.query.pin)) return sendJson(res, 401, { error: 'Нет доступа' });
      const filePath = path.join(UPLOADS_DIR, fileMatch[1]);
      if (!filePath.startsWith(UPLOADS_DIR) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        return res.end('Файл не найден');
      }
      res.writeHead(200);
      return fs.createReadStream(filePath).pipe(res);
    }

    // ---- Иначе — отдаём статику (html/css/js) ----
    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'Ошибка сервера: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
