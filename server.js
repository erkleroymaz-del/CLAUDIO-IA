// ============================================================
//  Claude Gateway — server.js
//  Proxy con control de consumo por usuario (diario + mensual)
// ============================================================

const express  = require('express');
const Database = require('better-sqlite3');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const Anthropic = require('@anthropic-ai/sdk');
const path     = require('path');
const cors     = require('cors');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── Configuración ───────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const JWT_SECRET        = process.env.JWT_SECRET || 'cambia-este-secreto-en-produccion';
const PORT              = process.env.PORT || 3000;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Modelos disponibles y sus precios USD por token
const MODELS = {
  'claude-haiku-4-5-20251001': {
    label:  'Haiku 4.5 — Rápido y económico',
    input:  0.80 / 1_000_000,
    output: 4.00 / 1_000_000,
  },
  'claude-sonnet-4-6': {
    label:  'Sonnet 4.6 — Equilibrado',
    input:  3.00 / 1_000_000,
    output: 15.00 / 1_000_000,
  },
  'claude-opus-4-6': {
    label:  'Opus 4.6 — Máxima capacidad',
    input:  15.00 / 1_000_000,
    output: 75.00 / 1_000_000,
  },
};

// Exponer lista de modelos al frontend
app.get('/api/models', (req, res) => {
  res.json(Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })));
});

// ── Base de Datos ───────────────────────────────────────────
const db = new Database('gateway.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    email             TEXT    UNIQUE NOT NULL,
    password_hash     TEXT    NOT NULL,
    role              TEXT    DEFAULT 'worker',
    daily_limit_usd   REAL    DEFAULT 1.00,
    monthly_limit_usd REAL    DEFAULT 8.00,
    is_active         INTEGER DEFAULT 1,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    date          TEXT    NOT NULL,        -- YYYY-MM-DD
    input_tokens  INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd      REAL    DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    role       TEXT    NOT NULL,          -- 'user' | 'assistant'
    content    TEXT    NOT NULL,
    cost_usd   REAL    DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Crear admin por defecto si no existe
const adminExists = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`
    INSERT INTO users (name, email, password_hash, role, daily_limit_usd, monthly_limit_usd)
    VALUES (?, ?, ?, 'admin', 9999, 99999)
  `).run('Administrador', 'admin@empresa.com', hash);
  console.log('✅  Admin creado: admin@empresa.com / admin123  (cámbialo en producción)');
}

// ── Cliente Anthropic ────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── Helpers de consumo ───────────────────────────────────────
function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getThisMonth() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function getDailyUsed(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM usage WHERE user_id = ? AND date = ?
  `).get(userId, getToday());
  return row.total;
}

function getMonthlyUsed(userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total
    FROM usage WHERE user_id = ? AND date LIKE ?
  `).get(userId, `${getThisMonth()}%`);
  return row.total;
}

function calcCost(modelId, inputTokens, outputTokens) {
  const prices = MODELS[modelId] || MODELS[DEFAULT_MODEL];
  return (inputTokens * prices.input) + (outputTokens * prices.output);
}

// ── Middleware de autenticación ──────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}

// ── Auth ─────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

  const user = db.prepare(`SELECT * FROM users WHERE email = ? AND is_active = 1`).get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const token = jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role }
  });
});

