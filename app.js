// app.js
require('dotenv').config();

const express = require('express');
const sql = require('mssql');
const app = express();

app.use(express.json());

// ===== Variables de entorno =====
const {
  SQL_SERVER,                     // ej: "mi-servidor.database.windows.net" o IP
  SQL_DATABASE = 'RPA',           // nombre de tu BD (por defecto RPA)
  SQL_USER,
  SQL_PASSWORD,
  SQL_ENCRYPT = 'false',          // "true" si tu SQL requiere TLS
  SQL_TRUST_CERT = 'true',        // on-prem sin CA pública: "true" (Azure suele ser "false")
  SQL_TLS_MIN = 'TLSv1',          // compatibilidad mínima
  SQL_TLS_MAX = 'TLSv1.2',        // tope
  API_KEY,
  PORT = 3000                     // solo por fallback local; en Railway se ignora
} = process.env;

// === Sanity-check de env (sin exponer secretos) ===
[
  'SQL_SERVER','SQL_DATABASE','SQL_USER','SQL_PASSWORD',
  'SQL_ENCRYPT','SQL_TRUST_CERT','SQL_TLS_MIN','SQL_TLS_MAX','API_KEY'
].forEach(k => {
  const v = process.env[k];
  if (!v || String(v).trim() === '') {
    console.error('[ENV] Missing or empty:', k);
  } else {
    const len = String(v).length;
    const sample = k === 'SQL_SERVER' ? String(v).slice(0, 20) : undefined;
    console.log('[ENV] OK:', k, 'len=', len, sample ? `sample=${sample}` : '');
  }
});

// ===== Pool SQL (lazy) =====
let poolPromise = null;
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool({
      user: SQL_USER,
      password: SQL_PASSWORD,
      server: SQL_SERVER,
      database: SQL_DATABASE,
      options: {
        encrypt: SQL_ENCRYPT === 'true',
        trustServerCertificate: SQL_TRUST_CERT === 'true',
        // Compatibilidad TLS para servidores antiguos (evita ERR_SSL_UNSUPPORTED_PROTOCOL)
        cryptoCredentialsDetails: {
          minVersion: SQL_TLS_MIN,  // p.ej. 'TLSv1' (compat)
          maxVersion: SQL_TLS_MAX   // p.ej. 'TLSv1.2'
        }
      }
    }).connect();
  }
  return poolPromise;
}

// ===== Helpers =====
function toStr(v) {
  return (v === null || v === undefined) ? '' : String(v).trim();
}
function parseFecha(s) {
  if (!s) return new Date();
  // Acepta "yyyy-MM-dd HH:mm:ss" o ISO "yyyy-MM-ddTHH:mm:ss"
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(iso);
  if (isNaN(d)) {
    throw new Error('FECHA_HORA inválida. Usa ISO (2025-09-12T15:30:00) o "yyyy-MM-dd HH:mm:ss".');
  }
  return d;
}

// ===== Rutas básicas =====
app.get('/', (req, res) => {
  res.send('coneccionQueryAstrid API: ok. Usa /health, /db-health, /env-check o POST /whatsapp/leads/insert');
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'coneccionQueryAstrid' });
});

