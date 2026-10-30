/**
 * Módulo de Notificaciones y Enlaces Mágicos de Acreditación (Nexxo S.A. / Codelco)
 * Gestiona la emisión de tokens de acceso criptográficos y despacho de correos para Fase 2.
 * Soporta envío real mediante SMTP (Gmail con Contraseña de Aplicación o SMTP corporativo)
 * y fallback automático a simulador de consola.
 */

const crypto = require('crypto');
const nodemailer = require('nodemailer');

/**
 * Genera un token criptográfico seguro y su fecha de expiración (7 días corridos)
 */
function generateAccessToken(validDays = 7) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);
  return { token, expiresAt };
}

/**
 * Retorna el transporte SMTP configurado o null si no hay credenciales
 */
function getMailTransporter() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass || user.trim() === '' || pass.trim() === '') {
    return null;
  }

  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const secure = process.env.SMTP_SECURE === 'false' ? false : (port === 465);

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: user.trim(),
      pass: pass.trim().replace(/\s+/g, '') // Elimina espacios accidentales en contraseñas de app
    }
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
  expires_at
}) {
  const candidateEmail = email || 'postulante@nexxo.cl';
  const candidateName = full_name || 'Postulante';
  const roleName = position_name || 'Especialidad Operativa';
  const formattedDate = expires_at instanceof Date ? expires_at.toLocaleDateString('es-CL') : '7 días';

  const htmlContent = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; background-color: #0F1115; color: #F3F4F6; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #14171E; border: 1px solid #262930; border-top: 4px solid #FFB800; border-radius: 4px; padding: 30px; }
    .header { border-bottom: 1px solid #262930; padding-bottom: 15px; margin-bottom: 20px; }
    .badge { display: inline-block; background: rgba(16, 185, 129, 0.15); color: #10B981; border: 1px solid #10B981; padding: 4px 10px; font-family: monospace; font-size: 12px; font-weight: bold; border-radius: 2px; }
    h1 { font-size: 18px; margin: 15px 0 5px 0; color: #F3F4F6; letter-spacing: 0.05em; text-transform: uppercase; }
    p { font-size: 14px; line-height: 1.6; color: #9CA3AF; margin: 12px 0; }
    .highlight { color: #FFB800; font-weight: bold; }
    .action-box { background: #181C24; border: 1px dashed #FFB800; padding: 20px; text-align: center; margin: 25px 0; border-radius: 2px; }
    .btn { display: inline-block; background: #F95738; color: #FFFFFF !important; text-decoration: none; padding: 12px 24px; font-weight: bold; font-family: monospace; font-size: 14px; border-radius: 2px; letter-spacing: 0.05em; }
    .btn:hover { background: #E0482B; }
    .link-alt { font-size: 11px; word-break: break-all; color: #6B7280; margin-top: 15px; font-family: monospace; }
    .footer { border-top: 1px solid #262930; padding-top: 15px; margin-top: 25px; font-size: 11px; color: #6B7280; font-family: monospace; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="badge">[ACCESO A FAENA APROBADO]</span>
      <h1>Nexxo S.A. — División El Teniente (Codelco)</h1>
    </div>

    <p>Estimado/a <strong style="color:#F3F4F6;">${candidateName}</strong>,</p>
    <p>Le informamos que su evaluación técnica para el cargo de <span class="highlight">${roleName}</span> ha sido <strong>APROBADA</strong> por el equipo de Reclutamiento y Acreditación de Nexxo S.A.</p>
    
    <p>Ha sido seleccionado para ingresar a la dotación de parada de planta. Para conformar su <strong>Carpeta de Acreditación WebControl Codelco</strong>, debe ingresar al siguiente enlace exclusivo para cargar su <strong>Cédula de Identidad</strong> y <strong>Certificado de Antecedentes para Fines Especiales</strong>:</p>

    <div class="action-box">
      <a href="${magic_link}" class="btn" target="_blank">[ INGRESAR A FASE 02: VALIDACIÓN DOCUMENTAL ]</a>
      <div class="link-alt">
        O copie y pegue esta URL en su navegador:<br>
        <a href="${magic_link}" style="color: #FFB800;">${magic_link}</a>
      </div>
    </div>

    <p style="font-size: 12px; color: #9CA3AF;">
      <strong>Vigencia del enlace:</strong> Este enlace de acceso directo es personal e intransferible y tiene una validez de 7 días corridos (vence el <strong>${formattedDate}</strong>).
    </p>

    <div class="footer">
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
      const fromAddress = process.env.SMTP_FROM || `"Nexxo S.A. Acreditaciones" <${process.env.SMTP_USER}>`;
      const mailOptions = {
        from: fromAddress,
        to: candidateEmail,
        subject: `[NEXXO S.A.] Aprobación de Acceso a Faena - Convocatoria El Teniente (${roleName})`,
        html: htmlContent
      };

      const info = await transporter.sendMail(mailOptions);
      console.log(`\n[MAILER/SMTP] Correo real enviado exitosamente a ${candidateEmail}. ID: ${info.messageId}`);
      return {
        success: true,
        sent: true,
        simulated: false,
        messageId: info.messageId,
        recipient: candidateEmail,
        magic_link,
        expires_at
      };
    } catch (err) {
      console.error(`\n[MAILER/SMTP ERROR] Error enviando correo real a ${candidateEmail}:`, err.message);
    }
  }

  // Fallback a Simulador de Consola
  console.log('\n' + '='.repeat(82));
  console.log(' [SIMULADOR DE EMAIL - NOTIFICACIÓN DE APROBACIÓN DE FAENA]');
  console.log(` Para:      ${candidateEmail} (${candidateName})`);
  console.log(` Cargo:     ${roleName}`);
  console.log(` Asunto:    [NEXXO S.A.] Aprobación de Acceso a Faena - Convocatoria El Teniente`);
  console.log(` Enlace:    ${magic_link}`);
  console.log(` Expiración: ${formattedDate}`);
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(' AVISO:     Para recepción real en bandeja, configure SMTP_USER y SMTP_PASS en .env');
  }
  console.log('='.repeat(82) + '\n');

  return {
    success: true,
    sent: false,
    simulated: true,
    recipient: candidateEmail,
    magic_link,
    expires_at,
    note: 'Configure SMTP_USER y SMTP_PASS en .env para entrega real a la bandeja'
  };
}

module.exports = {
  generateAccessToken,
  sendPhase2InvitationEmail
};
