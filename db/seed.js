// db/seed.js — siembra idempotente de Princessitas Ceremonias.
// Solo siembra si las tablas están vacías. Se ejecuta:
//   - automáticamente al arrancar el servidor (server.js), y
//   - manualmente con `npm run seed` (requiere DATABASE_URL).
// No registra asistencias ni toca datos existentes.
const fs = require('fs');
const path = require('path');

const BRANCHES = [
  { name: 'Medrano 58', mon_sat_start: '10:00', mon_sat_end: '19:00', sun_start: '10:00', sun_end: '15:30', tolerance_minutes: 10 },
  { name: 'Medrano 60', mon_sat_start: '10:00', mon_sat_end: '19:00', sun_start: '10:00', sun_end: '15:30', tolerance_minutes: 10 },
  { name: 'Zapotlanejo', mon_sat_start: '09:00', mon_sat_end: '19:00', sun_start: '09:00', sun_end: '15:00', tolerance_minutes: 10 },
];

// Empleadas: name, branchName, restDay (día de descanso semanal, en español).
const EMPLOYEES = [
  { name: 'Carolina Parra', branch: 'Medrano 58', rest_day: 'domingo' },
  { name: 'Isela Martínez', branch: 'Medrano 58', rest_day: 'lunes' },
  { name: 'Natalia Ponce', branch: 'Medrano 60', rest_day: 'miércoles' },
  { name: 'Marlene Villavicencio', branch: 'Zapotlanejo', rest_day: 'jueves' },
  { name: 'Yesenia Paredes', branch: 'Zapotlanejo', rest_day: 'martes' },
];

// Festivos oficiales de México (LFT art. 74). Fechas verificadas:
// 2026: Constitución 1er lunes feb = 2 feb; Juárez 3er lunes mar = 16 mar;
//   Semana Santa: Jueves 2 abr, Viernes 3 abr (Pascua 5 abr);
//   Revolución 3er lunes nov = 16 nov.
// 2027: Constitución 1er lunes feb = 1 feb; Juárez 3er lunes mar = 15 mar;
//   Semana Santa: Jueves 25 mar, Viernes 26 mar (Pascua 28 mar);
//   Revolución 3er lunes nov = 15 nov.
// El 1 de octubre se incluye tal como pide la especificación del proyecto
// (día de transmisión del Poder Ejecutivo Federal); es editable y se puede
// eliminar desde Administración > Festivos si no aplica en un año dado.
const HOLIDAYS = [
  // 2026
  ['2026-01-01', 'Año Nuevo'],
  ['2026-02-02', 'Día de la Constitución (1er lunes de febrero)'],
  ['2026-03-16', 'Natalicio de Benito Juárez (3er lunes de marzo)'],
  ['2026-04-02', 'Jueves Santo'],
  ['2026-04-03', 'Viernes Santo'],
  ['2026-05-01', 'Día del Trabajo'],
  ['2026-09-16', 'Día de la Independencia'],
  ['2026-10-01', 'Transmisión del Poder Ejecutivo Federal'],
  ['2026-11-02', 'Día de Muertos'],
  ['2026-11-16', 'Día de la Revolución (3er lunes de noviembre)'],
  ['2026-12-25', 'Navidad'],
  // 2027
  ['2027-01-01', 'Año Nuevo'],
  ['2027-02-01', 'Día de la Constitución (1er lunes de febrero)'],
  ['2027-03-15', 'Natalicio de Benito Juárez (3er lunes de marzo)'],
  ['2027-03-25', 'Jueves Santo'],
  ['2027-03-26', 'Viernes Santo'],
  ['2027-05-01', 'Día del Trabajo'],
  ['2027-09-16', 'Día de la Independencia'],
  ['2027-10-01', 'Transmisión del Poder Ejecutivo Federal'],
  ['2027-11-02', 'Día de Muertos'],
  ['2027-11-15', 'Día de la Revolución (3er lunes de noviembre)'],
  ['2027-12-25', 'Navidad'],
];

async function ensureSchema(client) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.query(sql);
}

async function count(client, table) {
  const r = await client.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
  return r.rows[0].c;
}

async function seed(client) {
  // Sucursales + empleadas: solo si branches está vacía.
  if ((await count(client, 'branches')) === 0) {
    const branchIds = {};
    for (const b of BRANCHES) {
      const r = await client.query(
        `INSERT INTO branches (name, mon_sat_start, mon_sat_end, sun_start, sun_end, tolerance_minutes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [b.name, b.mon_sat_start, b.mon_sat_end, b.sun_start, b.sun_end, b.tolerance_minutes]
      );
      branchIds[b.name] = r.rows[0].id;
    }
    for (const e of EMPLOYEES) {
      await client.query(
        `INSERT INTO employees (branch_id, name, active, hire_date, birthday, rest_day, phone, emergency_contact, nss, rfc, annual_vacation_days)
         VALUES ($1,$2,TRUE,NULL,NULL,$3,NULL,NULL,NULL,NULL,NULL)`,
        [branchIds[e.branch], e.name, e.rest_day]
      );
    }
    console.log('seed: sucursales y empleadas sembradas (3 sucursales, 5 empleadas).');
  } else {
    console.log('seed: branches ya tiene datos, no se siembran sucursales ni empleadas.');
  }

  // Festivos: solo si holidays está vacía.
  if ((await count(client, 'holidays')) === 0) {
    for (const [date, name] of HOLIDAYS) {
      await client.query(
        'INSERT INTO holidays (date, name, custom) VALUES ($1,$2,FALSE)',
        [date, name]
      );
    }
    console.log(`seed: ${HOLIDAYS.length} festivos sembrados (2026 y 2027).`);
  } else {
    console.log('seed: holidays ya tiene datos, no se siembran festivos.');
  }
  return { branches: BRANCHES.length, employees: EMPLOYEES.length, holidays: HOLIDAYS.length };
}

if (require.main === module) {
  (async () => {
    const { pool } = require('../src/db');
    try {
      await ensureSchema(pool);
      await seed(pool);
      console.log('seed completado.');
    } catch (err) {
      console.error('Error en seed:', err.message);
      process.exitCode = 1;
    } finally {
      await pool.end().catch(() => {});
    }
  })();
}

module.exports = { seed, ensureSchema, BRANCHES, EMPLOYEES, HOLIDAYS };
