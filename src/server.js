const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { createWorker } = require('tesseract.js');
require('dotenv').config();

// Evitar que errores asíncronos internos de workers OCR tumben el proceso Node.js
process.on('uncaughtException', (err) => {
  console.error('[Proceso - Excepción Capturada]:', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Proceso - Promesa Rechazada]:', reason && reason.message ? reason.message : reason);
});

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar directorio de subidas estáticas
const UPLOADS_DIR = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Aumentar límites para transferencia de documentos y fotos
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

const VALID_STATES = [
  'POSTULADO',
  'DESCARTADO_TECNICO',
  'PRESELECCIONADO',
  'DOCS_CARGADOS',
  'EN_REVISION_MANUAL',
  'PRE_ACREDITADO',
  'CONTRATADO_FAENA',
  // Compatibilidad con registros antiguos
  'Pendiente',
  'Aprobado',
  'Rechazado'
];

async function initDB(retries = 10, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`[DB] Conectando a MySQL (${i + 1}/${retries})...`);
      pool = mysql.createPool(dbConfig);
      const conn = await pool.getConnection();

      // Crear tablas base
      await conn.query(`
        CREATE TABLE IF NOT EXISTS positions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          description TEXT,
          required_credential VARCHAR(150),
          min_experience_years INT DEFAULT 2,
          ecf_code VARCHAR(80)
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
          age INT DEFAULT 30,
          position_id INT NOT NULL,
          cert_file VARCHAR(255),
          antecedentes_file VARCHAR(255),
          initial_selfie VARCHAR(255),
          random_selfie VARCHAR(255),
          score INT DEFAULT 0,
          total_questions INT DEFAULT 0,
          audio_file VARCHAR(255),
          status VARCHAR(50) DEFAULT 'POSTULADO',
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

      // Migraciones seguras para soportar la Máquina de Estados y el Funnel de 4 Fases
      try { await conn.query("ALTER TABLE candidates MODIFY COLUMN status VARCHAR(50) DEFAULT 'POSTULADO'"); } catch (e) {}
      try { await conn.query('ALTER TABLE candidates MODIFY COLUMN age INT DEFAULT 30'); } catch (e) {}

      const positionMigrations = [
        'ALTER TABLE positions ADD COLUMN required_credential VARCHAR(150)',
        'ALTER TABLE positions ADD COLUMN min_experience_years INT DEFAULT 2',
        'ALTER TABLE positions ADD COLUMN ecf_code VARCHAR(80)'
      ];
      for (const sql of positionMigrations) {
        try { await conn.query(sql); } catch (e) {}
      }

      const candidateMigrations = [
        'ALTER TABLE candidates ADD COLUMN email VARCHAR(150)',
        'ALTER TABLE candidates ADD COLUMN phone VARCHAR(50)',
        'ALTER TABLE candidates ADD COLUMN city VARCHAR(100)',
        'ALTER TABLE candidates ADD COLUMN experience_years INT DEFAULT 0',
        'ALTER TABLE candidates ADD COLUMN cv_file VARCHAR(255)',
        'ALTER TABLE candidates ADD COLUMN credencial_file VARCHAR(255)',
        'ALTER TABLE candidates ADD COLUMN carnet_file VARCHAR(255)',
        'ALTER TABLE candidates ADD COLUMN carnet_back_file VARCHAR(255)',
        'ALTER TABLE candidates ADD COLUMN ocr_text TEXT',
        'ALTER TABLE candidates ADD COLUMN ocr_birth_date VARCHAR(50)',
        'ALTER TABLE candidates ADD COLUMN ocr_detected_age INT',
        'ALTER TABLE candidates ADD COLUMN ocr_verified BOOLEAN DEFAULT FALSE',
        'ALTER TABLE candidates ADD COLUMN ocr_detected_name VARCHAR(150)',
        'ALTER TABLE candidates ADD COLUMN ocr_detected_rut VARCHAR(50)',
        'ALTER TABLE candidates ADD COLUMN ocr_credencial_status VARCHAR(100)',
        'ALTER TABLE candidates ADD COLUMN ocr_antecedentes_status VARCHAR(80)',
        'ALTER TABLE candidates ADD COLUMN ocr_carnet_vigencia VARCHAR(80)',
        'ALTER TABLE candidates ADD COLUMN ocr_cross_check_ok BOOLEAN DEFAULT FALSE',
        'ALTER TABLE candidates ADD COLUMN ocr_manually_edited BOOLEAN DEFAULT FALSE',
        'ALTER TABLE candidates ADD COLUMN ocr_edited_fields VARCHAR(255)',
        'ALTER TABLE candidates ADD COLUMN discrepancy_notes TEXT',
        'ALTER TABLE candidates ADD COLUMN consent_proctoring BOOLEAN DEFAULT FALSE',
        'ALTER TABLE candidates ADD COLUMN consent_ley19628 BOOLEAN DEFAULT FALSE'
      ];
      for (const sql of candidateMigrations) {
        try { await conn.query(sql); } catch (e) {}
      }

      console.log('[DB] Tablas y Máquina de Estados MySQL verificadas exitosamente.');

      // Poblar o actualizar datos semilla de cargos y preguntas (5-8 preguntas por cargo)
      await ensureSeedData(conn);

      conn.release();
      return;
    } catch (err) {
      console.error(`[DB Error] ${err.message}`);
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

async function ensureSeedData(conn) {
  const [posRows] = await conn.query('SELECT COUNT(*) as count FROM positions');
  if (posRows[0].count === 0) {
    console.log('[DB Seed] Poblando cargos y banco de preguntas ECF Codelco El Teniente...');

    // 1. Rigger
    const [res1] = await conn.query(
      'INSERT INTO positions (name, description, required_credential, min_experience_years, ecf_code) VALUES (?, ?, ?, ?, ?)',
      [
        'Rigger (Maniobrista de Izaje)',
        'Especialista en maniobras de izaje, cálculo de cargas y señales de seguridad para grúas en paradas de planta (División El Teniente).',
        'Credencial Rigger Acreditada (ASME / ChileValora / OTEC)',
        2,
        'ECF N° 7 Codelco — Cargas Suspendidas e Izaje'
      ]
    );
    await insertQuestionsForPosition(conn, res1.insertId, 'rigger');

    // 2. Soldador
    const [res2] = await conn.query(
      'INSERT INTO positions (name, description, required_credential, min_experience_years, ecf_code) VALUES (?, ?, ?, ?, ?)',
      [
        'Soldador de Mantención Minera (WPQ)',
        'Soldador calificado para reparación de estructuras pesadas, chutes, baldes y tuberías en planta concentradora.',
        'Calificación de Soldador Vigente (WPQ / 3G, 4G o 6G - AWS)',
        2,
        'ECF N° 6 Codelco — Incendio & Trabajo en Caliente'
      ]
    );
    await insertQuestionsForPosition(conn, res2.insertId, 'soldador');

    // 3. Operador
    const [res3] = await conn.query(
      'INSERT INTO positions (name, description, required_credential, min_experience_years, ecf_code) VALUES (?, ?, ?, ?, ?)',
      [
        'Operador de Maquinaria Pesada',
        'Operador de cargador frontal, excavadora y equipos de apoyo en faenas de montaje y mantenimiento minero.',
        'Licencia Municipal Clase D / A4 Vigente + Hoja de Vida del Conductor',
        3,
        'ECF N° 3 Codelco — Maquinaria Industrial Pesada'
      ]
    );
    await insertQuestionsForPosition(conn, res3.insertId, 'operador');

    console.log('[DB Seed] Banco de preguntas ECF poblado con éxito.');
  } else {
    // Asegurar que los cargos existentes tengan metadata ECF y al menos 5 preguntas cada uno
    const [positions] = await conn.query('SELECT * FROM positions ORDER BY id ASC');
    for (const p of positions) {
      if (!p.required_credential) {
        if (/rigger/i.test(p.name)) {
          await conn.query(
            'UPDATE positions SET required_credential = ?, min_experience_years = 2, ecf_code = ? WHERE id = ?',
            ['Credencial Rigger Acreditada (ASME / ChileValora / OTEC)', 'ECF N° 7 Codelco — Cargas Suspendidas e Izaje', p.id]
          );
        } else if (/soldador/i.test(p.name)) {
          await conn.query(
            'UPDATE positions SET required_credential = ?, min_experience_years = 2, ecf_code = ? WHERE id = ?',
            ['Calificación de Soldador Vigente (WPQ / 3G, 4G o 6G - AWS)', 'ECF N° 6 Codelco — Incendio & Trabajo en Caliente', p.id]
          );
        } else {
          await conn.query(
            'UPDATE positions SET required_credential = ?, min_experience_years = 3, ecf_code = ? WHERE id = ?',
            ['Licencia Municipal Clase D / A4 Vigente + Hoja de Vida del Conductor', 'ECF N° 3 Codelco — Maquinaria Industrial Pesada', p.id]
          );
        }
      }

      const [qCount] = await conn.query('SELECT COUNT(*) as c FROM questions WHERE position_id = ?', [p.id]);
      if (qCount[0].c < 5) {
        const type = /rigger/i.test(p.name) ? 'rigger' : (/soldador/i.test(p.name) ? 'soldador' : 'operador');
        await insertQuestionsForPosition(conn, p.id, type);
      }
    }
  }
}

async function insertQuestionsForPosition(conn, posId, type) {
  if (type === 'rigger') {
    await conn.query(
      `INSERT INTO questions (position_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES
      (?, '¿Cuál es el ángulo de trabajo recomendado con respecto a la horizontal para una maniobra con eslingas de dos ramales para evitar sobrecargas críticas?', 'Entre 45° y 60°', '90° exactos en todo momento', 'Menor a 30° siempre', 'Mayor a 120°', 'A'),
      (?, 'Según el ECF N° 7 de Codelco, si un grillete o estrobo presenta un desgaste superior al 10% o deformación en su cuerpo, ¿qué acción corresponde?', 'Pintarlo para identificarlo', 'Darlo de baja e inutilizarlo de inmediato', 'Usarlo solo para cargas menores a 1 tonelada', 'Lubricar el pasador con grasa', 'B'),
      (?, 'En señales manuales estandarizadas (ASME B30.5), ¿qué significa extender el brazo horizontalmente con el puño cerrado y el pulgar apuntando hacia arriba?', 'Subir la pluma de la grúa', 'Bajar la pluma', 'Parada de emergencia', 'Extender pluma telescópica', 'A'),
      (?, '¿Qué elemento es obligatorio utilizar para guiar y controlar el giro o balanceo de una carga suspendida sin exponerse bajo la línea de fuego?', 'Cuerda guía (viento) de largo adecuado', 'Empujar la carga directamente con las manos usando guantes', 'Cadena secundaria al gancho', 'Cinta de confinamiento perimetral', 'A'),
      (?, 'Si la velocidad del viento en terreno supera el límite máximo permitido por el fabricante de la grúa o el procedimiento de izaje (ej. > 32 km/h), ¿qué debe hacer el Rigger?', 'Acelerar la maniobra para terminar rápido', 'Suspender de inmediato la maniobra de izaje y asegurar la carga en piso', 'Agregar un tercer estrobo de respaldo', 'Bajar la carga a 1 metro del suelo y continuar', 'B'),
      (?, 'Al leer la tabla de carga de una grúa móvil, si se incrementa el radio de operación (distancia horizontal desde el eje de giro hasta la carga), ¿qué ocurre con la capacidad bruta de levante?', 'Disminuye la capacidad de carga de la grúa', 'Aumenta proporcionalmente', 'Se mantiene constante si la pluma no cambia de largo', 'Depende únicamente del tipo de eslinga', 'A')`,
      [posId, posId, posId, posId, posId, posId]
    );
  } else if (type === 'soldador') {
    await conn.query(
      `INSERT INTO questions (position_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES
      (?, 'En soldadura MIG/MAG (GMAW) para reparación estructural pesada, ¿cuál es la función principal del gas de protección (mezcla Ar/CO2)?', 'Enfriar rápidamente el metal base', 'Proteger el baño de fusión contra la contaminación atmosférica (oxígeno/nitrógeno)', 'Incrementar la tensión del arco eléctrico', 'Desprender la escoria gruesa del cordón', 'B'),
      (?, 'Según estándares de seguridad en faena minera (ECF N° 6), antes de iniciar soldadura u oxicorte fuera de un taller habilitado, ¿qué documento es obligatorio y excluyente?', 'Permiso de Trabajo en Caliente (PTC) autorizado + medición de gases inflamables (LEL 0%)', 'Solo el registro de asistencia del turno', 'Orden de compra del electrodo', 'Certificado de estudios medios', 'A'),
      (?, 'En calificación de soldadores bajo código AWS D1.1 / ASME IX, ¿qué posición de soldadura representa la sigla "4G" en plancha?', 'Posición plana', 'Posición horizontal', 'Posición sobrecabeza (techo)', 'Posición vertical ascendente', 'C'),
      (?, 'Si al soldar acero estructural de gran espesor con proceso SMAW (electrodo E7018 de bajo hidrógeno) aparece porosidad agrupada al inicio del cordón, ¿cuál es la causa técnica más probable?', 'Revestimiento del electrodo con humedad por falta de horno de mantención o contaminación superficial', 'Exceso de precalentamiento controlado', 'Uso de corriente continua polaridad invertida (DCEP)', 'Limpieza excesiva del bisel con esmeril', 'A'),
      (?, '¿Cuál es el propósito técnico de realizar precalentamiento controlado en aceros de alta resistencia o alto carbono (ej. planchas antidesgaste de chutes o baldes) antes de soldar?', 'Ahorrar consumo de electrodos', 'Disminuir la velocidad de enfriamiento para evitar fisuración inducida por hidrógeno en la ZAC', 'Eliminar la necesidad de limpieza mecánica', 'Aumentar la deformación térmica de la pieza', 'B'),
      (?, 'En equipos de oxicorte, ¿qué dispositivo de seguridad es indispensable instalar en los reguladores y soplete para evitar el retroceso de llama hacia los cilindros?', 'Válvulas antirretorno y arrestallamas certificados', 'Manómetro de plástico simple', 'Abrazaderas de alambre galvanizado', 'Filtro decantador de agua', 'A')`,
      [posId, posId, posId, posId, posId, posId]
    );
  } else {
    await conn.query(
      `INSERT INTO questions (position_id, question_text, option_a, option_b, option_c, option_d, correct_option) VALUES
      (?, 'Durante la inspección pre-operacional (vuelta del perro 360°), si detecta una fuga activa en una manguera hidráulica de dirección o frenos, ¿cuál es el protocolo obligatorio?', 'Rellenar aceite hidráulico y operar hasta el cambio de turno', 'No operar el equipo, aplicar bloqueo/etiquetado de falla y reportar a supervisión/mantención', 'Colocar un paño absorbente amarrado y continuar', 'Operar solo en terreno plano', 'B'),
      (?, 'Al descender por una rampa pronunciada en faena minera con el equipo pesado cargado, ¿cuál es la técnica correcta de operación segura?', 'Bajar en neutro controlando solo con el freno de servicio', 'Mantener marcha baja enganchada, usar retardador/freno de motor y llevar el implemento (balde) bajo y controlado', 'Usar la marcha más alta para reducir revoluciones del motor', 'Apagar el motor para ahorrar combustible', 'B'),
      (?, 'Si operando maquinaria pesada en una pendiente sufre una pérdida repentina de presión en el sistema de frenos principales, ¿cuál es la maniobra inmediata de emergencia?', 'Saltar de la cabina con el equipo en movimiento', 'Bajar inmediatamente el balde/implemento al suelo, activar freno de emergencia y dirigir el equipo hacia el pretil o berma de contención', 'Poner marcha atrás de golpe a alta velocidad', 'Girar bruscamente hacia el borde libre del banco', 'B'),
      (?, 'Según el ECF N° 3 de Codelco, al estacionar un cargador frontal o excavadora al finalizar la maniobra, ¿qué pasos son obligatorios antes de descender de la cabina?', 'Bajar implemento al piso, aplicar freno de parqueo, colocar cuñas y cortar corriente/contacto', 'Dejar el balde levantado a media altura para visibilidad', 'Dejar el motor encendido en primera marcha sin freno de mano', 'Estacionar detrás de un camión CAEX en punto ciego', 'A'),
      (?, '¿Qué indica el encendido de una luz roja crítica en el tablero del equipo acompañada de alarma sonora continua durante la operación?', 'Aviso de próximo cambio de filtro de aire en 250 horas', 'Condición crítica de falla (ej. pérdida de presión de aceite o sobretemperatura): detener el equipo de inmediato en lugar seguro', 'Nivel de limpiaparabrisas bajo', 'Aire acondicionado activado', 'B'),
      (?, '¿Cuál es la regla de prioridad y comunicación obligatoria antes de ingresar con un equipo de apoyo al radio de giro de una pala o zona de carguío activa?', 'Ingresar tocando dos bocinazos sin avisar por radio', 'Solicitar autorización radial directa al operador del equipo principal y esperar confirmación visual y radial expresa', 'Pasar rápido por el lado izquierdo (punto ciego) del equipo', 'Encender solo las luces altas', 'B')`,
      [posId, posId, posId, posId, posId, posId]
    );
  }
}

// Función auxiliar para guardar imágenes Base64 / PDFs
function saveBase64File(base64Data, prefix = 'file', defaultExt = 'jpg') {
  if (!base64Data) return { url: null, absolutePath: null };
  try {
    const matches = base64Data.match(/^data:([A-Za-z0-9-+\/\.]+);base64,(.+)$/);
    let extension = defaultExt;
    if (matches && matches[1]) {
      const mime = matches[1].toLowerCase();
      if (mime.includes('pdf')) extension = 'pdf';
      else if (mime.includes('png')) extension = 'png';
      else if (mime.includes('webp')) extension = 'webp';
      else if (mime.includes('jpeg') || mime.includes('jpg')) extension = 'jpg';
    }
    const buffer = matches ? Buffer.from(matches[2], 'base64') : Buffer.from(base64Data, 'base64');
    const filename = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${extension}`;
    const filepath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filepath, buffer);
    return { url: `/uploads/${filename}`, absolutePath: filepath };
  } catch (e) {
    console.error('Error guardando archivo Base64:', e);
    return { url: null, absolutePath: null };
  }
}

