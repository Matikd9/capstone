# Portal de Convocatoria, Filtro Técnico y Pre-Acreditación Normativa — Nexxo S.A.

Plataforma web diseñada para **Nexxo S.A.** (Especialistas en Mantenimiento Industrial, Paradas de Planta y Montaje Minero) que automatiza el reclutamiento operativo, la validación técnica y la pre-acreditación documental bajo los **Estándares de Control de Fatalidades (ECF) de Codelco**, el **Reglamento de Seguridad Minera (DS N° 132)** y la **Ley N° 19.628 de Protección de la Vida Privada**.

---

## 1. Flujo Operativo de Postulación y Acreditación

```
[ FASE 1: POSTULACIÓN INICIAL Y FILTRO CURRICULAR ]
  ├─ Selección de cargo crítico (Rigger, Operador Camión Pluma, Soldador 6G)
  ├─ Carga de Credencial Técnica Habilitante + Currículum Vitae (CV)
  └─ Motor OCR extrae identidad, contacto, residencia y meses reales de experiencia
         │
         ▼ (Consentimiento explícito + Selfie de Validación Informada)
[ FASE 1.5: MINI-TEST TÉCNICO + PROCTORING TRANSPARENTE ]
  ├─ 5 preguntas técnicas de opción múltiple (40 segundos por pregunta)
  ├─ Cámara visible en pantalla durante el examen (sin capturas ocultas)
  └─ Filtro automático: exige nota >= 80% y experiencia mínima del ECF
         │
         ├── Si reprueba (< 80% o sin experiencia mínima) ──► [ DESCARTADO_TECNICO ]
         │
         ▼ Si aprueba (>= 80% y cumple experiencia ECF) ────► [ PRESELECCIONADO ]
[ FASE 2: PRE-ACREDITACIÓN DOCUMENTAL Y CRUCE BIOMÉTRICO / OCR ]
  ├─ Carga de Cédula de Identidad (Frente y Reverso) + Certificado de Antecedentes
  ├─ Cruce OCR: RUT y Nombre (Fase 1 vs. Cédula), Edad (18-75), Vigencia y Antecedentes
  ├─ Contraste visual en Panel RR.HH.: Selfie del Mini-Test vs. Fotografía de Cédula
  └─ Emisión automática de Carpeta de Acreditación para sistema WebControl / Codelco
```

---

## 2. Características Principales

### Cumplimiento Legal y Ético (Ley N° 19.628)
* **Proctoring Transparente Informado:** Se eliminó cualquier captura encubierta o grabación de audio improvisado. El postulante visualiza su cámara en todo momento y otorga consentimiento explícito antes de capturar la Selfie de Validación Informada.
* **Recolección Progresiva de Datos Sensibles:** La Cédula de Identidad y el Certificado de Antecedentes solo se solicitan en la **Fase 2** a quienes ya aprobaron el filtro curricular y técnico (`PRESELECCIONADO`).

### Motor OCR Contextual y Reglas Anti-Ruido (`src/server.js`)
* **Extracción Híbrida PDF + Imagen:**
  * Uso de `pdftotext -raw` (Poppler) para preservar el orden de lectura por bloques en CVs digitales de múltiples columnas (ej. plantillas de Canva o Word) sin mezclar columnas horizontalmente.
  * Uso de `tesseract-ocr` (`spa+eng`) con preprocesamiento de imagen (`sharp`: escala de grises, normalización de contraste, nitidez, umbralización y rotación automática 90°/180°/270°) para fotografías de credenciales y cédulas tomadas desde teléfonos móviles.
* **Segmentación Semántica de CV (`splitCvIntoSections`):**
  * Clasifica automáticamente el contenido del CV en `HEADER`, `CONTACTO`, `PERFIL`, `EXPERIENCIA`, `EDUCACION`, `HABILIDADES`, `CARACTERISTICAS`, `CURSOS` y `REFERENCIAS`.
* **Bloqueo de Nombres de Universidades e Instituciones:**
  * Descarta falsos positivos provenientes de casas de estudio (ej. *Universidad Adolfo Ibáñez*, *INACAP*, *DUOC UC*, *USM*), cargos operativos, términos técnicos y metadatos internos de archivos PDF.
* **Detección Estricta de Ciudad de Residencia:**
  * Extrae la ciudad o comuna exclusivamente desde el encabezado personal (`HEADER`), bloque de `CONTACTO` o etiquetas explícitas (`Ciudad:`, `Comuna:`, `Residencia:`, `Domicilio:`), ignorando comunas mencionadas dentro de `EXPERIENCIA` como lugar de faenas o bodegas anteriores (ej. *Lampa*). Si el CV no indica domicilio, el campo queda vacío para ingreso manual.
