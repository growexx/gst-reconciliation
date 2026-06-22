import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { ChevronDown } from 'lucide-react';
import api from '../api/axios';

export default function Login() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [company, setCompany] = useState('');
    const [companies, setCompanies] = useState([]);
    const [loadingCompanies, setLoadingCompanies] = useState(true);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const { login } = useAuth();

    useEffect(() => {
        (async () => {
            try {
                const { data } = await api.get('/auth/companies');
                setCompanies(data.companies || []);
                if (data.companies?.length > 0) setCompany(data.companies[0]);
            } catch {
                setCompanies(['COMP1']);
                setCompany('COMP1');
            } finally {
                setLoadingCompanies(false);
            }
        })();
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const { data } = await api.post('/auth/login', { username, password, company });
            login(data.token, data.user);
        } catch (err) {
            setError(err.response?.data?.message || 'Login failed. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-background flex items-center justify-center px-4 relative overflow-hidden">
            <div className="fixed inset-0 pointer-events-none">
                <div className="absolute -top-40 -right-40 w-80 h-80 bg-primary/10 rounded-full blur-3xl" />
                <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-primary/5 rounded-full blur-3xl" />
            </div>

            <div className="relative w-full max-w-md animate-fade-in-up">
                <div className="text-center mb-8">
                    <div className="inline-flex items-center justify-center mb-4 w-20 h-20 rounded-2xl bg-primary/10 text-4xl">🧾</div>
                    <h1 className="text-2xl font-bold text-foreground">GST Reconciliation</h1>
                    <p className="text-sm text-muted-foreground mt-1">2A / 2B matching &amp; unmatched bills</p>
                </div>

                <div className="rounded-2xl border border-border bg-card/80 backdrop-blur-xl p-8 shadow-2xl">
                    <form onSubmit={handleSubmit} className="space-y-5">
                        {error && (
                            <div className="animate-slide-down bg-destructive/10 border border-destructive/20 text-destructive text-sm px-4 py-3 rounded-xl">
                                {error}
                            </div>
                        )}

                        <div>
                            <label className="block text-sm font-medium text-muted-foreground mb-2">Company</label>
                            {loadingCompanies ? (
                                <div className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-muted-foreground text-sm">
                                    Loading companies...
                                </div>
                            ) : (
                                <div className="relative">
                                    <select
                                        value={company}
                                        onChange={(e) => setCompany(e.target.value)}
                                        className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all appearance-none cursor-pointer pr-10"
                                        required
                                    >
                                        {companies.map((c) => (<option key={c} value={c}>{c}</option>))}
                                    </select>
                                    <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                                </div>
                            )}
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-muted-foreground mb-2">Username</label>
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-foreground placeholder-muted-foreground/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                                placeholder="Username"
                                required
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-muted-foreground mb-2">Password</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-foreground placeholder-muted-foreground/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all"
                                placeholder="Password"
                                required
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading || loadingCompanies}
                            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold py-3 rounded-xl transition-all duration-200 shadow-lg shadow-primary/25 hover:shadow-primary/40 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                        >
                            {loading ? 'Signing in...' : 'Sign In'}
                        </button>
                    </form>

                    <div className="mt-6 pt-5 border-t border-border">
                        <p className="text-center text-muted-foreground/60 text-xs">
                            Protected system. Authorized access only.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
