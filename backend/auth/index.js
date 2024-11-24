const express = require('express');
const { createHash } = require('crypto');
const { v4: uuidv4 } = require('uuid');
const pg = require('pg');
const router = express.Router();
const expressRateLimit = require('express-rate-limit');

module.exports = function (httpRequestsTotal, dbConfig) {
    // Configurar el limitador de solicitudes
    const limiter = expressRateLimit({
        windowMs: 1000 * 60 * 60 * 24, // 1 día
        max: 5, // Máximo 5 solicitudes por IP
        handler: (req, res) => {
            console.log(`Too many requests from this IP: ${req.ip}`);
            httpRequestsTotal.inc({ endpoint: 'login', method: req.method, status_code: '429' });
            res.status(429).json({ error: 'Too many requests from this IP, please try again after 24 hours' });
        }
    });

    router.post('/login', limiter, async (req, res) => {
        const { username, password } = req.body;
    
        console.log(`Username and password received: ${username}, [password hidden]`);
    
        if (!username || !password) {
            httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '400' });
            return res.status(400).json({ error: 'Username and password are required' });
        }
    
        const hashedPassword = createHash('sha256').update(password).digest('base64');
        const db = new pg.Client(dbConfig);
    
        try {
            await db.connect();
            const currentTime = new Date();
    
            // Obtener IP del cliente
            const clientIp = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    
            // Verificar intentos fallidos por IP
            const ipAttemptResult = await db.query(`
                SELECT attempts, last_attempt
                FROM ip_login_attempts
                WHERE ip_address = $1;
            `, [clientIp]);
    
            if (ipAttemptResult.rowCount > 0) {
                const { attempts, last_attempt } = ipAttemptResult.rows[0];
                const lastAttemptTime = new Date(last_attempt);
                const timeElapsed = currentTime - lastAttemptTime;
                const lockoutPeriod = 15 * 60 * 1000; // 15 minutos
    
                if (attempts >= 5 && timeElapsed < lockoutPeriod) {
                    const timeRemaining = Math.ceil((lockoutPeriod - timeElapsed) / 1000);
                    console.log(`IP ${clientIp} is temporarily locked.`);
                    httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '429' });
                    return res.status(429).json({
                        error: 'Too many login attempts. Please try again later.',
                        timeRemaining: timeRemaining // Tiempo restante en segundos
                    });
                }
                
    
                if (timeElapsed >= lockoutPeriod) {
                    // Restablecer intentos fallidos
                    await db.query(`
                        UPDATE ip_login_attempts
                        SET attempts = 0, last_attempt = $1
                        WHERE ip_address = $2;
                    `, [currentTime, clientIp]);
                }
            }
    
            // Verificar si el usuario existe
            const userResult = await db.query(`
                SELECT 
                    u.id, 
                    u.username, 
                    u.password, 
                    u.is_locked, 
                    u.unlock_time, 
                    r.role_name
                FROM 
                    users u
                JOIN 
                    user_roles ur ON u.id = ur.user_id
                JOIN 
                    roles r ON ur.role_id = r.id
                WHERE 
                    u.username = $1;
            `, [username]);
    
            if (userResult.rowCount === 0) {
                // Registrar intento fallido por IP
                await db.query(`
                    INSERT INTO ip_login_attempts (ip_address, attempts, last_attempt)
                    VALUES ($1, 1, $2)
                    ON CONFLICT (ip_address) DO UPDATE
                    SET attempts = ip_login_attempts.attempts + 1, last_attempt = $2;
                `, [clientIp, currentTime]);
    
                console.log(`Login failed for non-existent username: ${username}`);
                httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '401' });
                return res.status(401).json({ error: 'Invalid username' });
            }
    
            const user = userResult.rows[0];
    
            // Verificar si la cuenta está bloqueada
            if (user.is_locked && new Date() < new Date(user.unlock_time)) {
                const timeRemaining = Math.ceil((new Date(user.unlock_time) - currentTime) / 1000);
                console.log(`Account for username ${username} is temporarily locked.`);
                httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '429' });
                return res.status(429).json({
                    error: 'Account temporarily locked due to multiple failed login attempts.',
                    timeRemaining
                });
            }
    
            // Verificar contraseña
            if (user.password !== hashedPassword) {
                // Registrar intento fallido por IP
                await db.query(`
                    INSERT INTO ip_login_attempts (ip_address, attempts, last_attempt)
                    VALUES ($1, 1, $2)
                    ON CONFLICT (ip_address) DO UPDATE
                    SET attempts = ip_login_attempts.attempts + 1, last_attempt = $2;
                `, [clientIp, currentTime]);
    
                console.log(`Invalid password for username: ${username}`);
                httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '401' });
                return res.status(401).json({ error: 'Invalid password' });
            }
    
            // Restablecer intentos fallidos por IP
            await db.query(`
                DELETE FROM ip_login_attempts
                WHERE ip_address = $1;
            `, [clientIp]);
    
            // Crear sesión
            const session = {
                sid: uuidv4(),
                userId: user.id,
                role: user.role_name
            };
    
            await db.query(`
                INSERT INTO sessions (session_id, user_id, expires_at)
                VALUES ($1, $2, $3)
                ON CONFLICT (session_id) DO NOTHING;
            `, [session.sid, session.userId, new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)]); // Expira en 30 días
    
            const sessionEncoded = Buffer.from(JSON.stringify(session), 'ascii').toString('base64');
    
            res.cookie('main_session', sessionEncoded, {
                httpOnly: false,
                secure: true,
                sameSite: 'strict',
                maxAge: 1000 * 60 * 60 * 24 * 30 // 30 días
            });
    
            console.log(`Login successful for username: ${username}`);
            httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '200' });
            res.json({ message: 'Login successful' });
        } catch (err) {
            console.error('Login error:', err.message);
            httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '500' });
            res.status(500).json({ error: 'Internal server error' });
        } finally {
            await db.end();
        }
    });
    
    
    router.get('/logout', async (req, res) => {
        const encodedSessionData = req.cookies['main_session'];

        if (!encodedSessionData) {
            console.log('No session ID found for logout');
            return res.status(400).json({ error: 'No active session to log out' });
        }

        try {
            const sessionData = JSON.parse(Buffer.from(encodedSessionData, 'base64').toString('ascii'));
            const { sessionId } = sessionData;

            if (!sessionId) {
                console.log('Invalid session ID');
                return res.status(400).json({ error: 'Invalid session ID' });
            }

            const db = new pg.Client(dbConfig);
            await db.connect();
            console.log('Connected to database for logout');

            await db.query(`
                DELETE FROM sessions WHERE session_id = $1;
            `, [sessionId]);

            await db.end();
            console.log('Session deleted and disconnected from database');

            // Limpiar la cookie de sesión
            res.clearCookie('main_session');
            httpRequestsTotal.inc({ endpoint: 'logout', method: 'GET', status_code: '200' });
            res.json({ message: 'Logout successful' });
        } catch (err) {
            console.error('Error processing logout:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });


    router.post('/register', async (req, res) => {
        const { username, password } = req.body;
        console.log(`Username and password: ${username} ${password}`);
        if (!username || !password) {
            httpRequestsTotal.inc({ endpoint: 'register', method: 'POST', status_code: '400' });
            res.status(400).json({ error: 'Username and password are required' });
            return;
        }

        const hashedPassword = createHash('sha256').update(password).digest('base64');
        console.log(`Hashed password: ${hashedPassword}`);

        try {
            const db = new pg.Client(dbConfig);
            await db.connect();
            console.log('Connected to database');

            const result = await db.query(`
                INSERT INTO
                    users (username, password)
                VALUES
                    ($1, $2)
                RETURNING
                    id;
            `, [username, hashedPassword]);

            const userId = result.rows[0].id;

            if (!userId) {
                httpRequestsTotal.inc({ endpoint: 'register', method: 'POST', status_code: '500' });
                res.status(500).json({ error: 'Internal server error' });
                return;
            }

            await db.query(`
                INSERT INTO
                    user_roles (user_id, role_id)
                VALUES
                    ($1, 2);
            `, [userId]);

            console.log(`Database message66666: ${JSON.stringify(result)}`);
            await db.end();
            console.log('Disconnected from database');

            httpRequestsTotal.inc({ endpoint: 'register', method: 'POST', status_code: '200' });
            res.json({ message: 'Registration successful' });
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'register', method: 'POST', status_code: '500' });
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
};
