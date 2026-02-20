/**
 * Email service using nodemailer.
 * Configure SMTP in .env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM).
 * If not configured, sendMail is a no-op and returns { sent: false }.
 */

let transporter = null;

function getTransporter() {
  if (transporter !== null) return transporter;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    return null;
  }
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  } catch (err) {
    console.warn('Email: nodemailer not configured or error:', err.message);
    return null;
  }
  return transporter;
}

/**
 * Send an email.
 * @param {Object} options - { to, subject, text, html }
 * @returns {Promise<{ sent: boolean, messageId?: string, error?: string }>}
 */
async function sendMail(options) {
  const trans = getTransporter();
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@afrikad.com';
  if (!trans) {
    if (process.env.NODE_ENV !== 'production') {
      console.info('Email (no SMTP):', { to: options.to, subject: options.subject });
    }
    return { sent: false };
  }
  try {
    const info = await trans.sendMail({
      from,
      to: options.to,
      subject: options.subject,
      text: options.text || (options.html ? options.html.replace(/<[^>]*>/g, '') : ''),
      html: options.html,
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error('Email send error:', err);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendMail, getTransporter };
