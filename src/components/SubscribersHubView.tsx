import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Clock,
  CreditCard,
  Download,
  MapPin,
  Moon,
  RefreshCw,
  Router as RouterIcon,
  Search,
  Signal,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import type { PaymentRecord, SubscriberBillingStatus, SubscriberRecord, TowerNode } from '../types';
import { CpeDetailModal } from './CpeDetailModal';

interface SubscribersHubViewProps {
  token: string;
  subscribers: SubscriberRecord[];
  payments: PaymentRecord[];
  towers: TowerNode[];
  onUpdateSubscriber: (
    subId: string,
    patch: Partial<SubscriberRecord> & { graceHours?: number }
  ) => Promise<void>;
  onCreatePayment: (subId: string, amountIqd: number, note: string, renewDays: number) => Promise<void>;
  onLocateOnMap: (subId: string) => void;
}

const STATUS_LABELS: Record<SubscriberBillingStatus, { text: string; color: string }> = {
  active: { text: 'نشط', color: 'text-emerald-600 dark:text-emerald-400' },
  expiring: { text: 'ينتهي قريباً', color: 'text-amber-600 dark:text-amber-400' },
  expired: { text: 'منتهي', color: 'text-slate-500 dark:text-slate-400' },
  debtor: { text: 'مدين', color: 'text-red-600 dark:text-red-400' },
};

