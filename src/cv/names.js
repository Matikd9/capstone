/**
 * Validación y elección de nombres de persona en textos OCR (CV, cédula, certificados).
 * Código movido sin cambios desde src/server.js (tarea 1.7).
 */
const { formatTitleCase, normalizeTextForMatch } = require("../shared/text");

// Etiquetas legítimas de campos de nombre que pueden preceder al nombre del titular en una misma línea
const FIELD_LABEL_PREFIX_REGEX =
  /\b(?:FOTO\s+OFICIAL|NOMBRE\s+COMPLETO|NOMBRE\s+DEL\s+TITULAR|NOMBRE\s+DEL\s+POSTULANTE|NOMBRE\s+DEL\s+TRABAJADOR|NOMBRE\s+DEL\s+ALUMNO|CERTIFICA\s+QUE|APELLIDOS?|NOMBRES?|POSTULANTE|TRABAJADOR|TITULAR|ALUMNO|FOTO|OFICIAL)\b\s*:?\s*/gi;

// Palabras de contexto que DESCALIFICAN por completo una línea o frase como nombre de persona
// (Nunca se deben borrar dejando el resto de la línea, para no convertir "Universidad Adolfo Ibáñez" en "Adolfo Ibáñez"
// ni "Constructora Miguel Morales" en "Miguel Morales")
const NON_NAME_CONTEXT_WORDS = new Set([
  // Instituciones educativas y términos académicos
  "UNIVERSIDAD",
  "UNIVERSITARIO",
  "UNIVERSITARIA",
  "INSTITUTO",
  "COLEGIO",
  "LICEO",
  "ESCUELA",
  "FACULTAD",
  "ACADEMIA",
  "CAMPUS",
  "SEDE",
  "CENTRO",
  "CFT",
  "DUOC",
  "INACAP",
  "AIEP",
  "EDUCACION",
  "FORMACION",
  "ACADEMICA",
  "ACADEMICO",
  "ESTUDIOS",
  "CURSANDO",
  "EGRESADO",
  "TITULADO",
  "GRADUADO",
  "MEMORIA",
  "TESIS",
  "DISTINCION",
  "MAXIMA",
  "PRACTICA",
  "OPERARIA",
  "CURSOS",
  "CURSO",
  "CERTIFICACION",
  "CERTIFICACIONES",
  "DIPLOMADO",
  "MAGISTER",
  "DOCTORADO",
  "PREGRADO",
  "POSTGRADO",
  "LICENCIATURA",
  "LICENCIADO",
  "BACHILLERATO",
  "ALUMNO",
  "ESTUDIANTE",
  // Cargos, profesiones y oficios
  "INGENIERIA",
  "INGENIERO",
  "TECNICO",
  "TECNOLOGO",
  "ANALISTA",
  "BODEGUERO",
  "BODEGERO",
  "JORNAL",
  "OPERADOR",
  "SOLDADOR",
  "RIGGER",
  "MANIOBRISTA",
  "MAESTRO",
  "CAPATAZ",
  "SUPERVISOR",
  "JEFE",
  "GERENTE",
  "DIRECTOR",
  "CONSULTOR",
  "ASISTENTE",
  "AYUDANTE",
  "MECANICO",
  "ELECTRICO",
  "ELECTROMECANICO",
  "PREVENCIONISTA",
  "CONDUCTOR",
  "CHOFER",
  "OCUPACION",
  "PROFESION",
  "PROFESIONAL",
  "CARGO",
  "PUESTO",
  "ESPECIALIDAD",
  "MENCION",
  "TECNOLOGIAS",
  "INFORMACION",
  // Empresas, organizaciones e industria
  "CONSTRUCTORA",
  "CONSULTORIA",
  "EMPRESA",
  "SOCIEDAD",
  "COMPANIA",
  "CORPORACION",
  "FUNDACION",
  "GRUPO",
  "CABAL",
  "HOLDING",
  "MINERA",
  "DIVISION",
  "CODELCO",
  "TENIENTE",
  "MANDANTE",
  "CONTRATISTA",
  "SUBCONTRATISTA",
  "SERVICIOS",
  "SERVICIO",
  "COMERCIAL",
  "INDUSTRIAL",
  "INFORMATICO",
  "SOLUCIONES",
  "TECHSOLUTIONS",
  "GLOBAL",
  "SPA",
  "LTDA",
  "LIMITADA",
  "CLINICA",
  "HOSPITAL",
  "MUTUAL",
  "ACHS",
  "IST",
  "SERNAGEOMIN",
  "CHILEVALORA",
  "SENCE",
  "ALLIANCE",
  "SCRUM",
  "BIZAGI",
  "POWER",
  "DOCKER",
  "PYTHON",
  "EXCEL",
  // Secciones de CV, habilidades y descriptores
  "CURRICULUM",
  "VITAE",
  "INFOGRAFIA",
  "GRAFICO",
  "SIMPLE",
  "AZUL",
  "AMARILLO",
  "RESUMEN",
  "PERFIL",
  "EXPERIENCIA",
  "LABORAL",
  "HABILIDADES",
  "COMPETENCIAS",
  "CARACTERISTICAS",
  "CONTACTO",
  "TELEFONO",
  "CORREO",
  "REFERENCIAS",
  "OBJETIVO",
  "IDIOMAS",
  "ESPANOL",
  "INGLES",
  "NATIVO",
  "AVANZADO",
  "HERRAMIENTAS",
  "METODOLOGIAS",
  "AGILES",
  "KANBAN",
  "MEJORA",
  "CONTINUA",
  "NEGOCIO",
  "MODELAMIENTO",
  "OPTIMIZACION",
  "LOGISTICA",
  "ANALITICA",
  "TABLEROS",
  "PIPELINES",
  "BASES",
  "DISTRIBUIDAS",
  "REEMPLAZO",
  "LICENCIA",
  "PROYECTO",
  "PROYECTOS",
  "DATOS",
  "GESTION",
  "OPERACIONES",
  "PROCESOS",
  "EQUIPO",
  "TRABAJO",
  "DISPOSICION",
  "ORATORIA",
  "AFABLE",
  "EXTROVERTIDO",
  "RESPONSABLE",
  "PROACTIVO",
  "EDAD",
  "ANOS",
  "NACIONALIDAD",
  "CHILENO",
  "CHILENA",
  "SEXO",
  "OPCIONAL",
  // Direcciones, calles, comunas y ciudades
  "AVENIDA",
  "CALLE",
  "PASAJE",
  "CAMINO",
  "CARRETERA",
  "RUTA",
  "PANAMERICANA",
  "NORTE",
  "SUR",
  "ORIENTE",
  "PONIENTE",
  "COMUNA",
  "CIUDAD",
  "REGION",
  "SECTOR",
  "VILLA",
  "ROBLE",
  "LAMPA",
  "SANTIAGO",
  "RANCAGUA",
  "MACHALI",
  "CALAMA",
  "ANTOFAGASTA",
  "COPIAPO",
  "IQUIQUE",
  "CONCEPCION",
  "VALPARAISO",
  "VINA",
  "MAR",
  "SERENA",
  "COQUIMBO",
  "TEMUCO",
  "TALCA",
  "CURICO",
  "PENALOLEN",
  "PROVIDENCIA",
  "CONDES",
  "MAIPU",
  "QUILICURA",
  "COLINA",
  "CHILE",
  // Fechas, meses y términos legales / documentos oficiales
  "ENERO",
  "FEBRERO",
  "MARZO",
  "ABRIL",
  "MAYO",
  "JUNIO",
  "JULIO",
  "AGOSTO",
  "SEPTIEMBRE",
  "SETIEMBRE",
  "OCTUBRE",
  "NOVIEMBRE",
  "DICIEMBRE",
  "ACTUALIDAD",
  "PRESENTE",
  "ACTUALMENTE",
  "VIGENCIA",
  "EMISION",
  "VENCIMIENTO",
  "NACIMIENTO",
  "FECHA",
  "REPUBLICA",
  "REGISTRO",
  "CIVIL",
  "IDENTIFICACION",
  "CEDULA",
  "NUMERO",
  "DOCUMENTO",
  "FIRMA",
  "INFORMADA",
  "NACIO",
  "CERTIFICADO",
  "ANTECEDENTES",
  "PARTICULARES",
  "FINES",
  "CONDENAS",
  "ANOTACIONES",
  "GENERAL",
  "ESPECIAL",
  "VIOLENCIA",
  "INTRAFAMILIAR",
  "FOLIO",
  "CODIGO",
  "VERIFICACION",
  "TIMBRE",
  "ELECTRONICO",
  "GRATUITO",
  "IMPRESO",
  "ACREDITACION",
  "BAJO",
  "NORMA",
  "ASME",
  "NIVEL",
  "IZAJES",
  "CRITICOS",
  "HOMOLOGADO",
  "ESTANDAR",
  "CONTROL",
  "FATALIDADES",
  "ECF",
  "HABILITANTE",
  "CALIFICACION",
  "CLASE",
  "VALIDO",
  "PARA",
  "INCORPORA",
  "AVANZADA",
  "VERIFIQUE",
  "CENTER",
  "TELEFONOS",
  "FIJOS",
  "CELULARES",
  "PROXIMA",
  "OBTEN",
  "ESTE",
  "NOMBRE",
  "NOMBRES",
  "APELLIDO",
  "APELLIDOS",
  "COMPLETO",
  "TITULAR",
  "POSTULANTE",
  "TRABAJADOR",
  "FOTO",
  "OFICIAL",
  "CERTIFICA",
  "QUE",
  "RUN",
  "RUT",
]);

