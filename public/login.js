'use strict';

const form = document.getElementById('form');
const errBox = document.getElementById('error');
const btn = document.getElementById('btn');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.style.display = 'none';
  btn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { location.href = '/'; return; }
    errBox.textContent = data.error || 'Błąd logowania';
    errBox.style.display = 'block';
  } catch (_) {
    errBox.textContent = 'Brak połączenia z serwerem';
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});
