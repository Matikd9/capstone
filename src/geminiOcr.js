/**
 * Módulo de Extracción y Auditoría OCR mediante Google Gemini 1.5 Flash
 * Diseñado para acreditación industrial minera (Nexxo S.A. / Codelco División El Teniente).
 * Extrae datos estructurados (JSON) directamente sin depender de Tesseract local.
 */

require('dotenv').config({ override: true });
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const mammoth = require('mammoth');

function isGeminiAvailable() {
  const key = process.env.GEMINI_API_KEY;
  return Boolean(key && key.trim() !== '' && key.trim() !== 'tu_api_key_aqui');
}

function parseBase64Payload(base64Data, defaultMime = 'image/jpeg') {
  if (!base64Data) return null;
  const match = base64Data.match(/^data:([A-Za-z0-9-+\/\.]+);base64,(.+)$/);
  if (match) {
    return {
      mimeType: match[1],
      data: match[2]
    };
  }
  return {
    mimeType: defaultMime,
    data: base64Data.replace(/\s+/g, '')
  };
}

/**
 * Llama a la API de Gemini 1.5 Flash mediante REST
 */
async function callGeminiGenerateContent(parts, systemInstruction = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no configurada en el entorno.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: parts
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  if (systemInstruction) {
    requestBody.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Error en API Gemini (${response.status}): ${errorText}`);
  }

  const jsonResult = await response.json();
  const rawText = jsonResult?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error('La respuesta de Gemini no contiene datos de texto.');
  }

  return JSON.parse(rawText);
}

/**
 * FASE 1: Extrae datos estructurados desde Credencial Técnica y Currículum Vitae
 */
async function analyzePhase1Documents({ credencialBase64, cvBase64 }) {
  const parts = [];

  const systemInstruction = `
Eres un auditor técnico y perito documental para acreditación en minería pesada en Chile (Nexxo S.A. / Codelco División El Teniente).
Analiza los documentos adjuntos:
- DOCUMENTO 1 (si existe): Credencial Técnica Habilitante / Licencia de Conducir (Licencia Clase D, A, Carnet Rigger, WPQ Soldador, etc.).
- DOCUMENTO 2 (si existe): Currículum Vitae (CV Técnico Laboral).

REGLAS CRÍTICAS DE EXTRACCIÓN Y FUSIÓN DOCUMENTAL (CASCADA Y VALIDACIÓN CRUZADA):
1. EXTRACCIÓN DE IDENTIDAD Y RUT:
   - Extrae el RUT del postulante en formato chileno estándar "XX.XXX.XXX-X" o "X.XXX.XXX-X" con dígito verificador.
   - Si el Currículum Vitae (CV) NO incluye el RUT, DEBES buscarlo y extraerlo obligatoriamente desde la Credencial Técnica / Licencia de Conducir / Certificado técnico adjunto (donde comúnmente figura como "RUT", "RUN", "Cédula", "N° Licencia" o bajo la fotografía).
   - Identifica de forma precisa la fuente del RUT:
     * "CREDENCIAL": Si se extrajo desde la Credencial / Licencia (porque el CV no lo tenía o solo se adjuntó credencial).
     * "CV": Si se extrajo exclusivamente desde el CV.
     * "AMBOS_COINCIDENTES": Si ambos documentos contienen el RUT y coinciden exactamente.
     * "DISCREPANCIA": Si ambos documentos contienen un RUT pero difieren entre sí (posible suplantación o error de documento).
     * "NO_DETECTADO": Si no se encuentra ningún RUT en ningún documento.
   - En caso de DISCREPANCIA:
     * Asigna 'rut_discrepancia': true.
     * En 'rut_id', prioriza el RUT de la Credencial / Licencia oficial por tener mayor fe pública y fotografía.
     * En 'discrepancia_nota', explica brevemente la diferencia (ej: "RUT en CV 12.345.678-5 difiere de Licencia 18.999.888-7").
2. NOMBRE COMPLETO LEGAL:
   - Si el RUT fue extraído de la Credencial Técnica / Licencia oficial, toma como 'full_name' el nombre legal completo que figure en dicha Credencial / Licencia (omitiendo cargos o membretes), ya que tiene validez oficial. Si solo hay CV, toma el nombre del CV sin títulos.
3. DATOS DE CONTACTO Y EXPERIENCIA:
   - Extrae email, teléfono, ciudad de residencia y experiencia laboral preferentemente desde el CV.

Devuelve un JSON estrictamente estructurado con las siguientes claves:

{
  "full_name": string o null (Nombre legal completo del titular sin títulos como 'Ingeniero' o nombres de instituciones),
  "rut_id": string o null (RUT chileno con formato "XX.XXX.XXX-X" o "X.XXX.XXX-X" con dígito verificador),
  "rut_source": "CREDENCIAL" | "CV" | "AMBOS_COINCIDENTES" | "DISCREPANCIA" | "NO_DETECTADO",
  "rut_credencial": string o null (RUT detectado en Credencial/Licencia o null),
  "rut_cv": string o null (RUT detectado en CV o null),
  "rut_discrepancia": boolean (true si ambos existen y no coinciden),
  "discrepancia_nota": string o null (Detalle de la discrepancia de RUT o nombre si existe),
  "email": string o null (Correo electrónico de contacto),
  "phone": string o null (Teléfono de contacto),
  "city": string o null (Comuna o ciudad de residencia indicada en el CV, ej: "Rancagua", "Machalí", "Santiago"),
  "experience_years": number (Años enteros de experiencia laboral efectiva en el oficio, excluyendo prácticas escolares o universitarias),
  "experience_months": number (Meses totales efectivos calculados en experiencia laboral),
  "credencial_status": string (Nombre o tipo de credencial técnica detectada, ej: "Carnet Rigger", "Calificación Soldador 6G WPQ", "Licencia D", o "No detectada"),
  "credencial_vigencia": string ("Vigente", "Vencido" o fecha encontrada),
  "es_conforme_tecnico": boolean (true si los documentos acreditan oficio operativo minero),
  "resumen_perfil": string (Breve descripción técnica de 1 línea del perfil)
}
`;

  if (credencialBase64) {
    const parsedCred = parseBase64Payload(credencialBase64, 'image/jpeg');
    if (parsedCred) {
      parts.push({
        text: 'DOCUMENTO 1: Credencial Técnica Habilitante (Carnet Rigger, WPQ o Licencia D):'
      });
      parts.push({
        inlineData: {
          mimeType: parsedCred.mimeType,
          data: parsedCred.data
        }
      });
    }
  }

  if (cvBase64) {
    const parsedCv = parseBase64Payload(cvBase64, 'application/pdf');
    if (parsedCv) {
      const mime = (parsedCv.mimeType || '').toLowerCase();
      if (mime.includes('word') || mime.includes('docx') || mime.includes('officedocument') || mime.includes('msword')) {
        try {
          const buffer = Buffer.from(parsedCv.data, 'base64');
          const docxResult = await mammoth.extractRawText({ buffer });
          const textValue = (docxResult.value || '').trim();
          parts.push({
            text: `DOCUMENTO 2: Currículum Vitae (Texto extraído directamente de archivo Microsoft Word .DOCX):\n\n${textValue}`
          });
        } catch (docxErr) {
          console.error('[Gemini OCR DOCX Error]:', docxErr.message);
          parts.push({
            text: 'DOCUMENTO 2: Currículum Vitae (CV Técnico Laboral):'
          });
          parts.push({
            inlineData: {
              mimeType: parsedCv.mimeType,
              data: parsedCv.data
            }
          });
        }
      } else {
        parts.push({
          text: 'DOCUMENTO 2: Currículum Vitae (CV Técnico Laboral):'
        });
        parts.push({
          inlineData: {
            mimeType: parsedCv.mimeType,
            data: parsedCv.data
          }
        });
      }
    }
  }

  if (parts.length === 0) {
    throw new Error('No se proporcionaron documentos válidos para analizar.');
  }

  parts.push({
    text: 'Extrae con exactitud los datos solicitados en formato JSON según las instrucciones.'
  });

  const rawResult = await callGeminiGenerateContent(parts, systemInstruction);
  return {
    full_name: rawResult.full_name || null,
    rut_id: rawResult.rut_id || null,
    rut_source: rawResult.rut_source || (rawResult.rut_id ? 'CV' : 'NO_DETECTADO'),
    rut_credencial: rawResult.rut_credencial || null,
    rut_cv: rawResult.rut_cv || null,
    rut_discrepancia: Boolean(rawResult.rut_discrepancia),
    discrepancia_nota: rawResult.discrepancia_nota || null,
    email: rawResult.email || null,
    phone: rawResult.phone || null,
    city: rawResult.city || null,
    experience_years: typeof rawResult.experience_years === 'number' ? rawResult.experience_years : null,
    experience_months: typeof rawResult.experience_months === 'number' ? rawResult.experience_months : null,
    credencial_status: rawResult.credencial_status || 'Documento Técnico Verificado',
    credencial_vigencia: rawResult.credencial_vigencia || 'Vigente',
    es_conforme_tecnico: Boolean(rawResult.es_conforme_tecnico),
    resumen_perfil: rawResult.resumen_perfil || ''
  };
}

/**
 * FASE 2: Validación Cruzada de Cédula de Identidad y Certificado de Antecedentes
 */
async function analyzePhase2IdentityDocuments({
  carnetFrontBase64,
  carnetBackBase64,
  antecedentesBase64,
  phase1Rut,
  phase1Name
}) {
  const parts = [];

  const systemInstruction = `
Eres el perito auditor de identidad y seguridad de Nexxo S.A. para ingreso a Codelco División El Teniente (WebControl).
Tu tarea es realizar la VALIDACIÓN CRUZADA OCR entre los documentos oficiales de Fase 2 y los datos registrados en Fase 1.

Datos de referencia registrados en Fase 1:
- RUT Registrado: "${phase1Rut || 'NO REGISTRADO'}"
- Nombre Registrado: "${phase1Name || 'NO REGISTRADO'}"

Analiza las imágenes adjuntas: Cédula de Identidad chilena (Frente y Reverso) y Certificado de Antecedentes para Fines Especiales (Registro Civil).
Devuelve un JSON con el siguiente esquema estricto:

{
  "carnet_rut": string o null (RUT detectado en la cédula en formato XX.XXX.XXX-X),
  "carnet_name": string o null (Nombre completo del titular según la cédula),
  "carnet_vigencia": string ("Vigente (Vence DD/MM/AAAA)" o "Vencido (Venció DD/MM/AAAA)"),
  "carnet_vigente_bool": boolean (true si la cédula está vigente a la fecha de hoy),
  "antecedentes_rut": string o null (RUT en el certificado de antecedentes),
  "antecedentes_name": string o null (Nombre en el certificado de antecedentes),
  "antecedentes_fecha_emision": string o null (Fecha de emisión en formato YYYY-MM-DD),
  "antecedentes_dias_antiguedad": number (Días transcurridos desde su emisión),
  "antecedentes_vigente_bool": boolean (true si fue emitido hace 60 días o menos),
  "tiene_anotaciones_penales": boolean (false si el certificado dice "NO REGISTRA ANOTACIONES" o "SIN ANTECEDENTES"),
  "antecedentes_status": string ("Limpio / Sin Anotaciones" o "Con Anotaciones Penales"),
  "rut_coincide": boolean (true si el RUT del carnet y antecedentes coincide con el de Fase 1),
  "nombre_coincide": boolean (true si el nombre del carnet coincide con el de Fase 1),
  "cross_check_ok": boolean (true solo si RUT coincide, Nombre coincide, Cédula está vigente, Certificado tiene 60 días o menos y NO registra anotaciones penales),
  "discrepancy_notes": string (Detalle de discordancias o "Consistencia 100% verificada entre Fase 1 y Fase 2.")
}
`;

  if (carnetFrontBase64) {
    const p = parseBase64Payload(carnetFrontBase64, 'image/jpeg');
    if (p) {
      parts.push({ text: 'DOCUMENTO A: Cédula de Identidad Chilena (Frente):' });
      parts.push({ inlineData: { mimeType: p.mimeType, data: p.data } });
    }
  }

  if (carnetBackBase64) {
    const p = parseBase64Payload(carnetBackBase64, 'image/jpeg');
    if (p) {
      parts.push({ text: 'DOCUMENTO B: Cédula de Identidad Chilena (Reverso):' });
      parts.push({ inlineData: { mimeType: p.mimeType, data: p.data } });
    }
  }

  if (antecedentesBase64) {
    const p = parseBase64Payload(antecedentesBase64, 'application/pdf');
    if (p) {
      parts.push({ text: 'DOCUMENTO C: Certificado de Antecedentes para Fines Especiales (Registro Civil):' });
      parts.push({ inlineData: { mimeType: p.mimeType, data: p.data } });
    }
  }

  parts.push({
    text: 'Realiza el cruce de identidad y genera el dictamen normativo en el JSON requerido.'
  });

  return await callGeminiGenerateContent(parts, systemInstruction);
}

module.exports = {
  isGeminiAvailable,
  analyzePhase1Documents,
  analyzePhase2IdentityDocuments
};
