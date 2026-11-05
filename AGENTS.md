# Directivas del Agente - Capstone Monolith Architecture

## 1. Stack Tecnológico y Entorno de Ejecución
- Runtime: Node.js 20 (formato estricto CommonJS: `require` y `module.exports`).
- Frontend: Vanilla JavaScript (ES6+ en navegador sin bundlers ni compiladores), HTML5, CSS3. Prohibido usar `import`/`export` en `public/*.js`.
- Base de datos: Dualidad MySQL 8.0 (local) y TiDB Cloud Serverless (producción con TLSv1.2). Driver `mysql2/promise`. Sin ORM.
- Esquema: Autogestionado mediante sentencias DDL directas en la función `initDB()` dentro de `src/server.js`.
- Almacenamiento y OCR: Manejo de buffers directos con validación mágica (`src/security/fileSecurity.js`), Gemini API REST, Tesseract.js y Poppler (`pdftotext`).

## 2. Protocolo de Ejecución Supervisado (Obligatorio)
Antes de modificar cualquier archivo, debes operar bajo este ciclo:
1. Inspección: Lee únicamente los bloques de código relevantes usando rangos de líneas para no saturar la ventana de contexto.
2. Plan de Implementación: Presenta un plan conciso en Markdown detallando:
   - Diagnóstico del problema o requerimiento.
   - Archivos y líneas exactas a modificar.
   - Si involucra base de datos, las sentencias SQL exactas compatibles con TiDB Serverless.
3. Espera de confirmación: Si la tarea implica cambios estructurales en `src/server.js` o en el esquema de base de datos, detente tras el plan y solicita confirmación.
4. Ejecución Quirúrgica: Modifica solo el bloque específico mediante ediciones basadas en diff/parche. Nunca intentes sobreescribir ni reescribir archivos extensos por completo.
5. Verificación Determinista: Ejecuta siempre los comandos de verificación antes de declarar la tarea como completada.

## 3. Comandos de Verificación (Sustitutos de Testing)
Dado que no existe `npm test`, toda tarea debe verificarse ejecutando los siguientes comandos en la terminal:
- Verificación de sintaxis del monolito:
  `node -c src/server.js`
- Verificación de sintaxis de cualquier módulo tocado:
  `node -c <ruta-del-archivo-modificado>`
- Validación de estilo y formato:
  `npx prettier --check "src/**/*.js" "public/**/*.js"`
- Si un comando falla, diagnostica y corrige el error antes de responder.

## 4. Restricciones Negativas Estrictas (Antipatrones Prohibidos)
- PROHIBIDO reescribir o truncar `src/server.js`: Realiza cambios exclusivamente con reemplazos puntuales de fragmentos. Jamás devuelvas el archivo entero.
- PROHIBIDO modularizar o refactorizar: No extraigas rutas, controladores ni funciones a nuevos archivos a menos que la instrucción del usuario lo exija explícitamente. Respeta la estructura monolítica actual.
- PROHIBIDO modificar variables de entorno: No leas ni escribas en `.env` o `.env.production`. Cualquier variable nueva debe documentarse únicamente en `.env.example`.
- PROHIBIDO instalar dependencias npm: Resuelve funcionalidades con las librerías existentes o APIs nativas de Node.js:
  - Tokens: usa el módulo nativo `crypto`.
  - Peticiones HTTP: usa `fetch` nativo de Node.js (no instales `axios`).
  - Subida de archivos: usa los buffers y la lógica ya implementada (no instales `multer`).
- PROHIBIDO borrar comentarios legales y normativos: Conserva intactos todos los comentarios que hagan referencia a la Ley N° 19.628, estándares ECF de Codelco o dictámenes de la Dirección del Trabajo.
- PROHIBIDO usar sintaxis incompatible con TiDB Cloud:
  - No uses bloqueos de tabla incompatibles (`LOCK TABLES`).
  - No alteres `AUTO_INCREMENT` asumiendo contigüidad estricta (TiDB usa asignación por lotes).
  - Asegúrate de que las conexiones mantengan soporte para TLSv1.2 (`ssl: { rejectUnauthorized: true }`).
- PROHIBIDO romper el frontend con módulos ES: Los archivos en `public/` (como `app.js` y `admin.js`) se cargan directamente como scripts tradicionales en el navegador. No uses `import`, `export` ni dependencias empaquetadas.

## 5. Gestión de Memoria y Resúmenes
- Al finalizar tareas que impliquen cambios en la lógica de estados de contratación o en la función `initDB()`, genera o actualiza un archivo temporal `docs/task_notes.md` resumiendo las sentencias ejecutadas y las funciones modificadas.

## Protocolo de Orquestación
- Si una tarea afecta a más de un archivo o combina base de datos con frontend, el agente principal TIENE PROHIBIDO escribir código directamente.
- El agente principal debe dividir la tarea en subagentes secuenciales, esperando el reporte de éxito del anterior antes de iniciar el siguiente.