export const SubscribersHubView: React.FC<SubscribersHubViewProps> = ({
  token,
  subscribers,
  payments,
  towers,
  onUpdateSubscriber,
  onCreatePayment,
  onLocateOnMap,
}) => {
  const [period, setPeriod] = useState<'today' | 'week' | 'month'>('today');
  const [quickFilter, setQuickFilter] = useState<'all' | 'flapping' | 'inactive' | 'debtor' | 'turbo'>('all');
  const [query, setQuery] = useState('');
  const [editingSub, setEditingSub] = useState<SubscriberRecord | null>(null);
  const [cpeSub, setCpeSub] = useState<SubscriberRecord | null>(null);
  const [modalTab, setModalTab] = useState<'account' | 'payments'>('account');

  const [draftFullName, setDraftFullName] = useState('');
  const [draftPhone, setDraftPhone] = useState('');
  const [draftArea, setDraftArea] = useState('');
  const [draftProfile, setDraftProfile] = useState('default');
  const [draftStaticIpPool, setDraftStaticIpPool] = useState('');
  const [draftStatus, setDraftStatus] = useState<SubscriberBillingStatus>('active');
  const [draftDebt, setDraftDebt] = useState('0');
  const [draftDisabled, setDraftDisabled] = useState(false);
  const [draftTowerId, setDraftTowerId] = useState('');

  const [payAmount, setPayAmount] = useState('25000');
  const [payNote, setPayNote] = useState('تجديد اشتراك شهري');
  const [payRenewDays, setPayRenewDays] = useState('30');
  const [saving, setSaving] = useState(false);

  const getUsage = (s: SubscriberRecord) => {
    if (period === 'today') return { rx: s.rxTodayGb, tx: s.txTodayGb, total: s.rxTodayGb + s.txTodayGb };
    if (period === 'week') return { rx: s.rxWeekGb, tx: s.txWeekGb, total: s.rxWeekGb + s.txWeekGb };
    return { rx: s.rxMonthGb, tx: s.txMonthGb, total: s.rxMonthGb + s.txMonthGb };
  };

  const filterCounts = useMemo(
    () => ({
      all: subscribers.length,
      flapping: subscribers.filter((s) => s.flapCountToday >= 10).length,
      inactive: subscribers.filter((s) => !s.online).length,
      debtor: subscribers.filter((s) => s.billingStatus === 'debtor' || s.debtAmountIqd > 0).length,
      turbo: subscribers.filter((s) => Boolean(s.turboNightEnabled)).length,
    }),
    [subscribers]
  );

  const filteredSorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...subscribers]
      .filter((s) => {
        if (quickFilter === 'flapping' && s.flapCountToday < 10) return false;
        if (quickFilter === 'inactive' && s.online) return false;
        if (quickFilter === 'debtor' && s.billingStatus !== 'debtor' && s.debtAmountIqd <= 0) return false;
        if (quickFilter === 'turbo' && !s.turboNightEnabled) return false;
        return (
          !q ||
          s.username.toLowerCase().includes(q) ||
          s.fullName.toLowerCase().includes(q) ||
          s.area.toLowerCase().includes(q) ||
          s.ip.includes(q) ||
          s.mac.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => getUsage(b).total - getUsage(a).total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribers, query, period, quickFilter]);

  const grandTotalGb = useMemo(
    () => filteredSorted.reduce((acc, s) => acc + getUsage(s).total, 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredSorted, period]
  );

  const maxTotalGb = filteredSorted.length > 0 ? Math.max(1, getUsage(filteredSorted[0]).total) : 1;

  const openEdit = (sub: SubscriberRecord) => {
    setEditingSub(sub);
    setModalTab('account');
    setDraftFullName(sub.fullName);
    setDraftPhone(sub.phone);
    setDraftArea(sub.area);
    setDraftProfile(sub.profile);
    setDraftStaticIpPool(sub.staticIpPool || '');
    setDraftStatus(sub.billingStatus);
    setDraftDebt(String(sub.debtAmountIqd));
    setDraftDisabled(sub.disabled);
    setDraftTowerId(sub.towerId || '');
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSub) return;
    setSaving(true);
    try {
      await onUpdateSubscriber(editingSub.id, {
        fullName: draftFullName,
        phone: draftPhone,
        area: draftArea,
        profile: draftProfile,
        staticIpPool: draftStaticIpPool.trim() || null,
        disabled: draftDisabled,
        billingStatus: draftStatus,
        debtAmountIqd: Number(draftDebt) || 0,
        towerId: draftTowerId || null,
        expiresInDays: draftStatus === 'active' ? 30 : draftStatus === 'expiring' ? 2 : 0,
      });
      setEditingSub(null);
    } finally {
      setSaving(false);
    }
  };

  const handleGrace = async (hours: number) => {
    if (!editingSub) return;
    setSaving(true);
    try {
      await onUpdateSubscriber(editingSub.id, {
        billingStatus: 'active',
        disabled: false,
        graceHours: hours,
      });
      setEditingSub(null);
    } finally {
      setSaving(false);
    }
  };

  const handleAddPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSub) return;
    const amt = Number(payAmount);
    if (!Number.isFinite(amt) || amt <= 0) return;
    setSaving(true);
    try {
      await onCreatePayment(editingSub.id, amt, payNote, Number(payRenewDays) || 30);
      setEditingSub(null);
    } finally {
      setSaving(false);
    }
  };

  const handleExportCsv = async () => {
    const res = await fetch('/api/subscribers/export.csv', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bro-radius-subscribers.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const subPayments = editingSub ? payments.filter((p) => p.subscriberId === editingSub.id) : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">المشتركين والفوترة</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            الاستهلاك الفعلي، انتهاء الاشتراك، الدفعات والديون، وتصدير التقارير
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleExportCsv()}
            disabled={subscribers.length === 0}
            className="min-h-[40px] px-3.5 rounded-xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#11151E] text-xs font-bold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            <Download className="w-4 h-4 text-sky-500" />
            <span>تصدير CSV</span>
          </button>

          <div className="flex items-center gap-1 bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-1 rounded-xl">
            {[
              { id: 'today' as const, label: 'اليوم' },
              { id: 'week' as const, label: 'أسبوع' },
              { id: 'month' as const, label: 'شهر' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setPeriod(t.id)}
                className={`min-h-[34px] px-3.5 rounded-lg text-xs font-bold transition-colors ${
                  period === t.id
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Summary Row */}
      <div className="rounded-2xl bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] px-5 py-4 flex items-center justify-between">
        <div className="text-sm font-bold text-slate-900 dark:text-white tabular-nums">
          {filteredSorted.length} مشترك · المجموع{' '}
          <span className="font-mono text-sky-600 dark:text-sky-400" dir="ltr">
            {grandTotalGb.toFixed(1)} GB
          </span>
        </div>
        <RefreshCw className="w-5 h-5 text-sky-500" />
      </div>

      {/* Search Bar & Quick Operational Filters (#51, #54, #59) */}
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="بحث بالاسم، يوزر PPPoE، IP، MAC أو المنطقة"
            className="w-full min-h-[48px] rounded-2xl border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#11151E] pr-11 pl-4 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-sky-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {[
            { id: 'all' as const, label: `الكل (${filterCounts.all})` },
            { id: 'flapping' as const, label: `متقطع ≥10 اليوم (${filterCounts.flapping})` },
            { id: 'inactive' as const, label: `خامل / غير متصل (${filterCounts.inactive})` },
            { id: 'debtor' as const, label: `مديون (${filterCounts.debtor})` },
            { id: 'turbo' as const, label: `توربو ليلي (${filterCounts.turbo})` },
          ].map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setQuickFilter(chip.id)}
              className={`min-h-[34px] px-3 rounded-xl text-xs font-bold border transition-colors ${
                quickFilter === chip.id
                  ? 'bg-sky-600 border-sky-600 text-white'
                  : 'bg-white dark:bg-[#11151E] border-slate-200/80 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {subscribers.length === 0 ? (
        <div className="rounded-[24px] border border-dashed border-slate-300 dark:border-white/[0.12] bg-white dark:bg-[#11151E] p-10 text-center space-y-2">
          <Users className="w-9 h-9 text-sky-500 mx-auto" />
          <div className="text-base font-bold text-slate-900 dark:text-white">
            لا يوجد مشتركين حتى الآن
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            بمجرد ربط راوتر MikroTik والتحقق منه، سيقوم النظام بسحب قائمة حسابات PPPoE والاتصالات الحية تلقائياً دون أي بيانات تجريبية.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {filteredSorted.map((sub, idx) => {
            const usage = getUsage(sub);
            const barWidth = Math.max(6, Math.round((usage.total / maxTotalGb) * 100));
            const statusMeta = STATUS_LABELS[sub.billingStatus];

            return (
              <div
                key={sub.id}
                onClick={() => openEdit(sub)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openEdit(sub);
                  }
                }}
                className="rounded-2xl bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] hover:border-sky-500/50 p-4 cursor-pointer transition-colors"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-8 h-8 rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400 font-mono font-bold text-xs flex items-center justify-center shrink-0 tabular-nums">
                      {idx + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-slate-900 dark:text-white truncate">
                        {sub.username} ·{' '}
                        <span className="font-normal text-slate-500 dark:text-slate-400">{sub.fullName}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="font-mono">{sub.profile}</span>
                        <span>·</span>
                        <span className={`font-bold ${statusMeta.color}`}>{statusMeta.text}</span>
                        <span>· متبقي {sub.expiresInDays} يوم</span>
                        {sub.debtAmountIqd > 0 && (
                          <span className="font-mono text-red-500">· {sub.debtAmountIqd.toLocaleString()} د.ع</span>
                        )}
                        {sub.flapCountToday >= 5 && (
                          <span className="inline-flex items-center gap-0.5 text-amber-500 font-bold">
                            <AlertTriangle className="w-3 h-3" /> تقطع {sub.flapCountToday}×
                          </span>
                        )}
                        {sub.turboNightEnabled && (
                          <span className="inline-flex items-center gap-0.5 text-indigo-400 font-bold">
                            <Moon className="w-3 h-3" /> توربو
                          </span>
                        )}
                        {typeof sub.cpeConnectedCount === 'number' && sub.cpeConnectedCount > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-emerald-500 font-mono font-bold">
                            <Wifi className="w-3 h-3" /> {sub.cpeConnectedCount} أجهزة
                          </span>
                        )}
                        {typeof sub.signalDbm === 'number' && (
                          <span className="inline-flex items-center gap-0.5 text-sky-500 font-mono" dir="ltr">
                            <Signal className="w-3 h-3" /> {sub.signalDbm}dBm
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-left shrink-0">
                    <div className="font-mono font-bold text-sm text-sky-600 dark:text-sky-400 tabular-nums" dir="ltr">
                      {usage.total.toFixed(1)} GB
                    </div>
                    {sub.online && (
                      <div className="text-[10px] font-mono text-emerald-500" dir="ltr">
                        ↓{sub.liveRxMbps}M
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-3 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-l from-sky-500 to-teal-500 transition-all"
                    style={{ width: `${barWidth}%` }}
                  />
                </div>

                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                  <span className="inline-flex items-center gap-3" dir="ltr">
                    <span className="inline-flex items-center gap-1">
                      <ArrowDown className="w-3 h-3 text-sky-500" /> {usage.rx.toFixed(1)} GB
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <ArrowUp className="w-3 h-3 text-teal-500" /> {usage.tx.toFixed(1)} GB
                    </span>
                    <span>{sub.macVendor}</span>
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setCpeSub(sub);
                      }}
                      className="font-sans font-bold text-teal-600 dark:text-teal-400 inline-flex items-center gap-1 hover:underline"
                    >
                      <RouterIcon className="w-3.5 h-3.5" />
                      <span>راوتر المنزل</span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onLocateOnMap(sub.id);
                      }}
                      className="font-sans font-bold text-sky-600 dark:text-sky-400 inline-flex items-center gap-1 hover:underline"
                    >
                      <MapPin className="w-3.5 h-3.5" />
                      <span>الموقع</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Edit Subscriber & Payments Modal (#51, #52, #53, #54) */}
      {editingSub && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  إدارة المشترك ({editingSub.username})
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 font-mono" dir="ltr">
                  {editingSub.ip || 'No IP'} · {editingSub.mac || 'No MAC'} · {editingSub.macVendor}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingSub(null)}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 bg-slate-100 dark:bg-[#171C28] p-1 rounded-2xl">
              <button
                type="button"
                onClick={() => setModalTab('account')}
                className={`min-h-[40px] rounded-xl text-xs font-bold ${
                  modalTab === 'account' ? 'bg-sky-600 text-white' : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                بيانات الاشتراك والباقة
              </button>
              <button
                type="button"
                onClick={() => setModalTab('payments')}
                className={`min-h-[40px] rounded-xl text-xs font-bold ${
                  modalTab === 'payments' ? 'bg-sky-600 text-white' : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                الدفعات والتمديد ({subPayments.length})
              </button>
            </div>

            {modalTab === 'account' ? (
              <form onSubmit={(e) => void handleSave(e)} className="space-y-3.5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      الاسم الكامل
                    </label>
                    <input
                      type="text"
                      value={draftFullName}
                      onChange={(e) => setDraftFullName(e.target.value)}
                      className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm text-slate-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      رقم الهاتف
                    </label>
                    <input
                      type="text"
                      dir="ltr"
                      value={draftPhone}
                      onChange={(e) => setDraftPhone(e.target.value)}
                      className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-slate-900 dark:text-white"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      البروفايل (MikroTik)
                    </label>
                    <input
                      type="text"
                      dir="ltr"
                      value={draftProfile}
                      onChange={(e) => setDraftProfile(e.target.value)}
                      className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-slate-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      البرج المرتبط (Line of Sight)
                    </label>
                    <select
                      value={draftTowerId}
                      onChange={(e) => setDraftTowerId(e.target.value)}
                      className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm text-slate-900 dark:text-white"
                    >
                      <option value="">غير مرتبط ببرج</option>
                      {towers.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                    الحالة المالية
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {(['active', 'expiring', 'expired', 'debtor'] as const).map((st) => (
                      <button
                        key={st}
                        type="button"
                        onClick={() => setDraftStatus(st)}
                        className={`min-h-[40px] rounded-xl text-xs font-bold border ${
                          draftStatus === st
                            ? 'bg-sky-600 border-sky-600 text-white'
                            : 'border-slate-200 dark:border-white/[0.09] text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {STATUS_LABELS[st].text}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      المنطقة
                    </label>
                    <input
                      type="text"
                      value={draftArea}
                      onChange={(e) => setDraftArea(e.target.value)}
                      className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm text-slate-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      Static IP / Pool
                    </label>
                    <input
                      type="text"
                      dir="ltr"
                      value={draftStaticIpPool}
                      onChange={(e) => setDraftStaticIpPool(e.target.value)}
                      placeholder="10.20.0.50 أو pool-vip"
                      className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-left text-slate-900 dark:text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1">
                      الدين المتراكم (د.ع)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      dir="ltr"
                      value={draftDebt}
                      onChange={(e) => setDraftDebt(e.target.value)}
                      className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-left text-slate-900 dark:text-white"
                    />
                  </div>
                </div>

                <label className="flex items-center justify-between rounded-xl border border-slate-200/80 dark:border-white/[0.08] px-3.5 py-2.5 text-xs font-bold text-slate-700 dark:text-slate-200">
                  <span>تعطيل الحساب على المايكروتك (Expired/Disabled)</span>
                  <input
                    type="checkbox"
                    checked={draftDisabled}
                    onChange={(e) => setDraftDisabled(e.target.checked)}
                    className="w-4 h-4 accent-red-500"
                  />
                </label>

                <div className="flex gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      const id = editingSub.id;
                      setEditingSub(null);
                      onLocateOnMap(id);
                    }}
                    className="flex-1 min-h-[46px] rounded-xl border border-sky-500/40 text-sky-600 dark:text-sky-400 text-xs font-bold inline-flex items-center justify-center gap-1.5"
                  >
                    <MapPin className="w-4 h-4" />
                    <span>تحديد على الخريطة</span>
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex-1 min-h-[46px] rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-bold"
                  >
                    {saving ? 'جاري الحفظ...' : 'حفظ التعديلات'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                {/* Grace Period Quick Buttons (#54) */}
                <div className="rounded-2xl bg-amber-500/10 border border-amber-500/20 p-3.5 space-y-2">
                  <div className="text-xs font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <Clock className="w-4 h-4" />
                    <span>فترة سماح مؤقتة بدون دفع فوري</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleGrace(24)}
                      className="min-h-[40px] rounded-xl bg-white dark:bg-[#171C28] border border-amber-500/30 text-xs font-bold text-slate-800 dark:text-slate-200"
                    >
                      تمديد 24 ساعة
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleGrace(48)}
                      className="min-h-[40px] rounded-xl bg-white dark:bg-[#171C28] border border-amber-500/30 text-xs font-bold text-slate-800 dark:text-slate-200"
                    >
                      تمديد 48 ساعة
                    </button>
                  </div>
                </div>

                {/* Record Payment (#52) */}
                <form onSubmit={(e) => void handleAddPayment(e)} className="rounded-2xl border border-slate-200/80 dark:border-white/[0.08] p-4 space-y-3">
                  <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                    <CreditCard className="w-4 h-4 text-emerald-500" />
                    <span>تسجيل دفعة وتجديد</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <input
                      type="number"
                      min={1000}
                      step={500}
                      dir="ltr"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                      placeholder="المبلغ د.ع"
                      className="min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-slate-900 dark:text-white"
                    />
                    <input
                      type="number"
                      min={1}
                      max={365}
                      dir="ltr"
                      value={payRenewDays}
                      onChange={(e) => setPayRenewDays(e.target.value)}
                      placeholder="أيام التجديد"
                      className="min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-slate-900 dark:text-white"
                    />
                  </div>
                  <input
                    type="text"
                    value={payNote}
                    onChange={(e) => setPayNote(e.target.value)}
                    placeholder="ملاحظة الدفعة"
                    className="w-full min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs text-slate-900 dark:text-white"
                  />
                  <button
                    type="submit"
                    disabled={saving}
                    className="w-full min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold"
                  >
                    تسجيل الدفعة في الصندوق
                  </button>
                </form>

                {/* Ledger History */}
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {subPayments.length === 0 ? (
                    <div className="text-center text-xs text-slate-400 py-3">لا توجد دفعات مسجلة لهذا المشترك</div>
                  ) : (
                    subPayments.map((p) => (
                      <div
                        key={p.id}
                        className="rounded-xl bg-slate-50 dark:bg-[#171C28] px-3 py-2 flex items-center justify-between text-xs"
                      >
                        <div>
                          <div className="font-bold text-emerald-500 font-mono">
                            +{p.amountIqd.toLocaleString()} د.ع
                          </div>
                          <div className="text-slate-500 text-[11px]">{p.note || 'دفعة مالية'}</div>
                        </div>
                        <div className="text-[10px] text-slate-400 text-left">
                          <div>{p.recordedBy}</div>
                          <div dir="ltr">{p.createdAt.slice(0, 10)}</div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {cpeSub && (
        <CpeDetailModal
          token={token}
          subscriber={cpeSub}
          onClose={() => setCpeSub(null)}
          onUpdateSubscriber={onUpdateSubscriber}
        />
      )}
    </div>
  );
};
