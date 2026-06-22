require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const app = require('./app');
const { connect, disconnect } = require('./config/db');

const PORT = process.env.PORT || 5000;

const start = async () => {
    try {
        await connect();
        const server = app.listen(PORT, () => {
            console.log(`\n🚀 GST Reco server running on http://localhost:${PORT}`);
            console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`   Health:      http://localhost:${PORT}/api/health\n`);
        });

        const shutdown = async (sig) => {
            console.log(`\n${sig} received — shutting down...`);
            server.close(async () => { await disconnect(); process.exit(0); });
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    } catch (err) {
        console.error('❌ Failed to start server:', err.message);
        process.exit(1);
    }
};

start();
