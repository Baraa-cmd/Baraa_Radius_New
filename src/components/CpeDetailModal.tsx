import React, { useEffect, useState } from 'react';
import {
  Activity,
  Archive,
  Ban,
  Camera,
  CheckCircle2,
  Clock,
  Gamepad2,
  Gauge,
  Globe,
  HardDriveDownload,
  History,
  Laptop,
  Moon,
  Power,
  RefreshCw,
  RotateCcw,
  Router,
  Send,
  Smartphone,
  Tv,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import type {
  CpeConnectedHost,
  CpeDeviceInfo,
  SubscriberRecord,
  SubscriberSessionRecord,
} from '../types';

interface Props {
  token: string;
  subscriber: SubscriberRecord;
  onClose: () => void;
  onUpdateSubscriber: (
    subId: string,
    patch: Partial<SubscriberRecord> & { graceHours?: number }
  ) => Promise<void>;
}

type ModalTab = 'devices' | 'wifi' | 'tools' | 'sessions';

function HostTypeIcon({ type }: { type: CpeConnectedHost['deviceType'] }) {
  if (type === 'phone') return <Smartphone className="w-4 h-4 text-sky-500" />;
  if (type === 'laptop') return <Laptop className="w-4 h-4 text-indigo-500" />;
  if (type === 'tv') return <Tv className="w-4 h-4 text-emerald-500" />;
  if (type === 'console') return <Gamepad2 className="w-4 h-4 text-amber-500" />;
  if (type === 'camera') return <Camera className="w-4 h-4 text-red-500" />;
  return <Router className="w-4 h-4 text-teal-500" />;
}

export const CpeDetailModal: React.FC<Props> = ({
  token,
  subscriber,
  onClose,
  onUpdateSubscriber,
}) => {
  const [tab, setTab] = useState<ModalTab>('devices');
  const [cpe, setCpe] = useState<CpeDeviceInfo | null>(null);
  const [sessions, setSessions] = useState<SubscriberSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pingResult, setPingResult] = useState<{
    status: 'up' | 'down';
    latencyMs: number | null;
    packetLossPct: number;
  } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // TR-069 / Proxy Manual Mapping
  const [tr069Id, setTr069Id] = useState('');
  const [cpeHost, setCpeHost] = useState(subscriber.ip || '');
  const [cpePort, setCpePort] = useState('80');

  // Wi-Fi 2.4 & 5GHz editor
  const [ssid24, setSsid24] = useState('');
  const [pass24, setPass24] = useState('');
  const [chan24, setChan24] = useState('');
  const [ssid5, setSsid5] = useState('');
  const [pass5, setPass5] = useState('');
  const [chan5, setChan5] = useState('');

  // CoA / Profile / Night Turbo
  const [coaRate, setCoaRate] = useState('');
  const [nextProfile, setNextProfile] = useState(subscriber.profile);
  const [turboEnabled, setTurboEnabled] = useState(Boolean(subscriber.turboNightEnabled));
  const [turboProf, setTurboProf] = useState(subscriber.turboProfile || '');
  const [showProxyFrame, setShowProxyFrame] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/subscribers/${subscriber.id}/cpe`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setCpe(data.cpe);
        setSessions(data.sessions || []);
        if (data.cpe) {
          setTr069Id(data.cpe.tr069DeviceId || '');
          setCpeHost(data.cpe.cpeHost || subscriber.ip || '');
          setCpePort(String(data.cpe.cpePort || 80));
          setSsid24(data.cpe.wifiSsid24 || '');
          setChan24(data.cpe.wifiChannel24 || '');
          setSsid5(data.cpe.wifiSsid5 || '');
          setChan5(data.cpe.wifiChannel5 || '');
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriber.id]);

  const handleSyncCpe = async () => {
    setSyncing(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/subscribers/${subscriber.id}/cpe/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error || 'فشل فحص راوتر المنزل');
        return;
      }
      setCpe(data.cpe);
      if (data.ping) setPingResult(data.ping);
      setMsg(
        data.cpe?.source === 'genieacs'
          ? 'تم سحب بيانات الراوتر المنزلي الحية عبر TR-069 GenieACS'
          : 'تم تحليل الأجهزة المتصلة من خلال MikroTik Conntrack واختبار Ping الحي'
      );
    } finally {
      setSyncing(false);
    }
  };

  const handleSaveMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    const res = await fetch(`/api/subscribers/${subscriber.id}/cpe/config`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        tr069DeviceId: tr069Id,
        cpeHost,
        cpePort: Number(cpePort) || 80,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setCpe(data.cpe);
      setMsg('تم حفظ معرف TR-069 / منفذ الواجهة');
    } else {
      setErr(data.error || 'تعذر الحفظ');
    }
  };

  const handlePushWifi = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/subscribers/${subscriber.id}/cpe/wifi`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ssid24,
        password24: pass24 || undefined,
        channel24: chan24 || undefined,
        ssid5,
        password5: pass5 || undefined,
        channel5: chan5 || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) setErr(data.error || 'فشل تحديث الواي فاي');
    else setMsg(data.message);
  };

  const handleCoa = async (action: 'disconnect' | 'coa-rate-limit') => {
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/subscribers/${subscriber.id}/coa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ action, rateLimit: coaRate }),
    });
    const data = await res.json();
    if (!res.ok) setErr(data.error || 'فشل تنفيذ CoA');
    else setMsg(data.message);
  };

  const handleBlockMac = async (mac: string) => {
    setErr(null);
    const res = await fetch(`/api/subscribers/${subscriber.id}/cpe/block-mac`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mac, block: true }),
    });
    const data = await res.json();
    if (res.ok) setMsg(data.message);
    else setErr(data.error);
  };

  const handleActionPost = async (path: string) => {
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/subscribers/${subscriber.id}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (res.ok) {
      setMsg(data.message || 'تم تنفيذ العملية بنجاح');
      void loadData();
    } else {
      setErr(data.error || 'تعذر تنفيذ الأمر');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4">
      <div className="w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-5 sm:p-6 shadow-2xl space-y-4">
        {/* Top Bar */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Router className="w-5 h-5 text-sky-500" />
              <h3 className="text-base sm:text-lg font-extrabold text-slate-900 dark:text-white">
                راوتر المنزل والتحكم العميق · {subscriber.fullName}
              </h3>
            </div>
            <p className="text-xs font-mono text-slate-500 mt-0.5" dir="ltr">
              {subscriber.username} · {subscriber.ip || 'Offline'} · {subscriber.macVendor}
              {subscriber.signalDbm !== null && subscriber.signalDbm !== undefined
                ? ` · RF ${subscriber.signalDbm} dBm`
                : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSyncCpe()}
              disabled={syncing}
              className="min-h-[38px] px-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold inline-flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>فحص الآن (CPE + Ping)</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl text-slate-500"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Ping & CPE Resource Snapshot (#24, #29) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
          <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
            <div className="text-[11px] text-slate-500">الأجهزة المتصلة</div>
            <div className="text-base font-extrabold font-mono text-sky-500 mt-0.5" dir="ltr">
              {cpe?.connectedCount ?? 0} جهاز
            </div>
          </div>
          <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
            <div className="text-[11px] text-slate-500">موديل الراوتر المنزلي</div>
            <div className="font-bold text-slate-900 dark:text-white truncate mt-0.5">
              {cpe?.model || 'اضغط فحص الآن'}
            </div>
          </div>
          <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
            <div className="text-[11px] text-slate-500">CPU / RAM / تشغيل</div>
            <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5" dir="ltr">
              {cpe?.cpuPct ?? '—'}% · {cpe?.ramPct ?? '—'}%
            </div>
          </div>
          <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
            <div className="text-[11px] text-slate-500">Ping الحي من المايكروتك</div>
            <div className="font-mono font-bold mt-0.5" dir="ltr">
              {pingResult
                ? pingResult.status === 'up'
                  ? `${pingResult.latencyMs}ms (${pingResult.packetLossPct}% loss)`
                  : 'Timeout (100% loss)'
                : cpe?.tr143DownMbps
                  ? `TR-143: ${cpe.tr143DownMbps} Mbps`
                  : '—'}
            </div>
          </div>
        </div>

        {err && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/25 px-3 py-2 text-xs text-red-500">
            {err}
          </div>
        )}
        {msg && (
          <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/25 px-3 py-2 text-xs text-emerald-500 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{msg}</span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-2 overflow-x-auto border-b border-slate-200/70 dark:border-white/[0.07]">
          {[
            { id: 'devices', label: 'الأجهزة المتصلة بالمنزل' },
            { id: 'wifi', label: 'الواي فاي و TR-069' },
            { id: 'tools', label: 'CoA وتوربو وسلفة' },
            { id: 'sessions', label: `سجل الجلسات (${sessions.length})` },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id as ModalTab)}
              className={`min-h-[40px] px-3 text-xs font-bold whitespace-nowrap border-b-2 ${
                tab === t.id
                  ? 'border-sky-500 text-sky-500'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="py-10 text-center text-xs text-slate-400">جارٍ التحميل...</div>
        ) : tab === 'devices' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-slate-500">
                المصدر:{' '}
                <strong className="text-slate-900 dark:text-white">
                  {cpe?.source === 'genieacs'
                    ? 'TR-069 GenieACS (دقة كاملة)'
                    : cpe?.source === 'mikrotik_conntrack'
                      ? 'تحليل MikroTik Conntrack + DHCP'
                      : 'اضغط "فحص الآن" للجرد'}
                </strong>
              </span>
              {subscriber.ip && (
                <button
                  type="button"
                  onClick={() => setShowProxyFrame((p) => !p)}
                  className="min-h-[34px] px-3 rounded-xl border border-sky-500/35 bg-sky-500/10 text-sky-500 font-bold inline-flex items-center gap-1.5"
                >
                  <Globe className="w-3.5 h-3.5" />
                  <span>{showProxyFrame ? 'إخفاء واجهة راوتر المنزل' : 'فتح صفحة راوتر المشترك Proxy'}</span>
                </button>
              )}
            </div>

            {showProxyFrame && (
              <div className="rounded-2xl border border-slate-200 dark:border-white/[0.1] overflow-hidden bg-white">
                <div className="px-3 py-1.5 bg-slate-100 dark:bg-[#171C28] text-[11px] font-mono text-slate-500 flex justify-between" dir="ltr">
                  <span>{`Proxy → http://${cpeHost}:${cpePort}/`}</span>
                  <button type="button" onClick={() => setShowProxyFrame(false)}>Close</button>
                </div>
                <iframe
                  title="CPE Web UI"
                  src={`/api/subscribers/${subscriber.id}/cpe-proxy`}
                  className="w-full h-72 bg-white"
                  sandbox="allow-forms allow-scripts"
                />
              </div>
            )}

            {!cpe || cpe.connectedHosts.length === 0 ? (
              <div className="rounded-2xl bg-slate-50 dark:bg-[#171C28] p-5 text-center text-xs text-slate-400">
                لم يتم سحب قائمة الأجهزة المتصلة داخل المنزل بعد — اضغط "فحص الآن".
              </div>
            ) : (
              <div className="divide-y divide-slate-200/70 dark:divide-white/[0.06] rounded-2xl border border-slate-200/80 dark:border-white/[0.07]">
                {cpe.connectedHosts.map((h, i) => (
                  <div key={`${h.mac}-${i}`} className="p-3 flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-[#171C28] flex items-center justify-center shrink-0">
                        <HostTypeIcon type={h.deviceType} />
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 dark:text-white truncate">{h.hostname}</div>
                        <div className="text-[11px] font-mono text-slate-500 truncate" dir="ltr">
                          {h.mac} · {h.ip} · {h.vendor}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-[11px] text-slate-500" dir="ltr">
                        {h.band}
                        {h.rssiDbm !== null ? ` · ${h.rssiDbm}dBm` : ''}
                      </span>
                      {!h.mac.startsWith('CONNTRACK') && (
                        <button
                          type="button"
                          onClick={() => void handleBlockMac(h.mac)}
                          className="p-1.5 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20"
                          title="حظر هذا الجهاز"
                        >
                          <Ban className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : tab === 'wifi' ? (
          <div className="space-y-4">
            <form onSubmit={(e) => void handlePushWifi(e)} className="rounded-2xl bg-slate-50 dark:bg-[#171C28] p-4 space-y-3 text-xs">
              <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Wifi className="w-4 h-4 text-sky-500" />
                <span>تعديل اسم وكلمة سر وقناة الواي فاي 2.4GHz و 5GHz (عبر TR-069)</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  type="text"
                  value={ssid24}
                  onChange={(e) => setSsid24(e.target.value)}
                  placeholder="SSID 2.4GHz"
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#11151E] px-2.5"
                />
                <input
                  type="text"
                  dir="ltr"
                  value={pass24}
                  onChange={(e) => setPass24(e.target.value)}
                  placeholder="Password 2.4GHz (8+)"
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#11151E] px-2.5 font-mono"
                />
                <input
                  type="text"
                  dir="ltr"
                  value={chan24}
                  onChange={(e) => setChan24(e.target.value)}
                  placeholder="Channel 2.4 (1/6/11)"
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#11151E] px-2.5 font-mono"
                />
                <input
                  type="text"
                  value={ssid5}
                  onChange={(e) => setSsid5(e.target.value)}
                  placeholder="SSID 5GHz"
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#11151E] px-2.5"
                />
                <input
                  type="text"
                  dir="ltr"
                  value={pass5}
                  onChange={(e) => setPass5(e.target.value)}
                  placeholder="Password 5GHz"
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#11151E] px-2.5 font-mono"
                />
                <input
                  type="text"
                  dir="ltr"
                  value={chan5}
                  onChange={(e) => setChan5(e.target.value)}
                  placeholder="Channel 5 (36/149)"
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#11151E] px-2.5 font-mono"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  className="min-h-[38px] px-4 rounded-xl bg-sky-600 text-white font-bold inline-flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>دفع إعدادات Wi-Fi</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleActionPost('/cpe/reboot')}
                  className="min-h-[38px] px-3 rounded-xl bg-amber-500/15 text-amber-500 font-bold inline-flex items-center gap-1.5"
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>إعادة تشغيل الراوتر</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleActionPost('/cpe/speedtest')}
                  className="min-h-[38px] px-3 rounded-xl bg-emerald-500/15 text-emerald-500 font-bold inline-flex items-center gap-1.5"
                >
                  <Gauge className="w-3.5 h-3.5" />
                  <span>فحص TR-143 من المنزل</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleActionPost('/cpe/backup')}
                  className="min-h-[38px] px-3 rounded-xl border border-slate-200 dark:border-white/[0.1] font-bold inline-flex items-center gap-1.5"
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span>حفظ نسخة إعدادات</span>
                </button>
                {cpe?.hasConfigBackup && (
                  <button
                    type="button"
                    onClick={() => void handleActionPost('/cpe/restore')}
                    className="min-h-[38px] px-3 rounded-xl border border-sky-500/35 text-sky-500 font-bold inline-flex items-center gap-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>استرجاع النسخة</span>
                  </button>
                )}
              </div>
            </form>

            <form onSubmit={(e) => void handleSaveMapping(e)} className="rounded-2xl border border-slate-200/80 dark:border-white/[0.07] p-4 grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs">
              <input
                type="text"
                dir="ltr"
                value={tr069Id}
                onChange={(e) => setTr069Id(e.target.value)}
                placeholder="GenieACS Device ID"
                className="sm:col-span-2 min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-slate-50 dark:bg-[#171C28] px-2.5 font-mono"
              />
              <input
                type="text"
                dir="ltr"
                value={cpeHost}
                onChange={(e) => setCpeHost(e.target.value)}
                placeholder="CPE IP"
                className="min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-slate-50 dark:bg-[#171C28] px-2.5 font-mono"
              />
              <button
                type="submit"
                className="min-h-[38px] rounded-xl bg-slate-800 dark:bg-white/[0.1] text-white font-bold"
              >
                حفظ الربط
              </button>
            </form>
          </div>
        ) : tab === 'tools' ? (
          <div className="space-y-4 text-xs">
            {/* RADIUS CoA & Profile Switcher (#46, #58) */}
            <div className="rounded-2xl bg-slate-50 dark:bg-[#171C28] p-4 space-y-3">
              <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Zap className="w-4 h-4 text-amber-500" />
                <span>تغيير السرعة الفوري (RADIUS CoA / PPPoE Profile)</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input
                  type="text"
                  dir="ltr"
                  value={nextProfile}
                  onChange={(e) => setNextProfile(e.target.value)}
                  placeholder="اسم الباقة على المايكروتك"
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#11151E] px-2.5 font-mono"
                />
                <input
                  type="text"
                  dir="ltr"
                  value={coaRate}
                  onChange={(e) => setCoaRate(e.target.value)}
                  placeholder="Rate-Limit (e.g. 10M/20M)"
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#11151E] px-2.5 font-mono"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void onUpdateSubscriber(subscriber.id, { profile: nextProfile })}
                    className="flex-1 min-h-[38px] rounded-xl bg-sky-600 text-white font-bold"
                  >
                    حفظ الباقة
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCoa(coaRate.trim() ? 'coa-rate-limit' : 'disconnect')}
                    className="flex-1 min-h-[38px] rounded-xl bg-amber-500 text-slate-950 font-bold"
                  >
                    تطبيق CoA
                  </button>
                </div>
              </div>
            </div>

            {/* Auto-Expiring Grace (#48) + Night Turbo (#54) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-2xl border border-slate-200/80 dark:border-white/[0.07] p-4 space-y-2.5">
                <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-sky-500" />
                  <span>سلفة تمديد تفصل تلقائياً</span>
                </div>
                {subscriber.graceExpiresAt && (
                  <div className="text-[11px] font-mono text-amber-500" dir="ltr">
                    ينتهي التمديد في: {new Date(subscriber.graceExpiresAt).toLocaleString('ar-IQ')}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {[6, 24, 48].map((hrs) => (
                    <button
                      key={hrs}
                      type="button"
                      onClick={() =>
                        void onUpdateSubscriber(subscriber.id, {
                          disabled: false,
                          billingStatus: 'active',
                          graceHours: hrs,
                        })
                      }
                      className="min-h-[36px] px-3 rounded-xl bg-sky-500/15 text-sky-500 font-bold"
                    >
                      تمديد {hrs} ساعة
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200/80 dark:border-white/[0.07] p-4 space-y-2.5">
                <div className="font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <Moon className="w-4 h-4 text-indigo-500" />
                  <span>التوربو الليلي التلقائي</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    dir="ltr"
                    value={turboProf}
                    onChange={(e) => setTurboProf(e.target.value)}
                    placeholder="باقة الليل (مثلاً Turbo-50M)"
                    className="flex-1 min-h-[36px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-slate-50 dark:bg-[#171C28] px-2.5 font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const next = !turboEnabled;
                      setTurboEnabled(next);
                      void onUpdateSubscriber(subscriber.id, {
                        turboNightEnabled: next,
                        turboProfile: turboProf,
                        baseProfile: subscriber.profile,
                      });
                    }}
                    className={`min-h-[36px] px-3 rounded-xl font-bold ${
                      turboEnabled ? 'bg-indigo-600 text-white' : 'bg-slate-200 dark:bg-white/[0.08]'
                    }`}
                  >
                    {turboEnabled ? 'مفعّل' : 'تفعيل'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                سيتم تسجيل الدخول والخروج وأسباب الانقطاع تلقائياً أثناء المراقبة الحية.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead className="text-[11px] text-slate-400 border-b border-slate-200/70 dark:border-white/[0.07]">
                    <tr>
                      <th className="py-2 pl-2">الدخول</th>
                      <th className="py-2 px-2">الخروج</th>
                      <th className="py-2 px-2">المدة</th>
                      <th className="py-2 px-2">IP</th>
                      <th className="py-2 pr-2">السبب</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200/60 dark:divide-white/[0.05]">
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td className="py-2 pl-2 font-mono text-[11px]" dir="ltr">
                          {new Date(s.loginAt).toLocaleString('ar-IQ', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                        </td>
                        <td className="py-2 px-2 font-mono text-[11px]" dir="ltr">
                          {s.logoutAt ? new Date(s.logoutAt).toLocaleString('ar-IQ', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : 'نشطة الآن'}
                        </td>
                        <td className="py-2 px-2 font-mono" dir="ltr">
                          {s.durationSec ? `${Math.round(s.durationSec / 60)}m` : '—'}
                        </td>
                        <td className="py-2 px-2 font-mono" dir="ltr">{s.ip}</td>
                        <td className="py-2 pr-2 text-slate-500">{s.disconnectCause || 'متصل'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
