/**
 * Analizador del texto OCR de documentos de Fase 1 (CV / credencial) y Fase 2 (cédula / antecedentes).
 * Código movido sin cambios desde src/server.js (tarea 1.7).
 */
const { formatTitleCase } = require("../shared/text");
const { formatRut, isValidChileanRutMod11 } = require("../shared/rut");
const { extractDatesFromText } = require("../shared/dates");
const {
  FIELD_LABEL_PREFIX_REGEX,
  NON_NAME_CONTEXT_WORDS,
  normalizeWordForCheck,
  isValidPersonName,
  pickBestPersonName,
} = require("./names");
const {
  splitCvIntoSections,
  calculateExperienceFromSections,
} = require("./experience");

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
      antecedentes_status: null,
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
    cvSections.CURSOS,
  ]
    .filter(Boolean)
    .join("\n");

  const personalContactText = [
    cvSections.HEADER,
    cvSections.CONTACTO,
    cvSections.CARACTERISTICAS,
  ]
    .filter(Boolean)
    .join("\n");

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

  const mrzDataMatch = rawText.match(
    /(\d{6})\d[MF<«](\d{6})\dCHL\s*(\d{7,8})\s*[<«\-K\s]\s*([0-9K])/i,
  );
  if (mrzDataMatch) {
    const bYY = parseInt(mrzDataMatch[1].slice(0, 2), 10);
    const bMM = parseInt(mrzDataMatch[1].slice(2, 4), 10);
    const bDD = parseInt(mrzDataMatch[1].slice(4, 6), 10);
    const birthYear = bYY <= currentYear % 100 ? 2000 + bYY : 1900 + bYY;
    if (bMM >= 1 && bMM <= 12 && bDD >= 1 && bDD <= 31) {
      mrzBirthDate = `${String(bDD).padStart(2, "0")}/${String(bMM).padStart(2, "0")}/${birthYear}`;
      const today = new Date();
      let age = today.getFullYear() - birthYear;
      const mDiff = today.getMonth() + 1 - bMM;
      if (mDiff < 0 || (mDiff === 0 && today.getDate() < bDD)) age--;
      mrzAge = age;
    }

    const eYY = parseInt(mrzDataMatch[2].slice(0, 2), 10);
    const eMM = parseInt(mrzDataMatch[2].slice(2, 4), 10);
    const eDD = parseInt(mrzDataMatch[2].slice(4, 6), 10);
    const expYear = 2000 + eYY;
    if (eMM >= 1 && eMM <= 12 && eDD >= 1 && eDD <= 31) {
      mrzExpiryDateObj = new Date(expYear, eMM - 1, eDD);
      mrzExpiryFormatted = `${String(eDD).padStart(2, "0")}/${String(eMM).padStart(2, "0")}/${expYear}`;
    }

    mrzRut = formatRut(`${mrzDataMatch[3]}-${mrzDataMatch[4]}`);
  }

  const mrzNameMatch = rawText.match(
    /([A-ZÑ]{3,})\s*[<«]+\s*([A-ZÑ]{3,})\s*[<«]{1,}\s*([A-ZÑ]+(?:[\s<«]+[A-ZÑ]+)*)/i,
  );
  if (mrzNameMatch) {
    const ap1 = mrzNameMatch[1].trim();
    const ap2 = mrzNameMatch[2].trim();
    const nomTokens = mrzNameMatch[3]
      .split(/[\s<«]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !/^[CKLX]+$/i.test(t));
    if (nomTokens.length > 0) {
      const candidateMrzName = formatTitleCase(
        `${nomTokens.join(" ")} ${ap1} ${ap2}`,
      );
      if (isValidPersonName(candidateMrzName)) {
        mrzName = candidateMrzName;
      }
    }
  }

  // 1. Extraer RUT / RUN chileno (ignorando sección de Referencias y validando Módulo 11 en números sin etiqueta)
  let detectedRut = mrzRut || null;
  if (!detectedRut) {
    const rutLabelMatch = textWithoutRefs.match(
      /(?:R\.?U\.?[NT]\.?|CEDULA\s+DE\s+IDENTIDAD)[^\d]{0,35}(\d{1,2}(?:[\.\s]\d{3}){2}[\-\s]?[0-9kK]|\d{7,8}[\-\s]?[0-9kK])/i,
    );
    if (rutLabelMatch && rutLabelMatch[1]) {
      detectedRut = formatRut(rutLabelMatch[1]);
    }
  }
  if (!detectedRut) {
    const genericRutMatches = [
      ...textWithoutRefs.matchAll(
        /\b(\d{1,2}(?:[\.\s]\d{3}){2}[\-][0-9kK]|\d{7,8}[\-][0-9kK])\b/g,
      ),
    ];
    for (const m of genericRutMatches) {
      if (isValidChileanRutMod11(m[1])) {
        detectedRut = formatRut(m[1]);
        break;
      }
    }
  }

  // 2. Extraer Email, Teléfono y Ciudad de Residencia (estrictamente desde Contacto/Encabezado, nunca desde Experiencia, Educación ni Referencias)
  const emailMatch =
    personalContactText.match(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    ) ||
    textWithoutRefs.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  const detectedEmail = emailMatch ? emailMatch[0].toLowerCase() : null;

  // 2a. Extracción de Teléfono Chileno (Etiqueta explícita o patrón numérico móvil)
  let detectedPhone = null;
  const combinedContactText = `${personalContactText}\n${textWithoutRefs}`;

  // Prioridad 1: Etiqueta explícita de contacto (Teléfono, Celular, Fono, WhatsApp, Móvil, Wsp, Cel)
  const explicitPhoneMatch = combinedContactText.match(
    /(?:tel[eé]fono|celular|m[oó]vil|fono|whatsapp|cel|wsp|contact[o]?)\s*[:.-]?\s*(\+?56[\s.-]*)?(?:9[\s.-]*)?(\d{4}[\s.-]*\d{4}|\d{8})/i,
  );
  if (explicitPhoneMatch) {
    const rawDigits = explicitPhoneMatch[0].replace(/\D/g, "");
    if (rawDigits.length >= 8) {
      const p8 = rawDigits.slice(-8);
      detectedPhone = `+56 9 ${p8.slice(0, 4)} ${p8.slice(4)}`;
    }
  }

  // Prioridad 2: Patrón genérico móvil chileno (ej. +56 9 8765 4321, 987654321, 9 8765 4321, etc.)
  if (!detectedPhone) {
    const phoneRegex =
      /(?:\+?56[\s.-]*)?9[\s.-]*\d{4}[\s.-]*\d{4}|\b9\d{8}\b|\b(?:\+?56[\s.-]*)?9[\s.-]*\d{8}\b/;
    const phoneMatch =
      personalContactText.match(phoneRegex) ||
      textWithoutRefs.match(phoneRegex);
    if (phoneMatch) {
      const rawDigits = phoneMatch[0].replace(/\D/g, "");
      if (rawDigits.length >= 8) {
        const p8 = rawDigits.slice(-8);
        detectedPhone = `+56 9 ${p8.slice(0, 4)} ${p8.slice(4)}`;
      }
    }
  }

  let detectedCity = null;
  const cityNamesRegex =
    /\b(Santiago|Rancagua|Machal[íi]|Calama|Antofagasta|Copiap[óo]|Iquique|Concepci[óo]n|Valpara[íi]so|Vi[ñn]a\s+del\s+Mar|La\s+Serena|Coquimbo|Talca|Temuco|Puerto\s+Montt|Punta\s+Arenas|Arica|Curic[óo]|Los\s+Andes|San\s+Fernando|Coya|Lampa|Colina|Quilicura|Maip[úu]|Puente\s+Alto|San\s+Bernardo|Providencia|Las\s+Condes|Pe[ñn]alol[ée]n)\b/i;

  // 2a. Primero buscar etiqueta explícita de residencia ("Ciudad:", "Comuna:", "Residencia:", "Domicilio:", "Ubicación:")
  const explicitCityLabel = personalContactText.match(
    /(?:Ciudad|Comuna|Residencia|Domicilio|Ubicaci[óo]n)\s*:\s*([^\n•|]+)/i,
  );
  if (explicitCityLabel && explicitCityLabel[1]) {
    const mCity = explicitCityLabel[1].match(cityNamesRegex);
    if (mCity) detectedCity = formatTitleCase(mCity[1]);
  }

  // 2b. Si no hay etiqueta explícita, buscar únicamente en las líneas de HEADER y CONTACTO (jamás en EXPERIENCIA ni EDUCACION)
  if (!detectedCity) {
    const headerAndContactLines = `${cvSections.HEADER}\n${cvSections.CONTACTO}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    for (const line of headerAndContactLines) {
      // Descartar líneas que mencionen universidades, empresas, reemplazos, prácticas o cargos
      if (
        /\b(?:Universidad|Instituto|Colegio|Liceo|Escuela|Reemplazo|Pr[áa]ctica|Constructora|Empresa|Grupo|Consultor[íi]a|Faena|Planta|Divisi[óo]n|Mandante)\b/i.test(
          line,
        )
      ) {
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
  const hasRigger =
    /\b(RIGGER|IZAJE|MANIOBRISTA|B30\.5|B30\.9|CHILEVALORA|GRUAS?)\b/i.test(
      rawText,
    );
  const hasSoldador =
    /\b(SOLDADOR|SOLDADURA|WPQ|AWS|3G|4G|6G|MIG|TIG|SMAW)\b/i.test(rawText);
  const hasOperador =
    /\b(CLASE\s*D|CLASE\s*A4|MAQUINARIA\s*PESADA|CONDUCTOR|EXCAVADORA|CARGADOR\s*FRONTAL)\b/i.test(
      rawText,
    );

  if (hasRigger) credencialStatus = "Credencial Rigger Detectada";
  else if (hasSoldador)
    credencialStatus = "Calificación Soldador (WPQ) Detectada";
  else if (hasOperador)
    credencialStatus = "Licencia Clase D / Conductor Detectada";

  // 5. Extraer Fechas (Nacimiento vs. Vigencia de Cédula / Emisión)
  const candidateDates = extractDatesFromText(rawText);

  let detectedBirthDate = mrzBirthDate || null;
  let detectedAge = mrzAge ?? null;
  let oldestYear = 9999;
  let latestDateObj = mrzExpiryDateObj || null;
  let latestDateFormatted = mrzExpiryFormatted || null;

  for (const d of candidateDates) {
    if (!detectedBirthDate && d.year >= 1940 && d.year <= currentYear - 17) {
      if (d.year < oldestYear) {
        oldestYear = d.year;
        const birthDateObj = new Date(d.year, d.month - 1, d.day);
        const today = new Date();
        let age = today.getFullYear() - birthDateObj.getFullYear();
        const mDiff = today.getMonth() - birthDateObj.getMonth();
        if (
          mDiff < 0 ||
          (mDiff === 0 && today.getDate() < birthDateObj.getDate())
        ) {
          age--;
        }
        detectedAge = age;
        detectedBirthDate = `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year}`;
      }
    }
    if (d.year >= 2020 && d.year <= 2040) {
      const dt = new Date(d.year, d.month - 1, d.day);
      if (!latestDateObj || dt > latestDateObj) {
        latestDateObj = dt;
        latestDateFormatted = `${String(d.day).padStart(2, "0")}/${String(d.month).padStart(2, "0")}/${d.year}`;
      }
    }
  }

  if (detectedAge === null) {
    const explicitAgeMatch =
      textWithoutRefs.match(/\bEdad\s*:\s*(\d{2})\s*a[ñn]os\b/i) ||
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
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[PDF_HEADER_NAME]:"));

  const lines = rawLines
    .map((l) =>
      l
        .replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s:]/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);

  function stripFieldLabelOnly(line) {
    return (line || "")
      .replace(FIELD_LABEL_PREFIX_REGEX, " ")
      .replace(/:/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!detectedName) {
    let apellidos = [];
    let nombres = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\bAPELLIDOS?\b/i.test(line)) {
        const inline = stripFieldLabelOnly(line);
        if (
          inline &&
          !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(inline))
        )
          apellidos.push(inline);
        for (let j = 1; j <= 2 && i + j < lines.length; j++) {
          const nextLine = lines[i + j];
          if (/\b(NOMBRES?|NACIONALIDAD|SEXO|FECHA|RUN|RUT)\b/i.test(nextLine))
            break;
          const cleaned = stripFieldLabelOnly(nextLine);
          if (
            cleaned &&
            !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(cleaned))
          )
            apellidos.push(cleaned);
        }
      } else if (/\bNOMBRES\b/i.test(line)) {
        const inline = stripFieldLabelOnly(line);
        if (
          inline &&
          !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(inline))
        )
          nombres.push(inline);
        if (
          !inline &&
          i + 1 < lines.length &&
          !/\b(APELLIDOS?|NACIONALIDAD|SEXO|FECHA|RUN|RUT)\b/i.test(
            lines[i + 1],
          )
        ) {
          const cleaned = stripFieldLabelOnly(lines[i + 1]);
          if (
            cleaned &&
            !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(cleaned))
          )
            nombres.push(cleaned);
        }
      } else if (
        /\b(?:NOMBRE\s+COMPLETO|NOMBRE\s+DEL\s+TITULAR)\b/i.test(line) ||
        /\b(?:NOMBRE|POSTULANTE|ALUMNO|TRABAJADOR)\s*:/i.test(line)
      ) {
        const inline = stripFieldLabelOnly(line);
        if (isValidPersonName(inline)) {
          detectedName = formatTitleCase(inline);
          break;
        } else {
          for (let j = 1; j <= 2 && i + j < lines.length; j++) {
            const nextLine = lines[i + j];
            if (
              /\b(?:R\s*U\s*T|R\s*U\s*N|FECHA|NACIONALIDAD|SEXO)\b/i.test(
                nextLine,
              )
            )
              break;
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
      const combined = [...nombres, ...apellidos]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
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
  const isIdCardBackOrCert =
    /\b(INCHL|NACIO\s+EN|SIN\s+ANTECEDENTES|REGISTRO\s+GENERAL\s+DE\s+CONDENAS)\b/i.test(
      rawText,
    );
  const headerLines = (cvSections.HEADER || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (!detectedName && !isIdCardBackOrCert && headerLines.length > 0) {
    const cvNameCandidates = [];
    const maxScan = Math.min(10, headerLines.length);

    const isCleanSingleWordNameToken = (rawLineStr) => {
      if (!rawLineStr || /[\d@|/\\,•●\-()]/.test(rawLineStr)) return false;
      const cleaned = rawLineStr
        .replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const parts = cleaned.split(/\s+/).filter(Boolean);
      if (parts.length !== 1) return false;
      const w = parts[0];
      if (w.length < 3 || w.length > 18) return false;
      return !NON_NAME_CONTEXT_WORDS.has(normalizeWordForCheck(w));
    };

    for (let i = 0; i < maxScan; i++) {
      const rawLine = headerLines[i];
      if (/[\d@|/\\,•●]/.test(rawLine) || /^\s*[\-*]/.test(rawLine)) continue;

      const cleaned = stripFieldLabelOnly(
        rawLine.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ\s:]/g, " "),
      );
      if (isValidPersonName(cleaned)) {
        cvNameCandidates.push(formatTitleCase(cleaned));
      } else if (
        i + 1 < maxScan &&
        isCleanSingleWordNameToken(rawLine) &&
        isCleanSingleWordNameToken(headerLines[i + 1])
      ) {
        const twoLineCandidate =
          `${rawLine.trim()} ${headerLines[i + 1].trim()}`.replace(/\s+/g, " ");
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
  if (
    /SIN\s+ANTECEDENTES|SIN\s+ANOTACIONES|NO\s+REGISTRA\s+ANTECEDENTES/i.test(
      rawText,
    )
  ) {
    antecedentesStatus = "Sin Antecedentes (Al día)";
  } else if (/REGISTRA\s+ANTECEDENTES|CON\s+ANTECEDENTES/i.test(rawText)) {
    antecedentesStatus = "Con Anotaciones (Requiere Revisión)";
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
    antecedentes_status: antecedentesStatus,
  };
}

module.exports = { parseExtractedText };