// ── Perfil + uso del usuario autenticado ─────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT id, name, email, role, daily_limit_usd, monthly_limit_usd
    FROM users WHERE id = ?
  `).get(req.user.id);

  res.json({
    ...user,
    daily_used:   getDailyUsed(req.user.id),
    monthly_used: getMonthlyUsed(req.user.id),
  });
});

// ── Historial de mensajes del usuario ───────────────────────
app.get('/api/messages', requireAuth, (req, res) => {
  const msgs = db.prepare(`
    SELECT role, content, cost_usd, created_at
    FROM messages WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 100
  `).all(req.user.id);
  res.json(msgs.reverse());
});

// ── CHAT — el corazón del gateway ───────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, model: requestedModel } = req.body;
  const model = MODELS[requestedModel] ? requestedModel : DEFAULT_MODEL;
  if (!messages?.length) return res.status(400).json({ error: 'Mensajes requeridos' });

  const user = db.prepare(`SELECT * FROM users WHERE id = ? AND is_active = 1`).get(req.user.id);
  if (!user) return res.status(403).json({ error: 'Cuenta inactiva' });

  // Verificar límites ANTES de llamar a la API
  const dailyUsed   = getDailyUsed(req.user.id);
  const monthlyUsed = getMonthlyUsed(req.user.id);

  if (dailyUsed >= user.daily_limit_usd) {
    return res.status(429).json({
      error: `Límite diario alcanzado ($${user.daily_limit_usd.toFixed(2)} USD). Contacta al administrador para ampliarlo.`,
      type: 'daily_limit'
    });
  }
  if (monthlyUsed >= user.monthly_limit_usd) {
    return res.status(429).json({
      error: `Límite mensual alcanzado ($${user.monthly_limit_usd.toFixed(2)} USD). Contacta al administrador para ampliarlo.`,
      type: 'monthly_limit'
    });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en el servidor' });
  }

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: `Eres un asistente de trabajo para ${user.name}. Responde en español, sé conciso y útil.`,
      messages,
    });

    const inputTokens  = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const cost         = calcCost(model, inputTokens, outputTokens);
    const today        = getToday();
    const reply        = response.content[0].text;

    // Registrar consumo
    db.prepare(`
      INSERT INTO usage (user_id, date, input_tokens, output_tokens, cost_usd)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.user.id, today, inputTokens, outputTokens, cost);

    // Guardar mensajes en historial
    const lastUser = messages[messages.length - 1];
    db.prepare(`INSERT INTO messages (user_id, role, content, cost_usd) VALUES (?, ?, ?, 0)`)
      .run(req.user.id, 'user', lastUser.content);
    db.prepare(`INSERT INTO messages (user_id, role, content, cost_usd) VALUES (?, ?, ?, ?)`)
      .run(req.user.id, 'assistant', reply, cost);

    res.json({
      content: reply,
      model,
      model_label: MODELS[model].label,
      usage: {
        input_tokens:  inputTokens,
        output_tokens: outputTokens,
        cost_usd:      cost,
        daily_used:    dailyUsed + cost,
        monthly_used:  monthlyUsed + cost,
      }
    });

  } catch (err) {
    console.error('Error Anthropic:', err.message);
    res.status(500).json({ error: 'Error al conectar con Claude: ' + err.message });
  }
});

// ── ADMIN: listar usuarios ───────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT
      u.id, u.name, u.email, u.role,
      u.daily_limit_usd, u.monthly_limit_usd,
      u.is_active, u.created_at,
      COALESCE((
        SELECT SUM(cost_usd) FROM usage
        WHERE user_id = u.id AND date = date('now')
      ), 0) AS daily_used,
      COALESCE((
        SELECT SUM(cost_usd) FROM usage
        WHERE user_id = u.id AND date LIKE strftime('%Y-%m', 'now') || '%'
      ), 0) AS monthly_used
    FROM users u
    ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