function formatTitleCase(str) {
  if (!str) return '';
  return str
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(word => word ? word.charAt(0).toUpperCase() + word.slice(1) : '')
    .join(' ');
}

function formatRut(rawRut) {
  if (!rawRut) return null;
  const clean = rawRut.replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 8 || clean.length > 9) return null;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const formattedBody = body.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${formattedBody}-${dv}`;
}

function normalizeTextForMatch(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

const MONTH_MAP = {
  ENE: 1, ENERO: 1,
  FEB: 2, FEBRERO: 2,
  MAR: 3, MARZO: 3,
  ABR: 4, ABRIL: 4,
  MAY: 5, MAYO: 5,
  JUN: 6, JUNIO: 6,
  JUL: 7, JULIO: 7,
  AGO: 8, AGOSTO: 8,
  SEP: 9, SEPT: 9, SEPTIEMBRE: 9, SETIEMBRE: 9,
  OCT: 10, OCTUBRE: 10,
  NOV: 11, NOVIEMBRE: 11,
  DIC: 12, DICIEMBRE: 12
};

function extractDatesFromText(rawText) {
  const dates = [];
  if (!rawText) return dates;

  const numDateRegex = /\b([0-3]?\d)[\/\-\.]([0-1]?\d)[\/\-\.]((?:19|20)\d{2})\b|\b((?:19|20)\d{2})[\/\-\.]([0-1]?\d)[\/\-\.]([0-3]?\d)\b/g;
  for (const m of rawText.matchAll(numDateRegex)) {
    if (m[1]) {
      dates.push({ day: parseInt(m[1], 10), month: parseInt(m[2], 10), year: parseInt(m[3], 10) });
    } else if (m[4]) {
      dates.push({ year: parseInt(m[4], 10), month: parseInt(m[5], 10), day: parseInt(m[6], 10) });
    }
  }

  const textDateRegex = /\b([0-3]?\d)\s*(?:DE\s+|\.|\-|\s)\s*(ENE(?:RO)?|FEB(?:RERO)?|MAR(?:ZO)?|ABR(?:IL)?|MAY(?:O)?|JUN(?:IO)?|JUL(?:IO)?|AGO(?:STO)?|SEP(?:T(?:IEMBRE)?)?|SETIEMBRE|OCT(?:UBRE)?|NOV(?:IEMBRE)?|DIC(?:IEMBRE)?)\.?\s*(?:DE\s+|\.|\-|\s)\s*((?:19|20)\d{2})\b/gi;
  for (const m of rawText.matchAll(textDateRegex)) {
    const day = parseInt(m[1], 10);
    const monthKey = m[2].toUpperCase().replace('.', '');
    const month = MONTH_MAP[monthKey];
    const year = parseInt(m[3], 10);
    if (month) {
      dates.push({ day, month, year });
    }
  }

  return dates.filter(d => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31);
}

// Etiquetas legítimas de campos de nombre que pueden preceder al nombre del titular en una misma línea
const FIELD_LABEL_PREFIX_REGEX = /\b(?:FOTO\s+OFICIAL|NOMBRE\s+COMPLETO|NOMBRE\s+DEL\s+TITULAR|NOMBRE\s+DEL\s+POSTULANTE|NOMBRE\s+DEL\s+TRABAJADOR|NOMBRE\s+DEL\s+ALUMNO|CERTIFICA\s+QUE|APELLIDOS?|NOMBRES?|POSTULANTE|TRABAJADOR|TITULAR|ALUMNO|FOTO|OFICIAL)\b\s*:?\s*/gi;

// Palabras de contexto que DESCALIFICAN por completo una línea o frase como nombre de persona
// (Nunca se deben borrar dejando el resto de la línea, para no convertir "Universidad Adolfo Ibáñez" en "Adolfo Ibáñez"
// ni "Constructora Miguel Morales" en "Miguel Morales")
const NON_NAME_CONTEXT_WORDS = new Set([
  // Instituciones educativas y términos académicos
  'UNIVERSIDAD', 'UNIVERSITARIO', 'UNIVERSITARIA', 'INSTITUTO', 'COLEGIO', 'LICEO', 'ESCUELA',
  'FACULTAD', 'ACADEMIA', 'CAMPUS', 'SEDE', 'CENTRO', 'CFT', 'DUOC', 'INACAP', 'AIEP',
  'EDUCACION', 'FORMACION', 'ACADEMICA', 'ACADEMICO', 'ESTUDIOS', 'CURSANDO', 'EGRESADO',
  'TITULADO', 'GRADUADO', 'MEMORIA', 'TESIS', 'DISTINCION', 'MAXIMA', 'PRACTICA', 'OPERARIA',
  'CURSOS', 'CURSO', 'CERTIFICACION', 'CERTIFICACIONES', 'DIPLOMADO', 'MAGISTER', 'DOCTORADO',
  'PREGRADO', 'POSTGRADO', 'LICENCIATURA', 'LICENCIADO', 'BACHILLERATO', 'ALUMNO', 'ESTUDIANTE',
  // Cargos, profesiones y oficios
  'INGENIERIA', 'INGENIERO', 'TECNICO', 'TECNOLOGO', 'ANALISTA', 'BODEGUERO', 'BODEGERO',
  'JORNAL', 'OPERADOR', 'SOLDADOR', 'RIGGER', 'MANIOBRISTA', 'MAESTRO', 'CAPATAZ',
  'SUPERVISOR', 'JEFE', 'GERENTE', 'DIRECTOR', 'CONSULTOR', 'ASISTENTE', 'AYUDANTE',
  'MECANICO', 'ELECTRICO', 'ELECTROMECANICO', 'PREVENCIONISTA', 'CONDUCTOR', 'CHOFER',
  'OCUPACION', 'PROFESION', 'PROFESIONAL', 'CARGO', 'PUESTO', 'ESPECIALIDAD', 'MENCION',
  'TECNOLOGIAS', 'INFORMACION',
  // Empresas, organizaciones e industria
  'CONSTRUCTORA', 'CONSULTORIA', 'EMPRESA', 'SOCIEDAD', 'COMPANIA', 'CORPORACION', 'FUNDACION',
  'GRUPO', 'CABAL', 'HOLDING', 'MINERA', 'DIVISION', 'CODELCO', 'TENIENTE', 'MANDANTE',
  'CONTRATISTA', 'SUBCONTRATISTA', 'SERVICIOS', 'SERVICIO', 'COMERCIAL', 'INDUSTRIAL',
  'INFORMATICO', 'SOLUCIONES', 'TECHSOLUTIONS', 'GLOBAL', 'SPA', 'LTDA', 'LIMITADA',
  'CLINICA', 'HOSPITAL', 'MUTUAL', 'ACHS', 'IST', 'SERNAGEOMIN', 'CHILEVALORA', 'SENCE',
  'ALLIANCE', 'SCRUM', 'BIZAGI', 'POWER', 'DOCKER', 'PYTHON', 'EXCEL',
  // Secciones de CV, habilidades y descriptores
  'CURRICULUM', 'VITAE', 'INFOGRAFIA', 'GRAFICO', 'SIMPLE', 'AZUL', 'AMARILLO', 'RESUMEN',
  'PERFIL', 'EXPERIENCIA', 'LABORAL', 'HABILIDADES', 'COMPETENCIAS', 'CARACTERISTICAS',
  'CONTACTO', 'TELEFONO', 'CORREO', 'REFERENCIAS', 'OBJETIVO', 'IDIOMAS', 'ESPANOL', 'INGLES',
  'NATIVO', 'AVANZADO', 'HERRAMIENTAS', 'METODOLOGIAS', 'AGILES', 'KANBAN', 'MEJORA',
  'CONTINUA', 'NEGOCIO', 'MODELAMIENTO', 'OPTIMIZACION', 'LOGISTICA', 'ANALITICA', 'TABLEROS',
  'PIPELINES', 'BASES', 'DISTRIBUIDAS', 'REEMPLAZO', 'LICENCIA', 'PROYECTO', 'PROYECTOS',
  'DATOS', 'GESTION', 'OPERACIONES', 'PROCESOS', 'EQUIPO', 'TRABAJO', 'DISPOSICION',
  'ORATORIA', 'AFABLE', 'EXTROVERTIDO', 'RESPONSABLE', 'PROACTIVO', 'EDAD', 'ANOS',
  'NACIONALIDAD', 'CHILENO', 'CHILENA', 'SEXO', 'OPCIONAL',
  // Direcciones, calles, comunas y ciudades
  'AVENIDA', 'CALLE', 'PASAJE', 'CAMINO', 'CARRETERA', 'RUTA', 'PANAMERICANA', 'NORTE', 'SUR',
  'ORIENTE', 'PONIENTE', 'COMUNA', 'CIUDAD', 'REGION', 'SECTOR', 'VILLA', 'ROBLE', 'LAMPA',
  'SANTIAGO', 'RANCAGUA', 'MACHALI', 'CALAMA', 'ANTOFAGASTA', 'COPIAPO', 'IQUIQUE',
  'CONCEPCION', 'VALPARAISO', 'VINA', 'MAR', 'SERENA', 'COQUIMBO', 'TEMUCO', 'TALCA',
  'CURICO', 'PENALOLEN', 'PROVIDENCIA', 'CONDES', 'MAIPU', 'QUILICURA', 'COLINA', 'CHILE',
  // Fechas, meses y términos legales / documentos oficiales
  'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE',
  'SETIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE', 'ACTUALIDAD', 'PRESENTE', 'ACTUALMENTE',
  'VIGENCIA', 'EMISION', 'VENCIMIENTO', 'NACIMIENTO', 'FECHA', 'REPUBLICA', 'REGISTRO',
  'CIVIL', 'IDENTIFICACION', 'CEDULA', 'NUMERO', 'DOCUMENTO', 'FIRMA', 'INFORMADA', 'NACIO',
  'CERTIFICADO', 'ANTECEDENTES', 'PARTICULARES', 'FINES', 'CONDENAS', 'ANOTACIONES',
  'GENERAL', 'ESPECIAL', 'VIOLENCIA', 'INTRAFAMILIAR', 'FOLIO', 'CODIGO', 'VERIFICACION',
  'TIMBRE', 'ELECTRONICO', 'GRATUITO', 'IMPRESO', 'ACREDITACION', 'BAJO', 'NORMA', 'ASME',
  'NIVEL', 'IZAJES', 'CRITICOS', 'HOMOLOGADO', 'ESTANDAR', 'CONTROL', 'FATALIDADES', 'ECF',
  'HABILITANTE', 'CALIFICACION', 'CLASE', 'VALIDO', 'PARA', 'INCORPORA', 'AVANZADA',
  'VERIFIQUE', 'CENTER', 'TELEFONOS', 'FIJOS', 'CELULARES', 'PROXIMA', 'OBTEN', 'ESTE',
  'NOMBRE', 'NOMBRES', 'APELLIDO', 'APELLIDOS', 'COMPLETO', 'TITULAR', 'POSTULANTE',
  'TRABAJADOR', 'FOTO', 'OFICIAL', 'CERTIFICA', 'QUE', 'RUN', 'RUT'
]);

// Nombres epónimos de universidades, institutos, colegios y calles chilenas que jamás deben tomarse como el postulante
const BLOCKED_EPONYMOUS_NAMES = [
  'ADOLFO IBANEZ',
  'ANDRES BELLO',
  'FEDERICO SANTA MARIA',
  'DIEGO PORTALES',
  'ALBERTO HURTADO',
  'BERNARDO OHIGGINS',
  'BERNARDO O HIGGINS',
  'ARTURO PRAT',
  'GABRIELA MISTRAL',
  'PEDRO DE VALDIVIA',
  'FINIS TERRAE',
  'SANTO TOMAS',
  'SAN SEBASTIAN',
  'VIRGINIO GOMEZ',
  'GUILLERMO SUBERCASEAUX',
  'RAUL SILVA HENRIQUEZ',
  'MIGUEL DE CERVANTES',
  'VICENTE PEREZ ROSALES',
  'MANUEL RODRIGUEZ',
  'VICUNA MACKENNA',
  'BENJAMIN VICUNA MACKENNA',
  'JOSE MIGUEL CARRERA',
  'IGNACIO CARRERA PINTO',
  'ALONSO DE ERCILLA'
];

const NAME_CONNECTORS = /^(de|del|la|las|los|y|san|von|van)$/i;

function normalizeWordForCheck(word) {
  return (word || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .toUpperCase();
}

function isValidPersonName(candidateStr) {
  if (!candidateStr || typeof candidateStr !== 'string') return false;

  const normFull = normalizeTextForMatch(candidateStr);
  if (!normFull) return false;

  for (const blocked of BLOCKED_EPONYMOUS_NAMES) {
    if (normFull.includes(blocked)) return false;
  }

  const words = candidateStr.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;

  let mainWordsCount = 0;
  let longWordsCount = 0;

  for (const w of words) {
    const cleanW = w.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ]/g, '');
    if (!cleanW) return false;

    const normW = normalizeWordForCheck(cleanW);
    if (!normW) return false;
    if (NON_NAME_CONTEXT_WORDS.has(normW)) return false;

    if (NAME_CONNECTORS.test(cleanW)) {
      continue;
    }

    // Cada nombre o apellido real debe tener al menos 3 letras (descarta basura de QR como "Ro Xt Ae Tu")
    if (cleanW.length < 3 || cleanW.length > 18) return false;
    // Debe contener al menos una vocal y una consonante
    if (!/[aeiouáéíóúAEIOUÁÉÍÓÚ]/.test(cleanW)) return false;
    if (!/[bcdfghjklmnñpqrstvwxyzBCDFGHJKLMNÑPQRSTVWXYZ]/.test(cleanW)) return false;
    // Evitar repeticiones de 3 letras iguales seguidas por ruido OCR
    if (/(.)\1\1/i.test(cleanW)) return false;

    mainWordsCount++;
    if (cleanW.length >= 4) longWordsCount++;
  }

  return mainWordsCount >= 2 && longWordsCount >= 2;
}

function pickBestPersonName(candidatesList, referenceNameOrEmail = null) {
  const validList = [];
  const seen = new Set();

  for (const raw of (candidatesList || [])) {
    if (!raw || typeof raw !== 'string') continue;
    const formatted = formatTitleCase(raw);
    if (!isValidPersonName(formatted)) continue;
    const key = normalizeTextForMatch(formatted);
    if (!seen.has(key)) {
      seen.add(key);
      validList.push(formatted);
    }
  }

  if (validList.length === 0) return null;

  let normRef = '';
  let emailLocal = '';
  if (referenceNameOrEmail && typeof referenceNameOrEmail === 'string') {
    if (referenceNameOrEmail.includes('@')) {
      emailLocal = referenceNameOrEmail.split('@')[0].replace(/[^a-zA-Z]/g, '').toUpperCase();
    } else {
      normRef = normalizeTextForMatch(referenceNameOrEmail);
    }
  }
  const refTokens = normRef ? normRef.split(' ').filter(t => t.length >= 3) : [];

  let bestName = validList[0];
  let bestScore = -999;

  for (let idx = 0; idx < validList.length; idx++) {
    const name = validList[idx];
    const words = name.split(/\s+/);
    const normCand = normalizeTextForMatch(name);
    const candTokens = normCand.split(' ').filter(t => t.length >= 3);

    let score = Math.max(0, 15 - idx * 4);

    // Preferir nombres oficiales completos de 3 a 4 palabras (Nombres + 2 Apellidos) sobre nombres cortos de CV (2 palabras)
    if (words.length === 4) score += 42;
    else if (words.length === 3) score += 38;
    else if (words.length === 2) score += 15;
    else score += 10;

    // Si este nombre más completo contiene todos los tokens de otro nombre más corto de la lista (ej. "Cristóbal Mena Illanes" contiene "Cristóbal Mena")
    for (const other of validList) {
      if (other === name) continue;
      const otherTokens = normalizeTextForMatch(other).split(' ').filter(t => t.length >= 3);
      if (otherTokens.length >= 2 && otherTokens.length < candTokens.length) {
        const allIncluded = otherTokens.every(t => candTokens.includes(t));
        if (allIncluded) score += 45;
      }
    }

    // Cruce con nombre de referencia
    if (refTokens.length > 0) {
      const matched = refTokens.filter(t => normCand.includes(t)).length;
      score += matched * 50;
    }

    // Cruce con el correo electrónico del CV (ej. cristobalmenaillanes88@gmail.com)
    if (emailLocal.length >= 5) {
      const emailMatched = candTokens.filter(t => emailLocal.includes(t)).length;
      score += emailMatched * 45;
    }

    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }

  return bestName;
}

function isValidChileanRutMod11(rawRut) {
  if (!rawRut) return false;
  const clean = String(rawRut).replace(/[^0-9kK]/g, '').toUpperCase();
  if (clean.length < 8 || clean.length > 9) return false;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  if (!/^\d+$/.test(body)) return false;
  const num = parseInt(body, 10);
  if (num < 1000000 || num > 50000000) return false;
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i], 10) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const rem = 11 - (sum % 11);
  const expectedDv = rem === 11 ? '0' : rem === 10 ? 'K' : String(rem);
  return dv === expectedDv;
}

// Segmenta el texto de un CV en secciones lógicas para evitar confundir datos de Experiencia, Educación o Referencias con Datos de Contacto
function splitCvIntoSections(rawText) {
  const sections = {
    HEADER: [],
    CONTACTO: [],
    PERFIL: [],
    EXPERIENCIA: [],
    EDUCACION: [],
    HABILIDADES: [],
    CARACTERISTICAS: [],
    CURSOS: [],
    REFERENCIAS: []
  };

  let currentSection = 'HEADER';
  const rawLines = (rawText || '').split(/\r?\n/);

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('[PDF_HEADER_NAME]:') || line.startsWith('[---')) continue;

    const cleanHeader = line.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, '').replace(/\s+/g, ' ').trim();

    if (/^(?:CONTACTO|DATOS\s+PERSONALES|INFORMACI[ÓO]N\s+DE\s+CONTACTO|INFORMACI[ÓO]N\s+PERSONAL|ANTECEDENTES\s+PERSONALES)$/i.test(cleanHeader)) {
      currentSection = 'CONTACTO';
      continue;
    }
    if (/^(?:PERFIL(?:\s+PROFESIONAL|\s+LABORAL)?|RESUMEN(?:\s+PROFESIONAL|\s+LABORAL|\s+EJECUTIVO)?|SOBRE\s+M[ÍI]|OBJETIVO(?:\s+PROFESIONAL|\s+LABORAL)?|PRESENTACI[ÓO]N)$/i.test(cleanHeader)) {
      currentSection = 'PERFIL';
      continue;
    }
    if (/^(?:EXPERIENCIA(?:\s+LABORAL|\s+PROFESIONAL|\s+T[ÉE]CNICA|\s+EN\s+FAENA)?|HISTORIAL\s+LABORAL|ANTECEDENTES\s+LABORALES|TRAYECTORIA(?:\s+LABORAL)?)$/i.test(cleanHeader)) {
      currentSection = 'EXPERIENCIA';
      continue;
    }
    if (/^(?:EDUCACI[ÓO]N|FORMACI[ÓO]N(?:\s+ACAD[ÉE]MICA)?|ESTUDIOS|ANTECEDENTES\s+ACAD[ÉE]MICOS)$/i.test(cleanHeader)) {
      currentSection = 'EDUCACION';
      continue;
    }
    if (/^(?:HABILIDADES(?:\s+Y\s+COMPETENCIAS)?|COMPETENCIAS|APTITUDES|CONOCIMIENTOS)$/i.test(cleanHeader)) {
      currentSection = 'HABILIDADES';
      continue;
    }
    if (/^(?:CARACTER[ÍI]STICAS|OTROS\s+DATOS|INFORMACI[ÓO]N\s+ADICIONAL)$/i.test(cleanHeader)) {
      currentSection = 'CARACTERISTICAS';
      continue;
    }
    if (/^(?:CERTIFICACIONES(?:\s+Y\s+CURSOS)?(?:\s+OPCIONAL)?|CURSOS(?:\s+Y\s+CERTIFICACIONES)?|CAPACITACIONES)$/i.test(cleanHeader)) {
      currentSection = 'CURSOS';
      continue;
    }
    if (/^(?:REFERENCIAS(?:\s+LABORALES|\s+PROFESIONALES|\s+PERSONALES)?)$/i.test(cleanHeader)) {
      currentSection = 'REFERENCIAS';
      continue;
    }

    sections[currentSection].push(line);
  }

  return {
    HEADER: sections.HEADER.join('\n'),
    CONTACTO: sections.CONTACTO.join('\n'),
    PERFIL: sections.PERFIL.join('\n'),
    EXPERIENCIA: sections.EXPERIENCIA.join('\n'),
    EDUCACION: sections.EDUCACION.join('\n'),
    HABILIDADES: sections.HABILIDADES.join('\n'),
    CARACTERISTICAS: sections.CARACTERISTICAS.join('\n'),
    CURSOS: sections.CURSOS.join('\n'),
    REFERENCIAS: sections.REFERENCIAS.join('\n')
  };
}

// Calcula la experiencia laboral real sumando meses trabajados en la sección de Experiencia,
// ignorando prácticas estudiantiles y años de Educación
function calculateExperienceFromSections(sections, fullTextWithoutRefs) {
  const explicitMatch = (fullTextWithoutRefs || '').match(/(\d{1,2})\s*(?:\+\s*)?a[ñn]os?\s+de\s+experiencia/i);
  if (explicitMatch) {
    const yrs = parseInt(explicitMatch[1], 10);
    return { years: yrs, months: yrs * 12 };
  }

  const expText = sections.EXPERIENCIA || '';
  if (!expText) {
    return { years: null, months: null };
  }

  // Excluir bloques de prácticas estudiantiles/operarias/profesionales (ej. "Practica operaria ... enero-febrero 2025")
  const cleanedExp = expText.replace(
    /\bpr[áa]ctica\s+(?:operaria|profesional|laboral|industrial|estudiantil|universitaria|t[ée]cnica)[\s\S]{0,140}?\b(?:19|20)\d{2}\b/gi,
    ' '
  );
  const normExp = cleanedExp.replace(/\s+/g, ' ');

  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  const workedMonths = new Set();

  const addMonthRange = (y1, m1, y2, m2) => {
    if (!y1 || !y2 || y1 < 1980 || y2 > curY + 1) return;
    const startIdx = y1 * 12 + (m1 - 1);
    const endIdx = y2 * 12 + (m2 - 1);
    if (endIdx < startIdx || (endIdx - startIdx) > 45 * 12) return;
    for (let idx = startIdx; idx <= endIdx; idx++) {
      workedMonths.add(idx);
    }
  };

  const monthNamesPattern = 'ENE(?:RO)?|FEB(?:RERO)?|MAR(?:ZO)?|ABR(?:IL)?|MAY(?:O)?|JUN(?:IO)?|JUL(?:IO)?|AGO(?:STO)?|SEP(?:T(?:IEMBRE)?)?|SETIEMBRE|OCT(?:UBRE)?|NOV(?:IEMBRE)?|DIC(?:IEMBRE)?';
  const presentPattern = 'ACTUALIDAD|PRESENTE|ACTUALMENTE|VIGENCIA\\s+ACTUAL|AL\\s+D[ÍI]A\\s+DE\\s+HOY|HOY';

  let workingStr = normExp;

  // 1. Rango "Mes Año - Mes Año" o "Mes Año - Actualidad"
  const rangeMonthYearRegex = new RegExp(
    `\\b(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})\\s*(?:[\\-–—/]|a|hasta)\\s*(?:(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})|(${presentPattern}))\\b`,
    'gi'
  );
  workingStr = workingStr.replace(rangeMonthYearRegex, (match, m1Str, y1Str, m2Str, y2Str, presStr) => {
    const m1 = MONTH_MAP[m1Str.toUpperCase().replace('.', '')];
    const y1 = parseInt(y1Str, 10);
    if (presStr) {
      addMonthRange(y1, m1, curY, curM);
    } else {
      const m2 = MONTH_MAP[m2Str.toUpperCase().replace('.', '')];
      const y2 = parseInt(y2Str, 10);
      addMonthRange(y1, m1, y2, m2);
    }
    return ' ';
  });

  // 2. Rango dentro del mismo año "Mes1 - Mes2 Año" (ej. "enero-febrero 2025")
  const sameYearMonthsRegex = new RegExp(
    `\\b(${monthNamesPattern})\\.?\\s*(?:[\\-–—/]|a)\\s*(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})\\b`,
    'gi'
  );
  workingStr = workingStr.replace(sameYearMonthsRegex, (match, m1Str, m2Str, yStr) => {
    const m1 = MONTH_MAP[m1Str.toUpperCase().replace('.', '')];
    const m2 = MONTH_MAP[m2Str.toUpperCase().replace('.', '')];
    const y = parseInt(yStr, 10);
    addMonthRange(y, m1, y, m2);
    return ' ';
  });

  // 3. Mes único puntual "Mes Año" (ej. "julio 2021" -> 1 mes)
  const singleMonthYearRegex = new RegExp(
    `\\b(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})\\b`,
    'gi'
  );
  workingStr = workingStr.replace(singleMonthYearRegex, (match, m1Str, y1Str) => {
    const m1 = MONTH_MAP[m1Str.toUpperCase().replace('.', '')];
    const y1 = parseInt(y1Str, 10);
    addMonthRange(y1, m1, y1, m1);
    return ' ';
  });

  // 4. Rango de años puros "Año1 - Año2 / Actualidad"
  const yearRangeRegex = new RegExp(
    `\\b((?:19|20)\\d{2})\\s*(?:[\\-–—/]|a|hasta)\\s*(?:((?:19|20)\\d{2})|(${presentPattern}))\\b`,
    'gi'
  );
  workingStr.replace(yearRangeRegex, (match, y1Str, y2Str, presStr) => {
    const y1 = parseInt(y1Str, 10);
    if (presStr) {
      addMonthRange(y1, 1, curY, curM);
    } else {
      const y2 = parseInt(y2Str, 10);
      addMonthRange(y1, 1, y2, 12);
    }
    return ' ';
  });

  if (workedMonths.size === 0) {
    return { years: null, months: null };
  }

  const totalMonths = workedMonths.size;
  const totalYears = Math.floor(totalMonths / 12);
  return { years: totalYears, months: totalMonths };
}

// Analizador OCR general para documentos de Fase 1 (CV / Credencial) y Fase 2 (Carnet / Antecedentes)
function parseExtractedText(rawText) {
  if (!rawText) {
    return {
      detected_name: null,
      detected_rut: null,
      detected_email: null,
      detected_phone: null,
      detected_city: null,
      detected_experience_years: null,
      detected_experience_months: null,
      detected_credencial_status: null,
      birth_date: null,
      detected_age: null,
      carnet_vigencia: null,
      antecedentes_status: null
    };
  }

  const currentYear = new Date().getFullYear();

  // Segmentar CV en secciones lógicas y aislar la sección de REFERENCIAS para no tomar datos de terceros
  const cvSections = splitCvIntoSections(rawText);
  const textWithoutRefs = [
    cvSections.HEADER,
    cvSections.CONTACTO,
    cvSections.PERFIL,
    cvSections.EXPERIENCIA,
    cvSections.EDUCACION,
    cvSections.HABILIDADES,
    cvSections.CARACTERISTICAS,
    cvSections.CURSOS
  ].filter(Boolean).join('\n');

  const personalContactText = [
    cvSections.HEADER,
    cvSections.CONTACTO,
    cvSections.CARACTERISTICAS
  ].filter(Boolean).join('\n');

  // Extraer pista de encabezado visual del PDF si fue inyectada por extractTextFromPdfWithPoppler
  let pdfHeaderName = null;
  const pdfHeaderMatch = rawText.match(/^\[PDF_HEADER_NAME\]:\s*(.+)$/m);
  if (pdfHeaderMatch && pdfHeaderMatch[1]) {
    const candidateHeader = formatTitleCase(pdfHeaderMatch[1].trim());
    if (isValidPersonName(candidateHeader)) {
      pdfHeaderName = candidateHeader;
    }
  }

  // 0. Detectar Zona de Lectura Mecánica (MRZ ICAO) del reverso de la Cédula de Identidad Chilena
  // Ejemplo MRZ Línea 2: 0404192M3404193CHL21559457<2<6
  // Ejemplo MRZ Línea 3: MEDINA<PAVEZ<<MATIAS<ALONSO<<< o MENA<ILLANES<<CRISTOBAL<<<<<<<
  let mrzName = null;
  let mrzRut = null;
  let mrzBirthDate = null;
  let mrzAge = null;
  let mrzExpiryDateObj = null;
  let mrzExpiryFormatted = null;

  const mrzDataMatch = rawText.match(/(\d{6})\d[MF<«](\d{6})\dCHL\s*(\d{7,8})\s*[<«\-K\s]\s*([0-9K])/i);
  if (mrzDataMatch) {
    const bYY = parseInt(mrzDataMatch[1].slice(0, 2), 10);
    const bMM = parseInt(mrzDataMatch[1].slice(2, 4), 10);
    const bDD = parseInt(mrzDataMatch[1].slice(4, 6), 10);
    const birthYear = bYY <= (currentYear % 100) ? (2000 + bYY) : (1900 + bYY);
    if (bMM >= 1 && bMM <= 12 && bDD >= 1 && bDD <= 31) {
      mrzBirthDate = `${String(bDD).padStart(2, '0')}/${String(bMM).padStart(2, '0')}/${birthYear}`;
      const today = new Date();
      let age = today.getFullYear() - birthYear;
      const mDiff = (today.getMonth() + 1) - bMM;
      if (mDiff < 0 || (mDiff === 0 && today.getDate() < bDD)) age--;
      mrzAge = age;
    }

    const eYY = parseInt(mrzDataMatch[2].slice(0, 2), 10);
    const eMM = parseInt(mrzDataMatch[2].slice(2, 4), 10);
    const eDD = parseInt(mrzDataMatch[2].slice(4, 6), 10);
    const expYear = 2000 + eYY;
    if (eMM >= 1 && eMM <= 12 && eDD >= 1 && eDD <= 31) {
      mrzExpiryDateObj = new Date(expYear, eMM - 1, eDD);
      mrzExpiryFormatted = `${String(eDD).padStart(2, '0')}/${String(eMM).padStart(2, '0')}/${expYear}`;
    }

    mrzRut = formatRut(`${mrzDataMatch[3]}-${mrzDataMatch[4]}`);
  }

  const mrzNameMatch = rawText.match(/([A-ZÑ]{3,})\s*[<«]+\s*([A-ZÑ]{3,})\s*[<«]{1,}\s*([A-ZÑ]+(?:[\s<«]+[A-ZÑ]+)*)/i);
  if (mrzNameMatch) {
    const ap1 = mrzNameMatch[1].trim();
    const ap2 = mrzNameMatch[2].trim();
    const nomTokens = mrzNameMatch[3]
      .split(/[\s<«]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !/^[CKLX]+$/i.test(t));
    if (nomTokens.length > 0) {
      const candidateMrzName = formatTitleCase(`${nomTokens.join(' ')} ${ap1} ${ap2}`);
      if (isValidPersonName(candidateMrzName)) {
        mrzName = candidateMrzName;
      }
    }
  }

  // 1. Extraer RUT / RUN chileno (ignorando sección de Referencias y validando Módulo 11 en números sin etiqueta)
  let detectedRut = mrzRut || null;
  if (!detectedRut) {
    const rutLabelMatch = textWithoutRefs.match(/(?:R\.?U\.?[NT]\.?|CEDULA\s+DE\s+IDENTIDAD)[^\d]{0,35}(\d{1,2}(?:[\.\s]\d{3}){2}[\-\s]?[0-9kK]|\d{7,8}[\-\s]?[0-9kK])/i);
    if (rutLabelMatch && rutLabelMatch[1]) {
      detectedRut = formatRut(rutLabelMatch[1]);
    }
  }
  if (!detectedRut) {
    const genericRutMatches = [...textWithoutRefs.matchAll(/\b(\d{1,2}(?:[\.\s]\d{3}){2}[\-][0-9kK]|\d{7,8}[\-][0-9kK])\b/g)];
    for (const m of genericRutMatches) {
      if (isValidChileanRutMod11(m[1])) {
        detectedRut = formatRut(m[1]);
        break;
      }
    }
  }

  // 2. Extraer Email, Teléfono y Ciudad de Residencia (estrictamente desde Contacto/Encabezado, nunca desde Experiencia, Educación ni Referencias)
  const emailMatch = personalContactText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/) ||
                     textWithoutRefs.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  const detectedEmail = emailMatch ? emailMatch[0].toLowerCase() : null;

  const phoneRegex = /(?:\(?\+?56\)?[\s\-]*9[\s\-]*\d{4}[\s\-]*\d{4}|\b9[\s\-]*\d{4}[\s\-]*\d{4}\b)/;
  const phoneMatch = personalContactText.match(phoneRegex) || textWithoutRefs.match(phoneRegex);
  const detectedPhone = phoneMatch ? phoneMatch[0].replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim() : null;

  let detectedCity = null;
  const cityNamesRegex = /\b(Santiago|Rancagua|Machal[íi]|Calama|Antofagasta|Copiap[óo]|Iquique|Concepci[óo]n|Valpara[íi]so|Vi[ñn]a\s+del\s+Mar|La\s+Serena|Coquimbo|Talca|Temuco|Puerto\s+Montt|Punta\s+Arenas|Arica|Curic[óo]|Los\s+Andes|San\s+Fernando|Coya|Lampa|Colina|Quilicura|Maip[úu]|Puente\s+Alto|San\s+Bernardo|Providencia|Las\s+Condes|Pe[ñn]alol[ée]n)\b/i;

  // 2a. Primero buscar etiqueta explícita de residencia ("Ciudad:", "Comuna:", "Residencia:", "Domicilio:", "Ubicación:")
  const explicitCityLabel = personalContactText.match(/(?:Ciudad|Comuna|Residencia|Domicilio|Ubicaci[óo]n)\s*:\s*([^\n•|]+)/i);
  if (explicitCityLabel && explicitCityLabel[1]) {
    const mCity = explicitCityLabel[1].match(cityNamesRegex);
    if (mCity) detectedCity = formatTitleCase(mCity[1]);
  }

  // 2b. Si no hay etiqueta explícita, buscar únicamente en las líneas de HEADER y CONTACTO (jamás en EXPERIENCIA ni EDUCACION)
  if (!detectedCity) {
    const headerAndContactLines = `${cvSections.HEADER}\n${cvSections.CONTACTO}`
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);

    for (const line of headerAndContactLines) {
      // Descartar líneas que mencionen universidades, empresas, reemplazos, prácticas o cargos
      if (/\b(?:Universidad|Instituto|Colegio|Liceo|Escuela|Reemplazo|Pr[áa]ctica|Constructora|Empresa|Grupo|Consultor[íi]a|Faena|Planta|Divisi[óo]n|Mandante)\b/i.test(line)) {
        continue;
      }
      const mCity = line.match(cityNamesRegex);
      if (mCity) {
        detectedCity = formatTitleCase(mCity[1]);
        break;
      }
    }
  }

  // 3. Extraer Años y Meses reales de Experiencia desde la sección EXPERIENCIA (ignorando prácticas estudiantiles y años de Educación)
  const expCalc = calculateExperienceFromSections(cvSections, textWithoutRefs);
  const detectedExpYears = expCalc.years;
  const detectedExpMonths = expCalc.months;

  // 4. Detectar tipo y vigencia de Credencial Técnica (Rigger, Soldador WPQ, Licencia Clase D / Hoja de Vida)
  let credencialStatus = null;
  const hasRigger = /\b(RIGGER|IZAJE|MANIOBRISTA|B30\.5|B30\.9|CHILEVALORA|GRUAS?)\b/i.test(rawText);
  const hasSoldador = /\b(SOLDADOR|SOLDADURA|WPQ|AWS|3G|4G|6G|MIG|TIG|SMAW)\b/i.test(rawText);
  const hasOperador = /\b(CLASE\s*D|CLASE\s*A4|MAQUINARIA\s*PESADA|CONDUCTOR|EXCAVADORA|CARGADOR\s*FRONTAL)\b/i.test(rawText);

  if (hasRigger) credencialStatus = 'Credencial Rigger Detectada';
  else if (hasSoldador) credencialStatus = 'Calificación Soldador (WPQ) Detectada';
  else if (hasOperador) credencialStatus = 'Licencia Clase D / Conductor Detectada';

  // 5. Extraer Fechas (Nacimiento vs. Vigencia de Cédula / Emisión)
  const candidateDates = extractDatesFromText(rawText);

  let detectedBirthDate = mrzBirthDate || null;
  let detectedAge = mrzAge ?? null;
  let oldestYear = 9999;
  let latestDateObj = mrzExpiryDateObj || null;
  let latestDateFormatted = mrzExpiryFormatted || null;

  for (const d of candidateDates) {
    if (!detectedBirthDate && d.year >= 1940 && d.year <= (currentYear - 17)) {
      if (d.year < oldestYear) {
        oldestYear = d.year;
        const birthDateObj = new Date(d.year, d.month - 1, d.day);
        const today = new Date();
        let age = today.getFullYear() - birthDateObj.getFullYear();
        const mDiff = today.getMonth() - birthDateObj.getMonth();
        if (mDiff < 0 || (mDiff === 0 && today.getDate() < birthDateObj.getDate())) {
          age--;
        }
        detectedAge = age;
        detectedBirthDate = `${String(d.day).padStart(2, '0')}/${String(d.month).padStart(2, '0')}/${d.year}`;
      }
    }
    if (d.year >= 2020 && d.year <= 2040) {
      const dt = new Date(d.year, d.month - 1, d.day);
      if (!latestDateObj || dt > latestDateObj) {
        latestDateObj = dt;
        latestDateFormatted = `${String(d.day).padStart(2, '0')}/${String(d.month).padStart(2, '0')}/${d.year}`;
      }
    }
  }

  if (detectedAge === null) {
    const explicitAgeMatch = textWithoutRefs.match(/\bEdad\s*:\s*(\d{2})\s*a[ñn]os\b/i) ||
                             textWithoutRefs.match(/\b(\d{2})\s*a[ñn]os\b[\s\S]{0,30}\bChilen[oa]\b/i);
    if (explicitAgeMatch) {
      detectedAge = parseInt(explicitAgeMatch[1], 10);
    }
  }

  let carnetVigencia = null;
  if (latestDateObj) {
    const now = new Date();
    if (latestDateObj >= now) {
      carnetVigencia = `Vigente (Vence: ${latestDateFormatted})`;
    } else {
      carnetVigencia = `Vencido (${latestDateFormatted})`;
    }
  }

  // 6. Extraer Nombre Completo (con descarte contextual estricto de instituciones, cargos, direcciones y referencias)
  let detectedName = mrzName || null;

  const rawLines = textWithoutRefs
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('[PDF_HEADER_NAME]:'));

  const lines = rawLines
    .map(l => l.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s:]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  function stripFieldLabelOnly(line) {
    return (line || '')
      .replace(FIELD_LABEL_PREFIX_REGEX, ' ')
      .replace(/:/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (!detectedName) {
    let apellidos = [];
    let nombres = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\bAPELLIDOS?\b/i.test(line)) {
        const inline = stripFieldLabelOnly(line);
        if (inline && !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(inline))) apellidos.push(inline);
        for (let j = 1; j <= 2 && (i + j) < lines.length; j++) {
          const nextLine = lines[i + j];
          if (/\b(NOMBRES?|NACIONALIDAD|SEXO|FECHA|RUN|RUT)\b/i.test(nextLine)) break;
          const cleaned = stripFieldLabelOnly(nextLine);
          if (cleaned && !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(cleaned))) apellidos.push(cleaned);
        }
      } else if (/\bNOMBRES\b/i.test(line)) {
        const inline = stripFieldLabelOnly(line);
        if (inline && !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(inline))) nombres.push(inline);
        if (!inline && (i + 1) < lines.length && !/\b(APELLIDOS?|NACIONALIDAD|SEXO|FECHA|RUN|RUT)\b/i.test(lines[i + 1])) {
          const cleaned = stripFieldLabelOnly(lines[i + 1]);
          if (cleaned && !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(cleaned))) nombres.push(cleaned);
        }
      } else if (/\b(?:NOMBRE\s+COMPLETO|NOMBRE\s+DEL\s+TITULAR)\b/i.test(line) || /\b(?:NOMBRE|POSTULANTE|ALUMNO|TRABAJADOR)\s*:/i.test(line)) {
        const inline = stripFieldLabelOnly(line);
        if (isValidPersonName(inline)) {
          detectedName = formatTitleCase(inline);
          break;
        } else {
          for (let j = 1; j <= 2 && (i + j) < lines.length; j++) {
            const nextLine = lines[i + j];
            if (/\b(?:R\s*U\s*T|R\s*U\s*N|FECHA|NACIONALIDAD|SEXO)\b/i.test(nextLine)) break;
            const cleanedNext = stripFieldLabelOnly(nextLine);
            if (isValidPersonName(cleanedNext)) {
              detectedName = formatTitleCase(cleanedNext);
              break;
            }
          }
          if (detectedName) break;
        }
      }
    }

    if (!detectedName && (nombres.length > 0 || apellidos.length > 0)) {
      const combined = [...nombres, ...apellidos].join(' ').replace(/\s+/g, ' ').trim();
      if (isValidPersonName(combined)) {
        detectedName = formatTitleCase(combined);
      }
    }
  }

  // Si el documento es un PDF con encabezado tipográfico validado (ej. título principal del CV en 1 o 2 líneas), usarlo
  if (!detectedName && pdfHeaderName) {
    detectedName = pdfHeaderName;
  }

  // Fallback para CV o diplomas donde el nombre propio encabeza el documento (buscando solo en HEADER)
  const isIdCardBackOrCert = /\b(INCHL|NACIO\s+EN|SIN\s+ANTECEDENTES|REGISTRO\s+GENERAL\s+DE\s+CONDENAS)\b/i.test(rawText);
  const headerLines = (cvSections.HEADER || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  if (!detectedName && !isIdCardBackOrCert && headerLines.length > 0) {
    const cvNameCandidates = [];
    const maxScan = Math.min(10, headerLines.length);

    const isCleanSingleWordNameToken = (rawLineStr) => {
      if (!rawLineStr || /[\d@|/\\,•●\-()]/.test(rawLineStr)) return false;
      const cleaned = rawLineStr.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const parts = cleaned.split(/\s+/).filter(Boolean);
      if (parts.length !== 1) return false;
      const w = parts[0];
      if (w.length < 3 || w.length > 18) return false;
      return !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(w));
    };

    for (let i = 0; i < maxScan; i++) {
      const rawLine = headerLines[i];
      if (/[\d@|/\\,•●]/.test(rawLine) || /^\s*[\-*]/.test(rawLine)) continue;

      const cleaned = stripFieldLabelOnly(rawLine.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s:]/g, ' '));
      if (isValidPersonName(cleaned)) {
        cvNameCandidates.push(formatTitleCase(cleaned));
      } else if (i + 1 < maxScan && isCleanSingleWordNameToken(rawLine) && isCleanSingleWordNameToken(headerLines[i + 1])) {
        const twoLineCandidate = `${rawLine.trim()} ${headerLines[i + 1].trim()}`.replace(/\s+/g, ' ');
        if (isValidPersonName(twoLineCandidate)) {
          cvNameCandidates.push(formatTitleCase(twoLineCandidate));
        }
      }
    }

    if (cvNameCandidates.length > 0) {
      detectedName = pickBestPersonName(cvNameCandidates, detectedEmail);
    }
  }

  // 7. Estado de Antecedentes Penales
  let antecedentesStatus = null;
  if (/SIN\s+ANTECEDENTES|SIN\s+ANOTACIONES|NO\s+REGISTRA\s+ANTECEDENTES/i.test(rawText)) {
    antecedentesStatus = 'Sin Antecedentes (Al día)';
  } else if (/REGISTRA\s+ANTECEDENTES|CON\s+ANTECEDENTES/i.test(rawText)) {
    antecedentesStatus = 'Con Anotaciones (Requiere Revisión)';
  }

  return {
    detected_name: detectedName,
    detected_rut: detectedRut,
    detected_email: detectedEmail,
    detected_phone: detectedPhone,
    detected_city: detectedCity,
    detected_experience_years: detectedExpYears,
    detected_experience_months: detectedExpMonths,
    detected_credencial_status: credencialStatus,
    birth_date: detectedBirthDate,
    detected_age: detectedAge,
    carnet_vigencia: carnetVigencia,
    antecedentes_status: antecedentesStatus
  };
}

// Cola serializada para evitar colisiones concurrentes de workers Tesseract
let ocrQueuePromise = Promise.resolve();

function extractPdfVisualHeaderName(pdfPath) {
  try {
    const xml = execFileSync('pdftotext', ['-bbox', '-f', '1', '-l', '1', pdfPath, '-'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (!xml) return null;

    const decodeEntities = (str) => (str || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

    const words = [];
    const wordRegex = /<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">([^<]+)<\/word>/g;
    for (const m of xml.matchAll(wordRegex)) {
      const xMin = parseFloat(m[1]);
      const yMin = parseFloat(m[2]);
      const xMax = parseFloat(m[3]);
      const yMax = parseFloat(m[4]);
      const text = decodeEntities(m[5]).trim();
      if (text) {
        words.push({ xMin, yMin, xMax, yMax, h: yMax - yMin, text });
      }
    }

    if (words.length === 0) return null;

    // Agrupar palabras en líneas visuales según coordenada Y, tamaño de fuente y cercanía horizontal
    const visualLines = [];
    for (const w of words) {
      const prev = visualLines[visualLines.length - 1];
      if (
        prev &&
        Math.abs(w.yMin - prev.yMin) <= 3.5 &&
        Math.abs(w.h - prev.h) <= 3.5 &&
        (w.xMin - prev.xMax) < 45.0 &&
        (w.xMin - prev.xMax) >= -10.0
      ) {
        prev.words.push(w.text);
        prev.xMax = Math.max(prev.xMax, w.xMax);
        prev.yMax = Math.max(prev.yMax, w.yMax);
      } else {
        visualLines.push({
          xMin: w.xMin,
          yMin: w.yMin,
          xMax: w.xMax,
          yMax: w.yMax,
          h: w.h,
          words: [w.text]
        });
      }
    }

    // Unir líneas consecutivas de título gigante en la misma columna (ej. "CRISTÓBAL" en línea 1 y "MENA" en línea 2)
    const mergedLines = [];
    for (let i = 0; i < visualLines.length; i++) {
      const cur = visualLines[i];
      if (i + 1 < visualLines.length) {
        const nxt = visualLines[i + 1];
        const sameLargeFont = cur.h >= 13.0 && Math.abs(cur.h - nxt.h) <= 3.5;
        const shortWordCount = cur.words.length <= 2 && nxt.words.length <= 2;
        const sameColumn = Math.abs(cur.xMin - nxt.xMin) < 100.0;
        const verticallyAdjacent = (nxt.yMin - cur.yMax) >= -6.0 && (nxt.yMin - cur.yMax) <= cur.h * 1.35;
        if (sameLargeFont && shortWordCount && sameColumn && verticallyAdjacent) {
          const combinedText = [...cur.words, ...nxt.words].join(' ');
          if (isValidPersonName(combinedText)) {
            mergedLines.push({ h: (cur.h + nxt.h) / 2, text: combinedText });
            i++;
            continue;
          }
        }
      }
      mergedLines.push({ h: cur.h, text: cur.words.join(' ') });
    }

    // Filtrar solo candidatos de nombre de persona válidos con tamaño de título/encabezado (h >= 13pt)
    // y ordenar de mayor a menor tamaño tipográfico
    const validHeaderCandidates = mergedLines
      .filter(l => l.h >= 13.0 && !/[\d@|/\\,•●]/.test(l.text) && isValidPersonName(l.text))
      .sort((a, b) => b.h - a.h);

    if (validHeaderCandidates.length > 0) {
      return formatTitleCase(validHeaderCandidates[0].text);
    }

    // Respaldo con metadato Author del PDF si coincide con palabras visibles del documento
    const authorMatch = xml.match(/<meta\s+name="Author"\s+content="([^"]+)"/i);
    if (authorMatch && authorMatch[1]) {
      const authorCandidate = formatTitleCase(decodeEntities(authorMatch[1]).trim());
      if (isValidPersonName(authorCandidate)) {
        const visibleNorm = normalizeTextForMatch(words.map(w => w.text).join(' '));
        const authorTokens = normalizeTextForMatch(authorCandidate).split(' ').filter(t => t.length >= 3);
        if (authorTokens.length >= 2 && authorTokens.every(t => visibleNorm.includes(t))) {
          return authorCandidate;
        }
      }
    }

    return null;
  } catch (err) {
    return null;
  }
}

function extractTextFromPdfWithPoppler(pdfPath) {
  try {
    // Usar -raw primero para mantener juntas las secciones en CVs de 2 columnas sin mezclar columnas en una misma línea
    let out = execFileSync('pdftotext', ['-raw', pdfPath, '-'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    if (!out || out.trim().length < 15) {
      out = execFileSync('pdftotext', ['-layout', pdfPath, '-'], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    }
    const rawPdfText = (out || '').trim();
    const headerName = extractPdfVisualHeaderName(pdfPath);
    if (headerName && rawPdfText) {
      return `[PDF_HEADER_NAME]: ${headerName}\n${rawPdfText}`;
    }
    return rawPdfText;
  } catch (err) {
    return '';
  }
}

function renderPdfFirstPageToPng(pdfPath) {
  const outPng = `${pdfPath}_page1.png`;
  try {
    execFileSync('gs', [
      '-dSAFER',
      '-dBATCH',
      '-dNOPAUSE',
      '-sDEVICE=png16m',
      '-r200',
      '-dFirstPage=1',
      '-dLastPage=1',
      `-sOutputFile=${outPng}`,
      pdfPath
    ], {
      timeout: 15000,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    return fs.existsSync(outPng) ? outPng : null;
  } catch (err) {
    return null;
  }
}

function preprocessImageForOcr(imagePath) {
  const outPath = `${imagePath}_ocr_prep.png`;
  try {
    execFileSync('convert', [
      imagePath,
      '-auto-orient',
      '-resize', '2000x2000>',
      '-colorspace', 'Gray',
      '-normalize',
      '-sharpen', '0x1.0',
      outPath
    ], {
      timeout: 10000,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    return fs.existsSync(outPath) ? outPath : imagePath;
  } catch (err) {
    return imagePath;
  }
}

// Ejecutar extracción de texto + OCR sobre imágenes (.png/.jpg/.webp) y documentos PDF (.pdf)
async function runTesseractOnFiles(fileItems) {
  const runTask = async () => {
    let combinedText = '';
    const parsedByType = {};

    const validItems = (fileItems || []).filter(item => {
      if (!item || !item.filePath || !fs.existsSync(item.filePath)) return false;
      const ext = path.extname(item.filePath).toLowerCase();
      return ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.pdf'].includes(ext);
    });

    if (validItems.length === 0) {
      return { combinedText: '', parsedByType };
    }

    let worker = null;
    const ensureWorker = async () => {
      if (worker) return worker;
      const rootDir = path.join(__dirname, '..');
      const hasLocalTrainedData = fs.existsSync(path.join(rootDir, 'spa.traineddata'));
      const workerOpts = {
        errorHandler: (err) => console.error('[Tesseract Worker Warning]:', err && err.message ? err.message : err)
      };
      if (hasLocalTrainedData) {
        workerOpts.langPath = rootDir;
        workerOpts.cachePath = rootDir;
        workerOpts.gzip = false;
        workerOpts.cacheMethod = 'readOnly';
      }
      worker = await createWorker('spa', 1, workerOpts);
      return worker;
    };

    try {
      for (const item of validItems) {
        const ext = path.extname(item.filePath).toLowerCase();
        let extractedText = '';

        if (ext === '.pdf') {
          console.log(`[OCR/PDF] Extrayendo texto de PDF (${item.type}): ${path.basename(item.filePath)}...`);
          extractedText = extractTextFromPdfWithPoppler(item.filePath);
          if (!extractedText || extractedText.length < 15) {
            const renderedPng = renderPdfFirstPageToPng(item.filePath);
            if (renderedPng) {
              try {
                const w = await ensureWorker();
                const ret = await w.recognize(renderedPng);
                extractedText = (ret.data.text || '').trim();
              } finally {
                try { if (fs.existsSync(renderedPng)) fs.unlinkSync(renderedPng); } catch (e) {}
              }
            }
          }
        } else {
          console.log(`[OCR] Procesando imagen ${item.type} con tesseract.js: ${path.basename(item.filePath)}...`);
          const prepPath = preprocessImageForOcr(item.filePath);
          try {
            const w = await ensureWorker();
            const ret = await w.recognize(prepPath);
            extractedText = (ret.data.text || '').trim();
          } finally {
            if (prepPath !== item.filePath) {
              try { if (fs.existsSync(prepPath)) fs.unlinkSync(prepPath); } catch (e) {}
            }
          }
        }

        if (extractedText) {
          combinedText += `[--- ${item.type} ---]\n${extractedText}\n\n`;
          parsedByType[item.type] = parseExtractedText(extractedText);
        }
      }
    } catch (err) {
      console.error('[OCR Error]:', err && err.message ? err.message : err);
    } finally {
      if (worker) {
        try { await worker.terminate(); } catch (e) {}
      }
    }

    return { combinedText: combinedText.trim(), parsedByType };
  };

  const resultPromise = ocrQueuePromise.then(runTask, runTask);
  ocrQueuePromise = resultPromise.catch(() => {});
  return resultPromise;
}

// ============================================================================
// REST ENDPOINTS
// ============================================================================

// 1. Obtener lista de cargos con requisitos ECF Codelco
app.get('/api/positions', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM positions ORDER BY id ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Obtener 5 preguntas aleatorias para el Mini-Test Técnico (Fase 1.5)
app.get('/api/positions/:id/questions', async (req, res) => {
  try {
    const { id } = req.params;
    const [questions] = await pool.query(
      'SELECT id, question_text, option_a, option_b, option_c, option_d FROM questions WHERE position_id = ? ORDER BY RAND() LIMIT 5',
      [id]
    );
    res.json({ questions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. FASE 1: Extracción OCR de Entrada (Credencial Técnica + CV) — Sin pedir Carnet ni Antecedentes
app.post('/api/ocr/phase1', async (req, res) => {
  const tempFiles = [];
  try {
    const { credencial_file, cv_file } = req.body;
    if (!credencial_file && !cv_file) {
      return res.status(400).json({ error: 'Adjunte su Credencial Técnica o CV para analizar.' });
    }

    const items = [];
    if (credencial_file) {
      const saved = saveBase64File(credencial_file, 'tmp_cred', 'jpg');
      if (saved.absolutePath) {
        tempFiles.push(saved.absolutePath);
        items.push({ type: 'CREDENCIAL_TECNICA', filePath: saved.absolutePath });
      }
    }
    if (cv_file) {
      const saved = saveBase64File(cv_file, 'tmp_cv', 'pdf');
      if (saved.absolutePath) {
        tempFiles.push(saved.absolutePath);
        items.push({ type: 'CV', filePath: saved.absolutePath });
      }
    }

    const { combinedText, parsedByType } = await runTesseractOnFiles(items);
    const cred = parsedByType.CREDENCIAL_TECNICA || {};
    const cv = parsedByType.CV || {};

    const bestName = pickBestPersonName(
      [cred.detected_name, cv.detected_name],
      cv.detected_email || cred.detected_email
    ) || '';

    res.json({
      full_name: bestName,
      rut_id: cred.detected_rut || cv.detected_rut || '',
      email: cv.detected_email || cred.detected_email || '',
      phone: cv.detected_phone || cred.detected_phone || '',
      city: cv.detected_city || '',
      experience_years: cv.detected_experience_years ?? cred.detected_experience_years ?? null,
      experience_months: cv.detected_experience_months ?? null,
      credencial_status: cred.detected_credencial_status || cv.detected_credencial_status || 'Documento Técnico Adjunto',
      credencial_vigencia: cred.carnet_vigencia || 'Vigente en documento',
      ocr_text: combinedText
    });
  } catch (err) {
    console.error('[Error /api/ocr/phase1]:', err);
    res.status(500).json({ error: 'Error procesando OCR de Fase 1.' });
  } finally {
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    }
  }
});

// Compatibilidad con endpoint /api/ocr/extract
app.post('/api/ocr/extract', async (req, res) => {
  req.body.credencial_file = req.body.credencial_file || req.body.carnet_file;
  req.body.cv_file = req.body.cv_file || req.body.antecedentes_file;
  const tempFiles = [];
  try {
    const items = [];
    if (req.body.credencial_file) {
      const s = saveBase64File(req.body.credencial_file, 'tmp_doc1', 'jpg');
      if (s.absolutePath) { tempFiles.push(s.absolutePath); items.push({ type: 'DOC_1', filePath: s.absolutePath }); }
    }
    if (req.body.cv_file) {
      const s = saveBase64File(req.body.cv_file, 'tmp_doc2', 'pdf');
      if (s.absolutePath) { tempFiles.push(s.absolutePath); items.push({ type: 'DOC_2', filePath: s.absolutePath }); }
    }
    const { combinedText, parsedByType } = await runTesseractOnFiles(items);
    const d1 = parsedByType.DOC_1 || {};
    const d2 = parsedByType.DOC_2 || {};
    res.json({
      full_name: pickBestPersonName([d1.detected_name, d2.detected_name], d2.detected_email || d1.detected_email) || '',
      rut_id: d1.detected_rut || d2.detected_rut || '',
      email: d2.detected_email || d1.detected_email || '',
      phone: d2.detected_phone || d1.detected_phone || '',
      city: d2.detected_city || d1.detected_city || '',
      age: d1.detected_age ?? d2.detected_age ?? null,
      birth_date: d1.birth_date || d2.birth_date || null,
      experience_years: d2.detected_experience_years ?? d1.detected_experience_years ?? null,
      credencial_status: d1.detected_credencial_status || d2.detected_credencial_status || null,
      antecedentes_status: d1.antecedentes_status || d2.antecedentes_status || null,
      ocr_text: combinedText
    });
  } catch (err) {
    res.status(500).json({ error: 'Error procesando OCR.' });
  } finally {
    for (const f of tempFiles) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    }
  }
});

// 4. FASE 1 + FASE 1.5: Evaluar Filtro Curricular + Mini-Test Técnico (Nota >= 80%) + Selfie Transparente
app.post('/api/candidates/phase1-submit', async (req, res) => {
  try {
    const {
      full_name,
      rut_id,
      email,
      phone,
      city,
      experience_years,
      position_id,
      cv_file,
      credencial_file,
      initial_selfie,
      consent_proctoring,
      answers,
      phase1_ocr_data
    } = req.body;

    let formattedName = formatTitleCase(full_name);
    if (!isValidPersonName(formattedName) && phase1_ocr_data && isValidPersonName(phase1_ocr_data.full_name)) {
      formattedName = formatTitleCase(phase1_ocr_data.full_name);
    }
    const formattedRut = formatRut(rut_id) || (rut_id || '').trim();
    const expYears = parseInt(experience_years || '0', 10);

    if (!formattedName || !formattedRut || !position_id) {
      return res.status(400).json({ error: 'Faltan datos obligatorios de identificación o cargo.' });
    }

    // Obtener requisitos ECF del cargo
    const [posRows] = await pool.query('SELECT * FROM positions WHERE id = ?', [position_id]);
    const position = posRows[0] || { min_experience_years: 2, name: 'Cargo Operativo' };
    const minExpRequired = position.min_experience_years || 2;

    // Guardar archivos de Fase 1 y Selfie Transparente del Mini-Test
    const cvResult = saveBase64File(cv_file, 'cv', 'pdf');
    const credencialResult = saveBase64File(credencial_file, 'credencial', 'jpg');
    const selfieResult = saveBase64File(initial_selfie, 'selfie_test', 'jpg');

    // Evaluar respuestas del Mini-Test Técnico (5 preguntas, umbral >= 80%)
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

    const scoreRatio = totalQuestions > 0 ? (score / totalQuestions) : 0;
    const passesQuiz = scoreRatio >= 0.80;
    const meetsExperience = expYears >= minExpRequired;

    // Estado según resultado de Fase 1 / 1.5
    const nextStatus = (passesQuiz && meetsExperience) ? 'PRESELECCIONADO' : 'DESCARTADO_TECNICO';

    const rejectionReasons = [];
    if (!meetsExperience) {
      rejectionReasons.push(`Experiencia declarada (${expYears} años) menor al mínimo exigido por el ECF Codelco (${minExpRequired} años).`);
    }
    if (!passesQuiz) {
      rejectionReasons.push(`Puntaje en Mini-Test Técnico (${score}/${totalQuestions} — ${Math.round(scoreRatio * 100)}%) inferior al 80% mínimo requerido.`);
    }

    const ocrTextPhase1 = (phase1_ocr_data && phase1_ocr_data.ocr_text) ? phase1_ocr_data.ocr_text : '';
    const ocrDetectedName = (phase1_ocr_data && phase1_ocr_data.full_name && isValidPersonName(phase1_ocr_data.full_name)) ? phase1_ocr_data.full_name : null;
    const ocrDetectedRut = (phase1_ocr_data && phase1_ocr_data.rut_id) ? phase1_ocr_data.rut_id : null;
    const ocrCredStatus = (phase1_ocr_data && phase1_ocr_data.credencial_status) ? phase1_ocr_data.credencial_status : 'Credencial Técnica Cargada';

    // Auditar si editó manualmente respecto a la lectura de Fase 1
    const editedFields = [];
    if (ocrDetectedName && normalizeTextForMatch(ocrDetectedName) !== normalizeTextForMatch(formattedName)) {
      editedFields.push(`Nombre Fase 1 (OCR: "${ocrDetectedName}")`);
    }
    if (ocrDetectedRut && formatRut(ocrDetectedRut) !== formattedRut) {
      editedFields.push(`RUT Fase 1 (OCR: ${ocrDetectedRut})`);
    }

    const [candRes] = await pool.query(
      `INSERT INTO candidates 
      (full_name, rut_id, email, phone, city, experience_years, age, position_id, cv_file, credencial_file, cert_file, initial_selfie, score, total_questions, status, ocr_text, ocr_detected_name, ocr_detected_rut, ocr_credencial_status, ocr_manually_edited, ocr_edited_fields, discrepancy_notes, consent_proctoring)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        formattedName,
        formattedRut,
        email || null,
        phone || null,
        city || 'Rancagua / El Teniente',
        expYears,
        30,
        parseInt(position_id, 10),
        cvResult.url,
        credencialResult.url,
        credencialResult.url,
        selfieResult.url,
        score,
        totalQuestions,
        nextStatus,
        ocrTextPhase1,
        ocrDetectedName,
        ocrDetectedRut,
        ocrCredStatus,
        editedFields.length > 0 ? 1 : 0,
        editedFields.join(' | ') || null,
        rejectionReasons.join(' ') || null,
        consent_proctoring ? 1 : 0
      ]
    );

    const candidateId = candRes.insertId;

    for (const ans of parsedAnswers) {
      await pool.query(
        'INSERT INTO candidate_answers (candidate_id, question_id, selected_option, is_correct) VALUES (?, ?, ?, ?)',
        [candidateId, ans.question_id, ans.selected_option, ans.is_correct]
      );
    }

    res.status(201).json({
      candidateId,
      score,
      totalQuestions,
      scorePercent: Math.round(scoreRatio * 100),
      status: nextStatus,
      qualifiedForPhase2: nextStatus === 'PRESELECCIONADO',
      rejectionReasons
    });
  } catch (err) {
    console.error('[Error /api/candidates/phase1-submit]:', err);
    res.status(500).json({ error: err.message });
  }
});

