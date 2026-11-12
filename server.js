// server.js — punto de entrada. Un solo servicio:
// Express sirve /api/* y el build de React (client/dist) en producción.
const path = require('path');
const express = require('express');
const { pool } = require('./src/db');
const { createApp } = require('./src/app');
const { ensureSchema, seed } = require('./db/seed');

const app = createApp(pool);
const PORT = process.env.PORT || 3000;

// Frontend (si existe el build; en desarrollo puede no existir aún).
const distDir = path.join(__dirname, 'client', 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) res.status(200).send('Princessitas Ceremonias — API en /api/health. Construye el frontend con npm run build.');
  });
});

async function start() {
  // Siembra inicial solo si las tablas están vacías (idempotente).
  // Si la base no está disponible, se registra el error y el servidor
  // sigue levantado para que /api/health responda; las rutas de datos
  // devolverán error hasta que la base esté disponible.
  try {
    await ensureSchema(pool);
    await seed(pool);
  } catch (err) {
    console.error('No se pudo preparar la base de datos al arrancar:', err.message);
  }
  app.listen(PORT, () => {
    console.log(`Princessitas app escuchando en el puerto ${PORT} (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
  });
}

if (require.main === module) start();

module.exports = app;
