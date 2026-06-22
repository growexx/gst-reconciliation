import { createContext, useContext, useState, useEffect } from 'react';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const savedToken = localStorage.getItem('token');
        const savedUser = localStorage.getItem('user');
        if (savedToken && savedUser) {
            setToken(savedToken);
            setUser(JSON.parse(savedUser));
        }
        setLoading(false);
    }, []);

    const login = (tokenValue, userData) => {
        localStorage.setItem('token', tokenValue);
        localStorage.setItem('user', JSON.stringify(userData));
        // Compatibility keys used by the copied reco components:
        localStorage.setItem('sessionId', tokenValue);
        if (userData?.company) localStorage.setItem('company', userData.company);
        if (userData?.company) localStorage.setItem('database', userData.company);
        if (userData?.username) localStorage.setItem('username', userData.username);
        setToken(tokenValue);
        setUser(userData);
    };

    const logout = async () => {
        try {
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
            });
        } catch { /* ignore */ }
        ['token', 'user', 'sessionId', 'company', 'database', 'username',
         'uploadedFile', 'selectedMonth', 'selectedYear', 'unmatchedBills', 'isReconciled']
            .forEach((k) => localStorage.removeItem(k));
        setToken(null);
        setUser(null);
    };

    return (
        <AuthContext.Provider value={{ user, token, loading, login, logout, isAuthenticated: !!token }}>
            {children}
        </AuthContext.Provider>
    );
}
