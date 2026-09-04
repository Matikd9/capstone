const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar directorio de subidas estáticas
const UPLOADS_DIR = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Aumentar límites para transferencia de fotos y audios
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Configuración DB MySQL
const dbConfig = {
  host: process.env.DB_HOST || 'db',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'rootpassword',
  database: process.env.DB_NAME || 'web_app',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

let pool;

async function initDB(retries = 10, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[DB] Conectando a MySQL (${i + 1}/${retries})...`);
      pool = mysql.createPool(dbConfig);
      const conn = await pool.getConnection();

      // Crear tablas
      await conn.query(`
        CREATE TABLE IF NOT EXISTS positions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT
        ) ENGINE=InnoDB;
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS audio_prompts (
          id INT AUTO_INCREMENT PRIMARY KEY,
          position_id INT NOT NULL,
          prompt_text TEXT NOT NULL,
          FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
        ) ENGINE=InnoDB;
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS questions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          position_id INT NOT NULL,
          question_text TEXT NOT NULL,
          option_a VARCHAR(255) NOT NULL,
          option_b VARCHAR(255) NOT NULL,
          option_c VARCHAR(255) NOT NULL,
          option_d VARCHAR(255) NOT NULL,
          correct_option CHAR(1) NOT NULL,
          FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
        ) ENGINE=InnoDB;
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS candidates (
          id INT AUTO_INCREMENT PRIMARY KEY,
          full_name VARCHAR(150) NOT NULL,
          rut_id VARCHAR(50) NOT NULL,
          age INT NOT NULL,
          position_id INT NOT NULL,
          cert_file VARCHAR(255),
          antecedentes_file VARCHAR(255),
          initial_selfie VARCHAR(255),
          random_selfie VARCHAR(255),
          score INT DEFAULT 0,
          total_questions INT DEFAULT 0,
          audio_file VARCHAR(255),
          status ENUM('Pendiente', 'Aprobado', 'Rechazado') DEFAULT 'Pendiente',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (position_id) REFERENCES positions(id)
        ) ENGINE=InnoDB;
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS candidate_answers (
          id INT AUTO_INCREMENT PRIMARY KEY,
          candidate_id INT NOT NULL,
          question_id INT NOT NULL,
          selected_option CHAR(1) NOT NULL,
          is_correct BOOLEAN NOT NULL,
          FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
          FOREIGN KEY (question_id) REFERENCES questions(id)
        ) ENGINE=InnoDB;
      `);

      console.log('[DB] Tablas de MySQL verificadas exitosamente.');
      
      // Poblar datos semilla si está vacío
      const [posRows] = await conn.query('SELECT COUNT(*) as count FROM positions');
      if (posRows[0].count === 0) {
        await seedData(conn);
      }

      conn.release();
      return;
    } catch (err) {
      console.error(`[DB Error] ${err.message}`);
      // Si el host 'db' no se puede resolver (fuera del contenedor Docker), intentar con 127.0.0.1 (localhost)
      if (err.code === 'ENOTFOUND' && dbConfig.host === 'db') {
        console.warn(`[DB Aviso] Host 'db' no encontrado fuera de Docker. Cambiando host a '127.0.0.1'...`);
        dbConfig.host = '127.0.0.1';
      }
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
}

async function seedData(conn) {
  console.log('[DB Seed] Poblando banco de preguntas técnicas y situacionales de voz...');

  // 1. Rigger
  const [res1] = await conn.query(
    'INSERT INTO positions (name, description) VALUES (?, ?)',
    [
      'Rigger (Maniobrista de Izaje)',
      'Especialista en maniobras de izaje, cálculo de cargas y señales de seguridad para grúas en minería.'
    ]
  );
  const riggerId = res1.insertId;

  await conn.query(
    `INSERT INTO audio_prompts (position_id, prompt_text) VALUES
    (?, 'Describa detalladamente los pasos que realiza para inspeccionar los elementos de izaje (estrobos, fajas, grilletes) antes de iniciar una maniobra en faena minera.'),
    (?, 'Explique cómo actuaría si durante una maniobra de izaje de carga suspendida repentinamente aumentan las ráfagas de viento por sobre el límite de seguridad.'),
    (?, 'Describa la comunicación y señales que debe coordinar con el operador de la grúa cuando la maniobra es a ciegas o sin visibilidad directa de la carga.')`,
    [riggerId, riggerId, riggerId]
  );

  await conn.query(
    `INSERT INTO questions (position_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES
    (?, '¿Cuál es el ángulo de trabajo recomendado para una maniobra de izaje con eslingas de dos brazos para evitar sobrecargas?', '45° a 60° (máximo recomendado)', '90° exactos', '15° a 20°', '120° o superior', 'A'),
    (?, 'Si un grillete presenta un desgaste visible superior al 10% en el cuerpo o perno, ¿qué acción inmediata debe tomar el Rigger?', 'Pintarlo para marcarlo', 'Darlo de baja e inutilizarlo de inmediato', 'Usarlo solo para cargas livianas', 'Aplicar grasa sintética', 'B'),
    (?, 'En señales manuales estandarizadas de izaje, ¿qué significa extender el brazo horizontalmente con el puño cerrado y el pulgar hacia arriba?', 'Subir la pluma de la grúa', 'Bajar la pluma', 'Detener maniobra de emergencia', 'Girar la torna mesa', 'A'),
    (?, '¿Qué elemento de seguridad es indispensable para controlar el balanceo de una carga suspendida durante la maniobra?', 'Viento o cuerda guía de retención', 'Cadena de amarre secundario', 'Gancho de seguridad doble', 'Cinta de peligro alrededor', 'A')`,
    [riggerId, riggerId, riggerId, riggerId]
  );

  // 2. Soldador
  const [res2] = await conn.query(
    'INSERT INTO positions (name, description) VALUES (?, ?)',
    [
      'Soldador de Mantención Minera',
      'Soldador calificado para reparación de estructuras pesadas, baldes de pala y tuberías en planta concentradora.'
    ]
  );
  const soldadorId = res2.insertId;

  await conn.query(
    `INSERT INTO audio_prompts (position_id, prompt_text) VALUES
    (?, 'Explique los controles de seguridad críticos (EPP especial, verificación de atmósfera y ventilación) antes de iniciar trabajos de soldadura en caliente dentro de un espacio confinado en planta.'),
    (?, 'Describa el procedimiento paso a paso para reparar una grieta mediante biselado y soldadura en el balde de una pala de extracción minera.'),
    (?, 'Explique cómo verifica la calidad de un cordón de soldadura terminado y qué acciones toma si detecta fisuras o falta de penetración.')`,
    [soldadorId, soldadorId, soldadorId]
  );

  await conn.query(
    `INSERT INTO questions (position_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES
    (?, 'Para soldadura MIG/MAG en estructura pesada, ¿cuál es la función principal del gas de protección (Ar/CO2)?', 'Enfriar la torcha', 'Proteger el baño de fusión de la oxidación atmosférica', 'Aumentar el amperaje', 'Limpiar la escoria', 'B'),
    (?, '¿Qué EPP específico es obligatorio para evitar quemaduras por radiación ultravioleta/infrarroja en la vista y rostro?', 'Gafas de seguridad claras', 'Máscara de soldar con filtro de tono adecuado', 'Careta facial de policarbonato', 'Lentes oscuros estándar', 'B'),
    (?, 'Antes de realizar trabajos en caliente cerca de líneas de lubricante o combustible en planta, ¿qué documento es EXCLUYENTE?', 'Checklist diario de herramientas', 'Permiso de Trabajo en Caliente (PTC) autorizado', 'Licencia de conducir interna', 'Registro de asistencia', 'B'),
    (?, 'Si detecta porosidad continua en el cordón de soldadura SMAW (electrodo revestido), ¿cuál es la causa más probable?', 'Electrodo húmedo o superficie con grasa/óxido', 'Amperaje demasiado bajo', 'Usar corriente continua', 'Arco eléctrico muy corto', 'A')`,
    [soldadorId, soldadorId, soldadorId, soldadorId]
  );

  // 3. Operador
  const [res3] = await conn.query(
    'INSERT INTO positions (name, description) VALUES (?, ?)',
    [
      'Operador de Maquinaria Pesada',
      'Operador de cargador frontal, excavadora y camión de extracción en faenas mineras de alta exigencia.'
    ]
  );
  const operadorId = res3.insertId;

  await conn.query(
    `INSERT INTO audio_prompts (position_id, prompt_text) VALUES
    (?, 'Describa la pauta de inspección pre-operacional (Checklist de 360°) que debe realizar a un cargador frontal o excavadora antes de encender el motor al inicio del turno.'),
    (?, 'Explique cómo opera el equipo de manera segura durante el tránsito en rampas pronunciadas con lluvia o presencia de barro en faena rajo abierto.'),
    (?, 'Describa el protocolo exacto a seguir si mientras opera el equipo se enciende la luz roja de advertencia con alarma continua de temperatura en el panel.')`,
    [operadorId, operadorId, operadorId]
  );

  await conn.query(
    `INSERT INTO questions (position_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES
    (?, 'Durante la inspección pre-operacional de 360°, si se detecta una fuga activa de fluido hidráulico, ¿cuál es el procedimiento correcto?', 'Rellenar el estanque y operar normalmente', 'Reportar de inmediato y colocar tarjeta de bloqueo/no operar', 'Continuar el turno si la fuga es pequeña', 'Colocar un trapo alrededor', 'B'),
    (?, '¿Cuál es la distancia mínima de seguridad recomendada al transitar o maniobrar maquinaria pesada cerca de líneas eléctricas energizadas?', '1 metro', '5 metros o más según voltaje de la línea', '50 centímetros', 'No se requiere distancia', 'B'),
    (?, 'En pendientes pronunciadas dentro de la mina, ¿cómo debe desplazarse la maquinaria pesada cargada?', 'Con la marcha más alta (marcha rápida)', 'Con marcha enganchada baja (primera/segunda) y balde/cuchara abajo', 'En neutro usando solo el freno', 'En marcha atrás siempre', 'B'),
    (?, '¿Qué indica una luz de advertencia roja en el panel del equipo acompañada de una alarma sonora continua?', 'Mantenimiento preventivo requerido en 50 horas', 'Falla crítica de seguridad o motor: detener la máquina en zona segura', 'Bajo nivel de combustible', 'Freno de estacionamiento desconectado', 'B')`,
    [operadorId, operadorId, operadorId, operadorId]
  );

  console.log('[DB Seed] Banco de preguntas técnicas y situacionales poblado con éxito.');
}

// Función auxiliar para guardar imágenes Base64 / Audios
function saveBase64File(base64Data, prefix = 'file', extension = 'jpg') {
  if (!base64Data) return null;
  try {
    const matches = base64Data.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    const buffer = matches ? Buffer.from(matches[2], 'base64') : Buffer.from(base64Data, 'base64');
    const filename = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${extension}`;
    const filepath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    return `/uploads/${filename}`;
  } catch (e) {
    console.error('Error guardando archivo Base64:', e);
    return null;
  }
}

// REST ENDPOINTS

// 1. Obtener lista de cargos
app.get('/api/positions', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM positions ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Obtener preguntas aleatorias para un cargo
app.get('/api/positions/:id/questions', async (req, res) => {
  try {
    const { id } = req.params;
    const [questions] = await pool.query(
      'SELECT id, question_text, option_a, option_b, option_c, option_d FROM questions WHERE position_id = ? ORDER BY RAND() LIMIT 4',
      [id]
    );
    const [audioPrompts] = await pool.query('SELECT id, prompt_text FROM audio_prompts WHERE position_id = ?', [id]);
    res.json({
      questions,
      audio_prompts: audioPrompts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatTitleCase(str) {
  if (!str) return '';
  return str
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(word => word ? word.charAt(0).toUpperCase() + word.slice(1) : '')
    .join(' ');
}

// 3. Registrar postulación del candidato (Validación + Quiz + Audios + Fotos)
app.post('/api/candidates/submit', async (req, res) => {
  try {
    const {
      full_name,
      rut_id,
      age,
      position_id,
      cert_file,
      antecedentes_file,
      initial_selfie,
      random_selfie,
      answers,
      audio_file
    } = req.body;

    // Formatear nombre a Title Case (ej. "Juan Carlos Pérez González")
    const formattedName = formatTitleCase(full_name);

    // Validación de requisitos excluyentes
    if (parseInt(age, 10) < 25) {
      return res.status(400).json({
        error: 'No cumple con el requisito de edad excluyente (Debe ser mayor de 25 años).'
      });
    }

    if (!formattedName || !rut_id || !position_id) {
      return res.status(400).json({ error: 'Faltan datos obligatorios del candidato.' });
    }

    // Guardar archivos subidos
    const certPath = saveBase64File(cert_file, 'cert', 'jpg');
    const antecedentesPath = saveBase64File(antecedentes_file, 'antecedentes', 'jpg');
    const initialSelfiePath = saveBase64File(initial_selfie, 'selfie_init', 'jpg');
    const randomSelfiePath = saveBase64File(random_selfie, 'selfie_rand', 'jpg');
    const audioPath = saveBase64File(audio_file, 'audio', 'webm');

    // Calcular puntaje
    const parsedAnswers = Array.isArray(answers) ? answers : JSON.parse(answers || '[]');
    let score = 0;
    const totalQuestions = parsedAnswers.length;

    for (const ans of parsedAnswers) {
      const [qRow] = await pool.query('SELECT correct_option FROM questions WHERE id = ?', [ans.question_id]);
      if (qRow.length > 0 && qRow[0].correct_option === ans.selected_option) {
        score++;
        ans.is_correct = true;
      } else {
        ans.is_correct = false;
      }
    }

    // Determinar estado inicial
    // Aprobado si responde al menos 75% correcto
    const passesQuiz = totalQuestions > 0 ? (score / totalQuestions) >= 0.75 : false;
    const initialStatus = passesQuiz ? 'Pendiente' : 'Rechazado';

    // Insertar candidato
    const [candRes] = await pool.query(
      `INSERT INTO candidates 
      (full_name, rut_id, age, position_id, cert_file, antecedentes_file, initial_selfie, random_selfie, score, total_questions, audio_file, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        formattedName,
        rut_id,
        parseInt(age, 10),
        parseInt(position_id, 10),
        certPath,
        antecedentesPath,
        initialSelfiePath,
        randomSelfiePath,
        score,
        totalQuestions,
        audioPath,
        initialStatus
      ]
    );

    const candidateId = candRes.insertId;

    // Guardar respuestas
    for (const ans of parsedAnswers) {
      await pool.query(
        'INSERT INTO candidate_answers (candidate_id, question_id, selected_option, is_correct) VALUES (?, ?, ?, ?)',
        [candidateId, ans.question_id, ans.selected_option, ans.is_correct]
      );
    }

    res.status(201).json({
      message: 'Postulación enviada correctamente.',
      candidateId,
      score,
      totalQuestions,
      status: initialStatus
    });
  } catch (err) {
    console.error('Error al procesar candidato:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. PANEL RECLUTADOR: Obtener postulantes
app.get('/api/admin/candidates', async (req, res) => {
  try {
    const { status, position_id } = req.query;
    let query = `
      SELECT c.*, p.name as position_name 
      FROM candidates c 
      JOIN positions p ON c.position_id = p.id 
    `;
    const params = [];
    const conditions = [];

    if (status) {
      conditions.push('c.status = ?');
      params.push(status);
    }
    if (position_id) {
      conditions.push('c.position_id = ?');
      params.push(position_id);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY c.created_at DESC';

    const [candidates] = await pool.query(query, params);
    res.json(candidates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. PANEL RECLUTADOR: Cambiar estado (Aprobar / Rechazar)
app.patch('/api/admin/candidates/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'Aprobado' o 'Rechazado'

    if (!['Aprobado', 'Rechazado', 'Pendiente'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    await pool.query('UPDATE candidates SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: `Candidato #${id} actualizado a estado "${status}".` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. PANEL RECLUTADOR: Estadísticas e Impacto Económico
app.get('/api/admin/stats', async (req, res) => {
  try {
    const [totalRows] = await pool.query('SELECT COUNT(*) as count FROM candidates');
    const [approvedRows] = await pool.query("SELECT COUNT(*) as count FROM candidates WHERE status = 'Aprobado'");
    const [rejectedRows] = await pool.query("SELECT COUNT(*) as count FROM candidates WHERE status = 'Rechazado'");
    const [avgScoreRows] = await pool.query('SELECT AVG(score) as avgScore, AVG(total_questions) as avgTotal FROM candidates');

    const total = totalRows[0].count;
    const approved = approvedRows[0].count;
    const rejected = rejectedRows[0].count;
    
    // Ahorro estimado: $1.000.000 CLP por trabajador filtrado a tiempo antes de contratar
    const savedTurnoverCosts = rejected * 1000000;

    res.json({
      total,
      approved,
      rejected,
      avgScore: avgScoreRows[0].avgScore ? parseFloat(avgScoreRows[0].avgScore).toFixed(1) : 0,
      avgTotal: avgScoreRows[0].avgTotal ? parseFloat(avgScoreRows[0].avgTotal).toFixed(1) : 0,
      savedTurnoverCostsCLP: savedTurnoverCosts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Iniciar Servidor con manejo dinámico de puerto si el 3000 está ocupado
function startServer(portToUse) {
  const server = app.listen(portToUse, async () => {
    console.log(`[Servidor] Plataforma Nexxo S.A. lista en http://localhost:${portToUse}`);
    await initDB();
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[AVISO] El puerto ${portToUse} está ocupado por otro proceso. Intentando en http://localhost:${portToUse + 1}...`);
      startServer(portToUse + 1);
    } else {
      console.error('[ERROR] Error fatal al iniciar servidor:', err);
    }
  });
}

startServer(parseInt(PORT, 10));

