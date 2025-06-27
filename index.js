// index.js
import 'dotenv/config';              // carga variables de entorno
import express from 'express';
import cors from 'cors';             // ⬅️ NUEVO

import { basicAuth } from './middleware/basicAuth.js';
import fileRoutes   from './routes/fileRoutes.js';
import chatRoutes   from './routes/chatRoutes.js';

const app = express();
app.use(express.json());

/* ──────────────────────────────────────────────────────────
   CORS
   1. Responde automáticamente a las peticiones OPTIONS
   2. Permite origen http://localhost:5173 (tu frontend Vite)
   3. credentials: true para que el header Authorization viaje
─────────────────────────────────────────────────────────────*/
app.options('*', cors());            // pre-flight
app.use(
  cors({
    origin: 'http://localhost:5173', // cambia al dominio de tu front en prod
    credentials: true,
  })
);

/* ──────────────────────────────────────────────────────────
   Autenticación Basic (se ejecuta DESPUÉS de CORS)
─────────────────────────────────────────────────────────────*/
app.use(basicAuth);

// Rutas protegidas
app.use('/files', fileRoutes);
app.use('/chat',  chatRoutes);

// Fallback 404
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

// Manejo de errores global
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 API protegida con Basic Auth en http://localhost:${PORT}`)
);
