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
    return next();  // Si es una ruta pública, continúa sin verificar la sesión
  }

  const encodedSessionData = req.cookies['main_session'];
  

  if (!encodedSessionData) {
    console.log('No session cookie found');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Decodificar la cookie y extraer sessionId y userId
    const sessionData = JSON.parse(Buffer.from(encodedSessionData, 'base64').toString('ascii'));
    const { sid: sessionId, userId } = sessionData;

    console.log('main_session', sessionData);

    if (!sessionId || !userId) {
      console.log('Invalid session data');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = new pg.Client(dbConfig);
    await db.connect();

    // Verificar si el session_id es válido y la sesión no ha expirado
    const sessionResult = await db.query(`
      SELECT user_id FROM sessions WHERE session_id = $1 AND expires_at > NOW();
    `, [sessionId]);

    console.log('Session not found or expired', sessionResult);
    

    // Si no se encuentra una sesión válida
    if (sessionResult.rowCount === 0) {
      console.log('Session not found or expired');
      await db.end();
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verificar si el userId de la cookie coincide con el userId de la sesión
    const storedUserId = sessionResult.rows[0].user_id;
    if (storedUserId !== userId) {
      console.log('Session userId does not match');
      await db.end();
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.session = { userId }; 
    console.log(`Authenticated session for userId: ${userId}`);

    await db.end();
    next(); 
  } catch (error) {
    console.error('Error processing session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/', (req, res) => {
  httpRequestsTotal.inc({ endpoint: 'home', method: 'GET', status_code: '200' });
  res.send('Welcome to the learning platform');
});

app.use('/', auth(httpRequestsTotal, dbConfig));
app.use('/users', users(httpRequestsTotal, dbConfig));
app.use('/courses', courses(httpRequestsTotal, dbConfig));
app.use('/authors', authors(httpRequestsTotal, dbConfig));

app.listen(8080, async () => {
  console.log('WebApp Server is up and running');
});

