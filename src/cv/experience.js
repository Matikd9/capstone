/**
 * Segmentación de un CV en secciones y cálculo de la experiencia laboral desde la sección de Experiencia.
 * Código movido sin cambios desde src/server.js (tarea 1.7).
 */
const { MONTH_MAP } = require("../shared/dates");

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
    REFERENCIAS: [],
  };

  let currentSection = "HEADER";
  const rawLines = (rawText || "").split(/\r?\n/);

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("[PDF_HEADER_NAME]:") ||
      line.startsWith("[---")
    )
      continue;

    const cleanHeader = line
      .replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (
      /^(?:CONTACTO|DATOS\s+PERSONALES|INFORMACI[ÓO]N\s+DE\s+CONTACTO|INFORMACI[ÓO]N\s+PERSONAL|ANTECEDENTES\s+PERSONALES)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "CONTACTO";
      continue;
    }
    if (
      /^(?:PERFIL(?:\s+PROFESIONAL|\s+LABORAL)?|RESUMEN(?:\s+PROFESIONAL|\s+LABORAL|\s+EJECUTIVO)?|SOBRE\s+M[ÍI]|OBJETIVO(?:\s+PROFESIONAL|\s+LABORAL)?|PRESENTACI[ÓO]N)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "PERFIL";
      continue;
    }
    if (
      /^(?:EXPERIENCIA(?:\s+LABORAL|\s+PROFESIONAL|\s+T[ÉE]CNICA|\s+EN\s+FAENA)?|HISTORIAL\s+LABORAL|ANTECEDENTES\s+LABORALES|TRAYECTORIA(?:\s+LABORAL)?)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "EXPERIENCIA";
      continue;
    }
    if (
      /^(?:EDUCACI[ÓO]N|FORMACI[ÓO]N(?:\s+ACAD[ÉE]MICA)?|ESTUDIOS|ANTECEDENTES\s+ACAD[ÉE]MICOS)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "EDUCACION";
      continue;
    }
    if (
      /^(?:HABILIDADES(?:\s+Y\s+COMPETENCIAS)?|COMPETENCIAS|APTITUDES|CONOCIMIENTOS)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "HABILIDADES";
      continue;
    }
    if (
      /^(?:CARACTER[ÍI]STICAS|OTROS\s+DATOS|INFORMACI[ÓO]N\s+ADICIONAL)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "CARACTERISTICAS";
      continue;
    }
    if (
      /^(?:CERTIFICACIONES(?:\s+Y\s+CURSOS)?(?:\s+OPCIONAL)?|CURSOS(?:\s+Y\s+CERTIFICACIONES)?|CAPACITACIONES)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "CURSOS";
      continue;
    }
    if (
      /^(?:REFERENCIAS(?:\s+LABORALES|\s+PROFESIONALES|\s+PERSONALES)?)$/i.test(
        cleanHeader,
      )
    ) {
      currentSection = "REFERENCIAS";
      continue;
    }

    sections[currentSection].push(line);
  }

  return {
    HEADER: sections.HEADER.join("\n"),
    CONTACTO: sections.CONTACTO.join("\n"),
    PERFIL: sections.PERFIL.join("\n"),
    EXPERIENCIA: sections.EXPERIENCIA.join("\n"),
    EDUCACION: sections.EDUCACION.join("\n"),
    HABILIDADES: sections.HABILIDADES.join("\n"),
    CARACTERISTICAS: sections.CARACTERISTICAS.join("\n"),
    CURSOS: sections.CURSOS.join("\n"),
    REFERENCIAS: sections.REFERENCIAS.join("\n"),
  };
}

