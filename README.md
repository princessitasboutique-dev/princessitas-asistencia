# Princessitas Ceremonias — Control de asistencia y vacaciones

App web para la tienda **Princessitas Ceremonias** (Ulises, México): registro de
entrada/salida con un toque desde el celular, y Administración con PIN para
asistencia, vacaciones, permisos y faltas, horas extra, festivos, empleadas y
reporte mensual. Todo en español, mobile-first.

Stack: **Node.js + Express + PostgreSQL (`pg`) + React con Vite**.
Un solo servicio web: Express sirve `/api/*` y el build de React
(`client/dist`). Sin servicios de pago.

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `DATABASE_URL` | Sí (en producción) | Cadena de conexión **pool** de Neon, con SSL. Ej.: `postgresql://usuario:contraseña@host/basedatos?sslmode=require` |
| `PORT` | No | Render lo inyecta. Local: `3000` por defecto. |
| `NODE_ENV` | No | `production` en Render. |

Copia `.env.example` como `.env` para desarrollo local. **Nunca subas `.env`
a Git** (está en `.gitignore`, junto con `node_modules/` y `client/dist/`).

El pool de `pg` está configurado con `min: 0, max: 5,
idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000` y
`ssl: { rejectUnauthorized: false }`: sin conexiones permanentes abiertas,
para no agotar las 100 CU-horas mensuales del plan gratuito de Neon.

## Despliegue en Render (desde un repo GitHub)

1. Sube este proyecto a un repositorio de GitHub (el repo **no** debe incluir
   `node_modules/` ni `client/dist/`; `.gitignore` ya los excluye).
