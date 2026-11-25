import React, { useState } from 'react';
import { Eye, EyeOff, Lock, Mail, MessageCircle, User } from 'lucide-react';
import type { AuthUser } from '../types';
import { BroLogo } from './BroLogo';
import { PWAInstallButton } from './PWAInstallButton';

interface AuthScreenProps {
  onAuthenticated: (token: string, user: AuthUser) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [networkName, setNetworkName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body =
        mode === 'login' ? { email, password } : { name, networkName, email, password };

      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'تعذر إتمام الطلب');
        return;
      }
      onAuthenticated(data.token, data.user);
    } catch {
      setError('تعذر الاتصال بالخادم، يرجى المحاولة مرة أخرى');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F4F6FA] dark:bg-[#070B14] flex flex-col justify-center py-10 px-4 relative overflow-hidden">
      {/* Ambient background glows */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-sky-500/10 blur-[140px] pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-[400px] h-[400px] rounded-full bg-teal-500/10 blur-[120px] pointer-events-none" />

      <div className="max-w-md w-full mx-auto relative z-10 space-y-6">
        {/* Animated Header & Logo */}
        <div className="text-center space-y-3">
          <div className="relative w-20 h-20 mx-auto flex items-center justify-center">
            <div className="absolute inset-0 rounded-3xl border border-sky-400/40 animate-[spin_10s_linear_infinite]" />
            <div className="p-2 rounded-[24px] bg-gradient-to-br from-sky-500/20 to-teal-500/20 backdrop-blur-xl border border-white/20 shadow-2xl animate-pulse">
              <BroLogo size="lg" />
            </div>
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-wider text-slate-900 dark:text-white" dir="ltr">
              Bro Radius
            </h1>
            <p className="text-xs text-slate-500 dark:text-sky-200/70 font-medium mt-1">
              منصة إدارة وتوجيه راوترات MikroTik والمشتركين الذكية
            </p>
          </div>
        </div>

        {/* Auth Card */}
        <div className="bg-white/90 dark:bg-[#111622]/90 backdrop-blur-xl border border-slate-200/80 dark:border-white/[0.08] rounded-[32px] p-7 sm:p-9 shadow-2xl shadow-slate-900/10 dark:shadow-black/70 space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-extrabold text-slate-900 dark:text-white">
              {mode === 'login' ? 'تسجيل الدخول' : 'إنشاء حساب شبكة'}
            </h2>
            <button
              type="button"
              onClick={() => {
                setMode((m) => (m === 'login' ? 'register' : 'login'));
                setError(null);
              }}
              className="text-xs font-bold text-sky-600 dark:text-sky-400 hover:underline min-h-[40px] px-2"
            >
              {mode === 'login' ? 'إنشاء حساب جديد' : 'لدي حساب بالفعل'}
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="الاسم الكامل"
                    className="w-full min-h-[50px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] pr-11 pl-4 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-sky-500 transition-colors"
                  />
                </div>
                <div>
                  <input
                    type="text"
                    required
                    value={networkName}
                    onChange={(e) => setNetworkName(e.target.value)}
                    placeholder="اسم الشبكة"
                    className="w-full min-h-[50px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-4 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-sky-500 transition-colors"
                  />
                </div>
              </>
            )}

            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2" />
              <input
                type="email"
                required
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="البريد الإلكتروني"
                className="w-full min-h-[50px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] pr-11 pl-4 text-sm text-left font-mono text-slate-900 dark:text-white placeholder:text-right placeholder:font-sans placeholder:text-slate-400 focus:outline-none focus:border-sky-500 transition-colors"
              />
            </div>

            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2" />
              <input
                type={showPassword ? 'text' : 'password'}
                required
                minLength={6}
                dir="ltr"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="كلمة المرور"
                className="w-full min-h-[50px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] pr-11 pl-12 text-sm text-left font-mono text-slate-900 dark:text-white placeholder:text-right placeholder:font-sans placeholder:text-slate-400 focus:outline-none focus:border-sky-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword((prev) => !prev)}
                className="absolute left-1.5 top-1/2 -translate-y-1/2 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {error && (
              <div className="rounded-2xl bg-red-500/10 border border-red-500/25 px-4 py-3 text-xs font-semibold text-red-500">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full min-h-[52px] rounded-2xl bg-gradient-to-l from-sky-600 to-teal-600 hover:from-sky-500 hover:to-teal-500 text-white font-extrabold text-sm shadow-xl shadow-sky-900/30 transition-all active:scale-[0.99] disabled:opacity-60"
            >
              {loading ? 'جاري التحقق...' : mode === 'login' ? 'تسجيل الدخول' : 'إنشاء الحساب'}
            </button>
          </form>

          <div className="pt-4 border-t border-slate-200/80 dark:border-white/[0.07] space-y-3">
            <a
              href="https://wa.me/905072415450"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full min-h-[50px] rounded-2xl bg-[#22C55E] hover:bg-[#16A34A] text-white font-extrabold text-sm flex items-center justify-center gap-2.5 shadow-lg shadow-emerald-900/20 transition-colors"
            >
              <MessageCircle className="w-5 h-5" />
              <span>تواصل مع الدعم الفني</span>
            </a>

            <div className="flex justify-center">
              <PWAInstallButton />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
