/**
 * Datos semilla: cargos y banco de preguntas (TECNICA / SJT).
 * Se ejecuta en cada arranque, después de las migraciones; es idempotente y no modifica el esquema.
 * Código movido sin cambios desde src/server.js.
 */

async function ensureSeedData(conn) {
  const [posRows] = await conn.query("SELECT COUNT(*) as count FROM positions");
  if (posRows[0].count === 0) {
    console.log(
      "[DB Seed] Poblando cargos y banco de preguntas ECF Codelco El Teniente...",
    );

    // 1. Rigger
    const [res1] = await conn.query(
      "INSERT INTO positions (name, description, required_credential, min_experience_years, ecf_code) VALUES (?, ?, ?, ?, ?)",
      [
        "Rigger (Maniobrista de Izaje)",
        "Especialista en maniobras de izaje, cálculo de cargas y señales de seguridad para grúas en paradas de planta (División El Teniente).",
        "Credencial Rigger Acreditada (ASME / ChileValora / OTEC)",
        2,
        "ECF N° 7 Codelco — Cargas Suspendidas e Izaje",
      ],
    );
    await insertQuestionsForPosition(conn, res1.insertId, "rigger");

    // 2. Soldador
    const [res2] = await conn.query(
      "INSERT INTO positions (name, description, required_credential, min_experience_years, ecf_code) VALUES (?, ?, ?, ?, ?)",
      [
        "Soldador de Mantención Minera (WPQ)",
        "Soldador calificado para reparación de estructuras pesadas, chutes, baldes y tuberías en planta concentradora.",
        "Calificación de Soldador Vigente (WPQ / 3G, 4G o 6G - AWS)",
        2,
        "ECF N° 6 Codelco — Incendio & Trabajo en Caliente",
      ],
    );
    await insertQuestionsForPosition(conn, res2.insertId, "soldador");

    // 3. Operador
    const [res3] = await conn.query(
      "INSERT INTO positions (name, description, required_credential, min_experience_years, ecf_code) VALUES (?, ?, ?, ?, ?)",
      [
        "Operador de Maquinaria Pesada",
        "Operador de cargador frontal, excavadora y equipos de apoyo en faenas de montaje y mantenimiento minero.",
        "Licencia Municipal Clase D / A4 Vigente + Hoja de Vida del Conductor",
        3,
        "ECF N° 3 Codelco — Maquinaria Industrial Pesada",
      ],
    );
    await insertQuestionsForPosition(conn, res3.insertId, "operador");

    console.log("[DB Seed] Banco de preguntas ECF poblado con éxito.");
  } else {
    // Asegurar metadata ECF y preguntas técnicas específicas para cada cargo
    const [positions] = await conn.query(
      "SELECT * FROM positions ORDER BY id ASC",
    );
    for (const p of positions) {
      if (!p.required_credential) {
        if (/rigger/i.test(p.name)) {
          await conn.query(
            "UPDATE positions SET required_credential = ?, min_experience_years = 2, ecf_code = ? WHERE id = ?",
            [
              "Credencial Rigger Acreditada (ASME / ChileValora / OTEC)",
              "ECF N° 7 Codelco — Cargas Suspendidas e Izaje",
              p.id,
            ],
          );
        } else if (/soldador/i.test(p.name)) {
          await conn.query(
            "UPDATE positions SET required_credential = ?, min_experience_years = 2, ecf_code = ? WHERE id = ?",
            [
              "Calificación de Soldador Vigente (WPQ / 3G, 4G o 6G - AWS)",
              "ECF N° 6 Codelco — Incendio & Trabajo en Caliente",
              p.id,
            ],
          );
        } else {
          await conn.query(
            "UPDATE positions SET required_credential = ?, min_experience_years = 3, ecf_code = ? WHERE id = ?",
            [
              "Licencia Municipal Clase D / A4 Vigente + Hoja de Vida del Conductor",
              "ECF N° 3 Codelco — Maquinaria Industrial Pesada",
              p.id,
            ],
          );
        }
      }

      const type = /rigger/i.test(p.name)
        ? "rigger"
        : /soldador/i.test(p.name)
          ? "soldador"
          : "operador";
      await insertQuestionsForPosition(conn, p.id, type);
    }
  }

  // 2. Asegurar banco transversal de Juicio Situacional (SJT ECF / Paso Cero)
  const [sjtRows] = await conn.query(
    "SELECT COUNT(*) as c FROM questions WHERE category = 'SJT'",
  );
  if (sjtRows[0].c < 2) {
    await conn.query(
      `INSERT INTO questions (position_id, question_text, option_a, option_b, option_c, option_d, correct_option, category) VALUES
      (NULL, 'El supervisor le pide ejecutar un izaje saltándose el check-list del ART porque el camión pluma debe abandonar la faena en 10 minutos. ¿Qué acción corresponde aplicar?', 'Ejecutar la maniobra rápido para no frenar la parada.', 'Aplicar el \\'Paso Cero\\' / Derecho a Decir NO, negándose a operar sin el ART completo y firmado', 'Pedir autorización verbal al operador de la grúa.', 'Llenar el documento después de terminar el izaje.', 'B', 'SJT'),
      (NULL, 'Durante la maniobra, detecta que una de las patas estabilizadoras de la grúa cedió levemente en terreno blando no señalizado. ¿Cuál es la conducta inmediata?', 'Compensar con contrapesos y seguir.', 'Detener la maniobra al instante, asegurar la carga y dar aviso de la condición de falla', 'Apurar la descarga antes de que ceda más.', 'Ignorar si el inclinómetro de la cabina sigue en rango amarillo.', 'B', 'SJT')`,
    );
    console.log(
      "[DB Seed] Banco transversal de Juicio Situacional (SJT ECF) poblado.",
    );
  }
}

