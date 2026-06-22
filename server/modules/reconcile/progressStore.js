/**
 * In-memory progress store, keyed by sessionId, for row-by-row upload progress.
 *
 * NOTE: in-memory is fine for a single backend process. If you scale the
 * backend to more than one replica behind a load balancer, swap this for
 * Redis (ioredis) so all replicas share progress.
 */
const progressMap = new Map();

module.exports = {
    set: (sessionId, data) => progressMap.set(sessionId, { ...data, timestamp: Date.now() }),
    get: (sessionId) => progressMap.get(sessionId),
    delete: (sessionId) => progressMap.delete(sessionId),
    cleanup: () => {
        const now = Date.now();
        for (const [key, value] of progressMap.entries()) {
            if (now - value.timestamp > 600000) progressMap.delete(key);
        }
    },
};
