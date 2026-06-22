const express = require('express');
const cors = require('cors');
const path = require('path');

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

// ── Serve the built frontend (client/dist) in production ──
const DIST_PATH = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(DIST_PATH));
app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(DIST_PATH, 'index.html'));
    }
});

// ── Error handler ──
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ message: 'Internal server error.' });
});

module.exports = app;
