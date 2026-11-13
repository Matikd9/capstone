/**
 * Módulo de Notificaciones y Enlaces Mágicos de Acreditación (Nexxo S.A. / Codelco)
 * Gestiona la emisión de tokens de acceso criptográficos y despacho de correos para Fase 2.
 * Soporta envío real mediante SMTP (Gmail con Contraseña de Aplicación o SMTP corporativo)
 * y fallback automático a simulador de consola.
 */

const crypto = require("crypto");
const nodemailer = require("nodemailer");

/**
 * Genera un token criptográfico seguro y su fecha de expiración (7 días corridos)
 */
function generateAccessToken(validDays = 7) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);
  return { token, expiresAt };
}

// Enmascara el token del magic link para logs (solo origen + 6 primeros caracteres)
const maskMagicLink = (link) =>
  String(link || "").replace(/token=([^&#]{0,6})[^&#]*/, "token=$1…");

/**
 * Retorna el transporte SMTP configurado o null si no hay credenciales
 */
function getMailTransporter() {
  const isProduction = process.env.NODE_ENV === "production";
  const defaultUser = isProduction ? "REMOVED" : null;
  const defaultPass = isProduction ? "REMOVED" : null;

  const user = process.env.SMTP_USER || defaultUser;
  const pass = process.env.SMTP_PASS || defaultPass;

  if (!user || !pass || user.trim() === "" || pass.trim() === "") {
    return null;
  }

  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = parseInt(process.env.SMTP_PORT || "465", 10);
  const secure = process.env.SMTP_SECURE === "false" ? false : port === 465;

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: user.trim(),
      pass: pass.trim().replace(/\s+/g, ""), // Elimina espacios accidentales en contraseñas de app
    },
  });
}

/* ==========================================================================
   Plantilla HTML de correos — sistema visual "Alta Visibilidad" (DESIGN.md)
   Tablas + estilos en línea para compatibilidad con Gmail/Outlook.
   Naranja flúor solo en la banda de fase y en el botón de acción; franjas
   blancas como cinta reflectante; estados con el código de color de casco.
   ========================================================================== */
const EMAIL = {
  font: "'Archivo', Arial, Helvetica, sans-serif",
  ink: "#1c232d",
  text2: "#4a5562",
  text3: "#626c78",
  ground: "#eef0f2",
  line: "#d5d9de",
  hivis: "#ff6a13",
  stripe: "#ffffff",
  reflect: "#c7ccd2",
  ok: "#1f7a48",
  okTint: "#e7f4ec",
  okLine: "#9fd1b3",
};

function escapeEmailHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getOriginFromLink(link) {
  try {
    return new URL(link).origin;
  } catch {
    return null;
  }
}

function emailParagraph(html, size = 15) {
  return `<p style="margin:0 0 16px 0;font-family:${EMAIL.font};font-size:${size}px;line-height:1.6;color:${EMAIL.text2};">${html}</p>`;
}

function emailStrong(text) {
  return `<strong style="color:${EMAIL.ink};font-weight:700;">${text}</strong>`;
}

function emailStatusPill(label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>
      <td style="background:${EMAIL.okTint};border:1px solid ${EMAIL.okLine};border-radius:4px;padding:6px 10px;font-family:${EMAIL.font};font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:${EMAIL.ok};">
        <span style="display:inline-block;width:8px;height:8px;background:${EMAIL.ok};margin-right:6px;vertical-align:1px;"></span>${label}
      </td></tr></table>`;
}

function emailFacts(rows) {
  const cells = rows
    .map(
      ([label, value], i) => `<tr>
        <td style="padding:12px 0;${i ? `border-top:1px solid ${EMAIL.line};` : ""}">
          <div style="font-family:${EMAIL.font};font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${EMAIL.text3};">${label}</div>
          <div style="font-family:${EMAIL.font};font-size:15px;font-weight:600;line-height:1.4;color:${EMAIL.ink};padding-top:3px;">${value}</div>
        </td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${EMAIL.line};border-bottom:1px solid ${EMAIL.line};margin:8px 0 24px 0;">${cells}</table>`;
}

