# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Postulante (trabajador de terreno):** riggers, operadores de camión pluma y soldadores calificados que postulan a paradas de planta y mantenimiento en Codelco División El Teniente. Postulan en igual proporción desde celular y computador. Llegan con su credencial técnica y su CV; si aprueban, vuelven días después por un magic link de correo para cargar Cédula y Certificado de Antecedentes.
- **Evaluador de RR.HH. Nexxo:** personal de selección que audita expedientes en escritorio, revisa por excepción los casos `EN_REVISION_MANUAL`, aprueba cupos de faena (emite magic link), contrasta selfies con cédula y exporta carpetas WebControl.

## Product Purpose

Portal de convocatoria, filtro técnico y pre-acreditación documental de Nexxo S.A. (Grupo Echeverría Izquierdo). Automatiza el reclutamiento operativo: lectura OCR de credencial y CV, mini-test técnico + juicio situacional (SJT) con cámara visible, y cruce OCR/biométrico de documentos de Fase 2. Éxito: un postulante calificado completa su postulación sin ayuda y RR.HH. solo interviene en las excepciones.

## Positioning

Filtro por estándar normativo, no por currículum: la aprobación exige ≥80 % en el test, 2/2 en SJT de Seguridad Crítica (ECF Codelco) y experiencia mínima; los documentos sensibles solo se piden después de que RR.HH. autoriza el cupo (Ley N° 19.628 / Dirección del Trabajo).

## Operating Context

- Flujo postulante: Fase 1 (cargo, credencial, CV, datos autocompletados por OCR, selfie con consentimiento) → Fase 1.5 (5 preguntas, 40 s c/u, cámara visible) → pausa hasta autorización de RR.HH. → Fase 2 por magic link `/?token=...` (Cédula frente/reverso, antecedentes, consentimiento Ley 19.628) → dictamen.
- Flujo RR.HH.: login → matriz de postulantes con filtros por cargo/estado → expediente (modal) con datos OCR, selfies, visor de documentos aislado, cambios de estado, emisión de magic link, exportación WebControl → notificaciones de Fase 2.
- Máquina de estados: POSTULADO, PRESELECCIONADO, DESCARTADO_TECNICO, APROBADO_FAENA, DOCS_CARGADOS, PRE_ACREDITADO, EN_REVISION_MANUAL, CONTRATADO_FAENA (+ legacy).

## Capabilities and Constraints

- Frontend vanilla JS sin bundler (`public/app.js`, `public/admin.js`), sin `import/export`; HTML admin en `src/admin_portal/`.
- No agregar dependencias npm. Backend y API no se modifican para el rediseño.
- JS depende de IDs y de clases (`status-pill status-*`, `ocr-banner-*`, `is-loaded`, `drag-over`, `step-item active/completed`, `option-btn selected`, `badge-code`, `info-grid`, `media-box`, `toast-*`, etc.) y de variables CSS heredadas (`--ecf-emerald`, `--safety-yellow`, `--status-normal-text`, …).
- Datos aún indefinidos en el producto (se muestran como "[Por definir]"): régimen de turno, correo y horario de la mesa de ayuda.

## Brand Commitments

- Logo Nexxo / Echeverría Izquierdo (`public/logo-nexxo.png`) se conserva intacto. Paleta, tipografía y estilo son libres.
- Referencias normativas (Ley N° 19.628, ECF Codelco, DS N° 132, Dirección del Trabajo) deben seguir visibles y sus comentarios legales en código se conservan.
- Idioma: español de Chile, trato de "tú/usted" mixto actual.

## Evidence on Hand

- Logo PNG y favicons en `public/`. No hay fotografía, testimonios ni métricas públicas; no inventarlas.
- Métrica "Gasto hundido evitado (CLP)" del panel RR.HH. se conserva con su cálculo actual.

## Product Principles

1. El postulante siempre sabe en qué fase está, qué se le pide y por qué.
2. La transparencia normativa es parte de la interfaz: consentimiento y cámara nunca ocultos.
3. RR.HH. trabaja por excepción: lo que requiere acción aparece primero.
4. Ninguna funcionalidad o dato se reemplaza por contenido ficticio.

## Accessibility & Inclusion

Usuarios de terreno con distinto nivel de alfabetización digital, en celular con luz variable: contraste alto, objetivos táctiles amplios, textos claros sin jerga técnica innecesaria.