app.get('/db-health', async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query('SELECT 1 AS ok;');
    res.json({ ok: true, db: r.recordset?.[0]?.ok === 1 });
  } catch (err) {
    console.error('DB Health error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== Endpoint de depuración de variables =====
app.get('/env-check', (req, res) => {
  const keys = [
    'SQL_SERVER','SQL_DATABASE','SQL_USER','SQL_PASSWORD',
    'SQL_ENCRYPT','SQL_TRUST_CERT','SQL_TLS_MIN','SQL_TLS_MAX','API_KEY'
  ];
  const out = {};
  for (const k of keys) {
    const v = process.env[k];
    out[k] = v
      ? { present: true, len: String(v).length, sample: k === 'SQL_SERVER' ? String(v).slice(0, 20) : undefined }
      : { present: false };
  }
  res.json(out);
});

// ===== Insert en dbo.Leads_Whatsapp =====
// JSON esperado:
// {
//   "NUMERO_TELEFONO": "string <= 26" (requerido),
//   "FECHA_HORA": "yyyy-MM-dd HH:mm:ss" o ISO con T (opcional),
//   "PUSH_NAME": "string <= 510" (requerido),
//   "NOMBRE_USUARIO": "string <= 255" (requerido),
//   "TIPO_SALUDO": null | "string <= 100" (opcional; lo puedes omitir para que sea NULL)
// }
app.post('/whatsapp/leads/insert', async (req, res) => {
  try {
    // Auth simple por API key (si no hay API_KEY definida, no valida: útil en local)
    const incomingKey = (req.headers['x-api-key'] || '').trim();
    const expectedKey = (API_KEY || '').trim();
    if (expectedKey && incomingKey !== expectedKey) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // Normalizar entradas
    let { NUMERO_TELEFONO, FECHA_HORA, PUSH_NAME, NOMBRE_USUARIO, TIPO_SALUDO } = req.body || {};
    NUMERO_TELEFONO = toStr(NUMERO_TELEFONO);
    PUSH_NAME       = toStr(PUSH_NAME);
    NOMBRE_USUARIO  = toStr(NOMBRE_USUARIO);

    // TIPO_SALUDO: opcional, a NULL si no viene
    if (TIPO_SALUDO !== null && TIPO_SALUDO !== undefined) {
      TIPO_SALUDO = toStr(TIPO_SALUDO) || null;
    } else {
      TIPO_SALUDO = null;
    }

    // Validaciones según tu tabla
    const errors = [];
    if (!NUMERO_TELEFONO) errors.push('NUMERO_TELEFONO es requerido');
    if (!PUSH_NAME)       errors.push('PUSH_NAME es requerido');
    if (!NOMBRE_USUARIO)  errors.push('NOMBRE_USUARIO es requerido');

    if (NUMERO_TELEFONO.length > 26)  errors.push('NUMERO_TELEFONO excede 26');
    if (PUSH_NAME.length > 510)       errors.push('PUSH_NAME excede 510');
    if (NOMBRE_USUARIO.length > 255)  errors.push('NOMBRE_USUARIO excede 255');
    if (TIPO_SALUDO && TIPO_SALUDO.length > 100) errors.push('TIPO_SALUDO excede 100');

    if (errors.length) {
      return res.status(400).json({ ok: false, error: 'validation', details: errors });
    }

    // Fecha
    const fecha = parseFecha(FECHA_HORA);

    // Insert parametrizado
    const pool = await getPool();
    const result = await pool.request()
      .input('NUMERO_TELEFONO', sql.NVarChar(26),  NUMERO_TELEFONO)
      .input('FECHA_HORA',     sql.DateTime2,      fecha)
      .input('PUSH_NAME',      sql.NVarChar(510),  PUSH_NAME)
      .input('NOMBRE_USUARIO', sql.VarChar(255),   NOMBRE_USUARIO)
      .input('TIPO_SALUDO',    sql.NVarChar(100),  TIPO_SALUDO) // null si no se manda
      .query(`
        INSERT INTO dbo.Leads_Whatsapp
          (NUMERO_TELEFONO, FECHA_HORA, PUSH_NAME, NOMBRE_USUARIO, TIPO_SALUDO)
        OUTPUT INSERTED.ID
        VALUES (@NUMERO_TELEFONO, @FECHA_HORA, @PUSH_NAME, @NOMBRE_USUARIO, @TIPO_SALUDO);
      `);

    const insertId = result.recordset?.[0]?.ID;
    return res.json({ ok: true, insertId });
  } catch (err) {
    console.error('Insert error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== Levantar servidor =====
const listenPort = Number(process.env.PORT || 3000);
const listenHost = '0.0.0.0'; // importante en Railway

console.log('[BOOT] PORT env =', process.env.PORT);

app.listen(listenPort, listenHost, () => {
  console.log(`[BOOT] API listening on http://${listenHost}:${listenPort}`);
});
