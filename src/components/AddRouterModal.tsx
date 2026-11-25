import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Globe,
  Info,
  KeyRound,
  Lock,
  Router,
  ShieldCheck,
  Terminal,
  Wifi,
  X,
} from 'lucide-react';
import type {
  ApiPermissionMode,
  ConnectionType,
  ProvisionResult,
  RouterDevice,
  ServerCapabilities,
} from '../types';

interface AddRouterModalProps {
  token: string;
  onClose: () => void;
  onRouterAdded: (router: RouterDevice) => void;
}

const CONNECTION_MODES: Array<{
  id: ConnectionType;
  label: string;
  sub: string;
  requiresVps?: boolean;
}> = [
  { id: 'direct', label: 'API مباشر (Public IP / DDNS)', sub: 'منافذ 8728 · 8729 · 443 · 80' },
  { id: 'agent', label: 'Agent HTTPS (خلف NAT)', sub: 'إرسال دوري عبر /tool fetch' },
  { id: 'wireguard', label: 'WireGuard (v7)', sub: 'نفق مشفر تلقائي', requiresVps: true },
  { id: 'sstp', label: 'SSTP (v6 / v7)', sub: 'نفق لإصدارات v6', requiresVps: true },
  { id: 'ovpn', label: 'OpenVPN (v6 / v7)', sub: 'نفق بديل مستقر', requiresVps: true },
];

