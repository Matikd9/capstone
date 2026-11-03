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
  ├─ Cruce OCR / Gemini Flash: RUT y Nombre (Fase 1 vs. Cédula), Vigencia y Antecedentes
  ├─ Contraste visual en Panel RR.HH.: Selfie del Mini-Test vs. Fotografía de Cédula
  └─ Emisión automática de Carpeta de Acreditación para sistema WebControl / Codelco
```

---

## 2. Características Principales

### Cumplimiento Legal y Ético (Ley N° 19.628 y Dirección del Trabajo)
* **Proctoring Transparente Informado:** Se eliminó cualquier captura encubierta o grabación de audio improvisado. El postulante visualiza su cámara en todo momento y otorga consentimiento explícito antes de capturar la Selfie de Validación Informada.
* **Bloqueo Estricto de Fase 2 y Despacho Asíncrono de Magic Link:** En estricto cumplimiento de la normativa laboral de la Dirección del Trabajo y la Ley N° 19.628, la Cédula de Identidad y el Certificado de Antecedentes **permanecen estrictamente bloqueados** al terminar el test. El postulante aprobado queda en estado `PRESELECCIONADO` y solo cuando RR.HH. autoriza formalmente el cupo de faena (`APROBADO_FAENA`), el sistema emite un token criptográfico único (Magic Link válido por 7 días) y le notifica por correo para reanudar la Fase 2 sin necesidad de crear contraseñas.

### Motor OCR Multimodal con Google Gemini (`src/geminiOcr.js`)
* **Extracción Estructurada Directa (JSON Schema):** Si se configura `GEMINI_API_KEY`, el motor delega el procesamiento visual a Gemini mediante REST, extrayendo sin consumo de CPU del servidor los campos normalizados de RUT, Nombres, Comuna, Meses de Experiencia y Vigencia de Credenciales.
* **Validación Cruzada de Identidad (Fase 2):** Realiza el cruce de consistencia entre Cédula, Certificado del Registro Civil y datos de Fase 1, detectando discrepancias o antecedentes penales.
* **Fallback Automático Local:** Si la API Key no está configurada, el sistema recurre de forma transparente al motor local basado en Poppler (`pdftotext -raw`) y Tesseract.js.

### Máquina de Estados de Candidatos (MySQL / TiDB)
1. `POSTULADO`: Registro inicial en proceso.
2. `PRESELECCIONADO`: Aprueba filtro de experiencia ECF, obtiene $\ge 80\%$ en el Mini-Test Técnico y 2/2 en Juicio Situacional (SJT); en espera de asignación de cupo por RR.HH.
3. `DESCARTADO_TECNICO`: No alcanza el puntaje mínimo, falla cualquiera de las 2 preguntas de seguridad crítica (SJT / Paso Cero) o no cumple la experiencia exigida por el estándar ECF.
4. `APROBADO_FAENA`: RR.HH. autorizó el cupo del candidato en faena y despachó el Magic Link por correo para desbloquear la Fase 2.
5. `DOCS_CARGADOS`: Documentación de Fase 2 recibida mediante el enlace de acceso seguro.
6. `PRE_ACREDITADO`: Cruce OCR 100% consistente entre Fase 1 y Fase 2 (RUT, nombre, cédula vigente y antecedentes limpios).
7. `EN_REVISION_MANUAL`: Discrepancia detectada por el motor OCR (ej. discordancia de RUT/nombre, documento vencido o edición manual) derivada a auditoría de RR.HH.
8. `CONTRATADO_FAENA`: Asignación definitiva a la parada de planta en División El Teniente con Carpeta WebControl.

---

## 3. Arquitectura de Ambientes: Desarrollo Local vs Producción

El proyecto cuenta con una separación limpia entre desarrollo y producción:

| Característica | Desarrollo Local | Producción (Cloud Run / AWS) |
| :--- | :--- | :--- |
| **Motor de Base de Datos** | MySQL 8.0 en contenedor Docker | TiDB Cloud (Serverless AWS) |
| **Host / Puerto** | `db:3306` (red interna Docker) o `127.0.0.1:3306` | `gateway01...tidbcloud.com:4000` |
| **Cifrado TLS/SSL** | Desactivado (`DB_SSL=false`) | Obligatorio TLSv1.2 (`DB_SSL=true`) |
| **Esquema y Migraciones** | Automático vía `initDB()` al arrancar | Automático vía `initDB()` (100% compatible) |
| **Recarga de Código** | En caliente vía `nodemon` | Contenedor productivo optimizado |

---

## 4. Puesta en Marcha del Entorno de Desarrollo (Docker Compose)

La forma principal y recomendada de trabajar es mediante **Docker Compose unificado**:

### 1. Clonar el repositorio y configurar variables de entorno
```bash
git clone git@github.com:Matikd9/capstone.git
cd capstone
```

Crea tu archivo `.env` para desarrollo local copiando el archivo de ejemplo:
```bash
cp .env.example .env
```

El archivo `.env` vendrá preconfigurado para desarrollo local:
```env
PORT=3000
NODE_ENV=development

