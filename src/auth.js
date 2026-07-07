'use strict';

const crypto = require('crypto');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db, getSetting, setSetting } = require('./db');

// Prosty magazyn sesji w SQLite (przeżywa restarty, jedna instancja)
class SqliteSessionStore extends session.Store {
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires_at < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = (sess.cookie && sess.cookie.maxAge) || 7 * 24 * 3600 * 1000;
      db.prepare(`INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`)
        .run(sid, JSON.stringify(sess), Date.now() + maxAge);
      cb(null);
    } catch (err) { cb(err); }
  }

  destroy(sid, cb) {
    try {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (err) { cb(err); }
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

setInterval(() => {
  try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); } catch (_) { /* sprzątanie */ }
}, 3600 * 1000).unref();

// SESSION_SECRET z env; gdy brak — generujemy raz i trzymamy w bazie
function sessionSecret() {
  if (config.sessionSecret) return config.sessionSecret;
  let secret = getSetting('session_secret', '');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('session_secret', secret);
  }
  return secret;
}

function sessionMiddleware() {
  return session({
    store: new SqliteSessionStore(),
    secret: sessionSecret(),
    name: 'otter.sid',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 7 * 24 * 3600 * 1000,
    },
  });
}

// Konto administratora z env (tworzone/aktualizowane przy starcie)
function seedAdmin() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (config.adminEmail && config.adminPassword) {
    const hash = bcrypt.hashSync(config.adminPassword, 12);
    db.prepare(`INSERT INTO users (email, password_hash) VALUES (?, ?)
      ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`)
      .run(config.adminEmail.toLowerCase(), hash);
    if (!getSetting('alert_emails', '')) setSetting('alert_emails', config.adminEmail);
  } else if (userCount === 0) {
    console.warn('[auth] UWAGA: brak użytkowników i brak ADMIN_EMAIL/ADMIN_PASSWORD — logowanie będzie niemożliwe.');
  }
}

function verifyLogin(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  // stały koszt porównania także dla nieistniejącego konta (ochrona przed enumeracją)
  const hash = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvaliduBOGUSBOGUSBOGUSBOGUSBOGUS';
  const ok = bcrypt.compareSync(String(password || ''), hash);
  return ok && user ? { id: user.id, email: user.email } : null;
}

// Zwraca false, gdy adres jest już zajęty
function createUser(email, password) {
  const hash = bcrypt.hashSync(password, 12);
  try {
    db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .run(email.toLowerCase(), hash);
    return true;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return false;
    throw err;
  }
}

function changePassword(userId, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Wymagane logowanie' });
  }
  return res.redirect('/login');
}

module.exports = { sessionMiddleware, seedAdmin, verifyLogin, createUser, changePassword, requireAuth };
