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

/**
 * Retorna el transporte SMTP configurado o null si no hay credenciales
 */
function getMailTransporter() {
  const isProduction = process.env.NODE_ENV === "production";
  const defaultUser = isProduction ? "matiasmedina278@gmail.com" : null;
  const defaultPass = isProduction ? "ebqo gdin oaaf idda" : null;

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

  const htmlContent = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif; background-color: #F8FAFC; color: #526173; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; background: #FFFFFF; border: 1px solid #DDE3EA; border-top: 4px solid #0F2942; border-radius: 8px; box-shadow: 0 4px 12px rgba(15, 41, 66, 0.05); padding: 32px; }
    .accent-line { height: 3px; background-color: #F5A623; margin-bottom: 20px; border-radius: 2px; }
    .header { border-bottom: 1px solid #DDE3EA; padding-bottom: 20px; margin-bottom: 24px; }
    .badge { display: inline-block; background-color: #ECFDF5; color: #059669; border: 1px solid #A7F3D0; padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: 4px; }
    h1 { font-size: 18px; margin: 12px 0 0 0; color: #0F2942; font-weight: 700; letter-spacing: 0.02em; }
    p { font-size: 14px; line-height: 1.6; color: #526173; margin: 12px 0; }
    .highlight { color: #0F2942; font-weight: 700; }
    .action-box { background-color: #F8FAFC; border: 1px solid #DDE3EA; border-radius: 6px; padding: 24px; text-align: center; margin: 24px 0; }
    .btn { display: inline-block; background-color: #0F2942; color: #FFFFFF !important; border: none; border-radius: 8px; font-weight: 600; padding: 14px 28px; text-decoration: none; font-size: 14px; }
    .btn:hover { background-color: #1A3E61; }
    .link-alt { font-size: 12px; word-break: break-all; color: #526173; margin-top: 16px; }
    .footer { border-top: 1px solid #DDE3EA; padding-top: 16px; margin-top: 24px; font-size: 11px; color: #526173; line-height: 1.5; }
  </style>
</head>
<body style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif; background-color: #F8FAFC; color: #526173; margin: 0; padding: 24px;">
  <div class="container" style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border: 1px solid #DDE3EA; border-top: 4px solid #0F2942; border-radius: 8px; box-shadow: 0 4px 12px rgba(15, 41, 66, 0.05); padding: 32px;">
    <div class="accent-line" style="height: 3px; background-color: #F5A623; margin-bottom: 20px; border-radius: 2px;"></div>
    <div class="header" style="border-bottom: 1px solid #DDE3EA; padding-bottom: 20px; margin-bottom: 24px;">
      <span class="badge" style="display: inline-block; background-color: #ECFDF5; color: #059669; border: 1px solid #A7F3D0; padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: 4px;">ACCESO A FAENA APROBADO</span>
      <h1 style="font-size: 18px; margin: 12px 0 0 0; color: #0F2942; font-weight: 700; letter-spacing: 0.02em;">Nexxo S.A. — División El Teniente (Codelco)</h1>
    </div>

    <p style="font-size: 14px; line-height: 1.6; color: #526173; margin: 12px 0;">Estimado/a <strong style="color: #0F2942;">${candidateName}</strong>,</p>
    <p style="font-size: 14px; line-height: 1.6; color: #526173; margin: 12px 0;">Le informamos que su evaluación técnica para el cargo de <span class="highlight" style="color: #0F2942; font-weight: 700;">${roleName}</span> ha sido <strong style="color: #0F2942;">APROBADA</strong> por el equipo de Reclutamiento y Acreditación de Nexxo S.A.</p>
    
    <p style="font-size: 14px; line-height: 1.6; color: #526173; margin: 12px 0;">Ha sido seleccionado para ingresar a la dotación de parada de planta. Para conformar su <strong style="color: #0F2942;">Carpeta de Acreditación WebControl Codelco</strong>, debe ingresar al siguiente enlace exclusivo para cargar su <strong style="color: #0F2942;">Cédula de Identidad</strong> y <strong style="color: #0F2942;">Certificado de Antecedentes para Fines Especiales</strong>:</p>

    <div class="action-box" style="background-color: #F8FAFC; border: 1px solid #DDE3EA; border-radius: 6px; padding: 24px; text-align: center; margin: 24px 0;">
      <a href="${magic_link}" class="btn" target="_blank" style="display: inline-block; background-color: #0F2942; color: #FFFFFF !important; border: none; border-radius: 8px; font-weight: 600; padding: 14px 28px; text-decoration: none; font-size: 14px;">INGRESAR A FASE 02: VALIDACIÓN DOCUMENTAL</a>
      <div class="link-alt" style="font-size: 12px; word-break: break-all; color: #526173; margin-top: 16px;">
        O copie y pegue esta URL en su navegador:<br>
        <a href="${magic_link}" style="color: #0F2942; font-weight: 600; text-decoration: underline;">${magic_link}</a>
      </div>
    </div>

    <p style="font-size: 12px; color: #526173; margin: 12px 0;">
      <strong style="color: #0F2942;">Vigencia del enlace:</strong> Este enlace de acceso directo es personal e intransferible y tiene una validez de 7 días corridos (vence el <strong style="color: #0F2942;">${formattedDate}</strong>).
    </p>

    <div class="footer" style="border-top: 1px solid #DDE3EA; padding-top: 16px; margin-top: 24px; font-size: 11px; color: #526173; line-height: 1.5;">
      Nexxo S.A. | Sistema de Acreditación Industrial & Control de Acceso Codelco DS N° 132.<br>
      En cumplimiento de la Ley N° 19.628, sus antecedentes penales solo son solicitados al contar con aprobación formal de cupo de faena.
    </div>
  </div>
</body>
</html>
  `;

  // Intento de envío SMTP real si hay configuración
  const transporter = getMailTransporter();
  if (transporter) {
    try {
      const senderUser =
        process.env.SMTP_USER ||
        (process.env.NODE_ENV === "production"
          ? "matiasmedina278@gmail.com"
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
  console.log(` Enlace:    ${magic_link}`);
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

  const htmlContent = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif; background-color: #F8FAFC; color: #526173; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; background: #FFFFFF; border: 1px solid #DDE3EA; border-top: 4px solid #0F2942; border-radius: 8px; box-shadow: 0 4px 12px rgba(15, 41, 66, 0.05); padding: 32px; }
    .accent-line { height: 3px; background-color: #F5A623; margin-bottom: 20px; border-radius: 2px; }
    .header { border-bottom: 1px solid #DDE3EA; padding-bottom: 20px; margin-bottom: 24px; }
    .badge { display: inline-block; background-color: #ECFDF5; color: #059669; border: 1px solid #A7F3D0; padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: 4px; }
    h1 { font-size: 18px; margin: 12px 0 0 0; color: #0F2942; font-weight: 700; letter-spacing: 0.02em; }
    p { font-size: 14px; line-height: 1.6; color: #526173; margin: 12px 0; }
    .highlight { color: #0F2942; font-weight: 700; }
    .info-box { background-color: #F8FAFC; border: 1px solid #DDE3EA; border-radius: 6px; padding: 16px; margin: 20px 0; }
    .info-item { font-size: 13px; color: #526173; margin-bottom: 8px; }
    .info-label { color: #526173; font-size: 12px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em; }
    .footer { border-top: 1px solid #DDE3EA; padding-top: 16px; margin-top: 24px; font-size: 11px; color: #526173; line-height: 1.5; }
  </style>
</head>
<body style="font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif; background-color: #F8FAFC; color: #526173; margin: 0; padding: 24px;">
  <div class="container" style="max-width: 600px; margin: 0 auto; background: #FFFFFF; border: 1px solid #DDE3EA; border-top: 4px solid #0F2942; border-radius: 8px; box-shadow: 0 4px 12px rgba(15, 41, 66, 0.05); padding: 32px;">
    <div class="accent-line" style="height: 3px; background-color: #F5A623; margin-bottom: 20px; border-radius: 2px;"></div>
    <div class="header" style="border-bottom: 1px solid #DDE3EA; padding-bottom: 20px; margin-bottom: 24px;">
      <span class="badge" style="display: inline-block; background-color: #ECFDF5; color: #059669; border: 1px solid #A7F3D0; padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: 4px;">ACREDITACIÓN APROBADA // ASIGNADO A PARADA</span>
      <h1 style="font-size: 18px; margin: 12px 0 0 0; color: #0F2942; font-weight: 700; letter-spacing: 0.02em;">Nexxo S.A. — División El Teniente (Codelco)</h1>
    </div>

    <p style="font-size: 14px; line-height: 1.6; color: #526173; margin: 12px 0;">Estimado/a <strong style="color: #0F2942;">${candidateName}</strong>,</p>
    <p style="font-size: 14px; line-height: 1.6; color: #526173; margin: 12px 0;">Le informamos que su expediente documental y acreditación técnica para el cargo de <span class="highlight" style="color: #0F2942; font-weight: 700;">${roleName}</span> han sido <strong style="color: #0F2942;">APROBADOS</strong> por el Departamento de Selección y Recursos Humanos de Nexxo S.A.</p>
    
    <div class="info-box" style="background-color: #F8FAFC; border: 1px solid #DDE3EA; border-radius: 6px; padding: 16px; margin: 20px 0;">
      <div class="info-item" style="font-size: 13px; color: #526173; margin-bottom: 8px;">
        <span class="info-label" style="color: #526173; font-size: 12px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em;">Estado:</span>
        <span class="badge" style="display: inline-block; background-color: #ECFDF5; color: #059669; border: 1px solid #A7F3D0; padding: 4px 8px; font-size: 12px; font-weight: 600; border-radius: 4px; margin-left: 6px;">Acreditación Conforme y Confirmada</span>
      </div>
      <div class="info-item" style="font-size: 13px; color: #526173; margin-bottom: 8px;">
        <span class="info-label" style="color: #526173; font-size: 12px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em;">Faena:</span>
        <strong style="color: #0F2942; margin-left: 6px;">Codelco División El Teniente (Rancagua)</strong>
      </div>
      <div class="info-item" style="font-size: 13px; color: #526173; margin-bottom: 0;">
        <span class="info-label" style="color: #526173; font-size: 12px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em;">Pase de Acceso:</span>
        <span style="color: #0F2942; margin-left: 6px;">Carpeta WebControl en tramitación reglamentaria</span>
      </div>
    </div>

    <p style="font-size: 14px; line-height: 1.6; color: #526173; margin: 12px 0;">
      Su incorporación a la dotación operativa de parada de planta se encuentra formalizada. Durante las próximas horas, el equipo de Operaciones de Nexxo S.A. se comunicará con usted vía telefónica o correo para coordinar:
    </p>
    <ul style="font-size: 13px; color: #526173; line-height: 1.8; padding-left: 20px; margin: 12px 0;">
      <li>Inducción de Seguridad en Faena (Obligación de Informar - ODI).</li>
      <li>Examen Ocupacional / Batería de Altura Geográfica y ECF.</li>
      <li>Programación de turno y entrega de Equipo de Protección Personal (EPP).</li>
    </ul>

    <div class="footer" style="border-top: 1px solid #DDE3EA; padding-top: 16px; margin-top: 24px; font-size: 11px; color: #526173; line-height: 1.5;">
      Nexxo S.A. | División Operaciones & Mantenimiento Minero.<br>
      Plataforma de Acreditación conforme a Estándares ECF Codelco y Reglamento de Seguridad Minera DS N° 132.
    </div>
  </div>
</body>
</html>
  `;

  const transporter = getMailTransporter();
  if (transporter) {
    try {
      const senderUser =
        process.env.SMTP_USER ||
        (process.env.NODE_ENV === "production"
          ? "matiasmedina278@gmail.com"
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