// Calcula la experiencia laboral real sumando meses trabajados en la sección de Experiencia,
// ignorando prácticas estudiantiles y años de Educación
function calculateExperienceFromSections(sections, fullTextWithoutRefs) {
  const explicitMatch = (fullTextWithoutRefs || "").match(
    /(\d{1,2})\s*(?:\+\s*)?a[ñn]os?\s+de\s+experiencia/i,
  );
  if (explicitMatch) {
    const yrs = parseInt(explicitMatch[1], 10);
    return { years: yrs, months: yrs * 12 };
  }

  const expText = sections.EXPERIENCIA || "";
  if (!expText) {
    return { years: null, months: null };
  }

  // Si la experiencia solo contiene trabajos de retail/supermercado/panadería y no hay menciones industriales o mineras:
  const isRetailOnly =
    /\b(supermercado|jumbo|lider|panader[íi]a|panadero|cajer[oa]|reponedor|garz[óo]n|mesero|comida\s+r[áa]pida|mcdonald|retail|falabella|ripley|atenci[óo]n\s+al\s+cliente)\b/i.test(
      expText,
    );
  const hasIndustrialOrMining =
    /\b(miner[íi]a|minera|faena|parada|planta|concentradora|fundici[óo]n|refiner[íi]a|montaje|mantenimiento|izaje|rigger|soldad|calderer|maquinaria|ecf|subterr[áa]nea|rajo|codelco|bhp|anglo|pelambres|collahuasi|chute|tub[ée]r|piping|mecanic|estructur)\b/i.test(
      expText,
    );

  if (isRetailOnly && !hasIndustrialOrMining) {
    return { years: 0, months: 0 };
  }

  // Excluir bloques de prácticas estudiantiles/operarias/profesionales (ej. "Practica operaria ... enero-febrero 2025")
  const cleanedExp = expText.replace(
    /\bpr[áa]ctica\s+(?:operaria|profesional|laboral|industrial|estudiantil|universitaria|t[ée]cnica)[\s\S]{0,140}?\b(?:19|20)\d{2}\b/gi,
    " ",
  );
  const normExp = cleanedExp.replace(/\s+/g, " ");

  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  const workedMonths = new Set();

  const addMonthRange = (y1, m1, y2, m2) => {
    if (!y1 || !y2 || y1 < 1980 || y2 > curY + 1) return;
    const startIdx = y1 * 12 + (m1 - 1);
    const endIdx = y2 * 12 + (m2 - 1);
    if (endIdx < startIdx || endIdx - startIdx > 45 * 12) return;
    for (let idx = startIdx; idx <= endIdx; idx++) {
      workedMonths.add(idx);
    }
  };

  const monthNamesPattern =
    "ENE(?:RO)?|FEB(?:RERO)?|MAR(?:ZO)?|ABR(?:IL)?|MAY(?:O)?|JUN(?:IO)?|JUL(?:IO)?|AGO(?:STO)?|SEP(?:T(?:IEMBRE)?)?|SETIEMBRE|OCT(?:UBRE)?|NOV(?:IEMBRE)?|DIC(?:IEMBRE)?";
  const presentPattern =
    "ACTUALIDAD|PRESENTE|ACTUALMENTE|VIGENCIA\\s+ACTUAL|AL\\s+D[ÍI]A\\s+DE\\s+HOY|HOY";

  let workingStr = normExp;

  // 1. Rango "Mes Año - Mes Año" o "Mes Año - Actualidad"
  const rangeMonthYearRegex = new RegExp(
    `\\b(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})\\s*(?:[\\-–—/]|a|hasta)\\s*(?:(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})|(${presentPattern}))\\b`,
    "gi",
  );
  workingStr = workingStr.replace(
    rangeMonthYearRegex,
    (match, m1Str, y1Str, m2Str, y2Str, presStr) => {
      const m1 = MONTH_MAP[m1Str.toUpperCase().replace(".", "")];
      const y1 = parseInt(y1Str, 10);
      if (presStr) {
        addMonthRange(y1, m1, curY, curM);
      } else {
        const m2 = MONTH_MAP[m2Str.toUpperCase().replace(".", "")];
        const y2 = parseInt(y2Str, 10);
        addMonthRange(y1, m1, y2, m2);
      }
      return " ";
    },
  );

  // 2. Rango dentro del mismo año "Mes1 - Mes2 Año" (ej. "enero-febrero 2025")
  const sameYearMonthsRegex = new RegExp(
    `\\b(${monthNamesPattern})\\.?\\s*(?:[\\-–—/]|a)\\s*(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})\\b`,
    "gi",
  );
  workingStr = workingStr.replace(
    sameYearMonthsRegex,
    (match, m1Str, m2Str, yStr) => {
      const m1 = MONTH_MAP[m1Str.toUpperCase().replace(".", "")];
      const m2 = MONTH_MAP[m2Str.toUpperCase().replace(".", "")];
      const y = parseInt(yStr, 10);
      addMonthRange(y, m1, y, m2);
      return " ";
    },
  );

  // 3. Mes único puntual "Mes Año" (ej. "julio 2021" -> 1 mes)
  const singleMonthYearRegex = new RegExp(
    `\\b(${monthNamesPattern})\\.?\\s*(?:de\\s+)?((?:19|20)\\d{2})\\b`,
    "gi",
  );
  workingStr = workingStr.replace(
    singleMonthYearRegex,
    (match, m1Str, y1Str) => {
      const m1 = MONTH_MAP[m1Str.toUpperCase().replace(".", "")];
      const y1 = parseInt(y1Str, 10);
      addMonthRange(y1, m1, y1, m1);
      return " ";
    },
  );

  // 4. Rango de años puros "Año1 - Año2 / Actualidad"
  const yearRangeRegex = new RegExp(
    `\\b((?:19|20)\\d{2})\\s*(?:[\\-–—/]|a|hasta)\\s*(?:((?:19|20)\\d{2})|(${presentPattern}))\\b`,
    "gi",
  );
  workingStr.replace(yearRangeRegex, (match, y1Str, y2Str, presStr) => {
    const y1 = parseInt(y1Str, 10);
    if (presStr) {
      addMonthRange(y1, 1, curY, curM);
    } else {
      const y2 = parseInt(y2Str, 10);
      addMonthRange(y1, 1, y2, 12);
    }
    return " ";
  });

  if (workedMonths.size === 0) {
    return { years: null, months: null };
  }

  const totalMonths = workedMonths.size;
  const totalYears = Math.floor(totalMonths / 12);
  return { years: totalYears, months: totalMonths };
}

module.exports = { splitCvIntoSections, calculateExperienceFromSections };
