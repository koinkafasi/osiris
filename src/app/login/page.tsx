'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { Radar, Lock, User, ArrowRight, AlertTriangle } from 'lucide-react';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || 'Giriş başarısız');
        setLoading(false);
        return;
      }
      const next = searchParams.get('next') || '/';
      router.push(next);
      router.refresh();
    } catch {
      setError('Bağlantı hatası — tekrar deneyin');
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen w-full flex items-center justify-center relative overflow-hidden"
      style={{ background: 'var(--bg-void)' }}
    >
      {/* Ambient radar-sweep backdrop */}
      <div className="absolute inset-0 pointer-events-none opacity-30">
        <div
          className="absolute top-1/2 left-1/2 w-[140vmax] h-[140vmax] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(212,175,55,0.06) 0%, transparent 55%)',
          }}
        />
        <div className="absolute inset-0" style={{
          backgroundImage:
            'linear-gradient(rgba(212,175,55,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(212,175,55,0.035) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }} />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="glass-panel p-8 w-[92vw] max-w-[380px] relative z-10"
      >
        <div className="flex flex-col items-center mb-6">
          <div className="relative mb-3">
            <div className="absolute inset-0 rounded-full bg-[var(--gold-primary)]/20 blur-xl" />
            <div className="relative w-12 h-12 rounded-full border border-[var(--gold-primary)]/40 flex items-center justify-center">
              <Radar className="w-6 h-6 text-[var(--gold-primary)] animate-osiris-pulse" />
            </div>
          </div>
          <span className="hud-text text-[16px] tracking-[0.2em] text-[var(--text-primary)]">OSIRIS</span>
          <span className="gotham-tag gotham-tag--low mt-2" style={{ fontSize: '8px', padding: '2px 6px' }}>
            RESTRICTED ACCESS
          </span>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <User className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              type="text"
              autoComplete="username"
              placeholder="Kullanıcı adı"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full pl-9 pr-3 py-2.5 rounded-lg text-[12px] font-mono bg-[var(--hover-accent)] border border-[var(--border-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--gold-primary)]/60 transition-colors"
            />
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Şifre"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full pl-9 pr-3 py-2.5 rounded-lg text-[12px] font-mono bg-[var(--hover-accent)] border border-[var(--border-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--gold-primary)]/60 transition-colors"
            />
          </div>

          {error && (
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-[var(--alert-red)]/40 bg-[var(--alert-red)]/10 text-[var(--alert-red)] text-[10px] font-mono">
              <AlertTriangle className="w-3 h-3 shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg text-[11px] font-mono font-bold tracking-widest text-black bg-[var(--gold-primary)] hover:brightness-110 disabled:opacity-50 transition-all mt-2"
          >
            {loading ? 'DOĞRULANIYOR...' : 'GİRİŞ'}
            {!loading && <ArrowRight className="w-3.5 h-3.5" />}
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-[var(--border-primary)] text-center">
          <span className="text-[9px] font-mono text-[var(--text-muted)] tracking-wider">
            osirisai.live · yetkisiz erişim izlenmektedir
          </span>
        </div>
      </motion.div>
    </div>
  );
}
