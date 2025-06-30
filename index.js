import 'dotenv/config';
import express  from 'express';
import cors     from 'cors';
import helmet   from 'helmet';

import { basicAuth }        from './middleware/basicAuth.js';
import chatRoutes           from './routes/chatRoutes.js';
import fileRoutes           from './routes/fileRoutes.js';
import { loadVectorStore }  from './services/vectorStoreService.js';

/* ───────── preload vectorstore ───────── */
await loadVectorStore();

/* ───────── app + middlewares ───────── */
const app = express();
app.use(helmet());
app.use(express.json({ limit: '4mb' }));

/* ───────── CORS (UNA sola configuración coherente) ───────── */
const FRONT_ORIGIN = process.env.FRONT_ORIGIN || 'http://localhost:5173';

const corsOptions = {
  origin: FRONT_ORIGIN,                     // front-end
  credentials: true,                        // permite Authorization Basic
  methods: 'GET,POST,DELETE,OPTIONS',
  allowedHeaders: 'Content-Type,Authorization',
};

app.use(cors(corsOptions));                 // aplica a todas las rutas
app.options('*', cors(corsOptions));        // responde pre-flights con lo mismo

/* ───────── Basic-Auth (después de CORS) ───────── */
app.use(basicAuth);

/* ───────── rutas protegidas (prefijo /api) ───────── */
app.use('/api', chatRoutes);   //  /api/chat/start  ·  /api/chat
app.use('/api', fileRoutes);   //  /api/files

/* healthcheck */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* 404 */
app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

/* error global */
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno' });
});

/* ───────── listen ───────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 API en http://localhost:${PORT}  (front allowed: ${FRONT_ORIGIN})`)
);