// Botón "a prueba de clientes": naranja con cinta blanca en su borde inferior.
function emailButton(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:8px 0 16px 0;">
      <tr><td bgcolor="${EMAIL.hivis}" style="background:${EMAIL.hivis};border-radius:6px 6px 0 0;padding:16px 28px 13px 28px;">
        <a href="${href}" target="_blank" style="font-family:${EMAIL.font};font-size:16px;font-weight:800;color:${EMAIL.ink};text-decoration:none;display:inline-block;">${label}&nbsp;&rarr;</a>
      </td></tr>
      <tr><td bgcolor="${EMAIL.stripe}" height="3" style="background:${EMAIL.stripe};height:3px;line-height:3px;font-size:0;">&nbsp;</td></tr>
      <tr><td bgcolor="${EMAIL.hivis}" height="5" style="background:${EMAIL.hivis};height:5px;line-height:5px;font-size:0;border-radius:0 0 6px 6px;">&nbsp;</td></tr>
    </table>`;
}

function renderEmailLayout({
  preheader,
  logoUrl,
  phaseNumber,
  phaseLabel,
  bodyHtml,
  footerHtml,
}) {
  const logo = logoUrl
    ? `<img src="${logoUrl}/logo-nexxo.png" width="96" alt="Nexxo S.A." style="display:block;width:96px;height:auto;border:0;">`
    : `<span style="font-family:${EMAIL.font};font-size:18px;font-weight:800;letter-spacing:0.02em;color:#143c6b;">NEXXO</span>`;
  const stripeRow = (h, color) =>
    `<tr><td bgcolor="${color}" height="${h}" style="background:${color};height:${h}px;line-height:${h}px;font-size:0;">&nbsp;</td></tr>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light">
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700;800&display=swap" rel="stylesheet">
  <title>Nexxo S.A.</title>
</head>
<body style="margin:0;padding:0;background:${EMAIL.ground};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${EMAIL.ground}" style="background:${EMAIL.ground};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;">
        <tr><td bgcolor="${EMAIL.ink}" style="background:${EMAIL.ink};padding:16px 24px;border-radius:10px 10px 0 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="width:1%;white-space:nowrap;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:4px;padding:6px 10px;">${logo}</td></tr></table></td>
            <td align="right" style="font-family:${EMAIL.font};font-size:13px;color:${EMAIL.reflect};padding-left:16px;">División El Teniente · Codelco Chile</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
            ${stripeRow(5, EMAIL.hivis)}${stripeRow(3, EMAIL.stripe)}
            <tr><td bgcolor="${EMAIL.hivis}" style="background:${EMAIL.hivis};padding:8px 24px;font-family:${EMAIL.font};color:${EMAIL.ink};">
              <span style="font-size:26px;font-weight:800;vertical-align:middle;">${phaseNumber}</span>
              <span style="font-size:13px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;vertical-align:middle;padding-left:10px;">${phaseLabel}</span>
            </td></tr>
            ${stripeRow(3, EMAIL.stripe)}${stripeRow(5, EMAIL.hivis)}
          </table>
        </td></tr>
        <tr><td bgcolor="#ffffff" style="background:#ffffff;padding:32px 32px 16px 32px;border-left:1px solid ${EMAIL.line};border-right:1px solid ${EMAIL.line};">
          ${bodyHtml}
        </td></tr>
        <tr><td bgcolor="${EMAIL.ink}" style="background:${EMAIL.ink};padding:20px 32px;border-radius:0 0 10px 10px;font-family:${EMAIL.font};font-size:12px;line-height:1.6;color:${EMAIL.reflect};">
          ${footerHtml}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Despacha el correo de invitación a Fase 2 (Validación Documental)
 * Envía correo real si SMTP_USER y SMTP_PASS están en .env; de lo contrario simula en consola.
 */
async function sendPhase2InvitationEmail({
  email,
  full_name,
  position_name,
  magic_link,
  expires_at,
}) {
  const candidateEmail = email || "postulante@nexxo.cl";
  const candidateName = full_name || "Postulante";
  const roleName = position_name || "Especialidad Operativa";
  const formattedDate =
    expires_at instanceof Date
      ? expires_at.toLocaleDateString("es-CL")
      : "7 días";

  const safeName = escapeEmailHtml(candidateName);
  const safeRole = escapeEmailHtml(roleName);
  const safeLink = escapeEmailHtml(magic_link);

  const htmlContent = renderEmailLayout({
    preheader: `Su evaluación técnica para ${safeRole} fue aprobada. Cargue su documentación de Fase 2.`,
    logoUrl: getOriginFromLink(magic_link),
    phaseNumber: "2",
    phaseLabel: "Acreditación · Validación documental",
    bodyHtml: `
      ${emailStatusPill("Acceso a faena aprobado")}
      <h1 style="margin:16px 0 20px 0;font-family:${EMAIL.font};font-size:24px;line-height:1.2;font-weight:800;color:${EMAIL.ink};">Nexxo S.A. — División El Teniente (Codelco)</h1>
      ${emailParagraph(`Estimado/a ${emailStrong(safeName)},`)}
      ${emailParagraph(`Le informamos que su evaluación técnica para el cargo de ${emailStrong(safeRole)} ha sido ${emailStrong("APROBADA")} por el equipo de Reclutamiento y Acreditación de Nexxo S.A.`)}
      ${emailParagraph(`Ha sido seleccionado para ingresar a la dotación de parada de planta. Para conformar su ${emailStrong("Carpeta de Acreditación WebControl Codelco")}, debe ingresar al siguiente enlace exclusivo para cargar su ${emailStrong("Cédula de Identidad")} y ${emailStrong("Certificado de Antecedentes para Fines Especiales")}:`)}
      ${emailButton(safeLink, "Ingresar a Fase 2: validación documental")}
      ${emailParagraph(`O copie y pegue esta URL en su navegador:<br><a href="${safeLink}" style="color:${EMAIL.ink};font-weight:600;text-decoration:underline;word-break:break-all;">${safeLink}</a>`, 13)}
      ${emailFacts([
        [
          "Vigencia del enlace",
          `7 días corridos · vence el ${escapeEmailHtml(formattedDate)}`,
        ],
        ["Uso", "Personal e intransferible"],
      ])}
    `,
    footerHtml: `Nexxo S.A. | Sistema de Acreditación Industrial &amp; Control de Acceso Codelco DS N° 132.<br>
      En cumplimiento de la Ley N° 19.628, sus antecedentes penales solo son solicitados al contar con aprobación formal de cupo de faena.`,
  });

  // Intento de envío SMTP real si hay configuración
  const transporter = getMailTransporter();
  if (transporter) {
    try {
      const senderUser =
        process.env.SMTP_USER ||
        (process.env.NODE_ENV === "production"
          ? "REMOVED"
          : "");
      const fromAddress =
        process.env.SMTP_FROM || `"Nexxo S.A. Acreditaciones" <${senderUser}>`;
      const mailOptions = {
        from: fromAddress,
        to: candidateEmail,
        subject: `[NEXXO S.A.] Aprobación de Acceso a Faena - Convocatoria El Teniente (${roleName})`,
        html: htmlContent,
      };

      const info = await transporter.sendMail(mailOptions);
      console.log(
        `\n[MAILER/SMTP] Correo real enviado exitosamente a ${candidateEmail}. ID: ${info.messageId}`,
      );
      return {
        success: true,
        sent: true,
        simulated: false,
        messageId: info.messageId,
        recipient: candidateEmail,
        magic_link,
        expires_at,
      };
    } catch (err) {
      console.error(
        `\n[MAILER/SMTP ERROR] Error enviando correo real a ${candidateEmail}:`,
        err.message,
      );
    }
  }

  // Fallback a Simulador de Consola
  console.log("\n" + "=".repeat(82));
  console.log(" [SIMULADOR DE EMAIL - NOTIFICACIÓN DE APROBACIÓN DE FAENA]");
  console.log(` Para:      ${candidateEmail} (${candidateName})`);
  console.log(` Cargo:     ${roleName}`);
  console.log(
    ` Asunto:    [NEXXO S.A.] Aprobación de Acceso a Faena - Convocatoria El Teniente`,
  );
  console.log(` Enlace:    ${maskMagicLink(magic_link)}`);
  console.log(` Expiración: ${formattedDate}`);
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(
      " AVISO:     Para recepción real en bandeja, configure SMTP_USER y SMTP_PASS en .env",
    );
  }
  console.log("=".repeat(82) + "\n");

  return {
    success: true,
    sent: false,
    simulated: true,
    recipient: candidateEmail,
    magic_link,
    expires_at,
    note: "Configure SMTP_USER y SMTP_PASS en .env para entrega real a la bandeja",
  };
}

