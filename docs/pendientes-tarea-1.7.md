# Pendientes detectados en la tarea 1.7 (fuera de su alcance)

La tarea 1.7 solo reorganizó código (extracción a `src/config/`, `src/shared/` y `src/cv/` sin cambiar lógica).
Estos problemas se detectaron durante el análisis y la extracción, y quedaron **documentados sin corregir** por decisión expresa.
Las líneas corresponden a `src/server.js` al cierre de la tarea 1.7.

## 1. Extracciones diferidas (requieren adaptar dependencias)

| Función | Motivo |
| :--- | :--- |
| `saveBase64File()` (l. 289) | Usa `pool`, que `initDB()` reasigna; extraerla exige inyectar el pool. |
| `loadCandidateAccess()` (l. 1838) | Consulta la BD con `pool`. |
| `reprocessCandidateOcr()` (l. 2433) | Usa `pool`, `UPLOADS_DIR`, el OCR local y `documentDecision`. |
| OCR local: `extractPdfVisualHeaderName`, `extractTextFromPdfWithPoppler` (l. 530), `renderPdfFirstPageToPng`, `preprocessImageForOcr`, `runTesseractOnFiles` (l. 612), `ocrQueuePromise` | Depende de binarios externos, de una ruta a `spa.traineddata` relativa a `__dirname` y de estado del módulo; no tiene pruebas automáticas. |

## 2. OCR local

- **Errores silenciados**: `catch (e) {}` vacíos en l. 693, 710 y 726, y `ocrQueuePromise = resultPromise.catch(() => {})` en l. 734.
- `extractTextFromPdfWithPoppler()` (l. 530) devuelve `""` si `pdftotext` falla, sin registrar el motivo; el resto de las funciones del bloque también devuelven valores vacíos ante errores.
- **El `Dockerfile` no instala `pdftotext` (Poppler), `gs` (Ghostscript) ni `convert` (ImageMagick)**: en Cloud Run el fallback local sin Gemini no puede leer PDFs. Tampoco están en el contenedor de desarrollo ni en el de CI.
- **Sin pruebas automáticas**: `runTesseractOnFiles()` y las rutas `/api/ocr/phase1` y `/api/ocr/extract` no se ejecutan en la suite. La llamada a `parseExtractedText` de l. 774 solo se verificó estáticamente.

## 3. Archivos subidos

- `saveBase64File()` acepta WEBP pero lo respalda en `file_storage` con `mime_type = application/octet-stream` (l. 353): el mapa de tipos no incluye `webp`.
- El respaldo en `file_storage` es "dispara y olvida": si falla, solo se registra un aviso y el archivo queda únicamente en el disco efímero de Cloud Run.
- Ruta de Fase 2 (l. 1636–1641): busca el archivo en `path.join(__dirname, "..", filePath)` con un valor que viene de la BD, y en `../storage/uploads` fijo (ignora `UPLOADS_DIR`). Duplica la lógica de `resolveUploadPath()` de `reprocessCandidateOcr()` (l. 2440).
- Otros `catch (e) {}` vacíos: caché en disco de `GET /api/files/:filename` (l. 799) y borrado de temporales en las rutas OCR (l. 1203 y 1258).

## 4. Registros y estructura

- La ruta de Fase 1 imprime trazas `[DEBUG OCR]` (l. 1024 y siguientes): revisar que no registren datos personales (Ley N° 19.628).
- `parseExtractedText()` (`src/cv/parser.js`) es una sola función de ~490 líneas; dividirla requiere ampliar antes las pruebas de caracterización.

## 5. Comportamientos actuales fijados por la prueba de caracterización

Quedaron registrados tal cual en `tests/fixtures/caracterizacion.snapshot.json`; corregirlos cambiará la instantánea (regenerarla solo con revisión):

1. En un certificado de antecedentes, la fecha de emisión se interpreta como vencimiento de cédula: `carnet_vigencia = "Vencido (01/06/2026)"`.
2. `isValidPersonName("Juan123 Pérez")` devuelve `true`.
3. `parseChileanDate()` devuelve `null` para `"02 ENE 1990"` y `"02 de Enero del 1990"`, aunque el parser de la cédula sí reconoce `"02 ENE 1990"`.
