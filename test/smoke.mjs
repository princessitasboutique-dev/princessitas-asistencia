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

    // 9b. Incidente con motivo Vacaciones: se registra como permiso y
    // descuenta un día del saldo (sin duplicar si se registra dos veces).
    // Isela descansa los lunes; 2026-11-18 es miércoles laborable y no está
    // cubierto por su vacación del 23–27.
    r = await req('/api/admin/incidents', { method: 'POST', headers: { 'x-admin-pin': PIN }, body: { employeeId: isela.id, date: '2026-11-18', type: 'falta', reason: 'vacaciones' } });
    check('POST /api/admin/incidents vacaciones -> 201 y tipo forzado a permiso', r.status === 201 && r.json?.incident?.type === 'permiso' && r.json?.incident?.reason === 'vacaciones', JSON.stringify(r.json));
    const vacIncidentId = r.json?.incident?.id;
    r = await req('/api/admin/state', { headers: { 'x-admin-pin': PIN } });
    const iselaState = (r.json?.employees || []).find((e) => e.name === 'Isela Martínez');
    check('Saldo Isela tras día de vacaciones -> used 5 (4 + 1)', iselaState?.vacation?.used === 5, JSON.stringify(iselaState?.vacation));
    r = await req('/api/admin/incidents', { method: 'POST', headers: { 'x-admin-pin': PIN }, body: { employeeId: isela.id, date: '2026-11-18', type: 'permiso', reason: 'vacaciones' } });
    check('Segundo registro mismo día -> 201 pero sin descontar de nuevo', r.status === 201, JSON.stringify(r.json));
    r = await req('/api/admin/state', { headers: { 'x-admin-pin': PIN } });
    const iselaState2 = (r.json?.employees || []).find((e) => e.name === 'Isela Martínez');
    check('Saldo Isela sigue en used 5 tras duplicado', iselaState2?.vacation?.used === 5, JSON.stringify(iselaState2?.vacation));
    r = await req('/api/admin/report?month=2026-11', { headers: { 'x-admin-pin': PIN } });
    const iselaReport = (r.json?.employees || []).find((e) => e.name === 'Isela Martínez');
    check('Reporte nov Isela -> vacationDays 5 y permisos 2', iselaReport?.vacationDays === 5 && iselaReport?.permisos === 2, JSON.stringify(iselaReport));
    r = await req(`/api/admin/incidents/${vacIncidentId}`, { method: 'DELETE', headers: { 'x-admin-pin': PIN } });
    check('DELETE incidente vacaciones -> 200', r.status === 200, JSON.stringify(r.json));
    r = await req('/api/admin/state', { headers: { 'x-admin-pin': PIN } });
    const iselaState3 = (r.json?.employees || []).find((e) => e.name === 'Isela Martínez');
    check('Saldo Isela vuelve a used 4 al eliminar el registro', iselaState3?.vacation?.used === 4, JSON.stringify(iselaState3?.vacation));

    // 10. Reporte mensual
    const month = new Date().toISOString().slice(0, 7);
    r = await req(`/api/admin/report?month=${month}`, { headers: { 'x-admin-pin': PIN } });
    check(`GET /api/admin/report?month=${month} -> 5 empleadas`, r.status === 200 && r.json?.employees?.length === 5, JSON.stringify(r.json)?.slice(0, 200));
    r = await req(`/api/admin/report-text?month=${month}`, { headers: { 'x-admin-pin': PIN } });
    check('GET /api/admin/report-text -> texto con el nombre de la tienda', r.status === 200 && r.text.includes('Princessitas'), r.text.slice(0, 120));

    // 11. Préstamos: crear, abonar, validar tope, liquidar y borrar abono.
    const carolina = (await req('/api/board')).json.employees.find((e) => e.name === 'Carolina Parra');
    r = await req('/api/admin/loans', { method: 'POST', headers: { 'x-admin-pin': PIN }, body: { employeeId: carolina.id, date: '2026-11-16', amount: 1000, note: 'Préstamo de prueba' } });
    check('POST /api/admin/loans $1,000 -> 201', r.status === 201 && r.json?.loan?.amount === 1000, JSON.stringify(r.json));
    const loanId = r.json?.loan?.id;
    r = await req('/api/admin/state', { headers: { 'x-admin-pin': PIN } });
    let loan = (r.json?.loans || []).find((l) => l.id === loanId);
    check('State: préstamo nuevo -> total_paid 0, balance 1000, activo', loan?.total_paid === 0 && loan?.balance === 1000 && loan?.status === 'activo', JSON.stringify(loan));

    r = await req(`/api/admin/loans/${loanId}/payments`, { method: 'POST', headers: { 'x-admin-pin': PIN }, body: { date: '2026-11-16', amount: 400 } });
    check('POST abono $400 -> 201', r.status === 201 && r.json?.payment?.amount === 400, JSON.stringify(r.json));
    const paymentId = r.json?.payment?.id;
    r = await req('/api/admin/state', { headers: { 'x-admin-pin': PIN } });
    loan = (r.json?.loans || []).find((l) => l.id === loanId);
    check('State tras abono $400 -> total_paid 400, balance 600, activo', loan?.total_paid === 400 && loan?.balance === 600 && loan?.status === 'activo', JSON.stringify(loan));

    r = await req(`/api/admin/loans/${loanId}/payments`, { method: 'POST', headers: { 'x-admin-pin': PIN }, body: { date: '2026-11-16', amount: 700 } });
    check('Abono $700 sobre saldo $600 -> 400 con mensaje de saldo pendiente', r.status === 400 && /supera el saldo pendiente/.test(r.json?.error || ''), JSON.stringify(r.json));

    r = await req(`/api/admin/loans/${loanId}/payments`, { method: 'POST', headers: { 'x-admin-pin': PIN }, body: { date: '2026-11-16', amount: 600 } });
    check('POST abono $600 -> 201 (liquida)', r.status === 201, JSON.stringify(r.json));
    r = await req('/api/admin/state', { headers: { 'x-admin-pin': PIN } });
    loan = (r.json?.loans || []).find((l) => l.id === loanId);
    check('State tras liquidar -> total_paid 1000, balance 0, liquidado', loan?.total_paid === 1000 && loan?.balance === 0 && loan?.status === 'liquidado', JSON.stringify(loan));

    r = await req('/api/board');
    check('GET /api/board NO expone loans ni loanPayments', !('loans' in (r.json || {})) && !('loanPayments' in (r.json || {})), Object.keys(r.json || {}).join(','));

    r = await req(`/api/admin/loan-payments/${paymentId}`, { method: 'DELETE', headers: { 'x-admin-pin': PIN } });
    check('DELETE abono $400 -> 200', r.status === 200, JSON.stringify(r.json));
    r = await req('/api/admin/state', { headers: { 'x-admin-pin': PIN } });
    loan = (r.json?.loans || []).find((l) => l.id === loanId);
    check('State tras borrar abono $400 -> total_paid 600, balance 400, activo', loan?.total_paid === 600 && loan?.balance === 400 && loan?.status === 'activo', JSON.stringify(loan));

    r = await req('/api/admin/loans', { method: 'POST', headers: { 'x-admin-pin': PIN }, body: { employeeId: carolina.id, date: '2026-11-16', amount: 0 } });
    check('POST préstamo $0 -> 400', r.status === 400, JSON.stringify(r.json));
    r = await req(`/api/admin/loans/${loanId}`, { method: 'DELETE', headers: { 'x-admin-pin': PIN } });
    check('DELETE préstamo -> 200', r.status === 200, JSON.stringify(r.json));
    r = await req('/api/admin/state', { headers: { 'x-admin-pin': PIN } });
    check('State tras borrar préstamo -> ya no aparece (ni sus abonos)', !(r.json?.loans || []).some((l) => l.id === loanId) && !(r.json?.loanPayments || []).some((p) => p.loan_id === loanId), JSON.stringify(r.json?.loans));
  } finally {
    server.close();
    await pool.end().catch(() => {});
  }

  console.log(`\nResultado: ${pass} pasaron, ${fail} fallaron.`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('Error en smoke test:', err); process.exit(1); });
