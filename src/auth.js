/**
 * Módulo de Autenticación y Seguridad Criptográfica de Nexxo S.A.
 * Implementa cifrado con sal (scrypt) y tokens JWT HMAC-SHA256 nativos sin dependencias externas.
 */

const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'nexxo-mining-division-teniente-secret-2026';
const TOKEN_EXPIRY_SECONDS = 8 * 60 * 60; // 8 horas (Jornada laboral completa)

/**
 * Genera un hash criptográfico con sal única de 16 bytes usando scrypt
 * @param {string} password 
 * @returns {string} salt:derivedKeyHex
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derivedKey}`;
}

/**
 * Verifica una contraseña contra su hash almacenado en tiempo constante
 * @param {string} password 
 * @param {string} storedHash 
 * @returns {boolean}
 */
function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  const keyBuffer = Buffer.from(key, 'hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

/**
 * Emite un token JWT (HS256) firmado criptográficamente
 * @param {object} payload 
 * @param {number} expiresIn 
 * @returns {string} Token JWT
 */
function generateToken(payload, expiresIn = TOKEN_EXPIRY_SECONDS) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/**
 * Valida la firma y la fecha de expiración de un token JWT
 * @param {string} token 
 * @returns {object|null} Payload decodificado si es válido, null en caso contrario
 */
function verifyToken(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    
    // Comparación segura en tiempo constante para evitar ataques de temporización
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now > payload.exp) {
      return null; // Token expirado
    }

    return payload;
  } catch (err) {
    return null;
  }
}

/**
 * Middleware para proteger rutas de administración en Express
 */
function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  // Soporte para enlaces directos en nueva pestaña (ej. exportación WebControl)
  if (!token && req.query && req.query.token) {
    token = String(req.query.token).trim();
  }

  if (!token) {
    return res.status(401).json({
      error: 'Acceso no autorizado.',
      message: 'Debe iniciar sesión con credenciales de RR.HH. para acceder a este recurso.'
    });
  }

  const user = verifyToken(token);
  if (!user) {
    return res.status(403).json({
      error: 'Sesión expirada o token no válido.',
      message: 'Su sesión ha caducado. Inicie sesión nuevamente en /admin/login.'
    });
  }

  req.adminUser = user;
  next();
}

/**
 * Inicializa la tabla admin_users y asegura el usuario por defecto admin / papa123
 */
async function initAdminAuth(pool) {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(150) NOT NULL,
        role VARCHAR(30) DEFAULT 'RRHH',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);

    // Comprobar si existe el usuario 'admin'
    const [rows] = await conn.query('SELECT id FROM admin_users WHERE username = ?', ['admin']);
    if (rows.length === 0) {
      const defaultHash = hashPassword('papa123');
      await conn.query(`
        INSERT INTO admin_users (username, password_hash, full_name, role)
        VALUES (?, ?, ?, ?)
      `, ['admin', defaultHash, 'Administrador RR.HH. Nexxo', 'SUPERADMIN']);
      console.log('[AUTH] Usuario inicial "admin" creado exitosamente con clave configurada.');
    }
  } finally {
    conn.release();
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  requireAdminAuth,
  initAdminAuth
};
