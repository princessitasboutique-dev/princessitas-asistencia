// src/db.js — pool de PostgreSQL (Neon).
// Configuración obligatoria: sin conexiones permanentes abiertas, para no
// agotar las 100 CU-horas mensuales del plan gratuito de Neon.
// DATABASE_URL se toma de la variable de entorno (Render la inyecta).
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

const pool = new Pool(
  connectionString
    ? {
        connectionString,
        min: 0,
        max: 5,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
        ssl: { rejectUnauthorized: false },
      }
    : {
        // Desarrollo local sin DATABASE_URL: valores por defecto de pg.
        min: 0,
        max: 5,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
      }
);

pool.on('error', (err) => console.error('Error inesperado del pool pg:', err.message));

module.exports = { pool };