// Nombres epónimos de universidades, institutos, colegios y calles chilenas que jamás deben tomarse como el postulante
const BLOCKED_EPONYMOUS_NAMES = [
  "ADOLFO IBANEZ",
  "ANDRES BELLO",
  "FEDERICO SANTA MARIA",
  "DIEGO PORTALES",
  "ALBERTO HURTADO",
  "BERNARDO OHIGGINS",
  "BERNARDO O HIGGINS",
  "ARTURO PRAT",
  "GABRIELA MISTRAL",
  "PEDRO DE VALDIVIA",
  "FINIS TERRAE",
  "SANTO TOMAS",
  "SAN SEBASTIAN",
  "VIRGINIO GOMEZ",
  "GUILLERMO SUBERCASEAUX",
  "RAUL SILVA HENRIQUEZ",
  "MIGUEL DE CERVANTES",
  "VICENTE PEREZ ROSALES",
  "MANUEL RODRIGUEZ",
  "VICUNA MACKENNA",
  "BENJAMIN VICUNA MACKENNA",
  "JOSE MIGUEL CARRERA",
  "IGNACIO CARRERA PINTO",
  "ALONSO DE ERCILLA",
];

const NAME_CONNECTORS = /^(de|del|la|las|los|y|san|von|van)$/i;

