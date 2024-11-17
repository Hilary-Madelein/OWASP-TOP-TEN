const express = require('express');
const pg = require('pg');
const router = express.Router();

module.exports = function (httpRequestsTotal, dbConfig) {
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
            console.log('Database connection closed.');
        }
    });
    

    router.post('/:id', async (req, res) => {
        try {
            const db = new pg.Client(dbConfig);
            await db.connect();
            const userId = parseInt(req.params.id);
            console.log(`User id: ${userId}`);

            const { bio, username, first_name, last_name, email, phone, website } = req.body;
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

            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'POST', status_code: '200'});
            res.json({ message: 'User updated' });
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id', method: 'POST', status_code: '500'});
            res.status(500).json({error: 'Internal server error'});
        }
    });

    router.get('/:id/payments', async (req, res) => {
        const db = new pg.Client(dbConfig);
        try {
            await db.connect();
            const userId = parseInt(req.params.id);
            console.log(`User id: ${userId}`);
            const payments = await db.query(`
            SELECT
                p.id,
                p.amount,
                p.date,
                p.description
            FROM 
                payments p
            WHERE
                p.user_id = $1;
            `, [userId]);
            console.log(`Database message: ${JSON.stringify(payments)}`);
            await db.end();
            console.log('Disconnected from database');
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'GET', status_code: '200'});
            res.json(payments?.rows);
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'GET', status_code: '500'});
            res.status(500).json({error: 'Internal server error'});
        }
    })

    router.post('/:id/payments', async (req, res) => {
        try {
            const db = new pg.Client(dbConfig);
            await db.connect();
            const userId = parseInt(req.params.id);
            console.log(`User id: ${userId}`);
            const { amount, date, description } = req.body;
            console.log(`Payment: ${amount} ${date} ${description}`);
            const result = await db.query(`
            INSERT INTO
                payments (user_id, amount, date, description)
            VALUES
                ($1, $2, $3, $4);
            `, [userId, amount, date, description]);
            console.log(`Database message: ${JSON.stringify(result)}`);
            await db.end();
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'POST', status_code: '200'});
            console.log('Disconnected from database');
            res.json({message: 'Payment added'});
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id_payments', method: 'POST', status_code: '500'});
            res.status(500).json({error: 'Internal server error'});
        }
    })

    router.get('/:id/courses', async (req, res) => {
        const db = new pg.Client(dbConfig);
        try {
            await db.connect();
            const userId = parseInt(req.params.id);
            console.log(`User id: ${userId}`);
            const courses = await db.query(`
            SELECT
                c.id,
                c.course_name,
                c.course_description,
                c.course_code
            FROM 
                courses c
            JOIN 
                user_courses cu ON c.id = cu.course_id
            WHERE
                cu.user_id = $1;
            `, [userId]);
            console.log(`Database message: ${JSON.stringify(courses)}`);
            await db.end();
            console.log('Disconnected from database');
            httpRequestsTotal.inc({ endpoint: 'users_id_courses', method: 'GET', status_code: '200'});
            res.json(courses?.rows);
        } catch (err) {
            console.error(err);
            httpRequestsTotal.inc({ endpoint: 'users_id_courses', method: 'GET', status_code: '500'});
            res.status(500).json({error: 'Internal server error'});
        }
    })

    return router;
};