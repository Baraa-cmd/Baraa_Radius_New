import React, { useState } from 'react';
import { Eye, EyeOff, Lock, Mail, MessageCircle, ShieldCheck, User } from 'lucide-react';
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
  const [supportOpen, setSupportOpen] = useState(false);

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
    <div className="min-h-screen bg-[#F4F6FA] dark:bg-[#090B10] flex flex-col">
      {/* Ocean Cobalt-Teal Header with Ambient Radial Glow */}
      <div className="relative overflow-hidden bg-gradient-to-b from-[#072B50] via-[#0369A1] to-[#0D9488] pt-14 pb-24 px-6 text-center text-white">
        <div
          className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[420px] h-[420px] rounded-full bg-cyan-300/15 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative max-w-md mx-auto flex flex-col items-center">
          <div className="p-2 rounded-[26px] bg-white/10 backdrop-blur-md border border-white/15 shadow-2xl">
            <BroLogo size="lg" />
          </div>
          <h1 className="mt-5 text-3xl font-extrabold tracking-tight" dir="ltr">
            Bro Radius
          </h1>
          <p className="mt-1.5 text-sm text-sky-100/90 font-medium">
            منصة مراقبة وإدارة راوترات MikroTik والمشتركين الحقيقية
          </p>
        </div>
      </div>

      {/* Elevated Sheet Card */}
      <div className="flex-1 px-4 -mt-14 pb-10 relative z-10">
        <div className="max-w-md mx-auto bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] rounded-[28px] p-6 sm:p-8 shadow-2xl shadow-slate-900/10 dark:shadow-black/60">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-slate-900 dark:text-white">
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
                    value={networkName}
                    onChange={(e) => setNetworkName(e.target.value)}
                    placeholder="اسم الشبكة أو البرج"
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
              className="w-full min-h-[50px] rounded-2xl bg-gradient-to-l from-sky-600 to-teal-600 hover:from-sky-500 hover:to-teal-500 text-white font-bold text-sm shadow-lg shadow-sky-900/25 transition-all active:scale-[0.99] disabled:opacity-60"
            >
              {loading ? 'جاري التحقق...' : mode === 'login' ? 'دخول' : 'إنشاء الحساب'}
            </button>
          </form>

          <div className="mt-5 pt-5 border-t border-slate-200/80 dark:border-white/[0.07] space-y-3">
            <div className="rounded-2xl bg-slate-50 dark:bg-[#171C28] border border-slate-200/80 dark:border-white/[0.06] px-4 py-3 flex items-center gap-3 text-xs text-slate-600 dark:text-slate-300">
              <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
              <span>تشفير AES-256-GCM لبيانات الراوتر واتصال مباشر عبر MikroTik API</span>
            </div>

            <PWAInstallButton />
          </div>
        </div>

        <div className="max-w-md mx-auto mt-5 space-y-3">
          <button
            type="button"
            onClick={() => setSupportOpen((prev) => !prev)}
            className="w-full min-h-[50px] rounded-2xl bg-[#22C55E] hover:bg-[#16A34A] text-white font-bold text-sm flex items-center justify-center gap-2.5 shadow-lg shadow-emerald-900/20 transition-colors"
          >
            <MessageCircle className="w-4 h-4" />
            <span>دليل الربط والدعم الهندسي</span>
          </button>

          {supportOpen && (
            <div className="rounded-2xl bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-4 text-xs text-slate-600 dark:text-slate-300 leading-relaxed text-center">
              بعد تسجيل الدخول يمكنك إضافة أي راوتر MikroTik وسحب بيانات الهاردوير والمنافذ والمشتركين تلقائياً دون الحاجة لإدخال الموديل يدوياً.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