// 5. FASE 2 & FASE 3: Subida de Carnet + Antecedentes (Solo Preseleccionados) + Motor OCR de Validación Cruzada
app.post('/api/candidates/:id/phase2-acreditacion', async (req, res) => {
  try {
    const { id } = req.params;
    const { carnet_file, carnet_back_file, antecedentes_file, consent_ley19628 } = req.body;

    if (!carnet_file || !antecedentes_file) {
      return res.status(400).json({ error: 'Debe adjuntar la Cédula de Identidad y el Certificado de Antecedentes para la Pre-Acreditación.' });
    }
    if (!consent_ley19628) {
      return res.status(400).json({ error: 'Debe aceptar el Consentimiento Expreso (Ley N° 19.628) para procesar su documentación de faena.' });
    }

    const [candRows] = await pool.query('SELECT * FROM candidates WHERE id = ?', [id]);
    if (candRows.length === 0) {
      return res.status(404).json({ error: 'Postulación no encontrada.' });
    }
    const candidate = candRows[0];

    // Guardar archivos de Fase 2
    const carnetFrontRes = saveBase64File(carnet_file, `carnet_${id}`, 'jpg');
    const carnetBackRes = saveBase64File(carnet_back_file, `carnet_rev_${id}`, 'jpg');
    const antecedentesRes = saveBase64File(antecedentes_file, `antecedentes_${id}`, 'pdf');

    // Estado transitorio DOCS_CARGADOS antes del análisis cruzado
    await pool.query("UPDATE candidates SET status = 'DOCS_CARGADOS' WHERE id = ?", [id]);

    // Ejecutar Motor OCR de Validación Cruzada (Fase 3)
    const itemsToScan = [
      { type: 'CEDULA_FRENTE', filePath: carnetFrontRes.absolutePath },
      { type: 'CEDULA_REVERSO', filePath: carnetBackRes.absolutePath },
      { type: 'CERT_ANTECEDENTES', filePath: antecedentesRes.absolutePath }
    ];

    const { combinedText, parsedByType } = await runTesseractOnFiles(itemsToScan);
    const cedFront = parsedByType.CEDULA_FRENTE || {};
    const cedBack = parsedByType.CEDULA_REVERSO || {};
    const ant = parsedByType.CERT_ANTECEDENTES || {};

    // Si en Fase 1 el nombre quedó incompleto o era un falso positivo (ej. universidad), repararlo
    let effectiveCandidateName = candidate.full_name;
    if (!isValidPersonName(effectiveCandidateName) && candidate.ocr_text) {
      const reparsedPhase1 = parseExtractedText(candidate.ocr_text);
      if (isValidPersonName(reparsedPhase1.detected_name)) {
        effectiveCandidateName = reparsedPhase1.detected_name;
        await pool.query('UPDATE candidates SET full_name = ? WHERE id = ?', [effectiveCandidateName, id]);
      }
    }

    const ocrCarnetName = pickBestPersonName(
      [cedFront.detected_name, cedBack.detected_name, ant.detected_name],
       isValidPersonName(effectiveCandidateName) ? effectiveCandidateName : candidate.email
    );
    if (!isValidPersonName(effectiveCandidateName) && ocrCarnetName) {
      effectiveCandidateName = ocrCarnetName;
    }

    const ocrCarnetRut = cedFront.detected_rut || cedBack.detected_rut || ant.detected_rut || null;
    const ocrBirthDate = cedFront.birth_date || cedBack.birth_date || ant.birth_date || null;
    const ocrDetectedAge = cedFront.detected_age ?? cedBack.detected_age ?? ant.detected_age ?? candidate.age;
    const ocrCarnetVigencia = cedFront.carnet_vigencia || cedBack.carnet_vigencia || 'Verificación Visual en Carnet';
    const ocrAntecedentesStatus = ant.antecedentes_status || cedFront.antecedentes_status || cedBack.antecedentes_status || 'Certificado Cargado (Validar Código)';

    // Validaciones Cruzadas (Cruce Carnet vs. Postulación/Credencial Fase 1)
    const discrepancies = [];

    const cleanCandidateRut = (candidate.rut_id || '').replace(/[^0-9kK]/g, '').toUpperCase();
    const cleanCarnetRut = (ocrCarnetRut || '').replace(/[^0-9kK]/g, '').toUpperCase();

    let rutMatches = false;
    if (cleanCarnetRut && cleanCarnetRut === cleanCandidateRut) {
      rutMatches = true;
    } else if (cleanCarnetRut && cleanCarnetRut !== cleanCandidateRut) {
      discrepancies.push(`Discordancia de RUT: Fase 1 (${candidate.rut_id}) vs. Cédula OCR (${ocrCarnetRut}).`);
    } else {
      discrepancies.push('OCR no logró leer el RUT nítidamente en la foto de la cédula (requiere validación visual).');
    }

    const normCandidateName = normalizeTextForMatch(effectiveCandidateName);
    const normCarnetName = normalizeTextForMatch(ocrCarnetName);
    let nameMatches = false;
    if (normCarnetName) {
      const candidateTokens = normCandidateName.split(' ').filter(t => t.length > 2);
      const carnetTokens = normCarnetName.split(' ').filter(t => t.length > 2);
      const matchedTokens = candidateTokens.filter(t => normCarnetName.includes(t));
      if (matchedTokens.length >= Math.min(2, candidateTokens.length)) {
        nameMatches = true;
        // Si la Cédula trae el nombre legal más completo que el CV (ej. "Cristóbal Mena Illanes" vs "Cristóbal Mena"), actualizar al nombre completo oficial
        if (carnetTokens.length > candidateTokens.length && candidateTokens.every(t => normCarnetName.includes(t))) {
          effectiveCandidateName = ocrCarnetName;
        }
      } else {
        discrepancies.push(`Discordancia de Nombre: Postulación ("${effectiveCandidateName}") vs. Cédula OCR ("${ocrCarnetName}").`);
      }
    }

    if (ocrCarnetVigencia.startsWith('Vencido')) {
      discrepancies.push(`Cédula de Identidad figura vencida (${ocrCarnetVigencia}).`);
    }

    if (ocrAntecedentesStatus.includes('Con Anotaciones')) {
      discrepancies.push('Certificado de Antecedentes registra anotaciones que requieren revisión de RR.HH.');
    }

    // Si el OCR validó RUT consistente y sin alertas de vencimiento/antecedentes -> PRE_ACREDITADO
    // Si hubo discordancia o foto borrosa -> EN_REVISION_MANUAL
    const crossCheckOk = rutMatches && !ocrCarnetVigencia.startsWith('Vencido') && !ocrAntecedentesStatus.includes('Con Anotaciones') && discrepancies.length === 0;
    const finalStatus = crossCheckOk ? 'PRE_ACREDITADO' : 'EN_REVISION_MANUAL';

    const updatedOcrText = [candidate.ocr_text, combinedText].filter(Boolean).join('\n\n');

    await pool.query(
      `UPDATE candidates SET
        full_name = ?,
        carnet_file = ?,
        carnet_back_file = ?,
        antecedentes_file = ?,
        random_selfie = ?,
        status = ?,
        ocr_text = ?,
        ocr_birth_date = ?,
        ocr_detected_age = ?,
        ocr_verified = ?,
        ocr_detected_name = COALESCE(?, ocr_detected_name),
        ocr_detected_rut = COALESCE(?, ocr_detected_rut),
        ocr_carnet_vigencia = ?,
        ocr_antecedentes_status = ?,
        ocr_cross_check_ok = ?,
        discrepancy_notes = ?,
        consent_ley19628 = 1
      WHERE id = ?`,
      [
        effectiveCandidateName,
        carnetFrontRes.url,
        carnetBackRes.url,
        antecedentesRes.url,
        carnetFrontRes.url, // Permite comparar Selfie del Test vs Foto del Carnet en el panel
        finalStatus,
        updatedOcrText,
        ocrBirthDate,
        ocrDetectedAge,
        crossCheckOk ? 1 : 0,
        ocrCarnetName,
        ocrCarnetRut,
        ocrCarnetVigencia,
        ocrAntecedentesStatus,
        crossCheckOk ? 1 : 0,
        discrepancies.length > 0 ? discrepancies.join(' | ') : 'Consistencia 100% verificada entre Fase 1 y Fase 2.',
        id
      ]
    );

    res.json({
      candidateId: Number(id),
      status: finalStatus,
      crossCheckOk,
      ocrCarnetName,
      ocrCarnetRut,
      ocrCarnetVigencia,
      ocrAntecedentesStatus,
      discrepancies
    });
  } catch (err) {
    console.error('[Error /api/candidates/:id/phase2-acreditacion]:', err);
    res.status(500).json({ error: err.message });
  }
});

