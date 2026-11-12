// test/smoke.mjs — prueba de humo sin base real.
// Levanta la app Express con pg-mem (PostgreSQL en memoria), ejecuta el
// seed y prueba los endpoints principales. No toca ningún dato real.
// Uso: npm test
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { newDb } = require('pg-mem');
const { createApp } = require('../src/app.js');
const { ensureSchema, seed } = require('../db/seed.js');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name} ${extra}`); }
}

async function main() {
  console.log('Smoke test — Princessitas app (pg-mem, sin base real)');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  await ensureSchema(pool);
  await seed(pool);

  const app = createApp(pool);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const PIN = '1234';

  async function req(path, opts = {}) {
    const res = await fetch(base + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* texto plano (report-text) */ }
    return { status: res.status, json, text };
  }

  try {
    // 1. Salud
    let r = await req('/api/health');
    check('GET /api/health -> {ok:true}', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));

    // 2. Tablero: 3 sucursales, 5 empleadas, sin vacaciones ni historial
    r = await req('/api/board');
    check('GET /api/board -> 3 sucursales', r.json?.branches?.length === 3, `branches=${r.json?.branches?.length}`);
    check('GET /api/board -> 5 empleadas activas', r.json?.employees?.length === 5, `employees=${r.json?.employees?.length}`);
    check('GET /api/board no expone vacaciones ni historial', !('vacations' in (r.json || {})) && !('attendanceHistory' in (r.json || {})));
    const names = (r.json?.employees || []).map((e) => e.name).sort();
    check('Tablero incluye a las 5 empleadas semilla', names.join('|') === ['Carolina Parra', 'Isela Martínez', 'Marlene Villavicencio', 'Natalia Ponce', 'Yesenia Paredes'].sort().join('|'), names.join(', '));
    const empId = r.json.employees[0].id;

    // 3. Check-in
    r = await req('/api/checkin', { method: 'POST', body: { employeeId: empId } });
    check('POST /api/checkin -> 200 y status a tiempo/tarde', r.status === 200 && ['on_time', 'late'].includes(r.json?.status), JSON.stringify(r.json));
    check('POST /api/checkin -> lateMinutes es número', typeof r.json?.lateMinutes === 'number', JSON.stringify(r.json));
    const firstId = r.json?.record?.id;

    // 4. Segundo check-in: devuelve el existente sin duplicar
    r = await req('/api/checkin', { method: 'POST', body: { employeeId: empId } });
    check('Segundo check-in -> alreadyExists y mismo registro', r.json?.alreadyExists === true && r.json?.record?.id === firstId, JSON.stringify(r.json));

    // 5. Check-out
    r = await req('/api/checkout', { method: 'POST', body: { employeeId: empId } });
    check('POST /api/checkout -> registra salida', r.status === 200 && !!r.json?.record?.check_out, JSON.stringify(r.json));

    // 6. PIN: verificar que aún no hay PIN, crear y verificar
    r = await req('/api/admin/verify-pin', { method: 'POST', body: { pin: PIN } });
    check('POST /api/admin/verify-pin sin PIN -> pinSet:false (sin "Error 200")', r.status === 200 && r.json?.pinSet === false, JSON.stringify(r.json));
    r = await req('/api/admin/pin', { method: 'POST', body: { pin: PIN } });
    check('POST /api/admin/pin (primer uso) -> creado', r.status === 200 && r.json?.created === true, JSON.stringify(r.json));
    r = await req('/api/admin/verify-pin', { method: 'POST', body: { pin: PIN } });
    check('POST /api/admin/verify-pin correcto -> verified:true', r.json?.ok === true && r.json?.verified === true, JSON.stringify(r.json));
    r = await req('/api/admin/verify-pin', { method: 'POST', body: { pin: '9999' } });
    check('POST /api/admin/verify-pin incorrecto -> verified:false', r.json?.ok === true && r.json?.verified === false, JSON.stringify(r.json));

    // 7. Zona admin protegida
    r = await req('/api/admin/state');
    check('GET /api/admin/state sin PIN -> 401', r.status === 401, `status=${r.status}`);
    r = await req('/api/admin/state', { headers: { 'x-admin-pin': PIN } });
    check('GET /api/admin/state con PIN -> 200, 5 empleadas, festivos precargados', r.status === 200 && r.json?.employees?.length === 5 && (r.json?.holidays?.length || 0) >= 22, `employees=${r.json?.employees?.length} holidays=${r.json?.holidays?.length}`);

    // 8. Agregar sucursal nueva (POST /api/admin/branches)
    r = await req('/api/admin/branches', { method: 'POST', headers: { 'x-admin-pin': PIN }, body: { name: 'Medrano 62', mon_sat_start: '10:00', mon_sat_end: '19:00', sun_start: '10:00', sun_end: '15:30', tolerance_minutes: 10 } });
    check('POST /api/admin/branches -> 201', r.status === 201 && r.json?.branch?.name === 'Medrano 62', JSON.stringify(r.json));
    r = await req('/api/board');
    check('Tablero ya muestra 4 sucursales tras agregar una', r.json?.branches?.length === 4, `branches=${r.json?.branches?.length}`);

    // 9. Vacaciones: los días cuentan solo laborables (rango lun-vie sin festivo)
    // Se usa un rango fijo en 2026-11-23 (lun) a 2026-11-27 (vie): 5 días
    // laborables salvo descanso/festivo de la empleada elegida (Isela, descanso lunes -> 4).
    const isela = (await req('/api/board')).json.employees.find((e) => e.name === 'Isela Martínez');
    r = await req('/api/admin/vacations', { method: 'POST', headers: { 'x-admin-pin': PIN }, body: { employeeId: isela.id, start_date: '2026-11-23', end_date: '2026-11-27', status: 'approved' } });
    check('POST /api/admin/vacations Isela lun-vie -> days_count 4 (sin su lunes de descanso)', r.status === 201 && r.json?.vacation?.days_count === 4, JSON.stringify(r.json));

    // 10. Reporte mensual
    const month = new Date().toISOString().slice(0, 7);
    r = await req(`/api/admin/report?month=${month}`, { headers: { 'x-admin-pin': PIN } });
    check(`GET /api/admin/report?month=${month} -> 5 empleadas`, r.status === 200 && r.json?.employees?.length === 5, JSON.stringify(r.json)?.slice(0, 200));
    r = await req(`/api/admin/report-text?month=${month}`, { headers: { 'x-admin-pin': PIN } });
    check('GET /api/admin/report-text -> texto con el nombre de la tienda', r.status === 200 && r.text.includes('Princessitas'), r.text.slice(0, 120));
  } finally {
    server.close();
    await pool.end().catch(() => {});
  }

  console.log(`\nResultado: ${pass} pasaron, ${fail} fallaron.`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('Error en smoke test:', err); process.exit(1); });