/**
 * Despacha el correo de confirmación de contratación (Asignar a Parada / Contratado Faena)
 */
async function sendHiredConfirmationEmail({ email, full_name, position_name }) {
  const candidateEmail = email || "postulante@nexxo.cl";
  const candidateName = full_name || "Postulante";
  const roleName = position_name || "Especialidad Operativa";

  const safeName = escapeEmailHtml(candidateName);
  const safeRole = escapeEmailHtml(roleName);
  const nextSteps = [
    "Inducción de Seguridad en Faena (Obligación de Informar - ODI).",
    "Examen Ocupacional / Batería de Altura Geográfica y ECF.",
    "Programación de turno y entrega de Equipo de Protección Personal (EPP).",
  ]
    .map(
      (step) =>
        `<li style="margin:0 0 8px 0;font-family:${EMAIL.font};font-size:15px;line-height:1.5;color:${EMAIL.text2};">${step}</li>`,
    )
    .join("");

  const htmlContent = renderEmailLayout({
    preheader: `Su acreditación para ${safeRole} fue aprobada y quedó asignado a la parada de planta.`,
    logoUrl: null,
    phaseNumber: "&#10003;",
    phaseLabel: "Asignado a parada de planta",
    bodyHtml: `
      ${emailStatusPill("Acreditación aprobada · Asignado a parada")}
      <h1 style="margin:16px 0 20px 0;font-family:${EMAIL.font};font-size:24px;line-height:1.2;font-weight:800;color:${EMAIL.ink};">Nexxo S.A. — División El Teniente (Codelco)</h1>
      ${emailParagraph(`Estimado/a ${emailStrong(safeName)},`)}
      ${emailParagraph(`Le informamos que su expediente documental y acreditación técnica para el cargo de ${emailStrong(safeRole)} han sido ${emailStrong("APROBADOS")} por el Departamento de Selección y Recursos Humanos de Nexxo S.A.`)}
      ${emailFacts([
        [
          "Estado",
          `<span style="color:${EMAIL.ok};">Acreditación conforme y confirmada</span>`,
        ],
        ["Faena", "Codelco División El Teniente (Rancagua)"],
        ["Pase de acceso", "Carpeta WebControl en tramitación reglamentaria"],
      ])}
      ${emailParagraph("Su incorporación a la dotación operativa de parada de planta se encuentra formalizada. Durante las próximas horas, el equipo de Operaciones de Nexxo S.A. se comunicará con usted vía telefónica o correo para coordinar:")}
      <ol style="margin:0 0 16px 0;padding-left:22px;">${nextSteps}</ol>
    `,
    footerHtml: `Nexxo S.A. | División Operaciones &amp; Mantenimiento Minero.<br>
      Plataforma de Acreditación conforme a Estándares ECF Codelco y Reglamento de Seguridad Minera DS N° 132.`,
  });

  const transporter = getMailTransporter();
  if (transporter) {
    try {
      const senderUser =
        process.env.SMTP_USER ||
        (process.env.NODE_ENV === "production"
          ? "REMOVED"
          : "");
      const fromAddress =
        process.env.SMTP_FROM || `"Nexxo S.A. Acreditaciones" <${senderUser}>`;
      const mailOptions = {
        from: fromAddress,
        to: candidateEmail,
        subject: `[NEXXO S.A.] Acreditación Aprobada — Convocatoria Parada de Planta El Teniente (${roleName})`,
        html: htmlContent,
      };

      const info = await transporter.sendMail(mailOptions);
      console.log(
        `\n[MAILER/SMTP] Notificación de contratación enviada exitosamente a ${candidateEmail}. ID: ${info.messageId}`,
      );
      return {
        success: true,
        sent: true,
        simulated: false,
        messageId: info.messageId,
        recipient: candidateEmail,
      };
    } catch (err) {
      console.error(
        `\n[MAILER/SMTP ERROR] Error enviando correo de contratación a ${candidateEmail}:`,
        err.message,
      );
    }
  }

  // Fallback a Simulador de Consola
  console.log("\n" + "=".repeat(82));
  console.log(
    " [SIMULADOR DE EMAIL - NOTIFICACIÓN DE CONTRATACIÓN // ASIGNADO A PARADA]",
  );
  console.log(` Para:   ${candidateEmail} (${candidateName})`);
  console.log(` Cargo:  ${roleName}`);
  console.log(
    ` Asunto: [NEXXO S.A.] Acreditación Aprobada — Convocatoria Parada de Planta El Teniente`,
  );
  console.log(` Estado: Acreditación aprobada y cupo asignado en faena`);
  console.log("=".repeat(82) + "\n");

  return {
    success: true,
    sent: false,
    simulated: true,
    recipient: candidateEmail,
  };
}

module.exports = {
  generateAccessToken,
  sendPhase2InvitationEmail,
  sendHiredConfirmationEmail,
};