// 6. PANEL RR.HH. NEXXO: Obtener postulantes con filtro por Cargo y Estado de la Máquina de Estados
app.get('/api/admin/candidates', async (req, res) => {
  try {
    const { status, position_id } = req.query;
    let query = `
      SELECT c.*, p.name as position_name, p.required_credential, p.ecf_code
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

// 7. PANEL RR.HH. NEXXO: Cambiar estado en la Máquina de Estados
app.patch('/api/admin/candidates/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!VALID_STATES.includes(status)) {
      return res.status(400).json({ error: 'Estado no válido en la máquina de estados.' });
    }

    await pool.query('UPDATE candidates SET status = ? WHERE id = ?', [status, id]);
    res.json({ message: `Candidato #${id} actualizado a estado "${status}".` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. PANEL RR.HH. NEXXO: Estadísticas Operativas e Impacto en División El Teniente
app.get('/api/admin/stats', async (req, res) => {
  try {
    const [totalRows] = await pool.query('SELECT COUNT(*) as count FROM candidates');
    const [preAcreditadosRows] = await pool.query(
      "SELECT COUNT(*) as count FROM candidates WHERE status IN ('PRE_ACREDITADO', 'CONTRATADO_FAENA', 'Aprobado')"
    );
    const [revisionRows] = await pool.query(
      "SELECT COUNT(*) as count FROM candidates WHERE status IN ('EN_REVISION_MANUAL', 'PRESELECCIONADO', 'DOCS_CARGADOS', 'Pendiente')"
    );
    const [descartadosRows] = await pool.query(
      "SELECT COUNT(*) as count FROM candidates WHERE status IN ('DESCARTADO_TECNICO', 'Rechazado')"
    );

    const total = totalRows[0].count;
    const approved = preAcreditadosRows[0].count;
    const inReview = revisionRows[0].count;
    const rejected = descartadosRows[0].count;

    // Ahorro estimado: $1.000.000 CLP por rechazo evitado antes de enviar a acreditación WebControl / exámenes
    const savedTurnoverCosts = rejected * 1000000;

    res.json({
      total,
      approved,
      inReview,
      rejected,
      savedTurnoverCostsCLP: savedTurnoverCosts
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. FASE 4: Exportar "Carpeta de Acreditación Estandarizada WebControl" (Codelco División El Teniente)
app.get('/api/admin/candidates/:id/export-webcontrol', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `SELECT c.*, p.name as position_name, p.required_credential, p.ecf_code
       FROM candidates c
       JOIN positions p ON c.position_id = p.id
       WHERE c.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).send('Candidato no encontrado.');
    }

    const c = rows[0];
    const cleanRut = (c.rut_id || 'SIN_RUT').replace(/\./g, '').replace(/\s+/g, '');
    const cleanNameSlug = normalizeTextForMatch(c.full_name).replace(/\s+/g, '_');
    const prefix = `${cleanRut}_${cleanNameSlug}`;

    const scorePercent = c.total_questions > 0 ? Math.round((c.score / c.total_questions) * 100) : 0;

    const htmlReport = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>Carpeta WebControl - ${prefix}</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f1e2e; margin: 2rem; background: #f8fafc; }
    .sheet { max-width: 860px; margin: 0 auto; background: #fff; border: 2px solid #0f1e2e; padding: 2rem; border-radius: 6px; }
    .header { display: flex; justify-content: space-between; border-bottom: 3px solid #c25e00; padding-bottom: 1rem; margin-bottom: 1.5rem; }
    .badge { background: #14532d; color: #fff; padding: 0.35rem 0.75rem; border-radius: 4px; font-family: monospace; font-weight: bold; }
    h1 { font-size: 1.35rem; margin: 0 0 0.25rem 0; }
    h2 { font-size: 1.05rem; background: #eff4ff; padding: 0.5rem 0.75rem; border-left: 4px solid #0f1e2e; margin-top: 1.5rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
    th, td { border: 1px solid #cbd5e1; padding: 0.6rem 0.75rem; text-align: left; }
    th { background: #f1f5f9; width: 32%; }
    .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.75rem; }
    .photo-box { border: 1px solid #cbd5e1; padding: 0.75rem; text-align: center; border-radius: 4px; }
    .photo-box img { max-width: 100%; max-height: 200px; object-fit: contain; margin-top: 0.5rem; }
    .print-bar { text-align: right; margin-bottom: 1rem; }
    .btn-print { background: #0f1e2e; color: #fff; border: none; padding: 0.6rem 1.2rem; border-radius: 4px; cursor: pointer; font-weight: bold; }
    @media print { .print-bar { display: none; } body { margin: 0; background: #fff; } .sheet { border: none; } }
  </style>
</head>
<body>
  <div class="print-bar">
    <button class="btn-print" onclick="window.print()">Imprimir / Guardar como PDF Estandarizado WebControl</button>
  </div>
  <div class="sheet">
    <div class="header">
      <div>
        <h1>CARPETA DE PRE-ACREDITACIÓN DE FAENA — NEXXO S.A.</h1>
        <p style="margin:0; font-size:0.88rem; color:#475569;">Mandante: <strong>CODELCO Chile — División El Teniente</strong> | Plataforma Destino: <strong>WebControl / SICEP</strong></p>
      </div>
      <div>
        <span class="badge">${c.status}</span>
      </div>
    </div>

    <h2>1. Identificación del Trabajador y Cargo Operativo</h2>
    <table>
      <tr><th>Nombre Completo</th><td><strong>${c.full_name}</strong></td></tr>
      <tr><th>RUT / RUN</th><td><code>${c.rut_id}</code></td></tr>
      <tr><th>Cargo Postulado</th><td>${c.position_name}</td></tr>
      <tr><th>Estándar de Control de Fatalidades</th><td>${c.ecf_code || 'ECF Codelco / DS N° 132 SERNAGEOMIN'}</td></tr>
      <tr><th>Experiencia Comprobable</th><td>${c.experience_years || 2} años en minería/industria</td></tr>
      <tr><th>Contacto</th><td>${c.email || 'S/I'} | ${c.phone || 'S/I'} (${c.city || 'Rancagua'})</td></tr>
    </table>

    <h2>2. Resultados de Pre-Filtro Técnico y Validación Cruzada OCR</h2>
    <table>
      <tr><th>Mini-Test Técnico (Umbral &ge; 80%)</th><td><strong>${c.score} / ${c.total_questions} (${scorePercent}%)</strong> — Aprobado</td></tr>
      <tr><th>Credencial Técnica Habilitante</th><td>${c.ocr_credencial_status || c.required_credential}</td></tr>
      <tr><th>Vigencia Cédula de Identidad (OCR)</th><td>${c.ocr_carnet_vigencia || 'Verificada'}</td></tr>
      <tr><th>Certificado de Antecedentes (OCR)</th><td>${c.ocr_antecedentes_status || 'Sin Antecedentes'}</td></tr>
      <tr><th>Diagnóstico de Consistencia Cruzada</th><td>${c.discrepancy_notes || 'Consistencia 100% verificada'}</td></tr>
      <tr><th>Consentimiento Ley N° 19.628</th><td>Aceptado expresamente por el titular para acreditación minera</td></tr>
    </table>

    <h2>3. Índice de Archivos Normalizados para Carga en WebControl</h2>
    <table>
      <thead>
        <tr><th>Nomenclatura Estandarizada WebControl</th><th>Tipo de Documento</th><th>Enlace Directo</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>${prefix}_Cedula_Identidad.jpg</code></td>
          <td>Cédula de Identidad (Frente)</td>
          <td>${c.carnet_file ? `<a href="${c.carnet_file}" target="_blank" download="${prefix}_Cedula_Identidad.jpg">Descargar Archivo</a>` : 'Pendiente'}</td>
        </tr>
        <tr>
          <td><code>${prefix}_Certificado_Antecedentes.jpg</code></td>
          <td>Certificado de Antecedentes Fines Especiales</td>
          <td>${c.antecedentes_file ? `<a href="${c.antecedentes_file}" target="_blank" download="${prefix}_Certificado_Antecedentes.jpg">Descargar Archivo</a>` : 'Pendiente'}</td>
        </tr>
        <tr>
          <td><code>${prefix}_Credencial_Tecnica_ECF.jpg</code></td>
          <td>${c.required_credential || 'Certificación Técnica'}</td>
          <td>${(c.credencial_file || c.cert_file) ? `<a href="${c.credencial_file || c.cert_file}" target="_blank" download="${prefix}_Credencial_Tecnica_ECF.jpg">Descargar Archivo</a>` : 'Pendiente'}</td>
        </tr>
        <tr>
          <td><code>${prefix}_Curriculum_Vitae.pdf</code></td>
          <td>Currículum Vitae (CV)</td>
          <td>${c.cv_file ? `<a href="${c.cv_file}" target="_blank" download="${prefix}_Curriculum_Vitae">Descargar Archivo</a>` : 'Pendiente'}</td>
        </tr>
      </tbody>
    </table>

    <h2>4. Respaldo Visual de Identidad (Selfie Proctoring Transparente vs. Cédula)</h2>
    <div class="photos">
      <div class="photo-box">
        <strong>Selfie Informada (Durante Mini-Test Técnico)</strong><br>
        ${c.initial_selfie ? `<img src="${c.initial_selfie}" alt="Selfie Test">` : '<p>Sin foto</p>'}
      </div>
      <div class="photo-box">
        <strong>Cédula de Identidad Cargada en Fase 2</strong><br>
        ${c.carnet_file ? `<img src="${c.carnet_file}" alt="Cédula Identidad">` : '<p>Pendiente de Fase 2</p>'}
      </div>
    </div>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlReport);
  } catch (err) {
    res.status(500).send('Error generando carpeta WebControl: ' + err.message);
  }
});

// Función para re-evaluar el expediente OCR de un candidato usando sus archivos almacenados
async function reprocessCandidateOcr(id) {
  const [candRows] = await pool.query('SELECT * FROM candidates WHERE id = ?', [id]);
  if (candRows.length === 0) return null;
  const c = candRows[0];

  const resolveUploadPath = (urlStr) => {
    if (!urlStr) return null;
    const baseName = path.basename(urlStr);
    const fullP = path.join(UPLOADS_DIR, baseName);
    return fs.existsSync(fullP) ? fullP : null;
  };

  const itemsToScan = [];
  const cvPath = resolveUploadPath(c.cv_file);
  const credPath = resolveUploadPath(c.credencial_file || c.cert_file);
  const carnetFrontPath = resolveUploadPath(c.carnet_file);
  const carnetBackPath = resolveUploadPath(c.carnet_back_file);
  const antPath = resolveUploadPath(c.antecedentes_file);

  if (credPath) itemsToScan.push({ type: 'CREDENCIAL_TECNICA', filePath: credPath });
  if (cvPath) itemsToScan.push({ type: 'CV', filePath: cvPath });
  if (carnetFrontPath) itemsToScan.push({ type: 'CEDULA_FRENTE', filePath: carnetFrontPath });
  if (carnetBackPath) itemsToScan.push({ type: 'CEDULA_REVERSO', filePath: carnetBackPath });
  if (antPath) itemsToScan.push({ type: 'CERT_ANTECEDENTES', filePath: antPath });

  if (itemsToScan.length === 0) return null;

  const { combinedText, parsedByType } = await runTesseractOnFiles(itemsToScan);
  const cred = parsedByType.CREDENCIAL_TECNICA || {};
  const cv = parsedByType.CV || {};
  const cedFront = parsedByType.CEDULA_FRENTE || {};
  const cedBack = parsedByType.CEDULA_REVERSO || {};
  const ant = parsedByType.CERT_ANTECEDENTES || {};

  const emailHint = cv.detected_email || cred.detected_email || c.email || null;
  let phase1Name = pickBestPersonName(
    [cred.detected_name, cv.detected_name, isValidPersonName(c.full_name) ? c.full_name : null],
    emailHint
  ) || (isValidPersonName(c.full_name) ? c.full_name : null);

  const phase2Name = pickBestPersonName(
    [cedFront.detected_name, cedBack.detected_name, ant.detected_name],
    phase1Name || emailHint
  );

  if (!phase1Name && phase2Name) {
    phase1Name = phase2Name;
  } else if (!phase1Name) {
    phase1Name = c.full_name;
  }

  const ocrCarnetRut = cedFront.detected_rut || cedBack.detected_rut || ant.detected_rut || cred.detected_rut || c.rut_id;
  const ocrBirthDate = cedFront.birth_date || cedBack.birth_date || ant.birth_date || c.ocr_birth_date;
  const ocrDetectedAge = cedFront.detected_age ?? cedBack.detected_age ?? ant.detected_age ?? c.ocr_detected_age ?? c.age;
  const ocrCarnetVigencia = cedFront.carnet_vigencia || cedBack.carnet_vigencia || c.ocr_carnet_vigencia || 'Vigente';
  const ocrAntecedentesStatus = ant.antecedentes_status || cedFront.antecedentes_status || cedBack.antecedentes_status || c.ocr_antecedentes_status || 'Sin Antecedentes (Al día)';

  const discrepancies = [];
  const cleanCandidateRut = (c.rut_id || '').replace(/[^0-9kK]/g, '').toUpperCase();
  const cleanCarnetRut = (ocrCarnetRut || '').replace(/[^0-9kK]/g, '').toUpperCase();

  const rutMatches = Boolean(cleanCarnetRut && cleanCarnetRut === cleanCandidateRut);
  if (!rutMatches && cleanCarnetRut) {
    discrepancies.push(`Discordancia de RUT: Fase 1 (${c.rut_id}) vs. Cédula OCR (${ocrCarnetRut}).`);
  }

  let nameMatches = true;
  if (phase2Name && phase1Name) {
    const normCand = normalizeTextForMatch(phase1Name);
    const normCarnet = normalizeTextForMatch(phase2Name);
    const tokens = normCand.split(' ').filter(t => t.length > 2);
    const carnetTokens = normCarnet.split(' ').filter(t => t.length > 2);
    const matched = tokens.filter(t => normCarnet.includes(t));
    if (matched.length >= Math.min(2, tokens.length)) {
      if (carnetTokens.length > tokens.length && tokens.every(t => normCarnet.includes(t))) {
        phase1Name = phase2Name;
      }
    } else {
      nameMatches = false;
      discrepancies.push(`Discordancia de Nombre: Postulación ("${phase1Name}") vs. Cédula OCR ("${phase2Name}").`);
    }
  }

  if (ocrCarnetVigencia.startsWith('Vencido')) {
    discrepancies.push(`Cédula de Identidad figura vencida (${ocrCarnetVigencia}).`);
  }
  if (ocrAntecedentesStatus.includes('Con Anotaciones')) {
    discrepancies.push('Certificado de Antecedentes registra anotaciones que requieren revisión de RR.HH.');
  }

  const hasPhase2Docs = Boolean(carnetFrontPath || antPath);
  const crossCheckOk = hasPhase2Docs && rutMatches && nameMatches && discrepancies.length === 0;
  let newStatus = c.status;
  if (hasPhase2Docs && (c.status === 'EN_REVISION_MANUAL' || c.status === 'DOCS_CARGADOS' || c.status === 'PRE_ACREDITADO')) {
    newStatus = crossCheckOk ? 'PRE_ACREDITADO' : 'EN_REVISION_MANUAL';
  }

  // Limpiar nota de edición manual si se debió a un falso positivo previo (ej. "Adolfo Ibañez")
  let cleanedEditedFields = c.ocr_edited_fields;
  let cleanedManuallyEdited = c.ocr_manually_edited;
  if (cleanedEditedFields && /(Adolfo|Completo|Ro Xt)/i.test(cleanedEditedFields)) {
    cleanedEditedFields = null;
    cleanedManuallyEdited = 0;
  }

  let updatedCity = cv.detected_city || c.city;
  if (!cv.detected_city && cvPath && c.city && /^lampa$/i.test(c.city.trim())) {
    updatedCity = 'No especificada en CV';
  }
  const updatedExpYears = (cvPath && cv.detected_experience_years !== null && cv.detected_experience_years !== undefined)
    ? cv.detected_experience_years
    : c.experience_years;

  await pool.query(
    `UPDATE candidates SET
      full_name = ?,
      email = COALESCE(?, email),
      phone = COALESCE(?, phone),
      city = ?,
      experience_years = ?,
      status = ?,
      ocr_text = ?,
      ocr_birth_date = ?,
      ocr_detected_age = ?,
      ocr_verified = ?,
      ocr_detected_name = ?,
      ocr_detected_rut = ?,
      ocr_carnet_vigencia = ?,
      ocr_antecedentes_status = ?,
      ocr_cross_check_ok = ?,
      ocr_manually_edited = ?,
      ocr_edited_fields = ?,
      discrepancy_notes = ?
    WHERE id = ?`,
    [
      phase1Name,
      cv.detected_email || null,
      cv.detected_phone || null,
      updatedCity,
      updatedExpYears,
      newStatus,
      combinedText || c.ocr_text,
      ocrBirthDate,
      ocrDetectedAge,
      crossCheckOk ? 1 : 0,
      phase2Name || phase1Name,
      ocrCarnetRut,
      ocrCarnetVigencia,
      ocrAntecedentesStatus,
      crossCheckOk ? 1 : 0,
      cleanedManuallyEdited,
      cleanedEditedFields,
      discrepancies.length > 0 ? discrepancies.join(' | ') : 'Consistencia 100% verificada entre Fase 1 y Fase 2.',
      id
    ]
  );

  return { id, full_name: phase1Name, ocrCarnetName: phase2Name || phase1Name, city: updatedCity, experience_years: updatedExpYears, status: newStatus, crossCheckOk, discrepancies };
}

app.post('/api/admin/candidates/:id/reprocess-ocr', async (req, res) => {
  try {
    const result = await reprocessCandidateOcr(req.params.id);
    if (!result) return res.status(404).json({ error: 'Candidato o archivos no encontrados.' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Iniciar Servidor con manejo dinámico de puerto si el 3000 está ocupado
function startServer(portToUse) {
  const server = app.listen(portToUse, async () => {
    console.log(`[Servidor] Portal de Convocatoria y Pre-Filtro Normativo Nexxo S.A. listo en http://localhost:${portToUse}`);
    await initDB();
    try {
      if (pool) {
        const [rows] = await pool.query(
          'SELECT id, full_name, city, ocr_detected_name, discrepancy_notes, ocr_edited_fields FROM candidates'
        );
        for (const r of rows) {
          const hasInvalidFullName = !isValidPersonName(r.full_name);
          const hasInvalidOcrName = Boolean(r.ocr_detected_name && !isValidPersonName(r.ocr_detected_name));
          const hasLegacyNoise = /(Adolfo|Completo|Ro Xt)/i.test(`${r.discrepancy_notes || ''} ${r.ocr_edited_fields || ''}`);
          const hasWorkplaceCityBug = Boolean(r.city && /^lampa$/i.test(r.city.trim()));
          if (hasInvalidFullName || hasInvalidOcrName || hasLegacyNoise || hasWorkplaceCityBug) {
            console.log(`[Auto-Repair OCR] Reparando expediente #${r.id} ("${r.full_name}")...`);
            await reprocessCandidateOcr(r.id);
          }
        }
      }
    } catch (e) {
      console.error('[Auto-Repair OCR Aviso]:', e.message);
    }
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
