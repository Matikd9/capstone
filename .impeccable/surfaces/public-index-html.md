---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: ["src/admin_portal/admin.html","src/admin_portal/login.html"]
---

## Scope

Portal postulante (`public/index.html`, `public/style.css`, `public/app.js`) y panel RR.HH. (`src/admin_portal/admin.html`, `login.html`, `public/admin.css`, `public/admin.js`). Mode: Operate. Redesign: replace visual world, keep every ID, flow, endpoint, copy fact and legal reference.

Audience: trabajadores de terreno (50 % celular) y evaluadores RR.HH. en escritorio. Task: postular en 3 fases / auditar por excepción.

## Direction contract

THESIS: La postulación habla el idioma del EPP del trabajador: una banda naranja flúor con franja retrorreflectante plateada marca la fase actual y la única acción que avanza. Rechaza el portal SaaS gris con stepper azul y el look anterior de franja de peligro amarillo-negro.

OWN-WORLD: Barra superior grafito (#1c232d) con logo sobre placa blanca; suelo gris frío claro; superficies blancas con filete 1px; naranja flúor (#ff6a13) solo para fase actual, CTA primario y foco; plata reflectante (#c7ccd2) como franja doble en lo activo; código de casco para estados (verde conforme, rojo descarte, ámbar revisión, azul en curso, blanco/gris pendiente). Archivo + Archivo Narrow en mayúsculas para etiquetas y numerales tabulares. Radio 6px, sin gradientes ni glass.

STORY: El postulante ve de inmediato en qué fase está, qué falta y por qué se le pide cada dato; confirma lo que el OCR leyó y avanza. RR.HH. ve primero lo que requiere acción y abre el expediente sin perder la matriz.

FIRST VIEWPORT: Barra grafito 64px (logo, faena, ayuda). Banda de fases naranja 76px a ancho completo, tres segmentos; el actual lleva doble franja plateada, los siguientes en naranja oscurecido. Debajo, grilla: formulario blanco ancho (título 34px, lead, select de especialidad, dos dropzones) y riel derecho 360px "Qué necesitas" con puntos de estado. CTA naranja con base plateada abajo a la derecha del formulario.

FORM: Alta Visibilidad — chaleco reflectante + código de casco; candidato 5 de 7 de la lista propia. seed:6bbca59800ee2932. Raises: naranja reservado al tramo activo (orienteering); matriz RR.HH. en módulos con filetes finos y densidad (japanese-high-density); cambio de estado repinta la banda de la fila sin mover columnas (split-flap); cada estado es una marca explícita, deshabilitado tachado, foco enmarcado (centre-rail). Signature: la franja reflectante en lo activo, con un barrido de brillo breve al activarse (como faros sobre cinta), respetando reduced-motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
