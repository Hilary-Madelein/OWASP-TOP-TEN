const express = require('express');
const axios = require('axios');
const router = express.Router();

const whitelist = ['dummyjson.com', 'jsonplaceholder.typicode.com'];

const isWhitelisted = (url) => {
    try {
        const urlObj = new URL(url); // Valida si es una URL válida
        return whitelist.includes(urlObj.hostname); // Verifica si el dominio está en la lista blanca
    } catch (error) {
        console.error(`Invalid URL format: ${url}`);
        return false; // Si no es una URL válida, no pasa la validación
    }
};

module.exports = function (httpRequestsTotal, dbConfig) {
    router.get('/', async (req, res) => {
        const { datasource } = req.query;

        // Validar que datasource esté presente
        if (!datasource) {
            httpRequestsTotal.inc({ endpoint: 'authors', method: 'GET', status_code: '400' });
            return res.status(400).json({ error: 'Parameter "datasource" is required' });
        }

        console.log(`Incoming request for datasource: ${datasource}`);

        // Validar que el dominio esté permitido
        if (!isWhitelisted(datasource)) {
            httpRequestsTotal.inc({ endpoint: 'authors', method: 'GET', status_code: '403' });
            return res.status(403).json({ error: 'Access to this datasource is not allowed' });
        }

        try {
            // Hacer la solicitud al datasource
            console.log(`Fetching data from: ${datasource}`);
            const response = await axios.get(datasource);

            // Incrementar métricas y responder con los datos
            httpRequestsTotal.inc({ endpoint: 'authors', method: 'GET', status_code: '200' });
            res.json({ success: true, data: response.data });
        } catch (err) {
            console.error(`Error fetching data from datasource: ${err.message}`);

            // Manejo de errores específicos de Axios
            if (err.response) {
                console.error(`Datasource returned status: ${err.response.status}`);
                httpRequestsTotal.inc({ endpoint: 'authors', method: 'GET', status_code: err.response.status });
                return res.status(err.response.status).json({
                    error: `Datasource error: ${err.response.statusText}`,
                });
            } else if (err.request) {
                console.error('No response received from datasource');
                httpRequestsTotal.inc({ endpoint: 'authors', method: 'GET', status_code: '504' });
                return res.status(504).json({ error: 'No response from datasource' });
            } else {
                console.error('Request setup error');
                httpRequestsTotal.inc({ endpoint: 'authors', method: 'GET', status_code: '500' });
                return res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    return router;
};
