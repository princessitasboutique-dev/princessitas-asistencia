// Cliente mínimo de la API. El PIN de admin se guarda solo en sessionStorage
// (se pierde al cerrar la pestaña) y se envía en el encabezado x-admin-pin.
export function getPin() {
  return sessionStorage.getItem('princessitas_admin_pin') || '';
}
export function setPin(pin) {
  if (pin) sessionStorage.setItem('princessitas_admin_pin', pin);
  else sessionStorage.removeItem('princessitas_admin_pin');
}

export async function api(path, { method = 'GET', body, pin, text = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const p = pin || getPin();
  if (p) headers['x-admin-pin'] = p;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (text) {
    const t = await res.text();
    if (!res.ok) throw new Error(t || `Error ${res.status}`);
    return t;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Error ${res.status}`);
  }
  return data;
}
