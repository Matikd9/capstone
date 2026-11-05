# Notas de Tarea: Implementación de Cotejo Biométrico Facial Anti-Fraude y Proctoring

## 1. Sentencias DDL Ejecutadas (Compatibilidad MySQL 8.0 y TiDB Cloud)
En la función `initDB()` dentro de `src/server.js`, se incorporaron las siguientes sentencias DDL idempotentes para la tabla `candidates`:

```sql
-- Sentencias ejecutadas de forma idempotente con fallback en initDB():
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS facial_match_ok TINYINT(1) DEFAULT NULL;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS facial_confidence INT DEFAULT NULL;

-- Fallback aplicado para motores que no soportan IF NOT EXISTS en ALTER TABLE:
ALTER TABLE candidates ADD COLUMN facial_match_ok TINYINT(1) DEFAULT NULL;
ALTER TABLE candidates ADD COLUMN facial_confidence INT DEFAULT NULL;
```

Asimismo, se actualizaron las definiciones de creación de tabla en `CREATE TABLE IF NOT EXISTS candidates`:
- `facial_match_ok TINYINT(1) DEFAULT NULL` (1 = verificado/conforme, 0 = discrepancia/suplantación, NULL = pendiente de Fase 2)
- `facial_confidence INT DEFAULT NULL` (porcentaje de confianza fisionómica 0-100)

---

## 2. Archivos y Funciones Modificados

### `src/server.js`
- **`initDB()`**:
  - Incorporación de las columnas `facial_match_ok` y `facial_confidence` en el schema inicial de `candidates`.
  - Ejecución de las sentencias DDL idempotentes al arranque con control de excepciones.
- **`POST /api/candidates` / `POST /api/candidates/phase1-submit`**:
  - Recepción del campo `random_selfie` además de `initial_selfie`.
  - Persistencia segura de la captura aleatoria en disco y almacenamiento de la ruta en la base de datos.
- **`POST /api/candidates/:id/phase2-acreditacion`**:
  - Función auxiliar `loadSelfieBase64` para leer las imágenes guardadas en Fase 1 (`initial_selfie` y `random_selfie`).
  - Envío de ambas selfies junto a la cédula de identidad a `geminiOcr.analyzePhase2IdentityDocuments`.
  - Procesamiento del dictamen biométrico: si `facial_match_ok === 0` o `false`, se invalida `crossCheckOk`, se agrega discrepancia con alerta de suplantación y se fuerza el estado `EN_REVISION_MANUAL`.
  - Actualización en base de datos de las columnas `facial_match_ok` y `facial_confidence`.

### `src/geminiOcr.js`
- **`analyzePhase2IdentityDocuments({ carnetFrontBase64, carnetBackBase64, antecedentesBase64, initialSelfieBase64, randomSelfieBase64, phase1Rut, phase1Name })`**:
  - Actualización del prompt pericial para auditar biometría facial triangulando:
    1. Fotografía de la Cédula de Identidad chilena (Frente).
    2. Selfie previa a la rendición del mini-test técnico (Fase 1.5).
    3. Captura aleatoria tomada en segundo plano durante la rendición del test.
  - Generación de veredicto estructurado en JSON con las claves `facial_match_ok`, `facial_confidence_percent` y `facial_match_details`.
  - Carga segura de los payloads JPEG como partes inline en la solicitud hacia la API de Gemini.

### `public/app.js`
- **`startMiniTest()`**:
  - Inicialización del índice aleatorio `randomCaptureQuestionIndex` (pregunta 1 a 3) y variables de estado para el proctoring silencioso.
- **`captureRandomSelfie()`**:
  - Captura del cuadro actual desde el stream activo de la cámara (`proctoringLiveVideo` o `webcamView`) sobre el canvas de proctoring en formato JPEG a compresión 0.7.
- **`showQuestion()`**:
  - Disparo automático retardado de la captura de proctoring cuando el postulante accede o responde a la pregunta seleccionada.
- **`finishTest()`**:
  - Respaldo de captura en caso de no haberse activado previamente y envío del campo `random_selfie` dentro del payload de Fase 1.

### `public/admin.js`
- **Modal de Postulante / `showCandidateModal()`**:
  - Visualización del badge biométrico (`Biometría Facial: Conforme`, `Alerta de Fraude: Posible Suplantación Facial`, o `Pendiente Fase 2`).
  - Adaptación de la cuadrícula de inspección visual (`media-comparison-grid`) para contrastar lado a lado:
    1. Selfie Inicial (Pre-Test).
    2. Captura en Vivo (Durante el Test).
    3. Fotografía de la Cédula de Identidad.

---

## 3. Lógica Biométrica Anti-Fraude Implementada
1. **Consentimiento y Proctoring No Invasivo**: Al iniciar el mini-test técnico de Fase 1.5, el postulante acepta el proctoring de cámara web.
2. **Doble Muestreo Fisionómico en Fase 1.5**:
   - Una selfie transparente inicial antes de arrancar las preguntas.
   - Una captura instantánea silenciosa y aleatoria durante la respuesta de una de las preguntas de seguridad crítica ECF.
3. **Triangulación Biométrica en Fase 2 (Pre-Acreditación)**:
   - Al cargar la cédula de identidad oficial chilena, el perito de visión computacional (Gemini OCR) compara las 3 imágenes.
   - Si se detecta suplantación de identidad (persona diferente rindiendo el test o discrepancia con el documento oficial), `facial_match_ok` se establece en `false` y `crossCheckOk` se rechaza categóricamente.
4. **Protección del Workflow Normativo**:
   - Ante cualquier falla en el cotejo biométrico facial, el postulante jamás avanza automáticamente a `PRE_ACREDITADO`, siendo derivado a `EN_REVISION_MANUAL` con alertas visuales destacadas para el auditor humano de Nexxo S.A.
