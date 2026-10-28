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
[ FASE 1.5: MINI-TEST TÉCNICO & JUICIO SITUACIONAL ECF + PROCTORING TRANSPARENTE ]
  ├─ 5 preguntas en total: 3 de Idoneidad Técnica Específica + 2 de Juicio Situacional (SJT) sobre Seguridad Crítica
  ├─ Cronómetro estricto de 40 segundos por pregunta y cámara visible con visor técnico
  └─ Regla de corte normativo: Exige nota >= 80% (mínimo 4/5) Y aprobación total de SJT (2/2 en Seguridad Crítica / Paso Cero)
         │
         ├── Si reprueba (< 80%, falla 1 SJT o sin experiencia mínima) ──► [ DESCARTADO_TECNICO ]
         │
         ▼ Si aprueba (>= 80%, 2/2 SJT y cumple experiencia ECF) ────────► [ PRESELECCIONADO ]
                                                                                   │
                                                                 (Pausa normativa: En espera de cupo de faena)
                                                                 (RR.HH. audita expediente en panel admin)
                                                                                   │
                                                                                   ▼ [ APROBAR ACCESO A FAENA ]
                                                                          [ APROBADO_FAENA ]
                                                                                   │
                                                          (Despacho de Magic Link / Token único por Email)
                                                          (Candidato abre enlace exclusivo: /?token=...)
                                                                                   │
                                                                                   ▼
[ FASE 2: PRE-ACREDITACIÓN DOCUMENTAL Y VALIDACIÓN CRUZADA OCR / VISIÓN ]
  ├─ Acceso desbloqueado únicamente con autorización previa de faena
  ├─ Carga de Cédula de Identidad (Frente y Reverso) + Certificado de Antecedentes en Dropzones Industriales
  ├─ Cruce OCR / Gemini 1.5 Flash: RUT y Nombre (Fase 1 vs. Cédula), Vigencia y Antecedentes
  ├─ Contraste visual en Panel RR.HH.: Selfie del Mini-Test vs. Fotografía de Cédula
  └─ Emisión automática de Carpeta de Acreditación para sistema WebControl / Codelco
```

---

## 2. Características Principales

### Cumplimiento Legal y Ético (Ley N° 19.628 y Dirección del Trabajo)
* **Proctoring Transparente Informado:** Se eliminó cualquier captura encubierta o grabación de audio improvisado. El postulante visualiza su cámara en todo momento y otorga consentimiento explícito antes de capturar la Selfie de Validación Informada.
* **Bloqueo Estricto de Fase 2 y Despacho Asíncrono de Magic Link:** En estricto cumplimiento de la normativa laboral de la Dirección del Trabajo y la Ley N° 19.628, la Cédula de Identidad y el Certificado de Antecedentes **permanecen estrictamente bloqueados** al terminar el test. El postulante aprobado queda en estado `PRESELECCIONADO` y solo cuando RR.HH. autoriza formalmente el cupo de faena (`APROBADO_FAENA`), el sistema emite un token criptográfico único (Magic Link válido por 7 días) y le notifica por correo para reanudar la Fase 2 sin necesidad de crear contraseñas.

### Motor OCR Multimodal con Gemini 1.5 Flash (`src/geminiOcr.js`)
* **Extracción Estructurada Directa (JSON Schema):** Si se configura `GEMINI_API_KEY`, el motor delega el procesamiento visual a Gemini 1.5 Flash mediante REST, extrayendo sin consumo de CPU del servidor los campos normalizados de RUT, Nombres, Comuna, Meses de Experiencia y Vigencia de Credenciales.
* **Validación Cruzada de Identidad (Fase 2):** Realiza el cruce de consistencia entre Cédula, Certificado del Registro Civil y datos de Fase 1, detectando discrepancias o antecedentes penales.
* **Fallback Automático Local:** Si la API Key no está configurada, el sistema recurre de forma transparente al motor local basado en Poppler (`pdftotext -raw`) y Tesseract.js.

### Máquina de Estados de Candidatos (MySQL)
1. `POSTULANDO`: Registro inicial en proceso.
2. `PRESELECCIONADO`: Aprueba filtro de experiencia ECF, obtiene $\ge 80\%$ en el Mini-Test Técnico y 2/2 en Juicio Situacional (SJT); en espera de asignación de cupo por RR.HH.
3. `DESCARTADO_TECNICO`: No alcanza el puntaje mínimo, falla cualquiera de las 2 preguntas de seguridad crítica (SJT / Paso Cero) o no cumple la experiencia exigida por el estándar ECF.
4. `APROBADO_FAENA`: RR.HH. autorizó el cupo del candidato en faena y despachó el Magic Link por correo para desbloquear la Fase 2.
5. `DOCS_CARGADOS`: Documentación de Fase 2 recibida mediante el enlace de acceso seguro.
6. `PRE_ACREDITADO`: Cruce OCR 100% consistente entre Fase 1 y Fase 2 (RUT, nombre, cédula vigente y antecedentes limpios).
7. `EN_REVISION_MANUAL`: Discrepancia detectada por el motor OCR (ej. discordancia de RUT/nombre, documento vencido o edición manual) derivada a auditoría de RR.HH.
8. `CONTRATADO_FAENA`: Asignación definitiva a la parada de planta en División El Teniente con Carpeta WebControl.

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
