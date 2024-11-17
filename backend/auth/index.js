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

    // Aplicar el limitador solo a la ruta /login
    router.post('/login', limiter, async (req, res) => {
        const { username, password } = req.body;
        console.log(`Username and password: ${username} ${password}`);

        if (!username || !password) {
            httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '400' });
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const hashedPassword = createHash('sha256').update(password).digest('base64');
        const db = new pg.Client(dbConfig);
        await db.connect();

        try {
            const result = await db.query(`
                SELECT
                    u.id,
                    u.username,
                    u.password,
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

            if (result.rowCount === 0) {
                console.log(`Login failed: Invalid username`);
                httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '401' });
                await db.end();
                return res.status(401).json({ error: 'Invalid username or password' });
            }

            const user = result.rows[0];

            if (user.password !== hashedPassword) {
                console.log(`Login failed: Invalid password`);
                httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '401' });
                await db.end();
                return res.status(401).json({ error: 'Invalid username or password' });
            }

            // Crear y enviar la sesión
            const session = {
                sid: uuidv4(),
                userId: user.id,
                role: user.role_name
            };

            const sessionEncoded = Buffer.from(JSON.stringify(session), 'ascii').toString('base64');
            res.cookie('main_session', sessionEncoded, {
                httpOnly: true,
                secure: true,
                sameSite: 'strict',
                maxAge: 1000 * 60 * 60 * 24 * 30 // 30 días
            });

            console.log(`Login successful for username: ${username}`);
            httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '200' });
            await db.end();
            res.json({ message: 'Login successful' });
        } catch (err) {
            console.error('Login error:', err.message);
            httpRequestsTotal.inc({ endpoint: 'login', method: 'POST', status_code: '500' });
            await db.end();
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.get('/logout', async (req, res) => {
        res.clearCookie('main_session');
        httpRequestsTotal.inc({ endpoint: 'logout', method: 'GET', status_code: '200' });
        res.json({ message: 'Logout successful' });
    });

    router.post('/register', async (req, res) => {
        const { username, password } = req.body;
        console.log(`Username and password: ${username} ${password}`);
        if (!username || !password) {
            httpRequestsTotal.inc({ endpoint: 'register', method: 'POST', status_code: '400'});
            res.status(400).json({error: 'Username, password are required'});
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
            console.log(`Database message: ${JSON.stringify(result)}`);
            const userId = result?.rows[0]?.id;
            if (!userId) {
                httpRequestsTotal.inc({ endpoint: 'register', method: 'POST', status_code: '500'});
                res.status(500).json({error: 'Internal server error'});
                return;
            }
            await db.query(`
            INSERT INTO
                user_roles (user_id, role_id)
            VALUES
                ($1, 2);
            `, [userId]);
            console.log(`Database message: ${JSON.stringify(result)}`);
            await db.end();
            console.log('Disconnected from database');
            httpRequestsTotal.inc({ endpoint: 'register', method: 'POST', status_code: '200'});
            res.json({message: 'Registration successful'});
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'register', method: 'POST', status_code: '500'});
            res.status(500).json({error: 'Internal server error'});
        }
    })

    return router;
};