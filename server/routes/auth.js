/**
 * Authentication — JWT only. No SAP involved.
 *
 * Validates the username/password against the `users` collection (passwords
 * hashed with Node's built-in scrypt). If the users collection is empty, a
 * single bootstrap login from .env (BOOTSTRAP_USER / BOOTSTRAP_PASS) is
 * accepted so you can sign in before seeding real users.
 */
const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { collections } = require('../config/db');
const { verifyToken } = require('../middleware/auth');

function verifyPassword(password, stored) {
    // stored format: "scrypt:<saltHex>:<hashHex>"
    const [scheme, saltHex, hashHex] = String(stored || '').split(':');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// GET /api/companies — list of companies for the login dropdown (from .env).
router.get('/companies', (req, res) => {
    const list = (process.env.COMPANIES || 'Nandan Terry').split(',').map((s) => s.trim()).filter(Boolean);
    res.json({ companies: list });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const company = req.body.company || req.body.database || 'Nandan Terry';
        if (!username || !password) {
            return res.status(400).json({ message: 'Username and password are required.' });
        }

        const usersCount = await collections.users().estimatedDocumentCount();
        let user = null;

        if (usersCount === 0) {
            // Bootstrap mode — accept the .env credentials once, before any user is seeded.
            if (username === process.env.BOOTSTRAP_USER && password === process.env.BOOTSTRAP_PASS) {
                user = { username, companies: null };
            }
        } else {
            const found = await collections.users().findOne({ username });
            if (found && verifyPassword(password, found.passwordHash)) {
                user = { username: found.username, companies: found.companies || null };
            }
        }

        if (!user) return res.status(401).json({ message: 'Invalid credentials.' });

        const payload = { username: user.username, companyId: company };
        const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({
            token,
            user: { username: user.username, company, database: company },
            sapSessionId: null, // kept for client compatibility; always null (no SAP)
        });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

// POST /api/auth/logout — JWT is stateless; nothing to revoke server-side.
router.post('/logout', (req, res) => res.json({ success: true }));

// GET /api/auth/me
router.get('/me', verifyToken, (req, res) => {
    res.json({ username: req.user.username, company: req.user.companyId });
});

module.exports = router;
