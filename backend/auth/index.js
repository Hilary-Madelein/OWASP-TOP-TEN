const express = require('express');
const { createHash } = require('crypto');
const { v4: uuidv4 } = require('uuid');
const pg = require('pg');
const router = express.Router();

module.exports = function (httpRequestsTotal, dbConfig) {

    router.post('/login', async (req, res) => {
        const { username, password } = req.body;
        console.log(`Username and password: ${username} ${password}`);
    
        if (!username || !password) {
            httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '400' });
            return res.status(400).json({ error: 'Username and password are required' });
        }
    
        const hashedPassword = createHash('sha256').update(password).digest('base64');
        console.log(`Hashed password: ${hashedPassword}`);
    
        const db = new pg.Client(dbConfig);
        await db.connect();
    
        try {
            // Verificar si la cuenta está bloqueada
            const lockResult = await db.query(`
                SELECT is_locked, unlock_time
                FROM users
                WHERE username = $1;
            `, [username]);
    
            if (lockResult.rowCount > 0) {
                const { is_locked, unlock_time } = lockResult.rows[0];
                const currentTime = new Date();
    
                // Si la cuenta está bloqueada y el tiempo de desbloqueo aún no ha pasado
                if (is_locked && unlock_time && currentTime < new Date(unlock_time)) {
                    const timeRemaining = Math.ceil((new Date(unlock_time) - currentTime) / 1000); // en segundos
                    await db.end();
                    return res.status(429).json({
                        error: 'Account temporarily locked due to multiple failed login attempts.',
                        timeRemaining: timeRemaining
                    });
                }
    
                // Si el tiempo de desbloqueo ha pasado, restablece el estado de bloqueo
                if (is_locked && unlock_time && currentTime >= new Date(unlock_time)) {
                    await db.query(`
                        UPDATE users
                        SET is_locked = FALSE, unlock_time = NULL
                        WHERE username = $1;
                    `, [username]);
                }
            }
    
            // Verificar intentos de inicio de sesión fallidos
            const attemptResult = await db.query(`
                SELECT attempts, last_attempt
                FROM login_attempts
                WHERE username = $1;
            `, [username]);
    
            if (attemptResult.rowCount > 0) {
                const { attempts, last_attempt } = attemptResult.rows[0];
                const lastAttemptTime = new Date(last_attempt);
                const currentTime = new Date();
                const timeElapsed = currentTime - lastAttemptTime;
                const lockoutPeriod = 15 * 60 * 1000; // 15 minutos en milisegundos
    
                // Si hay tres o más intentos y es reciente, bloquea la cuenta temporalmente
                if (attempts >= 3 && timeElapsed < lockoutPeriod) {
                    const unlockTime = new Date(currentTime.getTime() + lockoutPeriod);
                    await db.query(`
                        UPDATE users
                        SET is_locked = TRUE, unlock_time = $1
                        WHERE username = $2;
                    `, [unlockTime, username]);
    
                    await db.end();
                    return res.status(429).json({
                        error: 'Account temporarily locked due to multiple failed login attempts.',
                        timeRemaining: Math.ceil(lockoutPeriod / 1000)
                    });
                }
    
                // Si han pasado más de 15 minutos, restablece los intentos
                if (timeElapsed >= lockoutPeriod) {
                    await db.query(`
                        UPDATE login_attempts
                        SET attempts = 0, last_attempt = $1
                        WHERE username = $2;
                    `, [currentTime, username]);
                }
            }
    
            // Intentar obtener el usuario desde la base de datos
            const result = await db.query(`
                SELECT u.id, u.username, u.password, r.role_name
                FROM users u
                JOIN user_roles ur ON u.id = ur.user_id
                JOIN roles r ON ur.role_id = r.id
                WHERE u.username = $1;
            `, [username]);
    
            if (result.rowCount === 0) {
                // Registrar intento fallido para nombre de usuario inexistente
                await db.query(`
                    INSERT INTO login_attempts (username, attempts, last_attempt)
                    VALUES ($1, 1, NOW())
                    ON CONFLICT (username) DO UPDATE
                    SET attempts = login_attempts.attempts + 1, last_attempt = NOW();
                `, [username]);
                await db.end();
                return res.status(401).json({ error: 'Invalid username' });
            }
    
            const user = result.rows[0];
    
            // Si la contraseña no coincide, incrementar el contador de intentos fallidos
            if (user.password !== hashedPassword) {
                httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '401'});
                res.status(401).json({error: 'Invalid password'});
                return;
            }

            // create session cookie and encode it in base64
            console.log(`Create cookie session`);
            const session = {
                sid: uuidv4(),
                userId: user.id,
                role: user.role_name
            };
            console.log(`New session: ${JSON.stringify(session)}`);
            const sessionString = JSON.stringify(session);
            const sessionEncoded = Buffer.from(sessionString, 'ascii').toString('base64');
            console.log(`New session cookie: ${sessionEncoded}`);

            res.cookie('main_session', sessionEncoded, {
                httpOnly: false, // cookie is not accessible via JavaScript
                secure: true, // https only
                sameSite: 'strict', // cookie is not sent in cross-site requests
                maxAge: 1000 * 60 * 60 * 24 * 30 // 30 days
            });
    
            res.json({ message: 'Login successful' });
        } catch (err) {
            console.error(err);
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

            console.log(`Database message-----: ${JSON.stringify(result)}`);
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
