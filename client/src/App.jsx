import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';

function AppRoutes() {
    const { isAuthenticated, loading } = useAuth();

    if (loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center text-muted-foreground">
                Loading...
            </div>
        );
    }

    return (
        <Routes>
            <Route path="/" element={isAuthenticated ? <Navigate to="/reconcile" replace /> : <Login />} />
            {/*
              Render <Login> IN PLACE when logged out (instead of redirecting to "/"),
              so the URL — including its ?tab=&section=&month= query string — is preserved.
              After login the same URL re-renders <Dashboard>, which restores that state.
            */}
            <Route path="/reconcile" element={isAuthenticated ? <Dashboard /> : <Login />} />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}

export default function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <AppRoutes />
            </AuthProvider>
        </BrowserRouter>
    );
}