function normalizeWordForCheck(word) {
  return (word || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();
}

function isValidPersonName(candidateStr) {
  if (!candidateStr || typeof candidateStr !== "string") return false;

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
    const cleanW = w.replace(/[^a-zA-ZáéíóúÁÉÍÓÚñÑ]/g, "");
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
    if (!/[bcdfghjklmnñpqrstvwxyzBCDFGHJKLMNÑPQRSTVWXYZ]/.test(cleanW))
      return false;
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

  for (const raw of candidatesList || []) {
    if (!raw || typeof raw !== "string") continue;
    const formatted = formatTitleCase(raw);
    if (!isValidPersonName(formatted)) continue;
    const key = normalizeTextForMatch(formatted);
    if (!seen.has(key)) {
      seen.add(key);
      validList.push(formatted);
    }
  }

  if (validList.length === 0) return null;

  let normRef = "";
  let emailLocal = "";
  if (referenceNameOrEmail && typeof referenceNameOrEmail === "string") {
    if (referenceNameOrEmail.includes("@")) {
      emailLocal = referenceNameOrEmail
        .split("@")[0]
        .replace(/[^a-zA-Z]/g, "")
        .toUpperCase();
    } else {
      normRef = normalizeTextForMatch(referenceNameOrEmail);
    }
  }
  const refTokens = normRef
    ? normRef.split(" ").filter((t) => t.length >= 3)
    : [];

  let bestName = validList[0];
  let bestScore = -999;

  for (let idx = 0; idx < validList.length; idx++) {
    const name = validList[idx];
    const words = name.split(/\s+/);
    const normCand = normalizeTextForMatch(name);
    const candTokens = normCand.split(" ").filter((t) => t.length >= 3);

    let score = Math.max(0, 15 - idx * 4);

    // Preferir nombres oficiales completos de 3 a 4 palabras (Nombres + 2 Apellidos) sobre nombres cortos de CV (2 palabras)
    if (words.length === 4) score += 42;
    else if (words.length === 3) score += 38;
    else if (words.length === 2) score += 15;
    else score += 10;

    // Si este nombre más completo contiene todos los tokens de otro nombre más corto de la lista (ej. "Cristóbal Mena Illanes" contiene "Cristóbal Mena")
    for (const other of validList) {
      if (other === name) continue;
      const otherTokens = normalizeTextForMatch(other)
        .split(" ")
        .filter((t) => t.length >= 3);
      if (otherTokens.length >= 2 && otherTokens.length < candTokens.length) {
        const allIncluded = otherTokens.every((t) => candTokens.includes(t));
        if (allIncluded) score += 45;
      }
    }

    // Cruce con nombre de referencia
    if (refTokens.length > 0) {
      const matched = refTokens.filter((t) => normCand.includes(t)).length;
      score += matched * 50;
    }

    // Cruce con el correo electrónico del CV (ej. nombre.apellido@correo.cl)
    if (emailLocal.length >= 5) {
      const emailMatched = candTokens.filter((t) =>
        emailLocal.includes(t),
      ).length;
      score += emailMatched * 45;
    }

    if (score > bestScore) {
      bestScore = score;
      bestName = name;
    }
  }

  return bestName;
}

module.exports = {
  FIELD_LABEL_PREFIX_REGEX,
  NON_NAME_CONTEXT_WORDS,
  normalizeWordForCheck,
  isValidPersonName,
  pickBestPersonName,
};
