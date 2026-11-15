# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

- Node.js 20, CommonJS (`require` / `module.exports`) en `src/`.
- Frontend en `public/*.js`: JavaScript vanilla cargado como script clásico en el navegador; no usar `import`/`export` ni bundlers.
- BD: MySQL 8.0 (local) y TiDB Cloud Serverless (producción, TLSv1.2). Driver `mysql2/promise`, sin ORM.

## Convenciones

- Compatibilidad TiDB: no usar `LOCK TABLES` ni asumir contigüidad de `AUTO_INCREMENT`; mantener `ssl: { rejectUnauthorized: true }` en producción.
- No leer ni modificar `.env` / `.env.production`; las variables nuevas se documentan en `.env.example`.
- Preferir `crypto` y `fetch` nativos de Node antes de agregar dependencias.
- Conservar los comentarios legales y normativos (Ley N° 19.628, estándares ECF de Codelco, dictámenes de la Dirección del Trabajo).
- `src/server.js` es muy grande: leer por rangos de líneas y editar con cambios puntuales, sin reescribirlo.
- Cambios estructurales en `src/server.js` o en el esquema de BD: presentar un plan breve y pedir confirmación antes de ejecutar.

## Verificación

Antes de dar una tarea por terminada (es lo mismo que ejecuta el CI en `.github/workflows/ci.yml`):

```bash
node -c src/server.js           # y cualquier otro módulo tocado
npm run lint                    # Prettier
npm test                        # node:test: tests/unit + tests/integration (requiere la BD local de Docker)
```

## Comandos

```bash
docker compose up -d            # Stack local: capstone-db (MySQL 8.0 :3306) + capstone-app (nodemon :3000)
docker compose logs -f app      # Logs de la app
docker compose down -v          # Destruye la BD local; initDB() la reconstruye al arrancar
npm run dev                     # nodemon fuera de Docker (si falla host 'db', initDB cae a 127.0.0.1)
npm run lint                    # prettier --check (src, public js/css)
npm run format                  # prettier --write
node -c src/server.js           # Verificación de sintaxis
npm test                        # Pruebas unitarias y de integración (BD local web_app_test_*)
```

- Portal postulante: `http://localhost:3000/` — Fase 2 vía magic link `/?token=...`
- Panel RR.HH.: `http://localhost:3000/admin/login` (usuario `admin`, clave `ADMIN_DEFAULT_PASSWORD`)
- Si el puerto está ocupado, `startServer()` reintenta en puerto+1.

## Arquitectura

**Monolito Express** en `src/server.js` (~4500 líneas): configuración de BD, `initDB()` con DDL/migraciones, datos semilla, todo el parser OCR local (heurísticas de RUT, nombres, fechas chilenas, cálculo de experiencia desde secciones del CV) y todas las rutas `/api/*`. Módulos satélite (CommonJS):
- `src/geminiOcr.js` — OCR vía Gemini REST con JSON schema; rota entre una lista de modelos ante 429/503/402. Si no hay `GEMINI_API_KEY`, `server.js` usa el fallback local: `pdftotext` (Poppler, vía `execFileSync`) + Tesseract.js con `spa.traineddata` en la raíz.
- `src/auth.js` — scrypt + JWT HMAC-SHA256 hecho a mano con `crypto`; `requireAdminAuth` protege `/api/admin/*`; `initAdminAuth(pool)` crea la tabla de admins y el usuario por defecto.
- `src/mailer.js` — nodemailer; genera el token del magic link (7 días) y envía invitación de Fase 2 / confirmación de contratación. Sin credenciales SMTP el transporter es `null`.
- `src/security/fileSecurity.js` — validación por magic bytes, heurística anti-macros/JS en DOCX/PDF, nombres de archivo aleatorios.

**Frontend**: `public/app.js` (portal postulante, wizard Fase 1 → Mini-Test con cámara → Fase 2) y `public/admin.js` (panel RR.HH., token JWT en `Authorization: Bearer`). Los HTML del admin viven en `src/admin_portal/` (no en `public/`) y se sirven con rutas explícitas `/admin`, `/admin/login`.

**Archivos subidos**: llegan como base64 en JSON (límite 50mb), se guardan con `saveBase64File()` en `storage/uploads/` (privado, fuera de `public/`) y se respaldan en la tabla `file_storage` (BLOB). `GET /api/files/:filename` sirve desde disco y, si no existe (disco efímero de Cloud Run), recupera desde la BD.

**Máquina de estados** de `candidates.status` (lista `VALID_STATES` en `server.js`): `POSTULADO` → `PRESELECCIONADO` | `DESCARTADO_TECNICO` (test ≥80% y 2/2 SJT + experiencia mínima) → `APROBADO_FAENA` (RR.HH. aprueba, se emite magic link) → `DOCS_CARGADOS` → `PRE_ACREDITADO` | `EN_REVISION_MANUAL` (cruce OCR Fase 1 vs Cédula/Antecedentes) → `CONTRATADO_FAENA`. Se conservan estados legacy (`Pendiente`, `Aprobado`, `Rechazado`).

**Esquema**: no hay archivos de migración. `initDB()` hace `CREATE TABLE IF NOT EXISTS` y luego listas de `ALTER TABLE ... ADD COLUMN` envueltas en `try {} catch {}` vacíos (idempotencia por error ignorado). Para agregar una columna, añádela a la lista correspondiente (`candidateMigrations`, `positionMigrations`). `ensureSeedData()` sincroniza cargos y banco de preguntas (TECNICA / SJT) en cada arranque.

**Arranque**: tras `initDB()`, `startServer()` recorre todos los candidatos y ejecuta `reprocessCandidateOcr()` sobre registros con nombres inválidos o ruido OCR conocido (auto-reparación). Tenerlo en cuenta al cambiar validadores como `isValidPersonName()`.

## Entornos

- `require("dotenv").config()` carga `.env`; si `DB_HOST` no está definido y existe `.env.production`, carga ese archivo.
- SSL se activa si `DB_SSL=true`, el host contiene `tidbcloud.com`, o `NODE_ENV=production` sin socket `/cloudsql/`. TiDB se detecta por host o `DB_PORT=4000`.
- Producción: Cloud Run (`Dockerfile`, puerto 8080, `trust proxy` activado) + TiDB Cloud Serverless. `AUTO_ID_CACHE = 10` en `candidates` evita saltos grandes de folios en TiDB.
- Rate limits: general `/api/` 300/15min, `/api/ocr/` 30/15min, login 15/15min.