export const AddRouterModal: React.FC<AddRouterModalProps> = ({
  token,
  onClose,
  onRouterAdded,
}) => {
  const [step, setStep] = useState<'form' | 'script' | 'verified'>('form');
  const [name, setName] = useState('');
  const [connectionType, setConnectionType] = useState<ConnectionType>('direct');
  const [permissionMode, setPermissionMode] = useState<ApiPermissionMode>('read-only');
  const [useExistingCredentials, setUseExistingCredentials] = useState(true);
  const [apiHost, setApiHost] = useState('');
  const [apiPort, setApiPort] = useState('8728');
  const [apiUsername, setApiUsername] = useState('');
  const [apiPassword, setApiPassword] = useState('');

  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provision, setProvision] = useState<ProvisionResult | null>(null);
  const [createdRouter, setCreatedRouter] = useState<RouterDevice | null>(null);
  const [copiedType, setCopiedType] = useState<'install' | 'uninstall' | null>(null);
  const [showUninstall, setShowUninstall] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/capabilities', {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (res.ok) {
          const caps = (await res.json()) as ServerCapabilities;
          setCapabilities(caps);
          setConnectionType(caps.wireguardReady ? 'wireguard' : 'direct');
        }
      } catch {
        // Fallback keeps direct mode selected
      }
    })();
  }, [token]);

  const handleProvision = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    let provisionedOk = false;
    try {
      const res = await fetch('/api/routers/provision', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name,
          connectionType,
          permissionMode,
          useExistingCredentials: connectionType === 'direct' && useExistingCredentials,
          apiHost: apiHost.trim() || undefined,
          apiPort: Number(apiPort) || 8728,
          apiUsername: apiUsername.trim() || undefined,
          apiPassword: apiPassword,
        }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        setError(data.error || `تعذر تجهيز الراوتر (HTTP ${res.status})`);
        return;
      }

      provisionedOk = true;
      setProvision(data.provision);
      setCreatedRouter(data.router);
      onRouterAdded(data.router);

      // Direct mode with existing credentials: connect & verify immediately in 1 step
      if (connectionType === 'direct' && useExistingCredentials) {
        try {
          const verRes = await fetch(`/api/routers/${data.provision.routerId}/verify`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          });
          const verText = await verRes.text();
          const verData = verText ? JSON.parse(verText) : {};
          if (verData.router) {
            setCreatedRouter(verData.router);
            onRouterAdded(verData.router);
          }
          if (verRes.ok && verData.verified) {
            setStep('verified');
            return;
          }
          setError(verData.error || `تم حفظ الراوتر لكن تعذر الاتصال المباشر (HTTP ${verRes.status})`);
          setStep('script');
          return;
        } catch {
          setError('تم حفظ الراوتر بنجاح، لكن انقطع الفحص اللحظي — اضغط "فحص الاتصال" لإعادة المحاولة.');
          setStep('script');
          return;
        }
      }

      setStep('script');
    } catch {
      if (!provisionedOk) {
        setError('تعذر الاتصال بالخادم أثناء تجهيز الراوتر — تأكد من استقرار الشبكة وأعد المحاولة');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (text: string, type: 'install' | 'uninstall') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedType(type);
      setTimeout(() => setCopiedType(null), 2000);
    } catch {
      setCopiedType(null);
    }
  };

  const handleVerifyConnection = async () => {
    if (!provision) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/routers/${provision.routerId}/verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.router) {
        setCreatedRouter(data.router);
        onRouterAdded(data.router);
      }
      if (!res.ok || !data.verified) {
        setError(data.error || 'لم يتمكن السيرفر من الوصول للراوتر بعد');
        return;
      }
      setStep('verified');
    } catch {
      setError('تعذر فحص الاتصال بالراوتر حالياً');
    } finally {
      setLoading(false);
    }
  };

  const selectedNeedsVps =
    (connectionType === 'wireguard' || connectionType === 'sstp' || connectionType === 'ovpn') &&
    capabilities !== null &&
    !capabilities.wireguardReady;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm sm:p-4">
      <div className="w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-t-[28px] sm:rounded-[28px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] shadow-2xl">
        <div className="sm:hidden w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto mt-3" />

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200/80 dark:border-white/[0.07]">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-sky-500 to-teal-500 text-white flex items-center justify-center shadow-md shadow-sky-900/20">
              <Router className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">ربط راوتر MikroTik جديد</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                يتم جلب الموديل والهاردوير والمنافذ والمشتركين تلقائياً من الراوتر
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 dark:hover:bg-white/[0.05]"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          {step === 'form' && (
            <form onSubmit={handleProvision} className="space-y-5">
              {/* Router Name only — NO manual model selection */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  الاسم التعريفي للراوتر
                </label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="مثال: راوتر البرج الرئيسي"
                  className="w-full min-h-[48px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-4 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              {/* Connection Type */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
                  طريقة الاتصال بالراوتر
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {CONNECTION_MODES.map((m) => {
                    const unavailableInPreview = Boolean(m.requiresVps && capabilities && !capabilities.wireguardReady);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setError(null);
                          setConnectionType(m.id);
                        }}
                        className={`text-right rounded-2xl border p-3 transition-all ${
                          connectionType === m.id
                            ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400'
                            : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/70 dark:bg-[#171C28]/70 text-slate-700 dark:text-slate-300'
                        } ${unavailableInPreview ? 'opacity-70' : ''}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-extrabold" dir="ltr">
                            {m.label}
                          </span>
                          {unavailableInPreview && (
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-500 whitespace-nowrap">
                              يتطلب VPS
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] opacity-80 mt-0.5">{m.sub}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {selectedNeedsVps && (
                <div className="rounded-2xl bg-amber-500/10 border border-amber-500/25 px-4 py-3 text-xs font-semibold text-amber-600 dark:text-amber-400 flex items-start gap-2.5">
                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    بيئة التشغيل السحابية الحالية لا تحتوي على واجهة WireGuard (`wg0`) أو منفذ UDP `51820`. للاتصال الفوري الآن اختر <strong className="underline cursor-pointer" onClick={() => setConnectionType('direct')}>API مباشر (Public IP / DDNS)</strong>.
                  </div>
                </div>
              )}

              {connectionType === 'agent' && capabilities?.isPreviewAuthProxy && (
                <div className="rounded-2xl bg-amber-500/10 border border-amber-500/25 px-4 py-3 text-xs font-semibold text-amber-600 dark:text-amber-400 flex items-start gap-2.5">
                  <Info className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    وضع المعاينة المؤقت يفرض تسجيل دخول Google Cookie أمام الروابط الخارجية، لذا يعمل وضع <span dir="ltr">HTTPS Agent</span> بعد نشر التطبيق (Publish) أو استضافته على VPS.
                  </div>
                </div>
              )}

              {connectionType === 'direct' && (
                <div className="space-y-4 rounded-2xl bg-slate-50/80 dark:bg-[#171C28]/70 border border-slate-200/80 dark:border-white/[0.07] p-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setUseExistingCredentials(true)}
                      className={`min-h-[42px] px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                        useExistingCredentials
                          ? 'border-sky-500 bg-sky-500/15 text-sky-600 dark:text-sky-400'
                          : 'border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <Wifi className="w-3.5 h-3.5" />
                      <span>لدي مستخدم API جاهز (ربط فوري)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setUseExistingCredentials(false)}
                      className={`min-h-[42px] px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                        !useExistingCredentials
                          ? 'border-sky-500 bg-sky-500/15 text-sky-600 dark:text-sky-400'
                          : 'border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      <span>توليد سكربت إنشاء مستخدم وفتح المنفذ</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                        Public IP أو MikroTik Cloud DDNS
                      </label>
                      <input
                        type="text"
                        required
                        dir="ltr"
                        value={apiHost}
                        onChange={(e) => setApiHost(e.target.value)}
                        placeholder="xxxx.sn.mynetname.net أو Public IP"
                        className="w-full min-h-[46px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-white dark:bg-[#11151E] px-3.5 text-sm font-mono text-left text-slate-900 dark:text-white focus:outline-none focus:border-sky-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                        منفذ API (8728 / 8729 SSL / 443 REST)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        dir="ltr"
                        value={apiPort}
                        onChange={(e) => setApiPort(e.target.value)}
                        className="w-full min-h-[46px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-white dark:bg-[#11151E] px-3.5 text-sm font-mono text-left text-slate-900 dark:text-white focus:outline-none focus:border-sky-500"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                        اسم مستخدم API
                      </label>
                      <input
                        type="text"
                        required={useExistingCredentials}
                        dir="ltr"
                        value={apiUsername}
                        onChange={(e) => setApiUsername(e.target.value)}
                        placeholder={useExistingCredentials ? 'admin' : 'broradius (اختياري)'}
                        className="w-full min-h-[46px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-white dark:bg-[#11151E] px-3.5 text-sm font-mono text-left text-slate-900 dark:text-white focus:outline-none focus:border-sky-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                        كلمة مرور API
                      </label>
                      <input
                        type="password"
                        dir="ltr"
                        value={apiPassword}
                        onChange={(e) => setApiPassword(e.target.value)}
                        placeholder={useExistingCredentials ? 'كلمة مرور الراوتر' : 'توليد تلقائي إن ترك فارغاً'}
                        className="w-full min-h-[46px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-white dark:bg-[#11151E] px-3.5 text-sm font-mono text-left text-slate-900 dark:text-white focus:outline-none focus:border-sky-500"
                      />
                    </div>
                  </div>

                  <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                    <span>
                      ملاحظة: العناوين الخاصة مثل <span dir="ltr" className="font-mono">192.168.x.x</span> لا يمكن الوصول إليها من السيرفر السحابي إلا عبر Public IP أو DDNS أو Port Forwarding.
                    </span>
                  </div>
                </div>
              )}

              {/* Permission Mode */}
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
                  صلاحيات API داخل المايكروتك
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setPermissionMode('read-only')}
                    className={`rounded-2xl border p-3 text-right transition-all ${
                      permissionMode === 'read-only'
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                        : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/70 dark:bg-[#171C28]/70 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <div className="text-xs font-extrabold flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5" />
                      <span>قراءة ومراقبة فقط</span>
                    </div>
                    <div className="text-[11px] opacity-80 mt-0.5">أقصى أمان (read,api,test)</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPermissionMode('full-control')}
                    className={`rounded-2xl border p-3 text-right transition-all ${
                      permissionMode === 'full-control'
                        ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400'
                        : 'border-slate-200 dark:border-white/[0.08] bg-slate-50/70 dark:bg-[#171C28]/70 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <div className="text-xs font-extrabold flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>تحكم وإدارة كاملة</span>
                    </div>
                    <div className="text-[11px] opacity-80 mt-0.5">فصل جلسات + هوتسبوت + نسخ</div>
                  </button>
                </div>
              </div>

              {error && (
                <div className="rounded-2xl bg-red-500/10 border border-red-500/25 px-4 py-3 text-xs font-semibold text-red-500">
                  {error}
                </div>
              )}

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="min-h-[46px] px-5 rounded-2xl border border-slate-200 dark:border-white/[0.09] text-sm font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.04]"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={loading || selectedNeedsVps}
                  className="min-h-[46px] px-6 rounded-2xl bg-gradient-to-l from-sky-600 to-teal-600 hover:from-sky-500 hover:to-teal-500 text-white text-sm font-bold inline-flex items-center gap-2 shadow-lg shadow-sky-900/20 disabled:opacity-50"
                >
                  <KeyRound className="w-4 h-4" />
                  <span>
                    {loading
                      ? 'جاري التنفيذ...'
                      : connectionType === 'direct' && useExistingCredentials
                        ? 'حفظ وفحص الاتصال فوراً'
                        : 'متابعة وتوليد سكربت الربط'}
                  </span>
                </button>
              </div>
            </form>
          )}

          {step === 'script' && provision && (
            <div className="space-y-4">
              {/* Step-by-step Winbox Onboarding Guide */}
              <div className="rounded-2xl bg-slate-50 dark:bg-[#171C28] border border-slate-200/80 dark:border-white/[0.07] p-4 space-y-2 text-xs text-slate-700 dark:text-slate-300">
                <div className="font-bold text-slate-900 dark:text-white">خطوات الربط داخل Winbox:</div>
                <ol className="list-decimal list-inside space-y-1">
                  <li>افتح برنامج Winbox وادخل إلى الراوتر المستهدف.</li>
                  <li>
                    من القائمة الجانبية اختر{' '}
                    <span className="font-mono font-bold text-sky-500" dir="ltr">
                      New Terminal
                    </span>
                    .
                  </li>
                  <li>انسخ السكربت بالأسفل وألصقه داخل التيرمنال ثم اضغط Enter.</li>
                  <li>
                    {provision.connectionType === 'direct'
                      ? 'سيطبع التيرمنال عنوان DDNS والآي بي العام — تأكد أنه مطابق ثم اضغط "فحص الاتصال".'
                      : 'اضغط "فحص الاتصال وجلب البيانات" للتحقق من وصول القراءات.'}
                  </li>
                </ol>
              </div>

              <div className="grid grid-cols-3 gap-3 rounded-2xl bg-slate-50 dark:bg-[#171C28] border border-slate-200/80 dark:border-white/[0.07] p-4 text-xs">
                <div>
                  <span className="text-slate-500 dark:text-slate-400 block">
                    {provision.connectionType === 'direct' ? 'عنوان الاتصال' : 'آي بي النفق'}
                  </span>
                  <span className="font-mono font-bold text-sky-600 dark:text-sky-400 mt-0.5 block truncate" dir="ltr">
                    {createdRouter?.apiHost || provision.tunnelIp}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-slate-400 block">منفذ API</span>
                  <span className="font-mono font-bold text-teal-600 dark:text-teal-400 mt-0.5 block" dir="ltr">
                    {provision.apiPort}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-slate-400 block">مستخدم API</span>
                  <span className="font-mono font-bold text-slate-900 dark:text-white mt-0.5 block" dir="ltr">
                    {provision.apiUsername}
                  </span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-200">
                    <Terminal className="w-4 h-4 text-sky-500" />
                    <span>سكربت التهيئة</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowUninstall((p) => !p)}
                      className="min-h-[36px] px-3 rounded-xl border border-slate-200 dark:border-white/[0.08] text-[11px] font-bold text-slate-600 dark:text-slate-300"
                    >
                      {showUninstall ? 'عرض سكربت الربط' : 'سكربت الإزالة'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopy(
                          showUninstall ? provision.uninstallScript : provision.installScript,
                          showUninstall ? 'uninstall' : 'install'
                        )
                      }
                      className="inline-flex items-center gap-1.5 min-h-[36px] px-3.5 rounded-xl bg-sky-500/15 text-sky-600 dark:text-sky-400 text-xs font-bold hover:bg-sky-500/25 transition-colors"
                    >
                      {copiedType ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedType ? 'تم النسخ' : 'نسخ'}</span>
                    </button>
                  </div>
                </div>

                <pre
                  dir="ltr"
                  className="rounded-2xl bg-[#070A10] text-emerald-300 border border-white/[0.08] p-4 text-[11px] leading-relaxed font-mono overflow-x-auto max-h-56 select-all text-left"
                >
                  {showUninstall ? provision.uninstallScript : provision.installScript}
                </pre>
              </div>

              {error && (
                <div className="rounded-2xl bg-amber-500/10 border border-amber-500/25 px-4 py-3 text-xs font-semibold text-amber-600 dark:text-amber-400 flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    <div>{error}</div>
                    <div className="mt-1 opacity-85">
                      بقي الراوتر في حالة &quot;بانتظار الربط&quot; — يمكنك أيضاً تعديل بيانات الاتصال في أي وقت من داخل صفحة الراوتر.
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="min-h-[46px] px-4 rounded-2xl border border-slate-200 dark:border-white/[0.09] text-sm font-semibold text-slate-700 dark:text-slate-300"
                >
                  إغلاق ومتابعة لاحقاً
                </button>
                <button
                  type="button"
                  onClick={() => void handleVerifyConnection()}
                  disabled={loading}
                  className="min-h-[46px] px-6 rounded-2xl bg-gradient-to-l from-sky-600 to-teal-600 hover:from-sky-500 hover:to-teal-500 text-white text-sm font-bold inline-flex items-center gap-2 shadow-lg shadow-sky-900/20 disabled:opacity-60"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>{loading ? 'جاري فحص الاتصال الحقيقي...' : 'فحص الاتصال وجلب البيانات'}</span>
                </button>
              </div>
            </div>
          )}

          {step === 'verified' && createdRouter && (
            <div className="py-5 text-center space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/15 text-emerald-500 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-9 h-9" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                  تم ربط {createdRouter.name} بنجاح
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1" dir="ltr">
                  {createdRouter.model || 'MikroTik'} · {createdRouter.routerOsVersion || ''} ·{' '}
                  {createdRouter.tunnelRttMs !== null ? `${createdRouter.tunnelRttMs} ms` : ''}
                </p>
                <p className="text-xs text-emerald-500 font-bold mt-2">
                  تم جلب {createdRouter.ports.length} منفذ و {createdRouter.pppoeSecretsCount} حساب PPPoE حياً من الراوتر
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="w-full sm:w-auto min-h-[48px] px-8 rounded-2xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-sm"
              >
                عرض لوحة الراوتر
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
