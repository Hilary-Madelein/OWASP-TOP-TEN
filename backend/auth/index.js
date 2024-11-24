const express = require('express');
const { createHash } = require('crypto');
const { v4: uuidv4 } = require('uuid');
const pg = require('pg');
const router = express.Router();

module.exports = function (httpRequestsTotal, dbConfig) {

    router.post('/login', async (req, res) => {
        const { username, password } = req.body;
        const clientIp = req.ip; // Obtener la IP del cliente
        console.log(`Username: ${username}, Client IP: ${clientIp}`);

        if (!username || !password) {
            httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '400' });
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const hashedPassword = createHash('sha256').update(password).digest('base64');
        const db = new pg.Client(dbConfig);
        await db.connect();

        try {
            const currentTime = new Date();

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
                const lockoutPeriod = 15 * 60 * 1000; // 15 minutos en milisegundos

                if (attempts >= 5 && timeElapsed < lockoutPeriod) {
                    const timeRemaining = Math.ceil((lockoutPeriod - timeElapsed) / 1000); // en segundos
                    console.log(`IP ${clientIp} is temporarily locked.`);
                    await db.end();
                    return res.status(429).json({
                        error: 'Too many login attempts from this IP. Try again later.',
                        timeRemaining: timeRemaining
                    });
                }

                if (timeElapsed >= lockoutPeriod) {
                    // Restablecer intentos fallidos por IP
                    await db.query(`
                        UPDATE ip_login_attempts
                        SET attempts = 0, last_attempt = $1
                        WHERE ip_address = $2;
                    `, [currentTime, clientIp]);
                }
            }

            // Intentar obtener el usuario desde la base de datos
            const result = await db.query(`
                SELECT u.id, u.username, u.password, r.role_name, u.is_locked, u.unlock_time
                FROM users u
                JOIN user_roles ur ON u.id = ur.user_id
                JOIN roles r ON ur.role_id = r.id
                WHERE u.username = $1;
            `, [username]);

            if (result.rowCount === 0) {
                // Registrar intento fallido por IP
                await db.query(`
                    INSERT INTO ip_login_attempts (ip_address, attempts, last_attempt)
                    VALUES ($1, 1, $2)
                    ON CONFLICT (ip_address) DO UPDATE
                    SET attempts = ip_login_attempts.attempts + 1, last_attempt = $2;
                `, [clientIp, currentTime]);

                console.log(`Login failed for non-existent username: ${username}`);
                await db.end();
                return res.status(401).json({ error: 'Invalid username or password' });
            }

            const user = result.rows[0];

            // Verificar si la cuenta está bloqueada
            if (user.is_locked && new Date() < new Date(user.unlock_time)) {
                const timeRemaining = Math.ceil((new Date(user.unlock_time) - currentTime) / 1000); // en segundos
                console.log(`Account for username ${username} is temporarily locked.`);
                await db.end();
                return res.status(429).json({
                    error: 'Account temporarily locked due to multiple failed login attempts.',
                    timeRemaining: timeRemaining
                });
            }

            if (user.password !== hashedPassword) {
                // Registrar intento fallido por IP
                await db.query(`
                    INSERT INTO ip_login_attempts (ip_address, attempts, last_attempt)
                    VALUES ($1, 1, $2)
                    ON CONFLICT (ip_address) DO UPDATE
                    SET attempts = ip_login_attempts.attempts + 1, last_attempt = $2;
                `, [clientIp, currentTime]);

                console.log(`Invalid password for username: ${username}`);
                await db.end();
                return res.status(401).json({ error: 'Invalid username or password' });
            }

            // Si la autenticación es exitosa, restablecer intentos fallidos por IP
            await db.query(`
                DELETE FROM ip_login_attempts
                WHERE ip_address = $1;
            `, [clientIp]);

            // Crear y guardar la sesión
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
                httpOnly: true,
                secure: true,
                sameSite: 'strict',
                maxAge: 1000 * 60 * 60 * 24 * 30 // 30 días
            });

            console.log(`Login successful for username: ${username}`);
            await db.end();
            res.json({ message: 'Login successful' });
        } catch (error) {
            console.error('Login error:', error.message);
            await db.end();
            res.status(500).json({ error: 'Internal server error' });
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
