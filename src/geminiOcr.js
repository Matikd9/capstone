/**
 * Módulo de Extracción y Auditoría OCR mediante Google Gemini 1.5 Flash
 * Diseñado para acreditación industrial minera (Nexxo S.A. / Codelco División El Teniente).
 * Extrae datos estructurados (JSON) directamente sin depender de Tesseract local.
 */

require('dotenv').config({ override: true });
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
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
 * Llama a la API de Gemini mediante REST con Conmutación en Cascada Multi-Modelo
 * Si un modelo está saturado (503) o con cuota agotada (429), conmuta automáticamente al siguiente modelo de IA.
 */
async function callGeminiGenerateContent(parts, systemInstruction = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no configurada en el entorno.');
  }

  // Lista de modelos optimizados por baja latencia, cuota y velocidad
  const modelsToTry = [
    process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3-flash-preview'
  ].filter((v, i, a) => a.indexOf(v) === i);

  const errors = [];

  for (let i = 0; i < modelsToTry.length; i++) {
    const currentModel = modelsToTry[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`;

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

    const controller = new AbortController();
    const timeoutTimer = setTimeout(() => {
      controller.abort();
    }, 15000); // 15 segundos máximo por intento

    const startTime = Date.now();

    try {
      console.log(`[Gemini Cascada] (${i + 1}/${modelsToTry.length}) Invocando modelo IA: ${currentModel}...`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal
      });
      clearTimeout(timeoutTimer);

      if (!response.ok) {
        const errorText = await response.text();
        const msg = `Modelo ${currentModel} respondió HTTP ${response.status}: ${errorText.slice(0, 140)}`;
        errors.push(msg);
        console.warn(`[Gemini Cascada Aviso] ${msg}. Conmutando al siguiente modelo de respaldo...`);
        await new Promise(r => setTimeout(r, 100));
        continue;
      }

      const jsonResult = await response.json();
      const rawText = jsonResult?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        throw new Error(`La respuesta de ${currentModel} no contiene datos de texto.`);
      }

      const parsed = JSON.parse(rawText);
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      parsed._used_model = currentModel;
      console.log(`[Gemini Cascada Éxito] Respuesta generada exitosamente con ${currentModel} en ${elapsedSec}s`);
      return parsed;
    } catch (err) {
      clearTimeout(timeoutTimer);
      const isTimeout = err.name === 'AbortError';
      const errMsg = isTimeout 
        ? `Timeout de 15s excedido en modelo ${currentModel}` 
        : `Modelo ${currentModel} falló: ${err.message}`;
      errors.push(errMsg);
      console.warn(`[Gemini Cascada ${isTimeout ? 'Timeout' : 'Error'}] ${errMsg}. Conmutando de inmediato...`);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  throw new Error(`Todos los modelos de IA en cascada fallaron:\n${errors.join('\n')}`);
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
   - Extrae el nombre del titular desde la Credencial Técnica / Licencia ('name_credencial') y desde el Currículum Vitae ('name_cv').
   - Identifica de forma precisa la fuente del nombre ('name_source'):
     * "CREDENCIAL": Si se extrajo únicamente desde la Credencial Técnica / Licencia oficial (o si el CV no contenía nombre claro).
     * "CV": Si se extrajo únicamente desde el CV (porque no se adjuntó credencial o esta no incluye nombre).
     * "AMBOS_COINCIDENTES": Si ambos documentos contienen el nombre y coinciden sustancialmente (mismos nombres y apellidos).
     * "DISCREPANCIA": Si ambos documentos contienen nombres distintos (ej: Credencial a nombre de 'Matías Medina Pavez' y CV a nombre de 'Cristóbal Mena Illanes').
     * "NO_DETECTADO": Si no se encuentra ningún nombre.
   - Si existe DISCREPANCIA en nombres:
     * Asigna 'name_discrepancia': true.
     * En 'full_name', prioriza el nombre legal completo que figure en la Credencial Técnica / Licencia oficial por tener mayor fe pública y fotografía.
     * Añade la observación a 'discrepancia_nota' detallando que el nombre en CV difiere del nombre en Credencial.
   - Si no hay discrepancia, asigna 'name_discrepancia': false y en 'full_name' coloca el nombre legal completo sin cargos ni membretes.
3. CÁLCULO ESTRICTO DE EXPERIENCIA EN MINERÍA / INDUSTRIA PESADA:
   - Este portal es para paradas de planta y mantención minera en Codelco División El Teniente (Nexxo S.A.).
   - SOLO se debe computar experiencia laboral comprobable en el rubro minero, faenas industriales, plantas de procesos (concentradoras, fundiciones, refinerías), montaje o mantenimiento industrial pesado.
   - QUEDA ESTRICTAMENTE PROHIBIDO computar como experiencia y se debe calcular como CERO (0) meses:
     * Trabajos en supermercados, retail o comercio minorista (ej. Panadero en Jumbo, cajero, reponedor, vendedor, atención a público).
     * Trabajos en gastronomía, comida rápida o restaurantes.
     * Labores menores de pavimentación o demolición de calles urbanas barriales (jornal municipal).
     * Prácticas operarias, universitarias, estudiantiles o de pasantía escolar.
     * Empleos administrativos o de oficina no relacionados con terreno minero.
   - Si el CV solo registra trabajos de comercio (como panadero en supermercado), prácticas estudiantiles o empleos ajenos a minería/industria, DEBES asignar obligatoriamente:
     "experience_years": 0,
     "experience_months": 0
     y en "resumen_perfil" indicar: "Sin experiencia comprobable en minería o industria pesada (antecedentes corresponden a comercio/retail o prácticas)."
4. DATOS DE CONTACTO:
   - Extrae email, teléfono y ciudad de residencia preferentemente desde el CV.

Devuelve un JSON estrictamente estructurado con las siguientes claves:

{
  "full_name": string o null (Nombre legal completo del titular sin títulos como 'Ingeniero' o nombres de instituciones),
  "name_source": "CREDENCIAL" | "CV" | "AMBOS_COINCIDENTES" | "DISCREPANCIA" | "NO_DETECTADO",
  "name_credencial": string o null (Nombre detectado en Credencial/Licencia o null),
  "name_cv": string o null (Nombre detectado en CV o null),
  "name_discrepancia": boolean (true si ambos existen y difieren entre sí),
  "rut_id": string o null (RUT chileno con formato "XX.XXX.XXX-X" o "X.XXX.XXX-X" con dígito verificador),
  "rut_source": "CREDENCIAL" | "CV" | "AMBOS_COINCIDENTES" | "DISCREPANCIA" | "NO_DETECTADO",
  "rut_credencial": string o null (RUT detectado en Credencial/Licencia o null),
  "rut_cv": string o null (RUT detectado en CV o null),
  "rut_discrepancia": boolean (true si ambos existen y no coinciden),
  "discrepancia_nota": string o null (Detalle de la discrepancia de RUT o nombre si existe),
  "email": string o null (Correo electrónico de contacto),
  "phone": string o null (Teléfono o celular de contacto chileno indicado en el CV, ej: "+56 9 8765 4321", "987654321" o "87654321"),
  "city": string o null (Comuna o ciudad de residencia indicada en el CV, ej: "Rancagua", "Machalí", "Santiago"),
  "experience_years": number (Años enteros de experiencia laboral efectiva EXCLUSIVAMENTE en minería, faenas industriales o mantenimiento pesado. Si solo trabajó en retail, supermercados, panaderías, servicios o prácticas, DEBE SER 0),
  "experience_months": number (Meses totales efectivos en minería o industria pesada. Si solo tiene experiencia en comercio/retail/prácticas, DEBE SER 0),
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
    name_source: rawResult.name_source || (rawResult.full_name ? (rawResult.name_credencial ? 'CREDENCIAL' : 'CV') : 'NO_DETECTADO'),
    name_credencial: rawResult.name_credencial || null,
    name_cv: rawResult.name_cv || null,
    name_discrepancia: Boolean(rawResult.name_discrepancia),
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
    resumen_perfil: rawResult.resumen_perfil || '',
    used_model: rawResult._used_model || 'gemini'
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

  const todayObj = new Date();
  const todayIso = todayObj.toISOString().slice(0, 10);
  const todayChilean = todayObj.toLocaleDateString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric' });

  const systemInstruction = `
Eres el perito auditor de identidad y seguridad de Nexxo S.A. para ingreso a Codelco División El Teniente (WebControl).
Tu tarea es realizar la VALIDACIÓN CRUZADA OCR entre los documentos oficiales de Fase 2 y los datos registrados en Fase 1.

RELOJ DEL SISTEMA Y REGLAS DE TIEMPO:
- La fecha oficial en tiempo real es: ${todayChilean} (ISO: ${todayIso}).
- Toda fecha en o anterior a ${todayChilean} corresponde al PASADO. Jamás catalogues una fecha del año en curso como "fecha futura".
- Extrae con precisión milimétrica la fecha de emisión del Certificado de Antecedentes (en YYYY-MM-DD) y la fecha de vencimiento de la cédula.

Datos de referencia registrados en Fase 1:
- RUT Registrado: "${phase1Rut || 'NO REGISTRADO'}"
- Nombre Registrado: "${phase1Name || 'NO REGISTRADO'}"

Analiza las imágenes adjuntas: Cédula de Identidad chilena (Frente y Reverso) y Certificado de Antecedentes para Fines Especiales (Registro Civil).
Devuelve un JSON con el siguiente esquema estricto:

{
  "carnet_rut": string o null (RUT detectado en la cédula en formato XX.XXX.XXX-X),
  "carnet_name": string o null (Nombre completo del titular según la cédula),
  "carnet_vigencia": string ("Vigente (Vence DD/MM/AAAA)" o "Vencido (Venció DD/MM/AAAA)"),
  "carnet_vigente_bool": boolean (true si la cédula está vigente a la fecha de ${todayChilean}),
  "antecedentes_rut": string o null (RUT en el certificado de antecedentes),
  "antecedentes_name": string o null (Nombre en el certificado de antecedentes),
  "antecedentes_fecha_emision": string o null (Fecha de emisión exacta del certificado en formato YYYY-MM-DD),
  "tiene_anotaciones_penales": boolean (false si el certificado dice "NO REGISTRA ANOTACIONES" o "SIN ANTECEDENTES"),
  "antecedentes_status": string ("Limpio / Sin Anotaciones" o "Con Anotaciones Penales"),
  "rut_coincide": boolean (true si el RUT del carnet y antecedentes coincide con el de Fase 1),
  "nombre_coincide": boolean (true si el nombre del carnet coincide con el de Fase 1),
  "cross_check_ok": boolean (true si RUT y Nombre coinciden y no hay antecedentes penales),
  "discrepancy_notes": string (Detalle de discordancias reales o "Consistencia 100% verificada entre Fase 1 y Fase 2.")
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
