import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Antenna,
  CalendarClock,
  CheckCircle2,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Search,
  Signal,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import type {
  RfProtocol,
  RfRadioDevice,
  RfSignalSample,
  RfVendor,
  RouterDevice,
  TowerNode,
} from '../types';

interface Props {
  token: string;
  radios: RfRadioDevice[];
  routers: RouterDevice[];
  towers: TowerNode[];
  onRadiosChanged: (radios: RfRadioDevice[]) => void;
  onRefreshDashboard: () => void;
}

interface ScanChannel {
  frequencyMhz: number;
  usagePct: number;
  noiseDbm: number;
  rating: 'clean' | 'busy' | 'noisy';
}

const VENDOR_LABELS: Record<RfVendor, string> = {
  mikrotik: 'MikroTik',
  ubiquiti: 'Ubiquiti airMAX',
  mimosa: 'Mimosa',
  cambium: 'Cambium ePMP',
};

const PROTOCOL_LABELS: Record<RfProtocol, string> = {
  ros: 'RouterOS API',
  airos: 'airOS HTTP/S',
  snmp: 'SNMP v2c',
};

function RfHistorySvg({ samples }: { samples: RfSignalSample[] }) {
  if (samples.length < 2) {
    return (
      <div className="h-36 flex items-center justify-center text-xs text-slate-400">
        سيتم رسم منحنى الإشارة والضجيج تلقائياً بعد سحب قراءتين فأكثر
      </div>
    );
  }
  const w = 640;
  const h = 150;
  const pad = 16;
  const sigVals = samples.map((s) => s.signalDbm ?? -70);
  const nfVals = samples.map((s) => s.noiseFloorDbm ?? -95);
  const allVals = [...sigVals, ...nfVals];
  const minVal = Math.min(-105, ...allVals);
  const maxVal = Math.max(-35, ...allVals);
  const span = Math.max(10, maxVal - minVal);

  const toPoints = (vals: number[]) =>
    vals
      .map((v, i) => {
        const x = pad + (i / (vals.length - 1)) * (w - pad * 2);
        const y = h - pad - ((v - minVal) / span) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-36 overflow-visible">
        <line x1={pad} y1={pad} x2={w - pad} y2={pad} stroke="currentColor" strokeOpacity="0.08" />
        <line x1={pad} y1={h / 2} x2={w - pad} y2={h / 2} stroke="currentColor" strokeOpacity="0.08" />
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="currentColor" strokeOpacity="0.08" />
        <polyline
          fill="none"
          stroke="#10B981"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={toPoints(sigVals)}
        />
        <polyline
          fill="none"
          stroke="#F59E0B"
          strokeWidth="2"
          strokeDasharray="4 4"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={toPoints(nfVals)}
        />
      </svg>
      <div className="flex items-center justify-between text-[11px] font-mono text-slate-400" dir="ltr">
        <span className="text-emerald-500">Signal (dBm): {sigVals[sigVals.length - 1]}</span>
        <span className="text-amber-500">Noise Floor: {nfVals[nfVals.length - 1]} dBm</span>
        <span>Samples: {samples.length}</span>
      </div>
    </div>
  );
}

export const RfWirelessView: React.FC<Props> = ({
  token,
  radios,
  routers,
  towers,
  onRadiosChanged,
  onRefreshDashboard,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(radios[0]?.id || null);
  const [showAdd, setShowAdd] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [history, setHistory] = useState<RfSignalSample[]>([]);
  const [scanResults, setScanResults] = useState<ScanChannel[]>([]);
  const [scanning, setScanning] = useState(false);
  const [shiftFreq, setShiftFreq] = useState('');
  const [shiftTime, setShiftTime] = useState('');
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Add Radio Form
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [vendor, setVendor] = useState<RfVendor>('mikrotik');
  const [protocol, setProtocol] = useState<RfProtocol>('ros');
  const [port, setPort] = useState('8728');
  const [username, setUsername] = useState('admin');
  const [secret, setSecret] = useState('');
  const [towerId, setTowerId] = useState('');
  const [routerId, setRouterId] = useState('');
  const [saving, setSaving] = useState(false);

  const selected = radios.find((r) => r.id === selectedId) || radios[0] || null;

  useEffect(() => {
    if (!selected) {
      setHistory([]);
      return;
    }
    setScanResults([]);
    setShiftFreq(selected.frequencyMhz ? String(selected.frequencyMhz) : '');
    void (async () => {
      const res = await fetch(`/api/rf/radios/${selected.id}/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setHistory(data.samples || []);
      }
    })();
  }, [selected?.id, selected?.lastSync, token]);

  const handleVendorChange = (nextVendor: RfVendor) => {
    setVendor(nextVendor);
    if (nextVendor === 'mikrotik') {
      setProtocol('ros');
      setPort('8728');
    } else if (nextVendor === 'ubiquiti') {
      setProtocol('airos');
      setPort('443');
    } else {
      setProtocol('snmp');
      setPort('161');
    }
  };

  const handleAddRadio = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/rf/radios', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name,
          host,
          vendor,
          protocol,
          port: Number(port) || 8728,
          username,
          secret,
          towerId: towerId || null,
          routerId: routerId || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'تعذر إضافة الراديو');
        return;
      }
      if (data.radio) {
        onRadiosChanged([data.radio, ...radios]);
        setSelectedId(data.radio.id);
      }
      setShowAdd(false);
      setName('');
      setHost('');
      setSecret('');
      onRefreshDashboard();
    } finally {
      setSaving(false);
    }
  };

  const handleSync = async (radioId: string) => {
    setSyncingId(radioId);
    setErrorMsg(null);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/rf/radios/${radioId}/sync`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'فشل سحب الإشارة من الجهاز');
        return;
      }
      if (data.radio) {
        onRadiosChanged(radios.map((r) => (r.id === radioId ? data.radio : r)));
        setActionMsg(`تم تحديث قياسات ${data.radio.name} بنجاح`);
      }
    } finally {
      setSyncingId(null);
    }
  };

  const handleScanFreq = async (radioId: string) => {
    setScanning(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/rf/radios/${radioId}/scan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error || 'فشل فحص الترددات');
        return;
      }
      setScanResults(data.channels || []);
    } finally {
      setScanning(false);
    }
  };

  const handleApplyFrequency = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setErrorMsg(null);
    setActionMsg(null);
    const res = await fetch(`/api/rf/radios/${selected.id}/frequency`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        frequencyMhz: Number(shiftFreq),
        scheduleTime: shiftTime.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setErrorMsg(data.error || 'تعذر تغيير التردد');
      return;
    }
    setActionMsg(data.message || 'تم تطبيق التردد');
  };

  const handleReboot = async (radioId: string) => {
    setErrorMsg(null);
    setActionMsg(null);
    const res = await fetch(`/api/rf/radios/${radioId}/reboot`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      setErrorMsg(data.error || 'فشل إرسال أمر إعادة التشغيل');
      return;
    }
    setActionMsg(data.message);
  };

  const handleDelete = async (radioId: string) => {
    const res = await fetch(`/api/rf/radios/${radioId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const next = radios.filter((r) => r.id !== radioId);
      onRadiosChanged(next);
      if (selectedId === radioId) setSelectedId(next[0]?.id || null);
    }
  };

  const avgCcq = radios.some((r) => r.ccqPct !== null)
    ? Math.round(
        radios.filter((r) => r.ccqPct !== null).reduce((a, r) => a + (r.ccqPct || 0), 0) /
          radios.filter((r) => r.ccqPct !== null).length
      )
    : null;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-white">
            الراديوهات والترددات اللاسلكية
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            سكترات ووصلات MikroTik · Ubiquiti · Mimosa · Cambium — التردد، CCQ، Airtime، SNR، توازن Chain، وفحص القنوات النظيفة
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="min-h-[44px] px-4 rounded-2xl bg-sky-600 hover:bg-sky-500 text-white text-xs sm:text-sm font-bold inline-flex items-center gap-2 shadow-lg shadow-sky-900/20"
        >
          <Plus className="w-4 h-4" />
          <span>إضافة سكتر أو نانو</span>
        </button>
      </div>

      {/* Summary Bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="rounded-[20px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">إجمالي أجهزة البث</div>
          <div className="text-xl font-extrabold font-mono tabular-nums mt-1 text-slate-900 dark:text-white" dir="ltr">
            {radios.filter((r) => r.status === 'online').length} / {radios.length}
          </div>
        </div>
        <div className="rounded-[20px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">متوسط كفاءة CCQ</div>
          <div className="text-xl font-extrabold font-mono tabular-nums mt-1 text-emerald-500" dir="ltr">
            {avgCcq !== null ? `${avgCcq}%` : '—'}
          </div>
        </div>
        <div className="rounded-[20px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">تنبيهات كبل 10M / استقطاب</div>
          <div className="text-xl font-extrabold font-mono tabular-nums mt-1 text-amber-500" dir="ltr">
            {radios.filter((r) => r.lanSpeed === '10M' || (r.chainImbalanceDb ?? 0) > 6).length}
          </div>
        </div>
        <div className="rounded-[20px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-4">
          <div className="text-xs text-slate-500 dark:text-slate-400">إجمالي محطات العملاء</div>
          <div className="text-xl font-extrabold font-mono tabular-nums mt-1 text-sky-500" dir="ltr">
            {radios.reduce((a, r) => a + r.clients.length, 0)}
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-2xl bg-red-500/10 border border-red-500/25 px-4 py-3 text-xs font-semibold text-red-500 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}
      {actionMsg && (
        <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/25 px-4 py-3 text-xs font-semibold text-emerald-500 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{actionMsg}</span>
        </div>
      )}

      {radios.length === 0 ? (
        <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-8 text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-sky-500/10 text-sky-500 flex items-center justify-center mx-auto">
            <Antenna className="w-6 h-6" />
          </div>
          <h2 className="text-base font-bold text-slate-900 dark:text-white">
            لا توجد سكترات أو وصلات RF مضافة بعد
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            أضف أجهزة MikroTik Wireless / LHG / MantBox أو Ubiquiti Rocket / LiteBeam أو Mimosa أو Cambium لمتابعة التردد، التشويش، الـ CCQ، وربط كل محطة بمشترك PPPoE.
          </p>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="min-h-[42px] px-5 rounded-xl bg-sky-600 text-white text-xs font-bold"
          >
            إضافة أول جهاز بث
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          {/* Left Radios List */}
          <div className="lg:col-span-4 space-y-2.5">
            {radios.map((r) => {
              const isSelected = selected?.id === r.id;
              const warnLan = r.lanSpeed === '10M';
              const warnChain = (r.chainImbalanceDb ?? 0) > 6;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={`w-full text-right rounded-[20px] border p-4 transition-colors ${
                    isSelected
                      ? 'bg-sky-500/10 border-sky-500/50'
                      : 'bg-white dark:bg-[#11151E] border-slate-200/80 dark:border-white/[0.07] hover:border-sky-500/35'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-slate-900 dark:text-white truncate">
                        {r.name}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5" dir="ltr">
                        {r.host} · {VENDOR_LABELS[r.vendor]}
                      </div>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-md text-[10px] font-bold shrink-0 ${
                        r.status === 'online'
                          ? 'bg-emerald-500/15 text-emerald-500'
                          : r.status === 'pending'
                            ? 'bg-amber-500/15 text-amber-500'
                            : 'bg-red-500/15 text-red-500'
                      }`}
                    >
                      {r.status === 'online' ? 'متصل' : r.status === 'pending' ? 'معلّق' : 'منقطع'}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono tabular-nums text-slate-600 dark:text-slate-300" dir="ltr">
                    <span>{r.frequencyMhz ? `${r.frequencyMhz} MHz` : '— MHz'}</span>
                    <span>·</span>
                    <span className={(r.ccqPct ?? 100) < 75 ? 'text-red-500 font-bold' : 'text-emerald-500 font-bold'}>
                      CCQ {r.ccqPct !== null ? `${r.ccqPct}%` : '—'}
                    </span>
                    <span>·</span>
                    <span>{r.signalDbm !== null ? `${r.signalDbm} dBm` : '—'}</span>
                    {r.lanSpeed && (
                      <>
                        <span>·</span>
                        <span className={warnLan ? 'text-red-500 font-bold' : 'text-sky-500'}>
                          LAN {r.lanSpeed}
                        </span>
                      </>
                    )}
                  </div>
                  {(warnLan || warnChain) && (
                    <div className="mt-2 text-[11px] text-amber-500 font-semibold">
                      {warnLan ? 'تنبيه كبل 10M! ' : ''}
                      {warnChain ? `فرق استقطاب ${r.chainImbalanceDb}dB` : ''}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Right Selected Radio Detail */}
          {selected && (
            <div className="lg:col-span-8 space-y-4">
              <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Radio className="w-5 h-5 text-sky-500" />
                      <h2 className="text-base font-extrabold text-slate-900 dark:text-white">
                        {selected.name}
                      </h2>
                    </div>
                    <p className="text-xs font-mono text-slate-500 mt-0.5" dir="ltr">
                      {selected.model || VENDOR_LABELS[selected.vendor]} · SSID: {selected.ssid || '—'} · {PROTOCOL_LABELS[selected.protocol]}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleSync(selected.id)}
                      disabled={syncingId === selected.id}
                      className="min-h-[38px] px-3.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${syncingId === selected.id ? 'animate-spin' : ''}`} />
                      <span>قراءة التردد والإشارة</span>
                    </button>
                    {selected.protocol === 'ros' && (
                      <button
                        type="button"
                        onClick={() => void handleScanFreq(selected.id)}
                        disabled={scanning}
                        className="min-h-[38px] px-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-bold inline-flex items-center gap-1.5"
                      >
                        <Search className="w-3.5 h-3.5" />
                        <span>{scanning ? 'جارٍ الفحص...' : 'فحص أنظف تردد'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleReboot(selected.id)}
                      className="min-h-[38px] px-3 rounded-xl border border-amber-500/35 bg-amber-500/10 text-amber-500 text-xs font-bold inline-flex items-center gap-1"
                      title="إعادة تشغيل عن بُعد"
                    >
                      <Power className="w-3.5 h-3.5" />
                      <span>Reboot</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(selected.id)}
                      className="min-h-[38px] px-2.5 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20"
                      title="حذف"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {selected.lastError && (
                  <div className="rounded-xl bg-red-500/10 border border-red-500/25 px-3 py-2 text-xs text-red-500">
                    {selected.lastError}
                  </div>
                )}

                {/* Live RF Telemetry Grid (#1, #2, #3, #5, #6, #7, #15) */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  {[
                    { label: 'التردد والعرض', val: selected.frequencyMhz ? `${selected.frequencyMhz} MHz / ${selected.channelWidthMhz || 20}M` : '—' },
                    { label: 'قوة البث TxPower', val: selected.txPowerDbm !== null ? `${selected.txPowerDbm} dBm` : '—' },
                    { label: 'الإشارة / الضجيج', val: selected.signalDbm !== null ? `${selected.signalDbm} / ${selected.noiseFloorDbm ?? '—'} dBm` : '—' },
                    { label: 'نسبة SNR', val: selected.snrDb !== null ? `${selected.snrDb} dB` : '—' },
                    { label: 'توازن Chain H/V', val: selected.chain0Dbm !== null ? `${selected.chain0Dbm} / ${selected.chain1Dbm} (Δ${selected.chainImbalanceDb}dB)` : '—' },
                    { label: 'جودة CCQ / Airtime', val: `${selected.ccqPct ?? '—'}% · Air ${selected.airtimePct ?? '—'}%` },
                    { label: 'سرعة الربط Tx/Rx', val: selected.txRateMbps !== null ? `${selected.txRateMbps}/${selected.rxRateMbps ?? '—'} Mbps` : '—' },
                    { label: 'سرعة كبل LAN', val: selected.lanSpeed || '—' },
                  ].map((m, i) => (
                    <div key={i} className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3 border border-slate-200/60 dark:border-white/[0.05]">
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">{m.label}</div>
                      <div className="font-mono font-bold tabular-nums text-slate-900 dark:text-white mt-1" dir="ltr">
                        {m.val}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Frequency Shift & Scheduler (#8) */}
                {selected.protocol === 'ros' && (
                  <form onSubmit={(e) => void handleApplyFrequency(e)} className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3.5 border border-slate-200/70 dark:border-white/[0.06] flex flex-wrap items-end gap-2.5">
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">التردد الجديد (MHz)</label>
                      <input
                        type="number"
                        required
                        dir="ltr"
                        value={shiftFreq}
                        onChange={(e) => setShiftFreq(e.target.value)}
                        placeholder="5520"
                        className="w-28 min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#11151E] px-2.5 text-xs font-mono text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-500 mb-1">جدولة التبديل (اختياري HH:MM)</label>
                      <input
                        type="text"
                        dir="ltr"
                        value={shiftTime}
                        onChange={(e) => setShiftTime(e.target.value)}
                        placeholder="03:30"
                        className="w-28 min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.1] bg-white dark:bg-[#11151E] px-2.5 text-xs font-mono text-slate-900 dark:text-white"
                      />
                    </div>
                    <button
                      type="submit"
                      className="min-h-[38px] px-4 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold inline-flex items-center gap-1.5"
                    >
                      <CalendarClock className="w-3.5 h-3.5" />
                      <span>{shiftTime.trim() ? 'جدولة التبديل الليلي' : 'تطبيق فوري'}</span>
                    </button>
                  </form>
                )}

                {/* Spectral Frequency Monitor Results (#4) */}
                {scanResults.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      نتائج مسح أنظف الترددات ({scanResults.length} قناة)
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 max-h-44 overflow-y-auto">
                      {scanResults.slice(0, 16).map((ch) => (
                        <button
                          key={ch.frequencyMhz}
                          type="button"
                          onClick={() => setShiftFreq(String(ch.frequencyMhz))}
                          className={`rounded-xl p-2.5 border text-right text-xs transition-colors ${
                            ch.rating === 'clean'
                              ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : ch.rating === 'busy'
                                ? 'border-amber-500/30 bg-amber-500/10 text-amber-500'
                                : 'border-red-500/30 bg-red-500/10 text-red-500'
                          }`}
                        >
                          <div className="font-mono font-bold" dir="ltr">{ch.frequencyMhz} MHz</div>
                          <div className="text-[10px] font-mono mt-0.5" dir="ltr">
                            Use {ch.usagePct}% · NF {ch.noiseDbm}dBm
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* RF Signal History Chart (#13) */}
              <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-2">
                <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                  <Activity className="w-4 h-4 text-emerald-500" />
                  <span>سجل استقرار الإشارة والضجيج</span>
                </div>
                <RfHistorySvg samples={history} />
              </div>

              {/* Registered RF Clients Correlated with PPPoE Subscribers (#10) */}
              <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                    <Wifi className="w-4 h-4 text-sky-500" />
                    <span>النانوات والعملاء المسجلين على هذا السكتر ({selected.clients.length})</span>
                  </div>
                </div>
                {selected.clients.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    لا توجد محطات مسجلة أو أن السكتر يقرأ عبر SNMP فقط بدون جدول Registration.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-right text-xs">
                      <thead className="text-[11px] text-slate-400 border-b border-slate-200/70 dark:border-white/[0.07]">
                        <tr>
                          <th className="py-2 pl-3">MAC Address</th>
                          <th className="py-2 px-2">حساب PPPoE</th>
                          <th className="py-2 px-2">الإشارة</th>
                          <th className="py-2 px-2">CCQ</th>
                          <th className="py-2 px-2">Tx / Rx</th>
                          <th className="py-2 pr-2">المسافة</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200/60 dark:divide-white/[0.05]">
                        {selected.clients.map((c, idx) => (
                          <tr key={`${c.mac}-${idx}`}>
                            <td className="py-2 pl-3 font-mono text-[11px]" dir="ltr">{c.mac}</td>
                            <td className="py-2 px-2 font-bold text-sky-500">
                              {c.subscriberUsername || 'غير مطابق'}
                            </td>
                            <td className="py-2 px-2 font-mono" dir="ltr">
                              <span className={(c.signalDbm ?? -60) < -74 ? 'text-red-500 font-bold' : 'text-emerald-500'}>
                                {c.signalDbm !== null ? `${c.signalDbm} dBm` : '—'}
                              </span>
                            </td>
                            <td className="py-2 px-2 font-mono" dir="ltr">{c.ccqPct !== null && c.ccqPct !== undefined ? `${c.ccqPct}%` : '—'}</td>
                            <td className="py-2 px-2 font-mono" dir="ltr">
                              {c.txRateMbps ?? '—'} / {c.rxRateMbps ?? '—'} M
                            </td>
                            <td className="py-2 pr-2 font-mono" dir="ltr">
                              {c.distanceKm !== null && c.distanceKm !== undefined ? `${c.distanceKm} km` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add Radio Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4">
          <div className="w-full max-w-lg rounded-t-3xl sm:rounded-3xl bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Signal className="w-5 h-5 text-sky-500" />
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  إضافة سكتر / نانو / لينك RF
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={(e) => void handleAddRadio(e)} className="space-y-3 text-xs">
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="الاسم (مثال: سكتر شمال البرج 1 أو لينك Mimosa)"
                className="w-full min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-slate-900 dark:text-white"
              />

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">الشركة المصنعة</label>
                  <select
                    value={vendor}
                    onChange={(e) => handleVendorChange(e.target.value as RfVendor)}
                    className="w-full min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-slate-900 dark:text-white"
                  >
                    <option value="mikrotik">MikroTik Wireless / 60G</option>
                    <option value="ubiquiti">Ubiquiti airMAX (Rocket / LiteBeam)</option>
                    <option value="mimosa">Mimosa (B5c / C5c / A5c)</option>
                    <option value="cambium">Cambium (ePMP / PTP)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] text-slate-500 mb-1">بروتوكول القراءة</label>
                  <select
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value as RfProtocol)}
                    className="w-full min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-slate-900 dark:text-white"
                  >
                    <option value="ros">RouterOS API (8728)</option>
                    <option value="airos">Ubiquiti airOS HTTP/S (443)</option>
                    <option value="snmp">SNMP v2c (UDP 161)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <input
                  type="text"
                  required
                  dir="ltr"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="IP (e.g. 10.77.10.20)"
                  className="col-span-2 min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 font-mono text-slate-900 dark:text-white"
                />
                <input
                  type="number"
                  dir="ltr"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="Port"
                  className="min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 font-mono text-slate-900 dark:text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                {protocol !== 'snmp' && (
                  <input
                    type="text"
                    dir="ltr"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Username (admin / ubnt)"
                    className="min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 font-mono text-slate-900 dark:text-white"
                  />
                )}
                <input
                  type="password"
                  dir="ltr"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={protocol === 'snmp' ? 'SNMP Community (public)' : 'Password'}
                  className={`${protocol === 'snmp' ? 'col-span-2' : ''} min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 font-mono text-slate-900 dark:text-white`}
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <select
                  value={towerId}
                  onChange={(e) => setTowerId(e.target.value)}
                  className="min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-slate-900 dark:text-white"
                >
                  <option value="">بدون برج محدد</option>
                  {towers.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
                <select
                  value={routerId}
                  onChange={(e) => setRouterId(e.target.value)}
                  className="min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-slate-900 dark:text-white"
                >
                  <option value="">الربط بالراوتر (اختياري)</option>
                  {routers.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={saving}
                className="w-full min-h-[44px] rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-bold disabled:opacity-60"
              >
                {saving ? 'جارٍ الاتصال وسحب الإشارة...' : 'حفظ ومزامنة الإشارة الآن'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