2. Crea una base en [Neon](https://neon.tech) (plan gratuito) y copia su
   cadena de conexión **pool** (la que termina en `-pooler`, con
   `sslmode=require`).
3. En [Render](https://render.com) → **New → Web Service** → conecta el repo.
   Render detecta `render.yaml` (plan free):
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `node server.js`
   - **Health Check Path:** `/api/health`
4. En el servicio, pestaña **Environment**, agrega:
   - `DATABASE_URL` = la cadena pool de Neon
   - `NODE_ENV` = `production`
5. Despliega. Al arrancar, el servidor crea las tablas (`db/schema.sql`) y
   siembra los datos iniciales **solo si las tablas están vacías**
   (ver "Siembra" abajo). Después abre la URL pública y compártela por
   WhatsApp: las empleadas entran desde el celular y la guardan como acceso
   directo.

## Siembra de la base (seed)

El seed corre solo al arrancar **si las tablas están vacías** (`server.js` →
`db/seed.js`). Es idempotente: si ya hay sucursales o festivos, no duplica nada.
Para correrlo manualmente (con `DATABASE_URL` en el entorno):

```bash
npm run seed
```

Siembra:

- **3 sucursales** con tolerancia de 10 min: Medrano 58 y Medrano 60
  (lun–sáb 10:00–19:00, dom 10:00–15:30) y Zapotlanejo
  (lun–sáb 9:00–19:00, dom 9:00–15:00).
- **5 empleadas** (sin fecha de ingreso ni cumpleaños todavía; se completan
  desde Administración): Carolina Parra (Medrano 58, descanso domingo),
  Isela Martínez (Medrano 58, descanso lunes), Natalia Ponce (Medrano 60,
  descanso miércoles), Marlene Villavicencio (Zapotlanejo, descanso jueves),
  Yesenia Paredes (Zapotlanejo, descanso martes).
- **Festivos oficiales de México 2026 y 2027** (22 en total, LFT art. 74;
  Semana Santa 2026: 2–3 abr; 2027: 25–26 mar). El 1 de octubre se incluye
  según la especificación del proyecto y se puede eliminar desde
  Administración → Festivos si no aplica en un año dado.

## Primer uso: PIN de administración

El PIN **no viene predefinido**. La primera vez que se entra a
Administración, la app pide crear un PIN (4 a 8 dígitos). Se guarda
**hasheado con bcrypt** en la tabla `settings` (`admin_pin_hash`).
Solo Ulises y Yareli Licona deben conocerlo. Para cambiarlo, en
Administración → Ajustes → Cambiar PIN (pide el PIN actual).

## Uso

- **Tablero (público):** cada empleada toca **Registrar entrada** o
  **Registrar salida**. La app responde al momento **A tiempo** o
  **Tarde X min**. Un segundo registro de entrada el mismo día devuelve el
  registro existente sin duplicar. Aquí **no** se muestran vacaciones ni
  historial. La puntualidad se calcula en hora de México
  (`America/Mexico_City`) contra el horario de su sucursal ese día
  (el domingo usa el horario de domingo) + tolerancia. **Tarde X min** =
  minutos después de (hora de entrada + tolerancia).
- **Administración (con PIN):** pestañas Asistencia (hoy + historial +
  corrección manual), Vacaciones (solicitudes, aprobar/rechazar/marcar
  tomadas, saldos), Permisos y faltas, Horas extra, Festivos, Empleadas
  (alta/edición con fecha de ingreso, cumpleaños, descanso, teléfono,
  contacto de emergencia, NSS, RFC y días de vacaciones anuales), Reporte
  mensual (con exportación CSV y texto listo para enviar por chat) y Ajustes
  (horarios por sucursal y tolerancia, **agregar sucursal nueva** y cambio
  de PIN). Los cumpleaños próximos (hoy + 3 días) se avisan con un banner
  en Administración.

### Agregar una sucursal nueva

En Administración → Ajustes → **Agregar sucursal**: nombre, horarios
lunes–sábado, horario domingo y tolerancia. Queda disponible de inmediato en
el tablero y en el alta de empleadas, sin tocar código. También existe el
endpoint `POST /api/admin/branches` (con PIN).

### Vacaciones

- Los días de un rango cuentan **solo días laborables**: no cuentan el día
  de descanso semanal de la empleada ni los festivos dentro del rango.
- Derecho anual por antigüedad (Ley Federal del Trabajo): 1 año = 12 días,
  2 = 14, 3 = 16, 4 = 18, 5 = 20, y +2 días por cada 5 años después
  (6–10 años = 22, 11–15 = 24, …). Si en Empleadas se define un número de
  días anuales, ese valor sustituye al cálculo por antigüedad.
- Saldo = derecho anual − días aprobados/tomados del año.

## Desarrollo local

```bash
npm install
npm run build        # construye el frontend (client/dist)
npm start            # levanta el servidor en http://localhost:3000
```

Sin `DATABASE_URL`, el servidor arranca pero las rutas de datos necesitan
una base PostgreSQL. Prueba de humo (sin base real, con `pg-mem`):

```bash
npm test
```

## Endpoints principales (`/api`)

- `GET /api/health` → `{ok:true}`
- `GET /api/board` → sucursales, empleadas activas y estado de hoy (sin vacaciones ni historial)
- `POST /api/checkin {employeeId}` · `POST /api/checkout {employeeId}`
- `POST /api/admin/pin {pin[, currentPin]}` · `POST /api/admin/verify-pin {pin}`
- `GET /api/admin/state` · `GET /api/admin/report?month=YYYY-MM` · `GET /api/admin/report-text?month=YYYY-MM`
- `POST/PATCH /api/admin/employees` · `POST /api/admin/branches` · `POST /api/admin/branch-schedule`
- `POST/PATCH/DELETE /api/admin/vacations` · `POST/DELETE /api/admin/incidents`
- `POST/DELETE /api/admin/overtime` · `POST/DELETE /api/admin/holidays`
- `POST/DELETE /api/admin/attendance`

La zona `/api/admin/*` (salvo `pin` y `verify-pin`) exige el PIN en el
encabezado `x-admin-pin` (también se acepta `?pin=` o `pin` en el cuerpo).
