/**
 * Seed / update a login user.
 * Usage:  node server/scripts/seedUser.js <username> <password> [company1,company2]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const crypto = require('crypto');
const { connect, collections, disconnect } = require('../config/db');

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

(async () => {
    const [, , username, password, companies] = process.argv;
    if (!username || !password) {
        console.error('Usage: node server/scripts/seedUser.js <username> <password> [company1,company2]');
        process.exit(1);
    }
    await connect();
    await collections.users().updateOne(
        { username },
        { $set: {
            username,
            passwordHash: hashPassword(password),
            companies: companies ? companies.split(',').map((s) => s.trim()) : null,
            updatedAt: new Date(),
        } },
        { upsert: true },
    );
    console.log(`✅ User "${username}" seeded.`);
    await disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
