/**
 * Validación de entradas con esquemas Zod.
 * Valida tipos, formatos y largos antes de la lógica de negocio y descarta campos inesperados.
 * Las reglas de negocio (RUT, nombre, estados de la postulación) siguen en cada ruta.
 */

const { z } = require("zod");
const { AppError } = require("./errors");

z.config(z.locales.es());

// El frontend limita cada archivo a 10 MB; en base64 son ~13,4 M caracteres. Se deja margen.
const MAX_FILE_CHARS = 16 * 1024 * 1024;

const emptyToUndefined = (schema) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), schema);

const id = z.coerce.number().int().positive().max(2147483647);
const optionalId = emptyToUndefined(id.optional());
const optionalText = (max) => z.string().max(max).nullish();
const base64File = z.string().max(MAX_FILE_CHARS).nullish();

const schemas = {
  idParam: z.object({ id }),

  adminLogin: z.object({
    username: z.string().trim().min(1).max(50),
    password: z.string().min(1).max(200),
  }),

  candidateSession: z.object({
    token: z.string().trim().min(16).max(128),
  }),

  ocrUpload: z.object({
    credencial_file: base64File,
    cv_file: base64File,
    carnet_file: base64File,
    antecedentes_file: base64File,
    position_id: optionalId,
  }),

  // Los obligatorios de negocio (nombre, RUT) se siguen comprobando en la ruta, con fallback OCR.
  phase1Submit: z.object({
    full_name: optionalText(150),
    rut_id: optionalText(20),
    email: optionalText(150),
    phone: optionalText(30),
    city: optionalText(100),
    experience_years: z
      .union([z.number().min(0).max(80), z.string().max(5)])
      .nullish(),
    position_id: id,
    cv_file: base64File,
    credencial_file: base64File,
    initial_selfie: base64File,
    random_selfie: base64File,
    consent_proctoring: z.boolean().optional(),
    answers: z
      .union([
        z
          .array(
            z.object({
              question_id: id,
              selected_option: z.string().max(10).nullish(),
            }),
          )
          .max(50),
        z.string().max(20000),
      ])
      .optional(),
    phase1_ocr_data: z.looseObject({}).nullish(),
  }),

  // Sin obligatorios aquí: la ruta primero verifica la sesión (401/403) y luego exige los archivos.
  phase2Submit: z.object({
    carnet_file: base64File,
    carnet_back_file: base64File,
    antecedentes_file: base64File,
    consent_ley19628: z.boolean().optional(),
  }),

  candidatesQuery: z.object({
    status: emptyToUndefined(z.string().max(50).optional()),
    position_id: optionalId,
  }),

  statusUpdate: (states) => z.object({ status: z.enum(states) }),
};

/**
 * Middleware: valida y normaliza req.params, req.query y req.body.
 * Reemplaza cada parte por su versión parseada (sin campos desconocidos).
 */
function validate(shape) {
  return (req, res, next) => {
    for (const key of ["params", "query", "body"]) {
      if (!shape[key]) continue;
      const result = shape[key].safeParse(req[key] || {});
      if (!result.success) {
        const details = result.error.issues.map((i) => ({
          campo: i.path.join(".") || key,
          mensaje: i.message,
        }));
        return next(
          new AppError(
            400,
            `Datos de entrada inválidos (${details[0].campo}): ${details[0].mensaje}`,
            { details },
          ),
        );
      }
      req[key] = result.data;
    }
    next();
  };
}

module.exports = { schemas, validate };