* **Cálculo Real de Experiencia Laboral (`calculateExperienceFromSections`):**
  * Suma los meses efectivamente trabajados en los rangos de fechas dentro de la sección `EXPERIENCIA`, excluyendo prácticas estudiantiles (`Práctica operaria / profesional`) e ignorando los años de estudio de la sección `EDUCACION`.
* **Aislamiento de Referencias y Validación Módulo 11 (`isValidChileanRutMod11`):**
  * Ignora por completo la sección `REFERENCIAS` para evitar extraer nombres, teléfonos o correos de antiguos jefes como si fueran del candidato, y valida matemáticamente el dígito verificador Módulo 11 en cada RUT detectado.

### Máquina de Estados de Candidatos (MySQL)
1. `POSTULANDO`: Registro inicial en proceso.
2. `PRESELECCIONADO`: Aprueba filtro de experiencia ECF y obtiene $\ge 80\%$ en el Mini-Test Técnico; habilitado para Fase 2.
3. `DESCARTADO_TECNICO`: No alcanza el puntaje mínimo o la experiencia exigida por el estándar ECF.
4. `DOCS_CARGADOS`: Documentación de Fase 2 recibida en espera de validación.
5. `PRE_ACREDITADO`: Cruce OCR 100% consistente entre Fase 1 y Fase 2 (RUT, nombre, cédula vigente y antecedentes limpios).
6. `EN_REVISION_MANUAL`: Discrepancia detectada por el motor OCR (ej. discordancia de RUT/nombre, documento vencido o edición manual) derivada a auditoría de RR.HH.
7. `CONTRATADO` / `RECHAZADO`: Decisión final del reclutador con generación de carpeta lista para **WebControl**.

---

## 3. Estimación de Escalabilidad y Costos en la Nube (Proyección Operativa)

Para evitar la saturación de CPU del servidor principal durante convocatorias masivas o paradas de planta, se proyectó el costo de desacoplar el procesamiento OCR y desplegar la plataforma en la nube.

### Base de Dimensionamiento Mensual
* **Volumen por cargo:** 1.000 postulaciones base con un factor de rotación mensual de **1,2x a 1,5x** (1.200 a 1.500 postulantes/mes por cargo).
* **Páginas procesadas por postulante:** ~3 páginas en Fase 1 (100% de postulantes) + 3 páginas en Fase 2 (~35%–40% de aprobados) = **~4,2 a 4,5 páginas en promedio por postulante**.
* **Escenario 1 Cargo Activo:** ~1.500 postulantes/mes $\approx$ **6.500 páginas OCR/mes**.
* **Escenario 3 Cargos Simultáneos (Rigger, Operador, Soldador):** ~4.500 postulantes/mes $\approx$ **20.000 páginas OCR/mes**.

### Comparativa de Alternativas de Motor OCR en la Nube

| Criterio | Opción A: Tesseract + Poppler en Contenedor Serverless (Google Cloud Run) | Opción B: API OCR Gestionada (Google Cloud Vision / AWS Textract) | Opción C: API Multimodal Estructurada (Gemini 2.5 Flash / Flash-Lite) |
| :--- | :--- | :--- | :--- |
| **Mecanismo de escalado** | Autoescalado horizontal de contenedores bajo demanda (baja a 0 instancias sin tráfico). | Procesamiento 100% externo vía HTTPS en servidores de Google/AWS (0% carga de CPU local). | Procesamiento 100% externo en Google AI que entrega directamente el JSON estructurado. |
| **Tarifa base oficial** | Capa gratuita: 180.000 vCPU-seg/mes. Extra: \$0,000024 USD / vCPU-seg. | Primeras 1.000 págs/mes gratis; luego **\$1,50 USD por cada 1.000 páginas**. | Entre **\$0,30 y \$1,00 USD por cada 1.000 páginas** procesadas. |
| **Costo mensual (1 Cargo: ~1.500 postulantes / 6.500 págs)** | **\$0 a \$1,00 USD/mes** (\$0 a \$950 CLP) | **~\$8,25 USD/mes** (~\$7.800 CLP) | **~\$2,50 a \$6,50 USD/mes** (~\$2.400 a \$6.200 CLP) |
| **Costo mensual (3 Cargos: ~4.500 postulantes / 20.000 págs)** | **\$0 a \$2,50 USD/mes** (\$0 a \$2.400 CLP) | **~\$28,50 USD/mes** (~\$27.000 CLP) | **~\$6,00 a \$19,00 USD/mes** (~\$5.700 a \$18.000 CLP) |
| **Precisión ante fotos móviles y CVs complejos** | **Media:** Requiere preprocesamiento `sharp` y reglas de expresiones regulares. | **Alta en lectura óptica**, pero entrega texto plano que requiere parseo por secciones. | **Muy Alta:** Comprende contexto visual y semántico sin depender de plantillas fijas. |

