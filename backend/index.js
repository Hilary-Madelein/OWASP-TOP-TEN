const express = require('express');
const cookieParser = require('cookie-parser');
const Prometheus = require('prom-client');
const promBundle = require("express-prom-bundle");
const axios = require('axios');
const pg = require('pg');


const app = express();

const auth = require('./auth');
const users = require('./users');
const courses = require('./courses');
const authors = require('./authors');


const tracer = require('dd-trace').init({
  analytics: true,
  tags: {
    'service.type': 'web'
  }
});

const dbConfig = {
  host: process.env.POSTGRES_HOST,
  port: process.env.POSTGRES_PORT,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const toJSON = (str) => {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
};

const metricsMiddleware = promBundle({
  includeMethod: true,
  includePath: true,
  includeStatusCode: true,
  includeUp: true,
  customLabels: { project_name: 'webapp', project_type: 'test_metrics_labels' },
  promClient: {
    collectDefaultMetrics: {}
  }
});

const metricsAuthMiddleware = (req, res, next) => {
  if (req.headers['authorization']?.includes('Basic')) {
    const token = req.headers['authorization'].split(' ')[1];
    const credentials = Buffer.from(token, 'base64').toString('ascii');
    const [username, password] = credentials.split(':');
    if (username === process.env.METRICS_USER && password === process.env.METRICS_PASSWORD) {
      next();
    } else {
      console.log('Unauthorized: Invalid credentials');
      res.status(401).send('Unauthorized');
    }
  } else {
    console.log('Unauthorized: No credentials');
    res.status(401).send('Unauthorized');
  }
};

app.use('/metrics', metricsAuthMiddleware);

app.use(metricsMiddleware);

const httpRequestsTotal = new Prometheus.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['endpoint', 'method', 'status_code'],
});

const isPublicPath = (path) => {
  console.log(`path: ${path}`);
  return path === '/login' || path == '/logout' || path === '/metrics' || path === '/' || path.includes('/courses') || path.includes('/authors');
};

app.use(async (req, res, next) => {
  const path = req.path;
  console.log(`Current path: ${path}`);

  // Verificar si la ruta es pública
  if (isPublicPath(path)) {
    console.log(`Public path accessed: ${path}`);
    return next(); // Continuar si es una ruta pública
  }

  const encodedSessionData = req.cookies['main_session'];

  if (!encodedSessionData) {
    console.log('No session cookie found');
    return res.status(401).json({ error: 'Unauthorized - No session cookie' });
  }

  try {
    // Decodificar y parsear la cookie de sesión
    const sessionData = JSON.parse(Buffer.from(encodedSessionData, 'base64').toString('ascii'));
    const { sid: sessionId, userId } = sessionData;

    console.log('Decoded session data:', sessionData);

    if (!sessionId || !userId) {
      console.log('Invalid session data');
      return res.status(401).json({ error: 'Unauthorized - Invalid session data' });
    }

    const db = new pg.Client(dbConfig);
    await db.connect();

    // Query para verificar la sesión activa
    const sessionResult = await db.query(`
      SELECT user_id 
      FROM sessions 
      WHERE session_id = $1 AND expires_at > NOW();
    `, [sessionId]);

    console.log('Session query result:', sessionResult.rows);

    if (sessionResult.rowCount === 0) {
      console.log('Session not found or expired');
      await db.end();
      return res.status(401).json({ error: 'Unauthorized - Session not found or expired' });
    }

    const storedUserId = sessionResult.rows[0].user_id;

    // Validar si el `userId` en la cookie coincide con el de la sesión
    if (storedUserId !== userId) {
      console.log(`Session userId (${storedUserId}) does not match cookie userId (${userId})`);
      await db.end();
      return res.status(401).json({ error: 'Unauthorized - Session userId mismatch' });
    }

    // Guardar los datos de sesión en `req` para que estén disponibles en la aplicación
    req.session = { userId };
    console.log(`Authenticated session for userId: ${userId}`);

    await db.end();
    next(); // Continuar al siguiente middleware
  } catch (error) {
    console.error('Error processing session:', error);

    // Asegurar que la conexión a la base de datos se cierre en caso de error
    try {
      const db = new pg.Client(dbConfig);
      await db.end();
    } catch (closeError) {
      console.error('Error closing the database connection:', closeError);
    }

    res.status(500).json({ error: 'Internal server error' });
  }});

app.get('/', (req, res) => {
  httpRequestsTotal.inc({ endpoint: 'home', method: 'GET', status_code: '200' });
  res.send('Welcome to the learning platform');
});

app.use('/', auth(httpRequestsTotal, dbConfig));
app.use('/users', users(httpRequestsTotal, dbConfig));
app.use('/courses', courses(httpRequestsTotal, dbConfig));
app.use('/authors', authors(httpRequestsTotal, dbConfig));
app.set('trust proxy', 'loopback'); 

app.listen(8080, async () => {
  console.log('WebApp Server is up and running');
});

