import React, { useState } from 'react';
import { Check, Copy, Key, Plus, Server, Sliders, Wifi, X } from 'lucide-react';
import type { RouterDevice } from '../types';

interface DirectManagementModalProps {
  token: string;
  routers: RouterDevice[];
  vouchers: Array<{ code: string; profile: string; createdAt: string; routerName: string }>;
  onVoucherCreated: (vouchers: Array<{ code: string; profile: string; createdAt: string; routerName: string }>) => void;
  onSelectRouter: (routerId: string) => void;
  onClose: () => void;
}

export const DirectManagementModal: React.FC<DirectManagementModalProps> = ({
  token,
  routers,
  vouchers,
  onVoucherCreated,
  onSelectRouter,
  onClose,
}) => {
  const [selectedRouterId, setSelectedRouterId] = useState(routers[0]?.id || '');
  const [profile, setProfile] = useState('default');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const activeRouter = routers.find((r) => r.id === selectedRouterId) || routers[0];

  const handleGenerateVoucher = async () => {
    if (!activeRouter) return;
    setError(null);
    setCreating(true);
    try {
      const res = await fetch('/api/hotspot/vouchers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ routerId: activeRouter.id, profile: profile.trim() || 'default' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'تعذر إصدار الكرت على الراوتر');
        return;
      }
      if (data.vouchers) {
        onVoucherCreated(data.vouchers);
      } else if (data.voucher) {
        onVoucherCreated([data.voucher, ...vouchers]);
      }
    } catch {
      setError('فشل الاتصال بالخادم أثناء إصدار الكرت');
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      setTimeout(() => setCopiedCode(null), 1800);
    } catch {
      // ignore
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4">
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] shadow-2xl">
        <div className="sm:hidden w-10 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full mx-auto mt-3" />
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200/80 dark:border-white/[0.07]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-500/15 text-teal-600 dark:text-teal-400 flex items-center justify-center">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 dark:text-white">الإدارة المباشرة للراوتر</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                هوتسبوت · كروت حقيقية على المايكروتك · بوابة API
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

        <div className="p-6 space-y-5">
          {routers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 dark:border-white/[0.12] p-6 text-center text-xs text-slate-500">
              لا توجد راوترات مربوطة حالياً. أضف راوتراً متصلاً بصلاحية التحكم الكامل لاستخدام الإدارة المباشرة.
            </div>
          ) : (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">
                  اختر الراوتر المستهدف
                </label>
                <select
                  value={selectedRouterId}
                  onChange={(e) => setSelectedRouterId(e.target.value)}
                  className="w-full min-h-[46px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-4 text-sm font-semibold text-slate-900 dark:text-white"
                >
                  {routers.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.apiHost}:{r.apiPort})
                    </option>
                  ))}
                </select>
              </div>

              {activeRouter && (
                <div className="grid grid-cols-2 gap-3 rounded-2xl bg-slate-50 dark:bg-[#171C28] border border-slate-200/80 dark:border-white/[0.07] p-4 text-xs">
                  <div className="flex items-center gap-2.5">
                    <Server className="w-4 h-4 text-sky-500 shrink-0" />
                    <div>
                      <span className="text-slate-500 dark:text-slate-400 block">بوابة API</span>
                      <span className="font-mono font-bold text-slate-900 dark:text-white" dir="ltr">
                        {activeRouter.apiHost}:{activeRouter.apiPort}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <Wifi className="w-4 h-4 text-teal-500 shrink-0" />
                    <div>
                      <span className="text-slate-500 dark:text-slate-400 block">هوتسبوت / PPPoE</span>
                      <span className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                        {activeRouter.hotspotOnline} / {activeRouter.pppoeOnline}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Hotspot Voucher Generator */}
              <div className="rounded-2xl border border-slate-200/80 dark:border-white/[0.07] p-4 space-y-3">
                <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                  <Key className="w-4 h-4 text-sky-500" />
                  <span>إصدار كرت هوتسبوت فعلي على الراوتر</span>
                </div>
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <input
                    type="text"
                    dir="ltr"
                    value={profile}
                    onChange={(e) => setProfile(e.target.value)}
                    placeholder="اسم البروفايل (مثال: default)"
                    className="flex-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-slate-900 dark:text-white"
                  />
                  <button
                    type="button"
                    onClick={() => void handleGenerateVoucher()}
                    disabled={creating}
                    className="min-h-[44px] px-5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-bold inline-flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-60"
                  >
                    <Plus className="w-4 h-4" />
                    <span>{creating ? 'جاري الإصدار...' : 'توليد كرت'}</span>
                  </button>
                </div>

                {error && (
                  <div className="rounded-xl bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs font-semibold text-red-500">
                    {error}
                  </div>
                )}

                {vouchers.length > 0 && (
                  <div className="divide-y divide-slate-200 dark:divide-white/[0.07] pt-1">
                    {vouchers.slice(0, 5).map((v) => (
                      <div key={v.code} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                        <div>
                          <span className="font-mono font-bold text-slate-900 dark:text-white" dir="ltr">
                            {v.code}
                          </span>
                          <div className="text-slate-500 dark:text-slate-400 mt-0.5">
                            {v.profile} · {v.routerName}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleCopy(v.code)}
                          className="min-w-[44px] min-h-[40px] px-3 rounded-lg bg-slate-100 dark:bg-[#171C28] text-slate-700 dark:text-slate-200 font-semibold inline-flex items-center justify-center gap-1"
                        >
                          {copiedCode === v.code ? (
                            <Check className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>{copiedCode === v.code ? 'تم' : 'نسخ'}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {activeRouter && (
                <button
                  type="button"
                  onClick={() => {
                    onSelectRouter(activeRouter.id);
                    onClose();
                  }}
                  className="w-full min-h-[48px] rounded-xl bg-gradient-to-l from-sky-600 to-teal-600 text-white font-bold text-sm hover:from-sky-500 hover:to-teal-500 transition-colors"
                >
                  فتح لوحة {activeRouter.name}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