### Costo Mensual de Arquitectura Completa en la Nube (Escenario 3 Cargos — 4.500 postulantes/mes)

Mantener la extracción local con `pdftotext` para PDFs digitales (que toman ~0,05 segundos y no consumen OCR de imagen) y enviar únicamente las fotografías de credenciales, carnets y CVs escaneados a una API en la nube reduce el consumo de la API a la mitad:

| Componente de Infraestructura | Especificación Técnica | Costo Mensual (USD) | Costo Mensual Aprox. (CLP) |
| :--- | :--- | :--- | :--- |
| **1. Servidor Web Node.js + MySQL** | VPS Cloud (2 vCPU, 4 GB RAM, 80 GB NVMe — Hetzner / DigitalOcean / Lightsail) | \$8 – \$12 USD | \$7.600 – \$11.400 CLP |
| **2. Almacenamiento de Documentos** | Object Storage (Cloudflare R2 / AWS S3, ~50 GB con retención de 90 días Ley 19.628) | \$1 – \$2 USD | \$950 – \$1.900 CLP |
| **3. Motor OCR en la Nube** | API Multimodal (Gemini Flash) o Cloud Vision para ~10.000–20.000 imágenes/mes | \$10 – \$28 USD | \$9.500 – \$26.600 CLP |
| **4. Dominio + Certificado SSL** | HTTPS obligatorio en producción para habilitar cámara web (`getUserMedia`) | \$1 USD | \$950 CLP |
| **TOTAL MENSUAL ESTIMADO** | **Soporta 4.500 postulantes/mes (~200 concurrentes en peaks)** | **\$20 a \$43 USD / mes** | **~\$19.000 a \$41.000 CLP / mes** |

> **Indicador de Eficiencia:** El costo operativo en la nube equivale a **menos de \$9 CLP por postulante evaluado**, automatizando la revisión documental y técnica previa a la carga en WebControl.

---

## 4. Requisitos e Instalación del Entorno de Desarrollo

### Opción 1: Ejecución con Docker Dev Container
1. Tener **Docker Desktop** o Docker Engine activo.
2. Abrir el repositorio en **VS Code** o **Antigravity IDE** con la extensión **Dev Containers** (`ms-vscode-remote.remote-containers`).
3. Ejecutar el comando **`Dev Containers: Reopen in Container`**.
4. Iniciar el servidor de desarrollo:
   ```bash
   npm run dev
   ```

### Opción 2: Ejecución Local en Linux (Ubuntu / Debian / WSL2)
El servidor detecta automáticamente si se ejecuta fuera de Docker y conmuta el host de MySQL de `db` a `127.0.0.1`, además de elegir un puerto libre si el `3000` está en uso.

1. Asegurar que estén instalados los paquetes del sistema para OCR y PDF:
   ```bash
   sudo apt-get update && sudo apt-get install -y tesseract-ocr tesseract-ocr-spa poppler-utils mysql-server
   ```
2. Instalar dependencias de Node.js e iniciar el servidor:
   ```bash
   npm install
   npm run dev
   ```

---

## 5. Accesos y Estructura del Proyecto

* **Portal del Postulante (Fase 1, Fase 1.5 y Fase 2):** `http://localhost:3000/`
* **Panel de Control RR.HH. y Auditoría OCR:** `http://localhost:3000/admin.html`

### Estructura de Archivos Relevantes
* `src/server.js`: Servidor Express, inicialización y migración automática de esquema MySQL, motor OCR (`pdftotext` + `tesseract` + `sharp`), segmentador contextual de CV (`splitCvIntoSections`), calculadora de experiencia laboral efectiva (`calculateExperienceFromSections`), validador Módulo 11 de RUT (`isValidChileanRutMod11`), evaluación del Mini-Test Técnico y generación de Carpeta WebControl.
* `public/index.html` y `public/app.js`: Interfaz paso a paso del postulante, autocompletado inteligente en Fase 1, cámara de Proctoring Transparente, temporizador del Mini-Test Técnico y carga documental de Fase 2.
* `public/admin.html` y `public/admin.js`: Dashboard de reclutamiento para Nexxo S.A. con métricas en tiempo real, filtros por estado, contraste visual Selfie vs. Cédula, auditoría de discrepancias OCR, botón de re-evaluación OCR y exportación de carpeta de acreditación.
* `public/styles.css`: Sistema de diseño corporativo industrial de Nexxo S.A.

### Credenciales MySQL por Defecto (`.env`)
* **Host:** `db` (en contenedor Docker) o `127.0.0.1` (ejecución local automática)
* **Puerto:** `3306`
* **Usuario:** `root`
* **Contraseña:** `rootpassword`
* **Base de datos:** `web_app`
