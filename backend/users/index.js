const express = require('express');
const pg = require('pg');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();

module.exports = function (httpRequestsTotal, dbConfig) {

    router.get('/', async (req, res) => {
        if (!req.session?.userId) {
            httpRequestsTotal.inc({ endpoint: 'users', method: 'GET', status_code: '401' });
            res.status(401).json({ error: 'No autorizado' });
            return;
        }

        const db = new pg.Client(dbConfig);
        try {
            await db.connect();

            const role = await db.query(`
            SELECT r.role_name
            FROM roles r
            JOIN user_roles ur ON r.id = ur.role_id
            WHERE ur.user_id = $1;
          `, [req.session.userId]);

            const roleName = role?.rows[0]?.role_name;
            if (roleName !== 'admin') {
                res.status(401).json({ error: 'No autorizado' });
                return;
            }

            const users = await db.query(`
            SELECT u.id, u.username, p.bio, p.first_name, p.last_name, p.email, p.phone, p.website, r.role_name
            FROM users u
            JOIN profiles p ON u.id = p.user_id
            JOIN user_roles ur ON u.id = ur.user_id
            JOIN roles r ON ur.role_id = r.id;
          `);

            await db.end();
            httpRequestsTotal.inc({ endpoint: 'users', method: 'GET', status_code: '200' });
            res.json(users?.rows);
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users', method: 'GET', status_code: '500' });
            res.status(500).json({ error: 'Error interno del servidor' });
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
        param('id').isInt().withMessage('El ID debe ser un número entero').toInt(),
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
        param('id').isInt().withMessage('El ID debe ser un número entero').toInt()
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
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'GET', status_code: '200' });
            res.json(payments?.rows);
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'GET', status_code: '500' });
            res.status(500).json({ error: 'Error interno del servidor' });
        }
    });

    router.post('/:id/payments', [
        param('id').isInt().withMessage('El ID de usuario debe ser un número entero').toInt(),
        body('amount').isFloat({ gt: 0 }).withMessage('La cantidad debe ser un número positivo'),
        body('date').isISO8601().withMessage('La fecha debe estar en formato ISO8601').toDate(),
        body('description').trim().escape()
    ], async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const db = new pg.Client(dbConfig);
        try {
            await db.connect();
            const userId = req.params.id;
            const { amount, date, description } = req.body;

            await db.query(`
                INSERT INTO payments (user_id, amount, date, description)
                VALUES ($1, $2, $3, $4);
            `, [userId, amount, date, description]);

            await db.end();
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'POST', status_code: '200' });
            res.json({ message: 'Pago agregado' });
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'POST', status_code: '500' });
            res.status(500).json({ error: 'Error interno del servidor' });
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
            httpRequestsTotal.inc({ endpoint: 'users_id_courses', method: 'GET', status_code: '200' });
            res.json(courses?.rows);
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id_courses', method: 'GET', status_code: '500' });
            res.status(500).json({ error: 'Error interno del servidor' });
        }
    });

    return router;
};
