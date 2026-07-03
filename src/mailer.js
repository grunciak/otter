'use strict';

const nodemailer = require('nodemailer');
const config = require('./config');
const { getSetting } = require('./db');

function transporter() {
  if (!config.smtp.host) return null;
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

function recipients() {
  const raw = getSetting('alert_emails', config.adminEmail || '');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// kind: 'alert' (czerwony) | 'ok' (zielony) | 'info'
function renderHtml({ kind, title, lines }) {
  const colors = { alert: '#dc2626', ok: '#16a34a', info: '#2563eb' };
  const badge = { alert: 'ALERT', ok: 'OK', info: 'INFO' };
  const color = colors[kind] || colors.info;
  const items = lines.map(([k, v]) =>
    `<tr><td style="padding:6px 12px;color:#64748b;font-size:13px;white-space:nowrap">${esc(k)}</td>
     <td style="padding:6px 12px;color:#0f172a;font-size:13px;font-weight:600">${esc(v)}</td></tr>`).join('');
  const link = config.appUrl
    ? `<p style="margin:20px 0 0"><a href="${esc(config.appUrl)}" style="background:${color};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;display:inline-block">Otwórz panel</a></p>`
    : '';
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f1f5f9;padding:32px 16px">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:${color};padding:18px 24px">
        <span style="background:rgba(255,255,255,.2);color:#fff;font-size:11px;font-weight:700;letter-spacing:1px;padding:4px 10px;border-radius:99px">${badge[kind] || 'INFO'}</span>
        <h1 style="color:#fff;font-size:18px;margin:10px 0 0">${esc(title)}</h1>
      </div>
      <div style="padding:20px 12px">
        <table style="border-collapse:collapse;width:100%">${items}</table>
        ${link ? `<div style="padding:0 12px">${link}</div>` : ''}
      </div>
      <div style="padding:14px 24px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
        Otter Monitor &middot; automatyczne powiadomienie
      </div>
    </div>
  </div>`;
}

// Zwraca { sent: bool, error: string|null }
async function sendAlertEmail({ kind, subject, title, lines }) {
  const t = transporter();
  const to = recipients();
  if (!t) return { sent: false, error: 'SMTP nie jest skonfigurowany (SMTP_HOST)' };
  if (to.length === 0) return { sent: false, error: 'Brak adresatów alertów' };
  try {
    await t.sendMail({
      from: config.smtp.from,
      to: to.join(', '),
      subject,
      text: `${title}\n\n${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}${config.appUrl ? `\n\nPanel: ${config.appUrl}` : ''}`,
      html: renderHtml({ kind, title, lines }),
    });
    return { sent: true, error: null };
  } catch (err) {
    console.error('[mailer] błąd wysyłki:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendAlertEmail, recipients };
