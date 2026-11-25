import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  Clock,
  Cpu,
  Network,
  Plus,
  RefreshCw,
  Router,
  ShieldAlert,
  Sliders,
  Thermometer,
  Users,
  ChevronLeft,
} from 'lucide-react';
import type { RouterAlertItem, RouterDevice } from '../types';

interface NetworkHomeViewProps {
  routers: RouterDevice[];
  alerts: RouterAlertItem[];
  loading: boolean;
  selectedRouterId: string | null;
  onRefresh: () => Promise<void>;
  onSelectRouter: (routerId: string) => void;
  onOpenAddRouter: () => void;
  onOpenDirectManage: () => void;
}

export const NetworkHomeView: React.FC<NetworkHomeViewProps> = ({
  routers,
  alerts,
  loading,
  selectedRouterId,
  onRefresh,
  onSelectRouter,
  onOpenAddRouter,
  onOpenDirectManage,
}) => {
  const [pullOffset, setPullOffset] = useState(0);
  const [pulling, setPulling] = useState(false);
  const touchStartY = useRef<number | null>(null);

  const onlineCount = routers.filter((r) => r.status === 'online').length;
  const pendingCount = routers.filter((r) => r.status === 'pending').length;
  const openAlerts = alerts.filter((a) => !a.acknowledged);
  const totalPppoe = routers.reduce((acc, r) => acc + r.pppoeOnline, 0);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (window.scrollY === 0) {
      touchStartY.current = e.touches[0].clientY;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return;
    const diff = e.touches[0].clientY - touchStartY.current;
    if (diff > 0 && window.scrollY === 0) {
      setPullOffset(Math.min(72, diff * 0.45));
    }
  };

  const handleTouchEnd = () => {
    if (pullOffset > 48 && !pulling) {
      setPulling(true);
      void onRefresh().finally(() => {
        setPulling(false);
        setPullOffset(0);
      });
    } else {
      setPullOffset(0);
    }
    touchStartY.current = null;
  };

  return (
    <div
      className="space-y-6"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Mobile Pull-To-Refresh Indicator (#94) */}
      {(pullOffset > 8 || pulling) && (
        <div
          className="lg:hidden flex items-center justify-center gap-2 text-xs font-bold text-sky-500 transition-all"
          style={{ height: pulling ? 36 : pullOffset }}
        >
          <RefreshCw className={`w-4 h-4 ${pulling ? 'animate-spin' : ''}`} />
          <span>{pulling ? 'جاري تحديث البيانات من السيرفر...' : 'اسحب للأسفل للتحديث'}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight">
            شبكتي
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-slate-500 dark:text-slate-400">
            مراقبة حقيقية عبر RouterOS API — تُسحب بيانات الموديل والمنافذ تلقائياً بعد الربط
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="min-h-[44px] px-4 rounded-2xl border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#11151E] text-xs font-bold text-slate-700 dark:text-slate-200 inline-flex items-center gap-2 hover:border-sky-500/40"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-sky-500' : ''}`} />
            <span className="hidden sm:inline">تحديث</span>
          </button>

          <button
            type="button"
            onClick={onOpenAddRouter}
            className="hidden lg:inline-flex items-center justify-center gap-2 min-h-[44px] px-5 rounded-2xl bg-gradient-to-l from-sky-600 to-teal-600 hover:from-sky-500 hover:to-teal-500 text-white text-sm font-bold shadow-lg shadow-sky-900/25 whitespace-nowrap shrink-0 transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>راوتر جديد</span>
          </button>
        </div>
      </div>

      {/* Hero Summary Card */}
      <div className="relative overflow-hidden rounded-[26px] bg-gradient-to-br from-[#073B6B] via-[#0284C7] to-[#0D9488] text-white p-6 shadow-xl shadow-sky-950/25">
        <div
          className="pointer-events-none absolute -bottom-16 -left-12 w-56 h-56 rounded-full bg-white/10"
          aria-hidden="true"
        />
        <div className="relative flex items-center gap-3.5 mb-6">
          <div className="w-11 h-11 rounded-2xl bg-white/15 backdrop-blur-sm flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold">
              {routers.length === 0
                ? 'ابدأ بربط أول راوتر MikroTik'
                : openAlerts.length > 0
                  ? `${openAlerts.length} ${openAlerts.length === 1 ? 'تنبيه مفتوح' : 'تنبيهات مفتوحة'}`
                  : 'الشبكة مستقرة — لا توجد تنبيهات مفتوحة'}
            </h2>
            <p className="text-xs text-sky-100/85 mt-0.5">
              {routers.length === 0
                ? 'الحساب جديد وخالي من أي بيانات وهمية — أضف راوترك الحقيقي ليبدأ الجلب المباشر'
                : openAlerts.length > 0
                  ? openAlerts[0].title
                  : `${onlineCount} راوتر متصل حياً${pendingCount > 0 ? ` · ${pendingCount} بانتظار التحقق` : ''}`}
            </p>
          </div>
        </div>

        <div className="relative grid grid-cols-4 gap-3 pt-4 border-t border-white/15">
          <div>
            <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums">
              {onlineCount}/{routers.length}
            </div>
            <div className="text-[11px] sm:text-xs text-sky-100/85 mt-0.5">متصل</div>
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums">
              {pendingCount}
            </div>
            <div className="text-[11px] sm:text-xs text-sky-100/85 mt-0.5">بانتظار الربط</div>
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums">
              {openAlerts.length}
            </div>
            <div className="text-[11px] sm:text-xs text-sky-100/85 mt-0.5">تنبيه</div>
          </div>
          <div>
            <div className="text-xl sm:text-2xl font-extrabold font-mono tabular-nums">
              {totalPppoe}
            </div>
            <div className="text-[11px] sm:text-xs text-sky-100/85 mt-0.5">مشترك PPPoE</div>
          </div>
        </div>
      </div>

      {/* Zero State (#12, #91) or Routers Grid */}
      {loading && routers.length === 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <div key={i} className="h-52 rounded-[22px] bg-slate-200 dark:bg-white/[0.05] animate-pulse" />
          ))}
        </div>
      ) : routers.length === 0 ? (
        <div className="rounded-[26px] border border-dashed border-slate-300 dark:border-white/[0.14] bg-white dark:bg-[#11151E] p-8 sm:p-12 text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-sky-500/12 text-sky-500 flex items-center justify-center mx-auto">
            <Router className="w-8 h-8" />
          </div>
          <div className="max-w-md mx-auto space-y-1.5">
            <h3 className="text-lg font-extrabold text-slate-900 dark:text-white">
              لا توجد راوترات مربوطة حتى الآن
            </h3>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 leading-relaxed">
              لا تُعرض أي بيانات تجريبية أو وهمية. اضغط &quot;ربط راوتر جديد&quot; واختر طريقة الاتصال ليقوم Bro Radius بسحب مواصفات الراوتر ومنافذه ومشتركيه الحقيقيين تلقائياً.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenAddRouter}
            className="min-h-[48px] px-6 rounded-2xl bg-gradient-to-l from-sky-600 to-teal-600 hover:from-sky-500 hover:to-teal-500 text-white text-sm font-bold inline-flex items-center gap-2 shadow-lg shadow-sky-900/25"
          >
            <Plus className="w-4 h-4" />
            <span>ربط راوتر جديد</span>
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-white">
            <Router className="w-5 h-5 text-sky-500" />
            <h2>راوترات الشبكة ({routers.length})</h2>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {routers.map((router) => {
              const upPorts = router.ports.filter((p) => p.status === 'up').length;
              const routerAlerts = openAlerts.filter((a) => a.routerId === router.id);
              const isSelected = selectedRouterId === router.id;
              const statusLabel =
                router.status === 'online'
                  ? 'متصل'
                  : router.status === 'pending'
                    ? 'بانتظار الربط'
                    : 'منقطع';
              const statusColor =
                router.status === 'online'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : router.status === 'pending'
                    ? 'text-amber-500'
                    : 'text-red-600 dark:text-red-400';

              return (
                <div
                  key={router.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectRouter(router.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectRouter(router.id);
                    }
                  }}
                  className={`group text-right rounded-[22px] bg-white dark:bg-[#11151E] border ${
                    isSelected
                      ? 'border-sky-500 ring-1 ring-sky-500/30'
                      : 'border-slate-200/80 dark:border-white/[0.07]'
                  } dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-sky-500/60 p-5 transition-all cursor-pointer`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-500 to-teal-500 text-white flex items-center justify-center shadow-lg shadow-sky-900/20 shrink-0">
                        <Router className="w-6 h-6" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-base font-bold text-slate-900 dark:text-white truncate group-hover:text-sky-600 dark:group-hover:text-sky-400 transition-colors">
                          {router.name}
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 truncate font-mono mt-0.5" dir="ltr">
                          {router.model
                            ? `${router.identity || router.name} · ${router.model}`
                            : 'تُجلب المواصفات تلقائياً عند الاتصال'}
                        </p>
                      </div>
                    </div>

                    <div className="text-left shrink-0">
                      <span className={`text-xs font-bold ${statusColor}`}>{statusLabel}</span>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5" dir="ltr">
                        {router.apiHost}:{router.apiPort}
                      </div>
                    </div>
                  </div>

                  {router.status === 'pending' ? (
                    <div className="mt-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 px-4 py-3 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-2">
                      <ShieldAlert className="w-4 h-4 shrink-0" />
                      <span>
                        {router.lastError
                          ? router.lastError
                          : 'افتح البطاقة لإتمام التحقق وسحب بيانات الهاردوير الحية'}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-4 mt-5">
                        <div>
                          <div className="flex items-center justify-between text-xs mb-1.5">
                            <span className="text-slate-500 dark:text-slate-400 font-semibold flex items-center gap-1">
                              <Cpu className="w-3.5 h-3.5" />
                              CPU
                            </span>
                            <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">
                              {router.cpuPercent ?? 0}%
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-100 dark:bg-white/[0.06] overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${
                                (router.cpuPercent ?? 0) > 80 ? 'bg-red-500' : 'bg-emerald-500'
                              }`}
                              style={{ width: `${router.cpuPercent ?? 0}%` }}
                            />
                          </div>
                        </div>

                        <div>
                          <div className="flex items-center justify-between text-xs mb-1.5">
                            <span className="text-slate-500 dark:text-slate-400 font-semibold">RAM</span>
                            <span className="font-mono font-bold text-sky-600 dark:text-sky-400 tabular-nums">
                              {router.ramPercent ?? 0}%
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-100 dark:bg-white/[0.06] overflow-hidden">
                            <div
                              className="h-full rounded-full bg-sky-500 transition-all duration-500"
                              style={{ width: `${router.ramPercent ?? 0}%` }}
                            />
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-white/[0.06] flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-300 tabular-nums">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-white/[0.04]">
                          <Users className="w-3.5 h-3.5 text-sky-500" />
                          <span className="font-mono">{router.pppoeOnline}</span> PPPoE
                        </span>
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-white/[0.04]">
                          <Network className="w-3.5 h-3.5 text-teal-500" />
                          <span className="font-mono">
                            {upPorts}/{router.ports.length}
                          </span>{' '}
                          منفذ
                        </span>
                        {router.uptimeText && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-white/[0.04]">
                            <Clock className="w-3.5 h-3.5 text-slate-400" />
                            {router.uptimeText}
                          </span>
                        )}
                        {router.tempCelsius !== null && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-white/[0.04]">
                            <Thermometer className="w-3.5 h-3.5 text-amber-500" />
                            <span className="font-mono">{router.tempCelsius}°</span>
                          </span>
                        )}
                        {router.tunnelRttMs !== null && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-white/[0.04] font-mono" dir="ltr">
                            {router.tunnelRttMs}ms
                          </span>
                        )}
                      </div>
                    </>
                  )}

                  {routerAlerts.length > 0 && (
                    <div className="mt-3 rounded-xl bg-red-500/10 border border-red-500/20 px-3 py-2 flex items-center gap-2 text-xs font-bold text-red-600 dark:text-red-400">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span className="truncate">{routerAlerts[0].title}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Direct Management Card */}
      <button
        type="button"
        onClick={onOpenDirectManage}
        className="w-full text-right rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] hover:border-teal-500/50 p-5 flex items-center justify-between gap-4 transition-all"
      >
        <div className="flex items-center gap-4 min-w-0">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-sky-500 text-white flex items-center justify-center shadow-lg shadow-indigo-900/20 shrink-0">
            <Sliders className="w-6 h-6" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-900 dark:text-white">الإدارة المباشرة للراوتر</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
              إصدار كروت هوتسبوت حقيقية عبر API + الوصول السريع لتفاصيل الراوتر
            </p>
          </div>
        </div>
        <ChevronLeft className="w-5 h-5 text-slate-400 shrink-0" />
      </button>

      {/* Mobile Floating CTA */}
      <button
        type="button"
        onClick={onOpenAddRouter}
        className="lg:hidden fixed bottom-20 right-4 z-30 min-h-[50px] px-5 rounded-2xl bg-gradient-to-l from-sky-600 to-teal-600 text-white font-bold text-sm shadow-xl shadow-sky-950/35 inline-flex items-center gap-2 active:scale-95 transition-transform"
      >
        <Plus className="w-5 h-5" />
        <span>راوتر جديد</span>
      </button>
    </div>
  );
};
