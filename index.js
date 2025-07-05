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

/* ───────── CORS (refleja cualquier origen) ───────── */
const corsOptions = {
  /**  
   * Refleja el origen que llega → ‘Access-Control-Allow-Origin: <origin>’  
   * El 2º parámetro (`cb`) es (error, allow?).  Con `true` permitimos todos.
   */
  origin: (_origin, cb) => cb(null, true),
  credentials: true,                              // deja pasar Authorization
  methods: 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  allowedHeaders: 'Origin,Content-Type,Authorization,Accept'
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));               // pre-flight

/* ───────── Basic-Auth después de CORS ───────── */
app.use(basicAuth);

/* ───────── rutas protegidas ───────── */
app.use('/api', chatRoutes);   // /api/chat…
app.use('/api', fileRoutes);   // /api/files…

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
  console.log(`🚀 API corriendo en http://localhost:${PORT}`)
);