async function insertQuestionsForPosition(conn, posId, type) {
  const [existing] = await conn.query(
    "SELECT id FROM questions WHERE position_id = ? ORDER BY id ASC",
    [posId],
  );

  let qList = [];
  if (type === "rigger") {
    qList = [
      {
        text: "¿Cuál es el ángulo mínimo recomendado entre las eslingas y la horizontal en una maniobra de izaje estándar?",
        a: "30°",
        b: "45°",
        c: "60°",
        d: "15°",
        correct: "C",
      },
      {
        text: "Al inspeccionar una eslinga sintética antes del izaje, ¿qué defecto obliga a descartarla de inmediato según norma ASME B30.9?",
        a: "Pérdida de etiqueta de capacidad o corte visible",
        b: "Suciedad superficial",
        c: "Decoloración por luz solar",
        d: "Costura doble en el ojo",
        correct: "A",
      },
      {
        text: "¿Qué elemento es mandatorio para guiar una carga suspendida cerca de estructuras en parada de planta?",
        a: "Guantes de cuero",
        b: "Vientos (cuerdas guía) de longitud adecuada",
        c: "Señalero sin radio",
        d: "Apoyo manual directo",
        correct: "B",
      },
    ];
  } else if (type === "soldador") {
    qList = [
      {
        text: "En soldadura MIG/MAG (GMAW) para reparación estructural pesada, ¿cuál es la función principal del gas de protección (mezcla Ar/CO2)?",
        a: "Enfriar rápidamente el metal base",
        b: "Proteger el baño de fusión contra la contaminación atmosférica (oxígeno/nitrógeno)",
        c: "Incrementar la tensión del arco eléctrico",
        d: "Desprender la escoria gruesa del cordón",
        correct: "B",
      },
      {
        text: 'En calificación de soldadores bajo código AWS D1.1 / ASME IX, ¿qué posición de soldadura representa la sigla "4G" en plancha?',
        a: "Posición plana",
        b: "Posición horizontal",
        c: "Posición sobrecabeza (techo)",
        d: "Posición vertical ascendente",
        correct: "C",
      },
      {
        text: "¿Cuál es el propósito técnico de realizar precalentamiento controlado en aceros de alta resistencia o alto carbono antes de soldar?",
        a: "Ahorrar consumo de electrodos",
        b: "Disminuir la velocidad de enfriamiento para evitar fisuración inducida por hidrógeno en la ZAC",
        c: "Eliminar la necesidad de limpieza mecánica",
        d: "Aumentar la deformación térmica de la pieza",
        correct: "B",
      },
    ];
  } else {
    qList = [
      {
        text: "Durante la inspección pre-operacional (vuelta del perro 360°), si detecta una fuga activa en una manguera hidráulica de dirección o frenos, ¿cuál es el protocolo obligatorio?",
        a: "Rellenar aceite hidráulico y operar hasta el cambio de turno",
        b: "No operar el equipo, aplicar bloqueo/etiquetado de falla y reportar a supervisión/mantención",
        c: "Colocar un paño absorbente amarrado y continuar",
        d: "Operar solo en terreno plano",
        correct: "B",
      },
      {
        text: "Al descender por una rampa pronunciada en faena minera con el equipo pesado cargado, ¿cuál es la técnica correcta de operación segura?",
        a: "Bajar en neutro controlando solo con el freno de servicio",
        b: "Mantener marcha baja enganchada, usar retardador/freno de motor y llevar el implemento (balde) bajo y controlado",
        c: "Usar la marcha más alta para reducir revoluciones del motor",
        d: "Apagar el motor para ahorrar combustible",
        correct: "B",
      },
      {
        text: "Si operando maquinaria pesada en una pendiente sufre una pérdida repentina de presión en el sistema de frenos principales, ¿cuál es la maniobra inmediata de emergencia?",
        a: "Saltar de la cabina con el equipo en movimiento",
        b: "Bajar inmediatamente el balde/implemento al suelo, activar freno de emergencia y dirigir el equipo hacia el pretil o berma de contención",
        c: "Poner marcha atrás de golpe a alta velocidad",
        d: "Girar bruscamente hacia el borde libre del banco",
        correct: "B",
      },
    ];
  }

  for (let i = 0; i < qList.length; i++) {
    const q = qList[i];
    if (existing[i]) {
      await conn.query(
        'UPDATE questions SET question_text = ?, option_a = ?, option_b = ?, option_c = ?, option_d = ?, correct_option = ?, category = "TECNICA" WHERE id = ?',
        [q.text, q.a, q.b, q.c, q.d, q.correct, existing[i].id],
      );
    } else {
      await conn.query(
        'INSERT INTO questions (position_id, question_text, option_a, option_b, option_c, option_d, correct_option, category) VALUES (?, ?, ?, ?, ?, ?, ?, "TECNICA")',
        [posId, q.text, q.a, q.b, q.c, q.d, q.correct],
      );
    }
  }
}

module.exports = { ensureSeedData };