// ── ADMIN: crear usuario ─────────────────────────────────────
app.post('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { name, email, password, daily_limit_usd, monthly_limit_usd } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nombre, email y contraseña requeridos' });
  }

  try {
    const hash   = bcrypt.hashSync(password, 10);
    const result = db.prepare(`
      INSERT INTO users (name, email, password_hash, daily_limit_usd, monthly_limit_usd)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, email, hash, daily_limit_usd ?? 1.00, monthly_limit_usd ?? 8.00);
    res.json({ id: result.lastInsertRowid, message: 'Usuario creado correctamente' });
  } catch {
    res.status(400).json({ error: 'Este email ya está registrado' });
  }
});

// ── ADMIN: actualizar usuario (límites, nombre, estado) ──────
app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { name, daily_limit_usd, monthly_limit_usd, is_active } = req.body;
  const { id } = req.params;

  db.prepare(`
    UPDATE users
    SET name = ?, daily_limit_usd = ?, monthly_limit_usd = ?, is_active = ?
    WHERE id = ?
  `).run(name, daily_limit_usd, monthly_limit_usd, is_active ? 1 : 0, id);

  res.json({ message: 'Usuario actualizado' });
});

// ── ADMIN: resetear contraseña ───────────────────────────────
app.put('/api/admin/users/:id/password', requireAuth, requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(hash, req.params.id);
  res.json({ message: 'Contraseña actualizada' });
});

// ── ADMIN: estadísticas generales ───────────────────────────
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const today = getToday();
  const month = getThisMonth();

  const totalToday = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE date = ?
  `).get(today);

  const totalMonth = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage WHERE date LIKE ?
  `).get(`${month}%`);

  const activeUsers = db.prepare(`
    SELECT COUNT(*) AS total FROM users WHERE is_active = 1 AND role = 'worker'
  `).get();

  const perUser = db.prepare(`
    SELECT
      u.name,
      COALESCE(SUM(CASE WHEN us.date = ? THEN us.cost_usd END), 0) AS today_cost,
      COALESCE(SUM(CASE WHEN us.date LIKE ? THEN us.cost_usd END), 0) AS month_cost,
      u.daily_limit_usd, u.monthly_limit_usd, u.is_active
    FROM users u
    LEFT JOIN usage us ON us.user_id = u.id
    WHERE u.role = 'worker'
    GROUP BY u.id
    ORDER BY month_cost DESC
  `).all(today, `${month}%`);

  res.json({
    total_today:  totalToday.total,
    total_month:  totalMonth.total,
    active_users: activeUsers.total,
    per_user:     perUser,
  });
});

// ── Endpoint compatible con Claude Code (/v1/messages) ──────
// Permite usar el gateway como ANTHROPIC_BASE_URL en Claude Code
app.post('/v1/messages', async (req, res) => {
  // Claude Code manda el token JWT como API key
  const header = req.headers.authorization || req.headers['x-api-key'] || '';
  const raw    = header.startsWith('Bearer ') ? header.slice(7) : header;

  let userId;
  try {
    const decoded = jwt.verify(raw, JWT_SECRET);
    userId = decoded.id;
  } catch {
    return res.status(401).json({ type: 'error', error: { type: 'authentication_error', message: 'Token inválido' } });
  }

  const user = db.prepare(`SELECT * FROM users WHERE id = ? AND is_active = 1`).get(userId);
  if (!user) return res.status(403).json({ type: 'error', error: { type: 'permission_error', message: 'Cuenta inactiva' } });

  const dailyUsed   = getDailyUsed(userId);
  const monthlyUsed = getMonthlyUsed(userId);
  if (dailyUsed >= user.daily_limit_usd)
    return res.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message: `Límite diario alcanzado ($${user.daily_limit_usd})` } });
  if (monthlyUsed >= user.monthly_limit_usd)
    return res.status(429).json({ type: 'error', error: { type: 'rate_limit_error', message: `Límite mensual alcanzado ($${user.monthly_limit_usd})` } });

  const modelId = req.body.model || DEFAULT_MODEL;

  if (!ANTHROPIC_API_KEY)
    return res.status(500).json({ type: 'error', error: { type: 'api_error', message: 'ANTHROPIC_API_KEY no configurada' } });

  try {
    const isStream = req.body.stream === true;

    if (isStream) {
      // Streaming para Claude Code
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');

      const stream = await anthropic.messages.stream({ ...req.body, model: modelId });

      let inputTokens = 0, outputTokens = 0;
      stream.on('text', () => {});
      stream.on('message', () => {});

      for await (const event of stream) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens || 0;
        }
        if (event.type === 'message_start' && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens || 0;
        }
      }

      const cost  = calcCost(modelId, inputTokens, outputTokens);
      const today = getToday();
      db.prepare(`INSERT INTO usage (user_id, date, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?)`)
        .run(userId, today, inputTokens, outputTokens, cost);

      res.write('data: [DONE]\n\n');
      res.end();

    } else {
      // No-streaming
      const response = await anthropic.messages.create({ ...req.body, model: modelId, stream: false });
      const inputTokens  = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const cost = calcCost(modelId, inputTokens, outputTokens);
      db.prepare(`INSERT INTO usage (user_id, date, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?)`)
        .run(userId, getToday(), inputTokens, outputTokens, cost);
      res.json(response);
    }
  } catch (err) {
    res.status(500).json({ type: 'error', error: { type: 'api_error', message: err.message } });
  }
});

// Fallback a index.html para SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀  Gateway corriendo en http://localhost:${PORT}`);
  console.log(`🔑  Admin: admin@empresa.com / admin123`);
  console.log(`⚠️   Recuerda setear ANTHROPIC_API_KEY en .env\n`);
});