# Base de Datos Local en Docker
DB_HOST=db
DB_PORT=3306
DB_USER=root
DB_PASSWORD=rootpassword
DB_NAME=web_app
DB_SSL=false

# Seguridad Administrativa
JWT_SECRET=dev-jwt-secret-key-capstone-2026
ADMIN_DEFAULT_PASSWORD=papa123

# Opcionales (Gemini OCR y SMTP)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASS=
```

### 2. Iniciar el stack de desarrollo
```bash
docker compose up -d
```
Esto levantará:
- **`capstone-db`**: MySQL 8.0 en el puerto `3306`, con persistencia en volumen `devcontainer_mysql-data`.
- **`capstone-app`**: Node.js en el puerto `3000`, montando tu código local con `nodemon` para reinicio automático al guardar cambios.

### 3. Ver logs en tiempo real
```bash
docker compose logs -f app
```
*(Verás la confirmación de conexión: `[DB] Conectando a DESARROLLO LOCAL (MySQL)...`)*

### 4. Detener el entorno
```bash
docker compose down
```

---

## 5. Accesos y Credenciales de Prueba

* **Portal del Postulante (Fase 1, 1.5 y 2):**  
  👉 [http://localhost:3000/](http://localhost:3000/)
* **Portal de Administración y Auditoría RR.HH.:**  
  👉 [http://localhost:3000/admin/login](http://localhost:3000/admin/login)

### Credenciales de Operador RR.HH. por Defecto (Local)
* **Usuario:** `admin`
* **Contraseña:** Configurada en `ADMIN_DEFAULT_PASSWORD` de tu `.env` (por defecto `papa123`).

---

## 6. Mantenimiento y Comandos Frecuentes

### Limpiar únicamente las postulaciones de prueba (manteniendo cargos y preguntas ECF)
Si realizaste pruebas y deseas vaciar la tabla de postulantes para comenzar desde cero sin borrar el banco de preguntas:
```bash
docker exec -i capstone-db mysql -u root -prootpassword -e "
USE web_app;
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE candidate_answers;
TRUNCATE TABLE candidates;
SET FOREIGN_KEY_CHECKS = 1;
"
rm -f public/uploads/*
```

### Reiniciar la base de datos por completo desde cero
Si deseas destruir completamente la base de datos local y dejar que la app reconstruya todo:
```bash
docker compose down -v
docker compose up -d
```

### Sincronización con GitHub (Post-limpieza de historial)
Si el historial fue saneado localmente para purgar adjuntos antiguos o credenciales:
```bash
git push --force origin main
```

---

## 7. Despliegue a Producción (Google Cloud Run / TiDB Cloud)

El repositorio incluye un [Dockerfile](Dockerfile) optimizado para despliegues en contenedores serverless:

1. **Construcción de imagen:**
   ```bash
   docker build -t gcr.io/<TU_PROYECTO>/capstone-app:latest .
   ```
2. **Variables de Entorno en el Proveedor Cloud:**  
   Configura directamente en el panel de Cloud Run (o Secret Manager) las credenciales de **TiDB Cloud**:
   - `DB_HOST`: Host de TiDB Cloud (ej. `gateway01...tidbcloud.com`)
   - `DB_PORT`: `4000`
   - `DB_USER`: Usuario TiDB
   - `DB_PASSWORD`: Contraseña TiDB
   - `DB_NAME`: `web_app`
   - `DB_SSL`: `true`
   - `JWT_SECRET`: Secreto criptográfico de alta entropía
   - `ADMIN_DEFAULT_PASSWORD`: Clave para el primer inicio de sesión admin
   - `PORT`: `8080` (predeterminado para Cloud Run)
