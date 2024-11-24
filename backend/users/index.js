const express = require('express');
const pg = require('pg');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();

module.exports = function (httpRequestsTotal, dbConfig) {

    // Validación de entrada
    const validateInput = (data) => {
        const errors = {};

        // Validar username
        const usernameRegex = /^[a-zA-Z0-9\-]{1,30}$/;
        if (!data.username || !usernameRegex.test(data.username)) {
            errors.username = 'Invalid username. Only alphanumeric characters and hyphens are allowed (max 30 characters).';
        }

        // Validar LinkedIn Profile
        const linkedinRegex = /^(https?:\/\/(www\.)?linkedin\.com\/.*|[a-zA-Z0-9\-]{1,30})$/;
        if (!data.website || !linkedinRegex.test(data.website)) {
            errors.website = 'Invalid LinkedIn profile. Must be a valid URL or a LinkedIn username.';
        }

        // Validar first_name y last_name
        if (!data.first_name || data.first_name.length < 1 || data.first_name.length > 50) {
            errors.first_name = 'First name must be between 1 and 50 characters.';
        }
        if (!data.last_name || data.last_name.length < 1 || data.last_name.length > 50) {
            errors.last_name = 'Last name must be between 1 and 50 characters.';
        }

        // Validar email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!data.email || !emailRegex.test(data.email)) {
            errors.email = 'Invalid email address.';
        }

        // Validar phone (opcional)
        const phoneRegex = /^\+?[0-9]{10,15}$/;
        if (data.phone && !phoneRegex.test(data.phone)) {
            errors.phone = 'Invalid phone number. Must be between 10 and 15 digits and may start with +.';
        }

        // Validar bio (opcional)
        if (data.bio && data.bio.length > 500) {
            errors.bio = 'Bio must not exceed 500 characters.';
        }

        return errors;
    };

    router.post('/:id', async (req, res) => {
        const userId = parseInt(req.params.id);
        const inputData = req.body;

        // Validar datos del usuario
        const validationErrors = validateInput(inputData);
        if (Object.keys(validationErrors).length > 0) {
            return res.status(400).json({ errors: validationErrors });
        }

        try {
            const db = new pg.Client(dbConfig);
            await db.connect();

            const { bio, username, first_name, last_name, email, phone, website } = inputData;

            // Actualizar usuario
            await db.query(`
                UPDATE users
                SET username = $1
                WHERE id = $2;
            `, [username, userId]);

            // Actualizar perfil
            await db.query(`
                UPDATE profiles
                SET bio = $1, first_name = $2, last_name = $3, email = $4, phone = $5, website = $6
                WHERE user_id = $7;
            `, [bio, first_name, last_name, email, phone, website, userId]);

            await db.end();

            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'POST', status_code: '200' });
            res.json({ message: 'Profile updated successfully.' });
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'POST', status_code: '500' });
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.get('/', async (req, res) => {
        if (req.session?.role !== 'admin') {
            httpRequestsTotal.inc({ endpoint: 'users', method: 'GET', status_code: '401' });
            console.log('Access denied: User role is not admin.');
            return res.status(401).json({ error: 'Unauthorized. Admin role is required.' });
        }
    
        const db = new pg.Client(dbConfig);
        try {
            await db.connect();
            console.log('Database connection established.');
    
            // Verify role from the database for added security
            const roleQuery = `
                SELECT r.role_name
                FROM roles r
                JOIN user_roles ur ON r.id = ur.role_id
                WHERE ur.user_id = $1;
            `;
            const roleResult = await db.query(roleQuery, [req.session.userId]);
            const userRole = roleResult?.rows[0]?.role_name;
    
            if (userRole !== 'admin') {
                console.log(`Access denied: User role is ${userRole}. Admin role required.`);
                return res.status(401).json({ error: 'Unauthorized. Admin role is required.' });
            }
    
            console.log(`Authorized: User role is ${userRole}. Fetching users...`);
    
            // Fetch all users
            const usersQuery = `
                SELECT
                    u.id,
                    u.username,
                    p.bio,
                    p.first_name,
                    p.last_name,
                    p.email,
                    p.phone,
                    p.website,
                    r.role_name
                FROM users u
                JOIN profiles p ON u.id = p.user_id
                JOIN user_roles ur ON u.id = ur.user_id
                JOIN roles r ON ur.role_id = r.id;
            `;
            const usersResult = await db.query(usersQuery);
    
            console.log(`Fetched ${usersResult.rows.length} users from the database.`);
            httpRequestsTotal.inc({ endpoint: 'users', method: 'GET', status_code: '200' });
    
            return res.json(usersResult.rows);
        } catch (error) {
            console.error('Error fetching users:', error.message);
            httpRequestsTotal.inc({ endpoint: 'users', method: 'GET', status_code: '500' });
            return res.status(500).json({ error: 'Internal server error' });
        } finally {
            await db.end();
            console.log('Database connection closed.');
        }
    });
    

    router.get('/:id', async (req, res) => {
        const db = new pg.Client(dbConfig);
        try {
            await db.connect();
            console.log('Database connection established.');
    
            const userId = parseInt(req.params.id, 10);
            if (isNaN(userId)) {
                console.log('Invalid user ID provided.');
                return res.status(400).json({ error: 'Invalid user ID.' });
            }
    
            console.log(`Fetching data for user ID: ${userId}`);
    
            // Fetch specific user data
            const userQuery = `
                SELECT
                    u.id,
                    u.username,
                    p.bio,
                    p.first_name,
                    p.last_name,
                    p.email,
                    p.phone,
                    p.website,
                    r.role_name
                FROM users u
                JOIN profiles p ON u.id = p.user_id
                JOIN user_roles ur ON u.id = ur.user_id
                JOIN roles r ON ur.role_id = r.id
                WHERE u.id = $1;
            `;
            const userResult = await db.query(userQuery, [userId]);
    
            if (userResult.rows.length === 0) {
                console.log(`User ID ${userId} not found.`);
                return res.status(404).json({ error: `User with ID ${userId} not found.` });
            }
    
            console.log(`User data fetched successfully for user ID: ${userId}`);
            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'GET', status_code: '200' });
    
            return res.json(userResult.rows[0]);
        } catch (error) {
            console.error(`Error fetching user with ID ${req.params.id}:`, error.message);
            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'GET', status_code: '500' });
            return res.status(500).json({ error: 'Internal server error' });
        } finally {
            await db.end();
            console.log('Disconnected from database');
            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'GET', status_code: '200' });
            res.json(user?.rows[0]);
        }
    });
    

    router.post('/:id', async (req, res) => {

        const userId = parseInt(req.params.id);
        const inputData = req.body;

        // Validar datos del usuario
        const validationErrors = validateInput(inputData);
        if (Object.keys(validationErrors).length > 0) {
            return res.status(400).json({ errors: validationErrors });
        }

        try {
            const db = new pg.Client(dbConfig);
            await db.connect();

            const { bio, username, first_name, last_name, email, phone, website } = inputData;
            console.log(`User: ${bio} ${username} ${first_name} ${last_name} ${email} ${phone} ${website}`);

            const user = await db.query(`
            UPDATE
                users u
            SET
                username = '${username}'
            WHERE
                u.id = ${userId};
            `);
            console.log(`User rows: ${JSON.stringify(user)}`);

            const profile = await db.query(`
            UPDATE
                profiles p
            SET
                bio = $1,
                first_name = $2,
                last_name = $3,
                email = $4,
                phone = $5,
                website = $6
            WHERE
                p.user_id = $7;
            `, [bio, first_name, last_name, email, phone, website, userId]);
            console.log(`Database message: ${JSON.stringify(profile)}`);

            await db.end();
            console.log('Disconnected from database');

            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'POST', status_code: '200' });
            res.json({ message: 'User updated' });
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'POST', status_code: '500' });
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.get('/:id', [
        param('id').isInt().withMessage('El ID de usuario debe ser un número entero').toInt(),
    ], async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const db = new pg.Client(dbConfig);
        try {
            await db.connect();
            const userId = req.params.id;

            const user = await db.query(`
            SELECT u.id, u.username, p.bio, p.first_name, p.last_name, p.email, p.phone, p.website, r.role_name
            FROM users u
            JOIN profiles p ON u.id = p.user_id
            JOIN user_roles ur ON u.id = ur.user_id
            JOIN roles r ON ur.role_id = r.id
            WHERE u.id = $1;
            `, [userId]);

            await db.end();
            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'GET', status_code: '200' });
            res.json(user?.rows[0]);
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'GET', status_code: '500' });
            res.status(500).json({ error: 'Error interno del servidor' });
        }
    });

    router.post('/:id', [
        param('id').isInt().withMessage('El ID de usuario debe ser un número entero').toInt(),
        body('username').trim().escape(),
        body('bio').trim().escape(),
        body('first_name').trim().escape(),
        body('last_name').trim().escape(),
        body('email').isEmail().withMessage('El correo electrónico no es válido').normalizeEmail(),
        body('phone').optional().isMobilePhone().withMessage('El número de teléfono no es válido'),
        body('website').optional().isURL().withMessage('La URL no es válida').trim()
    ], async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const db = new pg.Client(dbConfig);
        try {
            await db.connect();
            const userId = req.params.id;
            const { bio, username, first_name, last_name, email, phone, website } = req.body;

            await db.query(`
                UPDATE users SET username = $1 WHERE id = $2;
            `, [username, userId]);

            await db.query(`
                UPDATE profiles SET bio = $1, first_name = $2, last_name = $3, email = $4, phone = $5, website = $6
                WHERE user_id = $7;
            `, [bio, first_name, last_name, email, phone, website, userId]);

            await db.end();
            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'POST', status_code: '200' });
            res.json({ message: 'Usuario actualizado' });
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'POST', status_code: '500' });
            res.status(500).json({ error: 'Error interno del servidor' });
        }
    });

    router.get('/:id/payments', [
        param('id').isInt().withMessage('El ID de usuario debe ser un número entero').toInt()
    ], async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const db = new pg.Client(dbConfig);
        try {
            await db.connect();
            const userId = req.params.id;

            const payments = await db.query(`
            SELECT p.id, p.amount, p.date, p.description
            FROM payments p
            WHERE p.user_id = $1;
            `, [userId]);

            await db.end();
            console.log('Disconnected from database');
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'GET', status_code: '200' });
            res.json(payments?.rows);
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'GET', status_code: '500' });
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    router.post('/:id/payments', [
        // Validaciones de los parámetros y el cuerpo de la solicitud
        param('id').isInt().withMessage('El ID de usuario debe ser un número entero').toInt(),
        body('amount').isFloat({ gt: 0 }).withMessage('La cantidad debe ser un número positivo'),
        body('date').isISO8601().withMessage('La fecha debe estar en formato ISO8601').toDate(),
        body('description').trim().escape()
    ], async (req, res) => {
        // Validar errores
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        // Conexión a la base de datos
        const db = new pg.Client(dbConfig);

        try {
            await db.connect();
            console.log('Conexión a la base de datos establecida.');

            // Extraer datos de la solicitud
            const userId = req.params.id;
            const { amount, date, description } = req.body;

            console.log(`Datos recibidos: User ID: ${userId}, Amount: ${amount}, Date: ${date}, Description: ${description}`);

            // Insertar pago en la base de datos
            const result = await db.query(`
                INSERT INTO payments (user_id, amount, date, description)
                VALUES ($1, $2, $3, $4);
            `, [userId, amount, date, description]);

            console.log(`Resultado de la consulta: ${JSON.stringify(result)}`);

            // Responder éxito
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'POST', status_code: '200' });
            res.status(200).json({ message: 'Pago agregado exitosamente' });
        } catch (err) {
            console.error('Error durante la ejecución:', err);

            // Incrementar métrica de error
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'POST', status_code: '500' });

            // Responder con error interno del servidor
            res.status(500).json({ error: 'Error interno del servidor' });
        } finally {
            // Cerrar conexión a la base de datos
            await db.end();
            console.log('Conexión a la base de datos cerrada.');
        }
    });

    router.get('/:id/courses', [
        param('id').isInt().withMessage('El ID de usuario debe ser un número entero').toInt()
    ], async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const db = new pg.Client(dbConfig);
        try {
            await db.connect();
            const userId = req.params.id;

            const courses = await db.query(`
            SELECT c.id, c.course_name, c.course_description, c.course_code
            FROM courses c
            JOIN user_courses cu ON c.id = cu.course_id
            WHERE cu.user_id = $1;
            `, [userId]);

            await db.end();
            console.log('Disconnected from database');
            httpRequestsTotal.inc({ endpoint: 'users_id_courses', method: 'GET', status_code: '200' });
            res.json(courses?.rows);
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id_courses', method: 'GET', status_code: '500' });
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
};
