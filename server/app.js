const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── API routes ──
app.use('/api/auth', require('./routes/auth'));
app.use('/api/reconcile', require('./routes/reconcile'));

// Login dropdown convenience alias (so the client can call /api/companies).
app.get('/api/companies', (req, res) =>
    res.redirect(307, '/api/auth/companies'));

// ── Health check ──
app.get('/api/health', (req, res) =>
    res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Serve the built frontend (client/dist) only when it's bundled with the
//    server (combined deployment). When the frontend is deployed separately the
//    dist isn't present, so we skip static serving instead of erroring on a
//    missing index.html for every non-API request. ──
const DIST_PATH = path.join(__dirname, '..', 'client', 'dist');
const INDEX_HTML = path.join(DIST_PATH, 'index.html');

if (fs.existsSync(INDEX_HTML)) {
    app.use(express.static(DIST_PATH));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api')) return next();
        res.sendFile(INDEX_HTML);
    });
} else {
    // Backend-only deployment: there is no frontend to serve here.
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api')) return next();
        res.status(404).json({ message: 'Not found. This is the API server.' });
    });
}

// ── Error handler ──
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ message: 'Internal server error.' });
});

module.exports = app;
