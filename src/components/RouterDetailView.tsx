import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Clock,
  Copy,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Fan,
  FileText,
  Gauge,
  GitCompare,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  Network,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Router,
  Route,
  Search,
  Server,
  Settings2,
  Shield,
  Thermometer,
  Trash2,
  UserCheck,
  Users,
  Wifi,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import type {
  ApiPermissionMode,
  ConfigDiffRecord,
  ConnectionType,
  DiagnosticDataset,
  FailoverEventRecord,
  LatencyProbeRecord,
  PortRole,
  RfRadioDevice,
  RouterAlertItem,
  RouterAlertRules,
  RouterBackupItem,
  RouterDevice,
  RouterPort,
  SecurityAuditResult,
  ServerCapabilities,
  SubscriberRecord,
  TorchEntry,
  TowerNode,
  TrafficSample,
} from '../types';
import { CpeDetailModal } from './CpeDetailModal';
import { TopologyView } from './TopologyView';

type RouterTab =
  | 'overview'
  | 'ports'
  | 'usage'
  | 'subscribers'
  | 'devices'
  | 'topology'
  | 'tools'
  | 'info'
  | 'alerts';

interface RouterDetailViewProps {
  token: string;
  router: RouterDevice;
  subscribers: SubscriberRecord[];
  alerts: RouterAlertItem[];
  rfRadios?: RfRadioDevice[];
  towers?: TowerNode[];
  onBack: () => void;
  onUpdateRouter: (updated: RouterDevice) => void;
  onDeleteRouter: (routerId: string) => Promise<void>;
  onAckAlert: (alertId: string) => void;
  onDisconnectSubscriber: (subId: string) => Promise<void>;
  onToggleSubscriberDisabled: (subId: string, disabled: boolean) => Promise<void>;
  onUpdateSubscriber?: (
    subId: string,
    patch: Partial<SubscriberRecord> & { graceHours?: number }
  ) => Promise<void>;
}

const PORT_ROLES: PortRole[] = ['WAN', 'ISP', 'Tower', 'Switch', 'LAN', 'Unassigned'];

const ArcGauge: React.FC<{
  value: number | null;
  max?: number;
  label: string;
  unit: string;
  accentColor: string;
}> = ({ value, max = 100, label, unit, accentColor }) => {
  const numeric = value ?? 0;
  const pct = Math.max(0, Math.min(1, numeric / max));
  const r = 34;
  const cx = 44;
  const cy = 44;
  const totalArc = 270 * (Math.PI / 180) * r;
  const circumference = 2 * Math.PI * r;
  const activeLength = value === null ? 0 : totalArc * pct;

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-[88px] h-[88px] flex items-center justify-center">
        <svg className="w-[88px] h-[88px] rotate-[135deg]" viewBox="0 0 88 88">
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${totalArc} ${circumference}`}
            className="text-slate-200 dark:text-white/[0.08]"
          />
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={accentColor}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${activeLength} ${circumference}`}
            className="transition-all duration-500"
          />
        </svg>
        <span
          className="absolute text-sm font-extrabold font-mono tabular-nums text-slate-900 dark:text-white"
          dir="ltr"
        >
          {value === null ? '—' : `${value}${unit}`}
        </span>
      </div>
      <span className="-mt-1 text-xs font-bold text-slate-500 dark:text-slate-400">{label}</span>
    </div>
  );
};

function buildSmoothSpline(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const midX = ((p0.x + p1.x) / 2).toFixed(1);
    d += ` C ${midX} ${p0.y.toFixed(1)}, ${midX} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

const LiveTrafficChart: React.FC<{ samples: TrafficSample[] }> = ({ samples }) => {
  const width = 560;
  const height = 188;
  const padLeft = 44;
  const padRight = 10;
  const padTop = 14;
  const padBottom = 16;

  if (samples.length === 0) {
    return (
      <div className="h-44 flex items-center justify-center text-xs text-slate-400">
        لا توجد عينات ترافيك مسجلة بعد — ستظهر فور نجاح الاتصال الحي بالراوتر
      </div>
    );
  }

  const maxVal = Math.max(10, ...samples.flatMap((s) => [s.rxMbps, s.txMbps]));
  const ceilMax = Math.ceil(maxVal / 10) * 10;

  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const mapPoints = (vals: number[]) =>
    vals.map((v, i) => ({
      x: padLeft + (i / Math.max(1, vals.length - 1)) * plotW,
      y: padTop + plotH - (v / ceilMax) * plotH,
    }));

  const rxPts = mapPoints(samples.map((s) => s.rxMbps));
  const txPts = mapPoints(samples.map((s) => s.txMbps));

  const rxLine = buildSmoothSpline(rxPts);
  const txLine = buildSmoothSpline(txPts);
  const baseY = (padTop + plotH).toFixed(1);
  const rxArea = rxPts.length
    ? `${rxLine} L ${rxPts[rxPts.length - 1].x.toFixed(1)} ${baseY} L ${rxPts[0].x.toFixed(1)} ${baseY} Z`
    : '';
  const txArea = txPts.length
    ? `${txLine} L ${txPts[txPts.length - 1].x.toFixed(1)} ${baseY} L ${txPts[0].x.toFixed(1)} ${baseY} Z`
    : '';

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-44 select-none overflow-visible">
      <defs>
        <linearGradient id="broRxGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0EA5E9" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#0EA5E9" stopOpacity="0.01" />
        </linearGradient>
        <linearGradient id="broTxGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#14B8A6" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#14B8A6" stopOpacity="0.01" />
        </linearGradient>
      </defs>

      {[0, 0.33, 0.66, 1].map((ratio, idx) => {
        const y = padTop + plotH * (1 - ratio);
        const label = ratio === 0 ? '0M' : `${Math.round(ceilMax * ratio)}M`;
        return (
          <g key={idx}>
            <line
              x1={padLeft}
              y1={y}
              x2={padLeft + plotW}
              y2={y}
              stroke="currentColor"
              strokeDasharray="2 4"
              className="text-slate-200 dark:text-white/[0.06]"
            />
            <text x={padLeft - 8} y={y + 4} textAnchor="end" className="fill-slate-400 text-[10px] font-mono">
              {label}
            </text>
          </g>
        );
      })}

      <path d={rxArea} fill="url(#broRxGrad)" />
      <path d={txArea} fill="url(#broTxGrad)" />
      <path d={rxLine} fill="none" stroke="#0EA5E9" strokeWidth="2.6" strokeLinecap="round" />
      <path d={txLine} fill="none" stroke="#14B8A6" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
};

export const RouterDetailView: React.FC<RouterDetailViewProps> = ({
  token,
  router,
  subscribers,
  alerts,
  rfRadios = [],
  towers = [],
  onBack,
  onUpdateRouter,
  onDeleteRouter,
  onAckAlert,
  onDisconnectSubscriber,
  onToggleSubscriberDisabled,
  onUpdateSubscriber,
}) => {
  const [activeTab, setActiveTab] = useState<RouterTab>('overview');
  const [refreshing, setRefreshing] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [cpeSub, setCpeSub] = useState<SubscriberRecord | null>(null);

  const [portFilter, setPortFilter] = useState<'all' | 'up' | 'down' | 'monitored'>('all');
  const [editingPort, setEditingPort] = useState<RouterPort | null>(null);
  const [editPortLabel, setEditPortLabel] = useState('');
  const [editPortRole, setEditPortRole] = useState<PortRole>('Unassigned');
  const [editPortMonitored, setEditPortMonitored] = useState(true);
  const [editPortSpeed, setEditPortSpeed] = useState<'1G' | '100M' | '10G'>('1G');
  const [poeCycling, setPoeCycling] = useState(false);

  const [usagePeriod, setUsagePeriod] = useState<'24h' | '7d' | '30d'>('24h');
  const [portHistorySamples, setPortHistorySamples] = useState<
    Array<{ port_name: string; rx_mbps: number; tx_mbps: number; recorded_at: string }>
  >([]);

  const [subQuery, setSubQuery] = useState('');
  const [subSort, setSubSort] = useState<'name' | 'oldest'>('name');

  const [showAddPing, setShowAddPing] = useState(false);
  const [pingName, setPingName] = useState('');
  const [pingIp, setPingIp] = useState('');
  const [pingSector, setPingSector] = useState('عام');
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const [diagnostics, setDiagnostics] = useState<DiagnosticDataset | null>(null);
  const [activeDiagKey, setActiveDiagKey] = useState<string | null>(null);
  const [logTopicFilter, setLogTopicFilter] = useState<string>('all');
  const [backups, setBackups] = useState<RouterBackupItem[]>([]);

  // Tools & Multi-WAN state (#36, #39, #43, #45, #66, #72, #73, #74, #77, #79, #80, #88)
  const [torchIface, setTorchIface] = useState(router.ports[0]?.name || 'ether1');
  const [torchRows, setTorchRows] = useState<TorchEntry[]>([]);
  const [torchBusy, setTorchBusy] = useState(false);

  const [btestTarget, setBtestTarget] = useState('');
  const [btestDir, setBtestDir] = useState<'both' | 'receive' | 'transmit'>('both');
  const [btestProto, setBtestProto] = useState<'tcp' | 'udp'>('tcp');
  const [btestResult, setBtestResult] = useState<{ rxMbps: number; txMbps: number; status: string } | null>(null);
  const [btestBusy, setBtestBusy] = useState(false);

  const [traceTarget, setTraceTarget] = useState('1.1.1.1');
  const [traceHops, setTraceHops] = useState<Array<{ hop: number; address: string; lossPct: number; avgMs: string }>>([]);
  const [traceBusy, setTraceBusy] = useState(false);

  const [latencyProbes, setLatencyProbes] = useState<LatencyProbeRecord[]>([]);
  const [failoverEvents, setFailoverEvents] = useState<FailoverEventRecord[]>([]);
  const [probeBusy, setProbeBusy] = useState(false);

  const [configDiffs, setConfigDiffs] = useState<ConfigDiffRecord[]>([]);
  const [activeDiffId, setActiveDiffId] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  const [securityAudit, setSecurityAudit] = useState<SecurityAuditResult | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);

  const [dualWgEndpoint, setDualWgEndpoint] = useState('');
  const [dualWgPort, setDualWgPort] = useState('51821');
  const [toolStatusMsg, setToolStatusMsg] = useState<string | null>(null);

  const [scriptModal, setScriptModal] = useState<{ title: string; script: string } | null>(null);
  const [scriptCopied, setScriptCopied] = useState(false);

  const [rules, setRules] = useState<RouterAlertRules>(router.alertRules);
  const [rulesSaved, setRulesSaved] = useState(false);

  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [showConnEditor, setShowConnEditor] = useState(false);
  const [editConnName, setEditConnName] = useState(router.name);
  const [editConnType, setEditConnType] = useState<ConnectionType>(router.connectionType);
  const [editPermMode, setEditPermMode] = useState<ApiPermissionMode>(router.permissionMode);
  const [editApiHost, setEditApiHost] = useState('');
  const [editApiPort, setEditApiPort] = useState(String(router.apiPort || 8728));
  const [editApiUser, setEditApiUser] = useState(router.apiUsername || 'admin');
  const [editApiPass, setEditApiPass] = useState('');
  const [editUseExisting, setEditUseExisting] = useState(true);
  const [connSaving, setConnSaving] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);

  useEffect(() => {
    setRules(router.alertRules);
  }, [router.id, router.alertRules]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/capabilities', {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (res.ok) {
          setCapabilities((await res.json()) as ServerCapabilities);
        }
      } catch {
        // Ignore capability check failure
      }
    })();
  }, [token]);

  const openConnectionEditor = () => {
    setEditConnName(router.name);
    const preferDirect =
      router.connectionType === 'wireguard' && capabilities && !capabilities.wireguardReady;
    setEditConnType(preferDirect ? 'direct' : router.connectionType);
    setEditPermMode(router.permissionMode);
    setEditApiHost(
      router.apiHost === router.tunnelIp || router.apiHost === 'https-agent' ? '' : router.apiHost
    );
    setEditApiPort(String(router.apiPort || 8728));
    setEditApiUser(router.apiUsername || 'admin');
    setEditApiPass('');
    setEditUseExisting(true);
    setConnError(null);
    setShowConnEditor(true);
  };

  const handleSaveConnectionSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnError(null);
    setConnSaving(true);
    try {
      const res = await fetch(`/api/routers/${router.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: editConnName,
          connectionType: editConnType,
          permissionMode: editPermMode,
          apiHost: editApiHost.trim() || undefined,
          apiPort: Number(editApiPort) || 8728,
          apiUsername: editApiUser.trim() || undefined,
          apiPassword: editApiPass,
          useExistingCredentials: editConnType === 'direct' && editUseExisting,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setConnError(data.error || 'تعذر حفظ إعدادات الاتصال');
        return;
      }
      if (data.router) {
        onUpdateRouter(data.router);
      }

      if (editConnType === 'direct' && editUseExisting) {
        const verRes = await fetch(`/api/routers/${router.id}/verify`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        const verData = await verRes.json();
        if (verData.router) {
          onUpdateRouter(verData.router);
        }
        if (!verRes.ok || !verData.verified) {
          setConnError(verData.error || 'تم الحفظ ولكن فشل الاتصال المباشر — تحقق من المنفذ أو الجدار الناري');
          return;
        }
        setShowConnEditor(false);
        setActionMsg('تم حفظ الإعدادات والربط الحي بالراوتر بنجاح');
        return;
      }

      setShowConnEditor(false);
      if (data.installScript) {
        setScriptModal({
          title: 'سكربت التهيئة المحدّث — ألصقه في New Terminal داخل Winbox',
          script: data.installScript,
        });
      }
    } catch {
      setConnError('تعذر الاتصال بالخادم أثناء تحديث الإعدادات');
    } finally {
      setConnSaving(false);
    }
  };

  const handleVerifyOrSync = async () => {
    setRefreshing(true);
    setActionMsg(null);
    try {
      const endpoint =
        router.status === 'pending'
          ? `/api/routers/${router.id}/verify`
          : `/api/routers/${router.id}/telemetry`;
      const res = await fetch(endpoint, {
        method: router.status === 'pending' ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.router) {
        onUpdateRouter(data.router);
      }
      if (!res.ok) {
        setActionMsg(data.error || 'تعذر الوصول إلى الراوتر');
      }
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (activeTab !== 'overview' || router.status !== 'online') return;
    const timer = setInterval(() => {
      void (async () => {
        const res = await fetch(`/api/routers/${router.id}/telemetry`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.router) {
          onUpdateRouter(data.router);
        }
      })();
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, router.id, router.status, token]);

  useEffect(() => {
    if (activeTab !== 'usage') return;
    void (async () => {
      const res = await fetch(`/api/routers/${router.id}/port-history?range=${usagePeriod}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setPortHistorySamples(data.samples || []);
      }
    })();
  }, [activeTab, usagePeriod, router.id, token]);

  useEffect(() => {
    if (activeTab !== 'info' && activeTab !== 'tools') return;
    void (async () => {
      if (activeTab === 'info') {
        const bakRes = await fetch(`/api/routers/${router.id}/backups`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (bakRes.ok) {
          const data = await bakRes.json();
          setBackups(data.backups || []);
        }
      }
      if (activeTab === 'tools') {
        const [latRes, difRes] = await Promise.all([
          fetch(`/api/routers/${router.id}/latency`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
          fetch(`/api/routers/${router.id}/config-diffs`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        ]);
        if (latRes.ok) {
          const lData = await latRes.json();
          setLatencyProbes(lData.probes || []);
          setFailoverEvents(lData.failovers || []);
        }
        if (difRes.ok) {
          const dData = await difRes.json();
          const list = (dData.diffs || []) as ConfigDiffRecord[];
          setConfigDiffs(list);
          if (list[0] && !activeDiffId) setActiveDiffId(list[0].id);
        }
      }
      if (!diagnostics && router.status === 'online') {
        const diagRes = await fetch(`/api/routers/${router.id}/diagnostics`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (diagRes.ok) {
          setDiagnostics(await diagRes.json());
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, diagnostics, router.id, router.status, token]);

  const routerAlerts = alerts.filter((a) => a.routerId === router.id && !a.acknowledged);
  const routerSubscribers = useMemo(
    () => subscribers.filter((s) => s.routerId === router.id),
    [subscribers, router.id]
  );

  const filteredSubs = useMemo(() => {
    const q = subQuery.trim().toLowerCase();
    const list = routerSubscribers.filter(
      (s) =>
        !q ||
        s.username.toLowerCase().includes(q) ||
        s.fullName.toLowerCase().includes(q) ||
        s.ip.includes(q) ||
        s.mac.toLowerCase().includes(q)
    );
    return [...list].sort((a, b) =>
      subSort === 'name' ? a.username.localeCompare(b.username) : b.uptimeSeconds - a.uptimeSeconds
    );
  }, [routerSubscribers, subQuery, subSort]);

  const upPortsCount = router.ports.filter((p) => p.status === 'up').length;
  const downPortsCount = router.ports.length - upPortsCount;
  const monitoredPortsCount = router.ports.filter((p) => p.monitored).length;

  const filteredPorts = router.ports.filter((p) => {
    if (portFilter === 'up') return p.status === 'up';
    if (portFilter === 'down') return p.status === 'down';
    if (portFilter === 'monitored') return p.monitored;
    return true;
  });

  const devicesBySector = useMemo(() => {
    const groups = new Map<string, typeof router.monitoredDevices>();
    for (const d of router.monitoredDevices) {
      const sec = d.sectorGroup || 'عام';
      const arr = groups.get(sec) || [];
      arr.push(d);
      groups.set(sec, arr);
    }
    return Array.from(groups.entries());
  }, [router.monitoredDevices]);

  const ispPorts = router.ports.filter((p) => p.role === 'WAN' || p.role === 'ISP');
  const towerPorts = router.ports.filter((p) => p.role === 'Tower' || p.role === 'LAN' || p.role === 'Switch');
  const ispGb = ispPorts.reduce((a, p) => a + (p.rxBytesToday + p.txBytesToday) / 1e9, 0);
  const towerGb = towerPorts.reduce((a, p) => a + (p.rxBytesToday + p.txBytesToday) / 1e9, 0);

  const openPortEditor = (port: RouterPort) => {
    setEditingPort(port);
    setEditPortLabel(port.label);
    setEditPortRole(port.role || 'Unassigned');
    setEditPortMonitored(port.monitored);
    setEditPortSpeed(port.expectedSpeed);
  };

  const handleSavePort = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingPort) return;
    const res = await fetch(`/api/routers/${router.id}/ports/${editingPort.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        label: editPortLabel,
        role: editPortRole,
        monitored: editPortMonitored,
        expectedSpeed: editPortSpeed,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      onUpdateRouter(data.router);
      setEditingPort(null);
    }
  };

  const handleAddPingDevice = async (nameVal: string, ipVal: string, sectorVal = 'عام') => {
    setDeviceError(null);
    const res = await fetch(`/api/routers/${router.id}/devices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: nameVal, ip: ipVal, sectorGroup: sectorVal }),
    });
    const data = await res.json();
    if (!res.ok) {
      setDeviceError(data.error || 'تعذر إضافة الجهاز');
      return;
    }
    if (data.router) onUpdateRouter(data.router);
    setPingName('');
    setPingIp('');
    setPingSector('عام');
    setShowAddPing(false);
  };

  const handleDeletePingDevice = async (deviceId: string) => {
    const res = await fetch(`/api/routers/${router.id}/devices/${deviceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.router) onUpdateRouter(data.router);
    }
  };

  const handleRotateKeys = async () => {
    const res = await fetch(`/api/routers/${router.id}/rotate-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (res.ok) {
      onUpdateRouter(data.router);
      setScriptModal({
        title: 'تدوير مفاتيح WireGuard — ألصق السكربت الجديد في New Terminal',
        script: data.installScript,
      });
    }
  };

  const handleShowUninstall = async () => {
    const res = await fetch(`/api/routers/${router.id}/uninstall-script`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (res.ok) {
      setScriptModal({
        title: 'سكربت إزالة Bro Radius بالكامل من الراوتر',
        script: data.uninstallScript,
      });
    }
  };

  const handleCreateBackup = async (kind: 'backup' | 'rsc') => {
    setActionMsg(null);
    const res = await fetch(`/api/routers/${router.id}/backups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind }),
    });
    const data = await res.json();
    if (!res.ok) {
      setActionMsg(data.error || 'تعذر أخذ النسخة الاحتياطية');
      return;
    }
    setActionMsg(`تم حفظ النسخة على الراوتر: ${data.filename}`);
    const bakRes = await fetch(`/api/routers/${router.id}/backups`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (bakRes.ok) {
      const bData = await bakRes.json();
      setBackups(bData.backups || []);
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
    a.download = `subscribers-${router.identity || router.id}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleSaveRules = async (nextRules: RouterAlertRules) => {
    setRules(nextRules);
    const res = await fetch(`/api/routers/${router.id}/alerts`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(nextRules),
    });
    if (res.ok) {
      const data = await res.json();
      onUpdateRouter({ ...router, alertRules: data.alertRules });
      setRulesSaved(true);
      setTimeout(() => setRulesSaved(false), 1800);
    }
  };

  const handleCyclePoe = async () => {
    if (!editingPort) return;
    setPoeCycling(true);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/routers/${router.id}/poe/${encodeURIComponent(editingPort.name)}/cycle`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setActionMsg(data.message || data.error || 'تم تنفيذ أمر PoE');
    } finally {
      setPoeCycling(false);
    }
  };

  const handleRunTorch = async () => {
    setTorchBusy(true);
    setToolStatusMsg(null);
    try {
      const res = await fetch(`/api/routers/${router.id}/torch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ iface: torchIface }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToolStatusMsg(data.error || 'تعذر تشغيل Torch');
        return;
      }
      setTorchRows(data.entries || []);
    } finally {
      setTorchBusy(false);
    }
  };

  const handleRunBtest = async (e: React.FormEvent) => {
    e.preventDefault();
    setBtestBusy(true);
    setToolStatusMsg(null);
    try {
      const res = await fetch(`/api/routers/${router.id}/bandwidth-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target: btestTarget, direction: btestDir, protocol: btestProto }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToolStatusMsg(data.error || 'فشل Bandwidth-Test');
        return;
      }
      setBtestResult({ rxMbps: data.rxMbps, txMbps: data.txMbps, status: data.status });
    } finally {
      setBtestBusy(false);
    }
  };

  const handleRunTraceroute = async (e: React.FormEvent) => {
    e.preventDefault();
    setTraceBusy(true);
    setToolStatusMsg(null);
    try {
      const res = await fetch(`/api/routers/${router.id}/traceroute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ target: traceTarget }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToolStatusMsg(data.error || 'فشل Traceroute');
        return;
      }
      setTraceHops(data.hops || []);
    } finally {
      setTraceBusy(false);
    }
  };

  const handleQuickRouterAction = async (
    endpoint: string,
    body?: Record<string, unknown>,
    fallbackMsg = 'تم التنفيذ'
  ) => {
    setToolStatusMsg(null);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) {
      setToolStatusMsg(data.error || 'تعذر التنفيذ');
      return;
    }
    if (data.results && Array.isArray(data.results)) {
      setToolStatusMsg(`فحص جماعي: ${data.results.map((r: { name: string; status: string }) => `${r.name} (${r.status})`).join(' · ')}`);
    } else if (data.latestVersion) {
      setToolStatusMsg(`الإصدار المثبت: ${data.installedVersion} · الأحدث: ${data.latestVersion} (${data.status})`);
    } else {
      setToolStatusMsg(data.message || fallbackMsg);
    }
  };

  const handleProbeLatency = async () => {
    setProbeBusy(true);
    setToolStatusMsg(null);
    try {
      const res = await fetch(`/api/routers/${router.id}/latency/probe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const latRes = await fetch(`/api/routers/${router.id}/latency`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (latRes.ok) {
          const lData = await latRes.json();
          setLatencyProbes(lData.probes || []);
          setFailoverEvents(lData.failovers || []);
        }
      }
    } finally {
      setProbeBusy(false);
    }
  };

  const handleToggleRoute = async (routeId: string, currentlyDisabled: boolean, comment?: string) => {
    setToolStatusMsg(null);
    const res = await fetch(`/api/routers/${router.id}/routes/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ routeId, disabled: !currentlyDisabled, comment }),
    });
    const data = await res.json();
    if (!res.ok) {
      setToolStatusMsg(data.error || 'تعذر تعديل المسار');
      return;
    }
    const [diagRes, latRes] = await Promise.all([
      fetch(`/api/routers/${router.id}/diagnostics`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`/api/routers/${router.id}/latency`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    if (diagRes.ok) setDiagnostics(await diagRes.json());
    if (latRes.ok) {
      const lData = await latRes.json();
      setLatencyProbes(lData.probes || []);
      setFailoverEvents(lData.failovers || []);
    }
    setToolStatusMsg('تم تحديث حالة المسار وتوثيق التحويل');
  };

  const handleCaptureConfigDiff = async () => {
    setDiffBusy(true);
    setToolStatusMsg(null);
    try {
      const res = await fetch(`/api/routers/${router.id}/config-diffs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setToolStatusMsg(data.error || 'تعذر قراءة مقارنة .rsc');
        return;
      }
      const listRes = await fetch(`/api/routers/${router.id}/config-diffs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (listRes.ok) {
        const dData = await listRes.json();
        setConfigDiffs(dData.diffs || []);
        setActiveDiffId(data.id);
      }
    } finally {
      setDiffBusy(false);
    }
  };

  const handleRunSecurityAudit = async () => {
    setAuditBusy(true);
    setToolStatusMsg(null);
    try {
      const res = await fetch(`/api/routers/${router.id}/security-audit`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        setToolStatusMsg(data.error || 'فشل تدقيق الأمان');
        return;
      }
      setSecurityAudit(data as SecurityAuditResult);
    } finally {
      setAuditBusy(false);
    }
  };

  const handleGenerateDualWg = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(`/api/routers/${router.id}/dual-wg-script`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        secondaryEndpoint: dualWgEndpoint,
        secondaryPort: Number(dualWgPort) || 51821,
      }),
    });
    const data = await res.json();
    if (res.ok && data.script) {
      setScriptModal({
        title: 'سكربت نفق WireGuard الاحتياطي المزدوج (Dual-Homed)',
        script: data.script,
      });
    }
  };

  const tabs: Array<{ id: RouterTab; label: string }> = [
    { id: 'overview', label: 'نظرة عامة' },
    { id: 'ports', label: 'المنافذ' },
    { id: 'usage', label: 'الاستهلاك' },
    { id: 'subscribers', label: 'المشتركين' },
    { id: 'devices', label: 'الأجهزة' },
    { id: 'topology', label: 'التوبولوجي' },
    { id: 'tools', label: 'أدوات وMulti-WAN' },
    { id: 'info', label: 'معلومات ونسخ' },
    { id: 'alerts', label: 'التنبيهات' },
  ];

  const diagnosticTiles = [
    { key: 'ipAddresses', title: 'عناوين IP', icon: Network, color: 'from-sky-500 to-blue-600' },
    { key: 'routes', title: 'المسارات والبوابة', icon: Route, color: 'from-indigo-500 to-sky-600' },
    { key: 'dhcpLeases', title: 'DHCP Leases', icon: Server, color: 'from-amber-500 to-orange-600' },
    { key: 'arpTable', title: 'جدول ARP', icon: FileText, color: 'from-teal-500 to-emerald-600' },
    { key: 'arpConflicts', title: 'تعارضات ARP / MAC', icon: AlertTriangle, color: 'from-red-500 to-orange-600' },
    { key: 'rogueDhcpAlerts', title: 'كشف Rogue DHCP', icon: Shield, color: 'from-rose-500 to-red-600' },
    { key: 'pppoeServers', title: 'سيرفرات PPPoE', icon: Database, color: 'from-sky-600 to-cyan-600' },
    { key: 'pppProfiles', title: 'باقات PPP', icon: UserCheck, color: 'from-cyan-500 to-teal-600' },
    { key: 'ipPools', title: 'تجمعات IP Pools', icon: Database, color: 'from-cyan-600 to-blue-700' },
    { key: 'hotspotActive', title: 'الهوتسبوت المتصل', icon: Wifi, color: 'from-blue-500 to-indigo-600' },
    { key: 'simpleQueues', title: 'Simple Queues', icon: Activity, color: 'from-amber-500 to-yellow-600' },
    { key: 'vlans', title: 'VLANs', icon: Layers, color: 'from-sky-500 to-indigo-500' },
    { key: 'bridgePorts', title: 'Bridge Ports (STP)', icon: Layers, color: 'from-violet-500 to-indigo-600' },
    { key: 'wirelessClients', title: 'الوايرلس', icon: Radio, color: 'from-emerald-500 to-teal-600' },
    { key: 'services', title: 'خدمات الراوتر', icon: Settings2, color: 'from-slate-500 to-slate-700' },
    { key: 'dnsSettings', title: 'DNS', icon: Globe, color: 'from-teal-500 to-cyan-600' },
    { key: 'ntpStatus', title: 'ساعة النظام NTP', icon: Clock, color: 'from-emerald-600 to-teal-600' },
    { key: 'logs', title: 'السجلات (Log)', icon: FileText, color: 'from-orange-500 to-red-600' },
  ];

  const renderFaceplatePort = (port: RouterPort) => {
    const isMonitoredDown = port.monitored && port.status === 'down';
    const isSlower = port.status === 'up' && port.expectedSpeed === '1G' && port.speed === '100M';

    let boxStyle = 'border-slate-300 dark:border-white/[0.15] bg-slate-50 dark:bg-[#0D1118]';
    let speedTextStyle = 'text-slate-400';
    let ledStyle = 'bg-slate-400/50';

    if (isMonitoredDown) {
      boxStyle = 'border-red-500 bg-red-500/10';
      speedTextStyle = 'text-red-500';
      ledStyle = 'bg-red-500';
    } else if (isSlower) {
      boxStyle = 'border-amber-500 bg-amber-500/10';
      speedTextStyle = 'text-amber-500';
      ledStyle = 'bg-amber-500';
    } else if (port.status === 'up' && (port.speed === '1G' || port.speed === '10G')) {
      boxStyle = 'border-emerald-500 bg-emerald-500/10 shadow-[0_0_12px_rgba(16,185,129,0.18)]';
      speedTextStyle = 'text-emerald-500';
      ledStyle = 'bg-emerald-500';
    } else if (port.status === 'up' && port.speed === '100M') {
      boxStyle = 'border-sky-500 bg-sky-500/10 shadow-[0_0_12px_rgba(14,165,233,0.18)]';
      speedTextStyle = 'text-sky-500';
      ledStyle = 'bg-sky-500';
    }

    return (
      <button
        key={port.id}
        type="button"
        onClick={() => openPortEditor(port)}
        className="flex flex-col items-center gap-1.5 group"
      >
        <div
          className={`w-full min-h-[58px] rounded-xl border-2 px-1.5 py-2 flex flex-col items-center justify-center transition-transform group-active:scale-95 ${boxStyle}`}
        >
          <span className="text-[11px] font-bold text-slate-900 dark:text-white truncate max-w-full" dir="ltr">
            {port.label}
          </span>
          <span className={`text-[10px] font-mono font-bold mt-0.5 ${speedTextStyle}`} dir="ltr">
            {port.status === 'up' ? port.speed : '—'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 h-3">
          <span className={`w-1.5 h-1.5 rounded-full ${ledStyle}`} />
          {port.monitored && <Eye className="w-3 h-3 text-sky-500" aria-label="مراقب" />}
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-5">
      {/* Router Top Header (#6, #9, #18) */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] rounded-[20px] px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-white/[0.05] text-slate-700 dark:text-slate-200"
            aria-label="رجوع إلى شبكتي"
          >
            <ArrowRight className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-base sm:text-lg font-extrabold text-slate-900 dark:text-white truncate">
                {router.name}
              </h1>
              <span
                className={`text-xs font-bold whitespace-nowrap ${
                  router.status === 'online'
                    ? 'text-emerald-500'
                    : router.status === 'pending'
                      ? 'text-amber-500'
                      : 'text-red-500'
                }`}
              >
                {router.status === 'online'
                  ? 'متصل حياً'
                  : router.status === 'pending'
                    ? 'بانتظار الربط'
                    : 'منقطع'}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-mono truncate" dir="ltr">
              {router.apiHost}:{router.apiPort} · {router.model || 'Pending Auto-Detect'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openConnectionEditor}
            className="min-h-[40px] px-3 rounded-xl border border-sky-500/40 bg-sky-500/10 text-xs font-bold text-sky-600 dark:text-sky-400 inline-flex items-center gap-1.5 hover:bg-sky-500/20"
            title="تعديل طريقة الربط وعنوان IP والمنفذ"
          >
            <Settings2 className="w-3.5 h-3.5" />
            <span>إعدادات الاتصال</span>
          </button>

          <a
            href={`winbox://${router.apiHost}`}
            className="min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-white/[0.08] text-xs font-bold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5"
            title="فتح عبر Winbox"
          >
            <ExternalLink className="w-3.5 h-3.5 text-sky-500" />
            <span>Winbox</span>
          </a>

          <button
            type="button"
            onClick={() => void handleRotateKeys()}
            className="min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-white/[0.08] text-xs font-bold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5"
            title="تدوير مفاتيح WireGuard"
          >
            <KeyRound className="w-3.5 h-3.5 text-amber-500" />
            <span className="hidden sm:inline">تدوير المفاتيح</span>
          </button>

          <button
            type="button"
            onClick={() => void handleShowUninstall()}
            className="min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-white/[0.08] text-xs font-bold text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5"
            title="سكربت الإزالة"
          >
            <span>إزالة السكربت</span>
          </button>

          <button
            type="button"
            onClick={() => void onDeleteRouter(router.id)}
            className="min-h-[40px] px-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500/20 text-xs font-bold inline-flex items-center gap-1"
            title="حذف الراوتر"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => void handleVerifyOrSync()}
            className="min-h-[40px] px-3.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span>{router.status === 'pending' ? 'تحقق واسحب البيانات' : 'تحديث الآن'}</span>
          </button>
        </div>
      </div>

      {(router.status === 'pending' || router.lastError) && (
        <div className="rounded-2xl bg-amber-500/10 border border-amber-500/30 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="space-y-1 text-xs">
            <div className="font-bold text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>
                {router.connectionType === 'wireguard' && capabilities && !capabilities.wireguardReady
                  ? 'نفق WireGuard غير مدعوم في بيئة المعاينة الحالية (لا توجد واجهة wg0)'
                  : router.lastError || 'الراوتر بانتظار إتمام الربط والتحقق الحي'}
              </span>
            </div>
            {router.lastError && router.connectionType === 'wireguard' && capabilities && !capabilities.wireguardReady && (
              <div className="text-slate-600 dark:text-slate-300">
                السبب التقني المسجّل: <span className="font-mono">{router.lastError}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={openConnectionEditor}
            className="min-h-[40px] px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-extrabold whitespace-nowrap shrink-0"
          >
            {router.connectionType === 'wireguard' && capabilities && !capabilities.wireguardReady
              ? 'تحويل إلى API مباشر (Public IP / DDNS)'
              : 'تعديل إعدادات الاتصال'}
          </button>
        </div>
      )}

      {actionMsg && (
        <div className="rounded-2xl bg-amber-500/10 border border-amber-500/25 px-4 py-3 text-xs font-semibold text-amber-600 dark:text-amber-400">
          {actionMsg}
        </div>
      )}

      {/* Horizontal Tab Strip */}
      <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-0.5 border-b border-slate-200/80 dark:border-white/[0.07]">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`min-h-[44px] px-4 text-sm font-bold whitespace-nowrap shrink-0 border-b-2 transition-colors ${
                isActive
                  ? 'border-sky-500 text-sky-600 dark:text-sky-400'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: OVERVIEW (#11, #13, #14, #15, #16) */}
      {activeTab === 'overview' && (
        <div className="space-y-4">
          <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-sky-500 to-teal-500 text-white flex items-center justify-center shadow-lg shadow-sky-900/20 shrink-0">
                <Router className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-bold text-slate-900 dark:text-white truncate">
                  {router.identity || router.name}
                </h2>
                <p className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5" dir="ltr">
                  {router.model ? `${router.model} · ROS ${router.routerOsVersion || '-'}` : 'بانتظار أول مزامنة حقيقية'}
                  {router.serialNumber ? ` · SN: ${router.serialNumber}` : ''}
                </p>
                <div className="flex flex-wrap items-center gap-3 mt-1 text-xs">
                  {router.uptimeText && (
                    <span className="font-bold text-teal-600 dark:text-teal-400">
                      مدة التشغيل: {router.uptimeText}
                    </span>
                  )}
                  {router.firmwareVersion && router.upgradeFirmware && router.firmwareVersion !== router.upgradeFirmware && (
                    <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-500 font-mono font-bold text-[11px]">
                      تحديث Firmware متاح: {router.upgradeFirmware}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-4 text-xs font-mono" dir="ltr">
              {router.voltage !== null && (
                <div className="flex items-center gap-1.5 text-amber-500 font-bold">
                  <Zap className="w-4 h-4" />
                  <span>{router.voltage}V</span>
                </div>
              )}
              {router.fanRpm.length > 0 && (
                <div className="flex items-center gap-1.5 text-sky-500 font-bold">
                  <Fan className="w-4 h-4" />
                  <span>{router.fanRpm.join(' / ')} RPM</span>
                </div>
              )}
            </div>
          </div>

          {routerAlerts.length > 0 && (
            <div className="rounded-[22px] bg-red-500/10 border border-red-500/25 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-bold text-red-600 dark:text-red-400">
                    {routerAlerts.length} تنبيه مفتوح
                  </h3>
                  <ul className="mt-1 space-y-0.5 text-xs text-slate-700 dark:text-slate-300">
                    {routerAlerts.map((a) => (
                      <li key={a.id}>
                        • {a.title} ({a.timestamp})
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onAckAlert(routerAlerts[0].id)}
                className="min-h-[40px] px-4 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold whitespace-nowrap shrink-0"
              >
                تأكيد المعالجة
              </button>
            </div>
          )}

          {/* Gauges & Live Chart */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-5 rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 flex items-center justify-around">
              <ArcGauge value={router.cpuPercent} label="المعالج" unit="%" accentColor="#10B981" />
              <ArcGauge value={router.ramPercent} label="الرام" unit="%" accentColor="#0EA5E9" />
              <ArcGauge value={router.tempCelsius} max={90} label="الحرارة" unit="°" accentColor="#14B8A6" />
            </div>

            <div className="lg:col-span-7 rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-white">حركة المنافذ الحية</h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    يتحدّث كل 3 ثواني عبر monitor-traffic
                  </p>
                </div>
                <div className="flex items-center gap-4 text-xs font-mono font-bold tabular-nums" dir="ltr">
                  <span className="text-sky-500">↓ {router.currentRxMbps} Mbps</span>
                  <span className="text-teal-500">↑ {router.currentTxMbps} Mbps</span>
                </div>
              </div>
              <LiveTrafficChart samples={router.trafficHistory} />
            </div>
          </div>

          {/* Per-Core CPU Load (#16) */}
          {router.cpuCoreLoads.length > 0 && (
            <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3">
              <div className="text-xs font-bold text-slate-900 dark:text-white">
                توزيع الحمل على أنوية المعالج ({router.cpuCoreLoads.length} نواة)
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5">
                {router.cpuCoreLoads.map((c) => (
                  <div key={c.core} className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-2.5 text-xs">
                    <div className="flex justify-between font-mono text-[11px]" dir="ltr">
                      <span className="text-slate-400">CPU{c.core}</span>
                      <span className="font-bold text-emerald-500">{c.load}%</span>
                    </div>
                    <div className="mt-1.5 h-1.5 rounded-full bg-slate-200 dark:bg-white/[0.07] overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${c.load}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Stat Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            {[
              { label: 'PPPoE متصل / مسجل', value: `${router.pppoeOnline}/${router.pppoeSecretsCount}`, icon: Users, color: 'from-indigo-500 to-blue-600', action: () => setActiveTab('subscribers') },
              { label: 'منافذ شغّالة', value: `${upPortsCount}/${router.ports.length}`, icon: Network, color: 'from-cyan-500 to-sky-600', action: () => setActiveTab('ports') },
              { label: 'أجهزة مجاورة', value: String(router.neighborsCount), icon: Radio, color: 'from-emerald-500 to-teal-600', action: () => setActiveTab('devices') },
              { label: 'DHCP Leases', value: String(router.dhcpLeasesCount), icon: Server, color: 'from-orange-500 to-amber-600', action: () => setActiveTab('info') },
              { label: 'اتصالات الجدار الناري', value: router.activeConnections !== null ? String(router.activeConnections) : '—', icon: Activity, color: 'from-amber-400 to-yellow-600', action: undefined },
              { label: 'هوتسبوت متصل', value: String(router.hotspotOnline), icon: Wifi, color: 'from-sky-500 to-cyan-600', action: () => setActiveTab('info') },
              {
                label: `${router.cpuCores ?? '—'} نواة · ${router.architecture || '—'}`,
                value: router.ramTotalMb ? `${(router.ramTotalMb / 1024).toFixed(1)} GB` : '—',
                icon: Cpu,
                color: 'from-blue-500 to-indigo-600',
                action: undefined,
              },
              {
                label: 'زمن الاستجابة للنفق',
                value: router.tunnelRttMs !== null ? `${router.tunnelRttMs} ms` : '—',
                icon: Shield,
                color: 'from-teal-500 to-emerald-600',
                action: undefined,
              },
            ].map((stat, idx) => {
              const Icon = stat.icon;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={stat.action}
                  disabled={!stat.action}
                  className="text-right rounded-[20px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] hover:border-sky-500/40 p-4 flex items-center justify-between gap-3 transition-colors disabled:cursor-default"
                >
                  <div className="min-w-0">
                    <div className="text-base sm:text-lg font-extrabold font-mono tabular-nums text-slate-900 dark:text-white truncate" dir="ltr">
                      {stat.value}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">{stat.label}</div>
                  </div>
                  <div className={`w-11 h-11 rounded-2xl bg-gradient-to-br ${stat.color} text-white flex items-center justify-center shadow-md shrink-0`}>
                    <Icon className="w-5 h-5" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: PORTS (#21, #24, #25, #26, #27, #28, #30) */}
      {activeTab === 'ports' && (
        <div className="space-y-4">
          {router.ports.length === 0 ? (
            <div className="rounded-[22px] border border-dashed border-slate-300 dark:border-white/[0.12] bg-white dark:bg-[#11151E] p-8 text-center text-xs text-slate-500">
              لم يتم جلب المنافذ بعد — اضغط &quot;تحقق واسحب البيانات&quot; لسحب منافذ الإيثر و SFP والربط تلقائياً.
            </div>
          ) : (
            <>
              <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div className="text-sm font-bold text-emerald-500 font-mono tabular-nums">
                    {upPortsCount}/{router.ports.length} شغّال
                  </div>
                  <div className="text-xs font-mono text-slate-500 dark:text-slate-400" dir="ltr">
                    {router.model}
                  </div>
                </div>

                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5" dir="ltr">
                  {router.ports.map(renderFaceplatePort)}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  اضغط على أي منفذ لتحديد دوره (WAN / ISP / Tower) ومراقبته
                </p>
                <div className="flex items-center gap-1.5 bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-1 rounded-2xl">
                  {[
                    { id: 'all' as const, label: `الكل (${router.ports.length})` },
                    { id: 'up' as const, label: `${upPortsCount} شغّال` },
                    { id: 'down' as const, label: `${downPortsCount} واقف` },
                    { id: 'monitored' as const, label: `${monitoredPortsCount} مراقب` },
                  ].map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setPortFilter(f.id)}
                      className={`min-h-[36px] px-3 rounded-xl text-xs font-bold whitespace-nowrap transition-colors ${
                        portFilter === f.id
                          ? 'bg-sky-600 text-white'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {filteredPorts.map((port) => {
                  const isDownshift = port.status === 'up' && port.expectedSpeed === '1G' && port.speed === '100M';
                  return (
                    <button
                      key={port.id}
                      type="button"
                      onClick={() => openPortEditor(port)}
                      className="text-right rounded-[20px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] hover:border-sky-500/40 p-4 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${
                              port.status === 'up'
                                ? 'bg-emerald-500/15 text-emerald-500'
                                : 'bg-red-500/15 text-red-500'
                            }`}
                          >
                            <Network className="w-5 h-5" />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-sm text-slate-900 dark:text-white truncate" dir="ltr">
                                {port.label}
                              </span>
                              {port.role !== 'Unassigned' && (
                                <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-500">
                                  {port.role}
                                </span>
                              )}
                              {port.monitored && <Eye className="w-3.5 h-3.5 text-sky-500 shrink-0" />}
                            </div>
                            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                              {port.name} ({port.type}) ·{' '}
                              <span className={port.status === 'up' ? 'text-emerald-500' : 'text-red-500'}>
                                {port.status === 'up' ? 'شغّال' : 'واقف'}
                              </span>
                              {isDownshift && <span className="text-amber-500"> · هبوط سرعة 100M!</span>}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-col items-end gap-1 font-mono text-[11px] tabular-nums shrink-0" dir="ltr">
                          <span
                            className={`px-2 py-0.5 rounded-md font-bold ${
                              port.status === 'up' ? 'bg-emerald-500 text-white' : 'bg-slate-700 text-slate-300'
                            }`}
                          >
                            {port.status === 'up' ? port.speed : 'Down'}
                          </span>
                          <span className="text-slate-400">{port.duplex}</span>
                        </div>
                      </div>

                      <div className="mt-3 pt-3 border-t border-slate-100 dark:border-white/[0.06] flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums">
                        <span className="text-sky-500 inline-flex items-center gap-1" dir="ltr">
                          <ArrowDown className="w-3.5 h-3.5" /> {port.rxMbps} Mbps
                        </span>
                        <span className="text-teal-500 inline-flex items-center gap-1" dir="ltr">
                          <ArrowUp className="w-3.5 h-3.5" /> {port.txMbps} Mbps
                        </span>
                        {(port.rxErrors > 0 || port.rxDrops > 0 || (port.txDrops ?? 0) > 0) && (
                          <span className="text-amber-500 text-[11px]" dir="ltr">
                            FCS:{port.rxErrors} RxD:{port.rxDrops} TxD:{port.txDrops ?? 0}
                          </span>
                        )}
                        {port.poeStatus && (
                          <span className="text-emerald-500 text-[11px]" dir="ltr">
                            PoE: {port.poeStatus} {port.poeWatts != null ? `${port.poeWatts}W` : ''} {port.poeVoltage != null ? `${port.poeVoltage}V` : ''}
                          </span>
                        )}
                        {port.sfpRxDbm !== null && (
                          <span className="text-cyan-500 text-[11px]" dir="ltr">
                            SFP: {port.sfpRxDbm}dBm / {port.sfpTempC ?? '-'}°C
                            {port.sfpVoltageV != null ? ` / ${port.sfpVoltageV}V` : ''}
                            {port.sfpBiasMa != null ? ` / ${port.sfpBiasMa}mA` : ''}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Port Disconnect Duration History (#30) */}
              {router.portDisconnects.length > 0 && (
                <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] overflow-hidden">
                  <div className="px-5 py-3.5 border-b border-slate-200/80 dark:border-white/[0.07] font-bold text-sm text-slate-900 dark:text-white">
                    سجل انقطاعات المنافذ ومدتها الدقيقة
                  </div>
                  <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                    {router.portDisconnects.slice(0, 12).map((ev) => (
                      <div key={ev.id} className="px-5 py-3 flex items-center justify-between text-xs">
                        <div>
                          <span className="font-mono font-bold text-slate-900 dark:text-white" dir="ltr">
                            {ev.portName}
                          </span>
                          <div className="text-[11px] text-slate-400 font-mono" dir="ltr">
                            {ev.disconnectedAt.slice(0, 19).replace('T', ' ')}
                          </div>
                        </div>
                        <span className="font-mono font-bold text-amber-500">
                          {ev.durationSeconds !== null ? `توقف ${ev.durationSeconds} ثانية` : 'منقطع حالياً'}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* TAB 3: USAGE (#23, #28) */}
      {activeTab === 'usage' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-1 rounded-2xl">
              {[
                { id: '24h' as const, label: '24 ساعة' },
                { id: '7d' as const, label: '7 أيام' },
                { id: '30d' as const, label: '30 يوم' },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setUsagePeriod(p.id)}
                  className={`min-h-[38px] px-4 rounded-xl text-xs font-bold transition-colors ${
                    usagePeriod === p.id
                      ? 'bg-sky-600 text-white'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="text-xs text-slate-500">
              {portHistorySamples.length} عينة تاريخية محفوظة في SQLite
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-[22px] bg-gradient-to-br from-[#073B6B] to-[#0284C7] text-white p-5">
              <div className="text-xs text-sky-100">مجموع منافذ المزودين (WAN / ISP)</div>
              <div className="text-2xl font-extrabold font-mono mt-1" dir="ltr">
                {ispGb.toFixed(2)} GB
              </div>
              <div className="text-[11px] text-sky-100/80 mt-1">{ispPorts.length} منفذ مصنّف</div>
            </div>
            <div className="rounded-[22px] bg-gradient-to-br from-[#0D9488] to-[#059669] text-white p-5">
              <div className="text-xs text-emerald-100">مجموع مخارج الأبراج والمشتركين (Tower / LAN)</div>
              <div className="text-2xl font-extrabold font-mono mt-1" dir="ltr">
                {towerGb.toFixed(2)} GB
              </div>
              <div className="text-[11px] text-emerald-100/80 mt-1">{towerPorts.length} منفذ مصنّف</div>
            </div>
          </div>

          <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200/80 dark:border-white/[0.07] font-bold text-sm text-slate-900 dark:text-white">
              عدادات المنافذ الحقيقية من الراوتر
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 dark:bg-white/[0.03] text-slate-500 dark:text-slate-400">
                  <tr>
                    <th className="py-2.5 px-4 text-right font-semibold">المنفذ</th>
                    <th className="py-2.5 px-4 text-right font-semibold">الدور</th>
                    <th className="py-2.5 px-4 text-left font-semibold">سحب</th>
                    <th className="py-2.5 px-4 text-left font-semibold">رفع</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06] font-mono tabular-nums">
                  {router.ports.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-white/[0.02]">
                      <td className="py-3 px-4 font-bold text-slate-900 dark:text-white" dir="ltr">
                        {p.label}
                      </td>
                      <td className="py-3 px-4 font-sans text-slate-500">{p.role}</td>
                      <td className="py-3 px-4 text-left text-sky-500">
                        {(p.rxBytesToday / 1e9).toFixed(2)} GB
                      </td>
                      <td className="py-3 px-4 text-left text-teal-500">
                        {(p.txBytesToday / 1e9).toFixed(2)} GB
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: SUBSCRIBERS (#41-#50) */}
      {activeTab === 'subscribers' && (
        <div className="space-y-4">
          <div className="rounded-[24px] bg-gradient-to-l from-[#073B6B] via-[#0284C7] to-[#0D9488] text-white p-5 flex items-center justify-between">
            <div>
              <div className="text-3xl font-extrabold font-mono tabular-nums">
                {router.pppoeOnline} / {router.pppoeSecretsCount}
              </div>
              <div className="text-xs text-sky-100 mt-0.5">متصل الآن / إجمالي حسابات PPPoE</div>
            </div>
            <button
              type="button"
              onClick={() => void handleExportCsv()}
              className="min-h-[40px] px-4 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-bold inline-flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" />
              <span>CSV</span>
            </button>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={subQuery}
                onChange={(e) => setSubQuery(e.target.value)}
                placeholder="بحث بالاسم أو IP أو MAC"
                className="w-full min-h-[48px] rounded-2xl border border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#11151E] pr-11 pl-4 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="flex items-center gap-1.5 bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-1 rounded-2xl shrink-0">
              <button
                type="button"
                onClick={() => setSubSort('name')}
                className={`min-h-[38px] px-4 rounded-xl text-xs font-bold ${
                  subSort === 'name' ? 'bg-sky-600 text-white' : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                بالاسم
              </button>
              <button
                type="button"
                onClick={() => setSubSort('oldest')}
                className={`min-h-[38px] px-4 rounded-xl text-xs font-bold ${
                  subSort === 'oldest' ? 'bg-sky-600 text-white' : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                الأطول اتصالاً
              </button>
            </div>
          </div>

          <div className="space-y-2.5">
            {filteredSubs.length === 0 ? (
              <div className="rounded-[20px] border border-dashed border-slate-300 dark:border-white/[0.12] p-8 text-center text-xs text-slate-500">
                لا توجد حسابات PPPoE مسجلة على هذا الراوتر بعد
              </div>
            ) : (
              filteredSubs.map((sub) => (
                <div
                  key={sub.id}
                  className="rounded-[20px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-4 flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-sky-500 to-teal-500 text-white font-bold text-sm flex items-center justify-center shrink-0 uppercase">
                      {sub.username.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-slate-900 dark:text-white truncate">
                        {sub.username} ·{' '}
                        <span className="font-mono text-xs text-sky-500">{sub.profile}</span>
                      </div>
                      <div className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5" dir="ltr">
                        {sub.ip || 'No IP'} · {sub.mac || 'No MAC'} ({sub.macVendor})
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap items-center gap-2">
                        <span>{sub.uptimeText}</span>
                        {sub.online && (
                          <span className="font-mono text-sky-500" dir="ltr">
                            ↓{sub.liveRxMbps}M / ↑{sub.liveTxMbps}M
                          </span>
                        )}
                        {sub.flapCountToday > 0 && (
                          <span className="text-amber-500 font-bold">انقطاعات اليوم: {sub.flapCountToday}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setCpeSub(sub)}
                      className="min-h-[38px] px-3 rounded-xl bg-sky-500/15 text-sky-600 dark:text-sky-400 hover:bg-sky-500/25 text-xs font-bold"
                    >
                      راوتر المنزل / CoA
                    </button>
                    {sub.online && (
                      <button
                        type="button"
                        onClick={() => void onDisconnectSubscriber(sub.id)}
                        className="min-h-[38px] px-3 rounded-xl bg-amber-500/15 text-amber-500 hover:bg-amber-500/25 text-xs font-bold"
                      >
                        فصل الجلسة
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void onToggleSubscriberDisabled(sub.id, !sub.disabled)}
                      className={`min-h-[38px] px-3 rounded-xl text-xs font-bold ${
                        sub.disabled
                          ? 'bg-emerald-500/15 text-emerald-500'
                          : 'bg-red-500/10 text-red-500'
                      }`}
                    >
                      {sub.disabled ? 'تفعيل' : 'تعطيل'}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* TAB 5: DEVICES & NEIGHBORS (#31, #32, #33, #35, #37) */}
      {activeTab === 'devices' && (
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
                <Radio className="w-4 h-4 text-sky-500" />
                <span>أجهزة Ping المراقبة ({router.monitoredDevices.length})</span>
              </div>
              <button
                type="button"
                onClick={() => setShowAddPing((prev) => !prev)}
                className="min-h-[40px] px-4 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 text-sky-600 dark:text-sky-400 text-xs font-bold inline-flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>إضافة</span>
              </button>
            </div>

            {showAddPing && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleAddPingDevice(pingName, pingIp, pingSector);
                }}
                className="rounded-[20px] bg-white dark:bg-[#11151E] border border-sky-500/40 p-4 space-y-3"
              >
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <input
                    type="text"
                    required
                    value={pingName}
                    onChange={(e) => setPingName(e.target.value)}
                    placeholder="اسم الجهاز (Sector-East)"
                    className="min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm text-slate-900 dark:text-white"
                  />
                  <input
                    type="text"
                    required
                    dir="ltr"
                    value={pingIp}
                    onChange={(e) => setPingIp(e.target.value)}
                    placeholder="192.168.88.254"
                    className="min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-left text-slate-900 dark:text-white"
                  />
                  <input
                    type="text"
                    value={pingSector}
                    onChange={(e) => setPingSector(e.target.value)}
                    placeholder="البرج / المجموعة"
                    className="min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm text-slate-900 dark:text-white"
                  />
                </div>
                {deviceError && <p className="text-xs font-semibold text-red-500">{deviceError}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAddPing(false)}
                    className="min-h-[40px] px-4 rounded-lg text-xs font-semibold text-slate-500"
                  >
                    إلغاء
                  </button>
                  <button type="submit" className="min-h-[40px] px-5 rounded-xl bg-sky-600 text-white text-xs font-bold">
                    حفظ وفحص Ping
                  </button>
                </div>
              </form>
            )}

            {router.monitoredDevices.length === 0 ? (
              <div className="rounded-[20px] border border-dashed border-slate-300 dark:border-white/[0.12] p-6 text-center text-xs text-slate-500">
                لا توجد أجهزة مراقبة — أضف جهازاً يدوياً أو اختر من الأجهزة المجاورة بالأسفل
              </div>
            ) : (
              devicesBySector.map(([sector, devs]) => (
                <div key={sector} className="space-y-2">
                  <div className="text-xs font-bold text-slate-500 px-1">مجموعة: {sector}</div>
                  {devs.map((dev) => (
                    <div
                      key={dev.id}
                      className="rounded-[20px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-4 flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="font-bold text-sm text-slate-900 dark:text-white">{dev.name}</div>
                        <div
                          className={`text-xs font-mono mt-0.5 ${
                            dev.status === 'up'
                              ? 'text-emerald-500'
                              : dev.status === 'down'
                                ? 'text-red-500'
                                : 'text-slate-400'
                          }`}
                          dir="ltr"
                        >
                          {dev.ip} · {dev.status === 'up' ? `${dev.latencyMs ?? 0}ms` : dev.status} · Loss:{' '}
                          {dev.packetLossPct}%
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleDeletePingDevice(dev.id)}
                        className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-400 hover:text-red-500 hover:bg-red-500/10"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
              <HardDrive className="w-4 h-4 text-teal-500" />
              <span>أجهزة مجاورة (/ip/neighbor · {router.neighborsCount})</span>
            </div>

            {router.neighbors.length === 0 ? (
              <div className="rounded-[20px] border border-dashed border-slate-300 dark:border-white/[0.12] p-6 text-center text-xs text-slate-500">
                لا توجد أجهزة مكتشفة عبر MNDP / CDP حالياً
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {router.neighbors.map((nb) => {
                  const alreadyMonitored = router.monitoredDevices.some((d) => d.ip === nb.ip);
                  return (
                    <div
                      key={nb.id}
                      className="rounded-[20px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-4 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="font-bold text-sm text-slate-900 dark:text-white truncate">{nb.identity}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400 truncate" dir="ltr">
                          {nb.platform} · {nb.board} · {nb.interfaceName}
                        </div>
                        <div className="text-xs font-mono text-sky-500 mt-0.5" dir="ltr">
                          {nb.ip} · {nb.mac}
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={alreadyMonitored || !nb.ip}
                        onClick={() => void handleAddPingDevice(nb.identity, nb.ip, nb.interfaceName || 'مجاور')}
                        className={`min-h-[40px] px-3.5 rounded-xl text-xs font-bold whitespace-nowrap shrink-0 ${
                          alreadyMonitored
                            ? 'bg-emerald-500/15 text-emerald-500'
                            : 'bg-sky-500/15 text-sky-600 dark:text-sky-400 hover:bg-sky-500/25'
                        }`}
                      >
                        {alreadyMonitored ? 'مراقب' : 'راقب'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 6: TOPOLOGY (#34) */}
      {activeTab === 'topology' && (
        <TopologyView router={router} rfRadios={rfRadios} towers={towers} />
      )}

      {/* TAB 7: TOOLS & MULTI-WAN (#36, #39, #43, #45, #66, #72, #73, #74, #77, #79, #80, #88) */}
      {activeTab === 'tools' && (
        <div className="space-y-5">
          {toolStatusMsg && (
            <div className="rounded-2xl bg-sky-500/10 border border-sky-500/25 px-4 py-3 text-xs font-bold text-sky-600 dark:text-sky-400">
              {toolStatusMsg}
            </div>
          )}

          {/* Quick Controls: DNS Flush, NTP Sync, RouterOS/Firmware Upgrade, Bulk Check */}
          <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
              <Wrench className="w-4 h-4 text-sky-500" />
              <span>أوامر الصيانة والترقية السريعة (RouterOS & Firmware)</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleQuickRouterAction(`/api/routers/${router.id}/dns/flush`)}
                className="min-h-[40px] px-3.5 rounded-xl bg-slate-100 dark:bg-[#171C28] text-xs font-bold text-slate-800 dark:text-slate-200 hover:border-sky-500 border border-transparent"
              >
                مسح كاش DNS
              </button>
              <button
                type="button"
                onClick={() => void handleQuickRouterAction(`/api/routers/${router.id}/ntp/sync`)}
                className="min-h-[40px] px-3.5 rounded-xl bg-slate-100 dark:bg-[#171C28] text-xs font-bold text-slate-800 dark:text-slate-200"
              >
                تفعيل ومزامنة NTP
              </button>
              <button
                type="button"
                onClick={() => void handleQuickRouterAction(`/api/routers/${router.id}/upgrade`, { mode: 'check' })}
                className="min-h-[40px] px-3.5 rounded-xl bg-sky-500/15 text-sky-600 dark:text-sky-400 text-xs font-bold"
              >
                فحص تحديث RouterOS
              </button>
              <button
                type="button"
                onClick={() => void handleQuickRouterAction(`/api/routers/${router.id}/upgrade`, { mode: 'install' })}
                className="min-h-[40px] px-3.5 rounded-xl bg-amber-500/15 text-amber-500 text-xs font-bold"
              >
                تنزيل وتثبيت RouterOS
              </button>
              <button
                type="button"
                onClick={() => void handleQuickRouterAction(`/api/routers/${router.id}/upgrade`, { mode: 'routerboard' })}
                className="min-h-[40px] px-3.5 rounded-xl bg-indigo-500/15 text-indigo-400 text-xs font-bold"
              >
                ترقية RouterBOOT Firmware
              </button>
              <button
                type="button"
                onClick={() => void handleQuickRouterAction('/api/routers/bulk-upgrade')}
                className="min-h-[40px] px-3.5 rounded-xl bg-emerald-500/15 text-emerald-500 text-xs font-bold"
              >
                فحص جماعي لكل الراوترات
              </button>
            </div>
          </div>

          {/* Live Torch (#36) */}
          <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                <Activity className="w-4 h-4 text-orange-500" />
                <span>فحص الاستهلاك الحي (Torch)</span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={torchIface}
                  onChange={(e) => setTorchIface(e.target.value)}
                  dir="ltr"
                  className="min-h-[38px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono text-slate-900 dark:text-white"
                >
                  {router.ports.length > 0 ? (
                    router.ports.map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name} ({p.label})
                      </option>
                    ))
                  ) : (
                    <option value="ether1">ether1</option>
                  )}
                </select>
                <button
                  type="button"
                  disabled={torchBusy}
                  onClick={() => void handleRunTorch()}
                  className="min-h-[38px] px-4 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold disabled:opacity-60"
                >
                  {torchBusy ? 'جاري الفحص (2ث)...' : 'تشغيل Torch'}
                </button>
              </div>
            </div>
            {torchRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono tabular-nums" dir="ltr">
                  <thead className="bg-slate-50 dark:bg-[#171C28] text-slate-400">
                    <tr>
                      <th className="py-2 px-3 text-left">Src</th>
                      <th className="py-2 px-3 text-left">Dst</th>
                      <th className="py-2 px-3 text-left">Proto / Port</th>
                      <th className="py-2 px-3 text-right">Rx Mbps</th>
                      <th className="py-2 px-3 text-right">Tx Mbps</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                    {torchRows.map((row, idx) => (
                      <tr key={idx}>
                        <td className="py-2 px-3">{row.srcAddress}</td>
                        <td className="py-2 px-3">{row.dstAddress}</td>
                        <td className="py-2 px-3 text-slate-400">{row.protocol}:{row.dstPort || '*'}</td>
                        <td className="py-2 px-3 text-right text-sky-500">{row.rxMbps}M</td>
                        <td className="py-2 px-3 text-right text-teal-500">{row.txMbps}M</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Bandwidth Test (#43) & Traceroute (#79) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <form
              onSubmit={(e) => void handleRunBtest(e)}
              className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3"
            >
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                <Gauge className="w-4 h-4 text-emerald-500" />
                <span>اختبار السرعة بين راوترين (Bandwidth-Test)</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="text"
                  required
                  dir="ltr"
                  value={btestTarget}
                  onChange={(e) => setBtestTarget(e.target.value)}
                  placeholder="IP الطرف المقابل"
                  className="col-span-3 sm:col-span-1 min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono"
                />
                <select
                  value={btestDir}
                  onChange={(e) => setBtestDir(e.target.value as 'both' | 'receive' | 'transmit')}
                  className="min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2 text-xs font-bold"
                >
                  <option value="both">Both (Rx/Tx)</option>
                  <option value="receive">Receive</option>
                  <option value="transmit">Transmit</option>
                </select>
                <select
                  value={btestProto}
                  onChange={(e) => setBtestProto(e.target.value as 'tcp' | 'udp')}
                  className="min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2 text-xs font-bold"
                >
                  <option value="tcp">TCP</option>
                  <option value="udp">UDP</option>
                </select>
              </div>
              <button
                type="submit"
                disabled={btestBusy}
                className="w-full min-h-[40px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-60"
              >
                {btestBusy ? 'جاري الاختبار (3 ثوانٍ)...' : 'بدء Bandwidth-Test'}
              </button>
              {btestResult && (
                <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3 flex items-center justify-between text-xs font-mono" dir="ltr">
                  <span className="text-sky-500 font-bold">Rx: {btestResult.rxMbps} Mbps</span>
                  <span className="text-teal-500 font-bold">Tx: {btestResult.txMbps} Mbps</span>
                  <span className="text-slate-400">{btestResult.status}</span>
                </div>
              )}
            </form>

            <form
              onSubmit={(e) => void handleRunTraceroute(e)}
              className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3"
            >
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                <Route className="w-4 h-4 text-sky-500" />
                <span>تتبع المسار المباشر (Traceroute)</span>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  required
                  dir="ltr"
                  value={traceTarget}
                  onChange={(e) => setTraceTarget(e.target.value)}
                  placeholder="1.1.1.1 أو 8.8.8.8"
                  className="flex-1 min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono"
                />
                <button
                  type="submit"
                  disabled={traceBusy}
                  className="min-h-[40px] px-4 rounded-xl bg-sky-600 text-white text-xs font-bold disabled:opacity-60"
                >
                  {traceBusy ? 'جاري التتبع...' : 'تتبع'}
                </button>
              </div>
              {traceHops.length > 0 && (
                <div className="max-h-40 overflow-y-auto space-y-1 text-xs font-mono" dir="ltr">
                  {traceHops.map((h) => (
                    <div key={h.hop} className="flex items-center justify-between rounded-lg bg-slate-50 dark:bg-[#171C28] px-3 py-1.5">
                      <span>#{h.hop} {h.address}</span>
                      <span className="text-sky-500">{h.avgMs} ms (loss {h.lossPct}%)</span>
                    </div>
                  ))}
                </div>
              )}
            </form>
          </div>

          {/* Multi-WAN Routes & Live Latency Matrix (#66, #72, #73) */}
          <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                <Globe className="w-4 h-4 text-sky-500" />
                <span>تعدد المزودين (Multi-WAN) ومصفوفة Latency وسجل Failover</span>
              </div>
              <button
                type="button"
                disabled={probeBusy}
                onClick={() => void handleProbeLatency()}
                className="min-h-[38px] px-4 rounded-xl bg-sky-600 text-white text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${probeBusy ? 'animate-spin' : ''}`} />
                <span>فحص بنج 1.1.1.1 / 8.8.8.8 / 9.9.9.9</span>
              </button>
            </div>

            {latencyProbes.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
                {['1.1.1.1', '8.8.8.8', '9.9.9.9'].map((ip) => {
                  const latest = latencyProbes.find((p) => p.target === ip);
                  return (
                    <div key={ip} className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3 flex items-center justify-between">
                      <div>
                        <div className="font-mono font-bold text-slate-900 dark:text-white" dir="ltr">{ip}</div>
                        <div className="text-[11px] text-slate-400">{latest?.label || 'DNS Probe'}</div>
                      </div>
                      <div className="text-left font-mono" dir="ltr">
                        <div className={`font-bold ${latest?.latencyMs != null ? 'text-emerald-500' : 'text-red-500'}`}>
                          {latest?.latencyMs != null ? `${latest.latencyMs} ms` : 'Timeout'}
                        </div>
                        <div className="text-[10px] text-slate-400">Loss {latest?.packetLossPct ?? 0}%</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {diagnostics?.routes && diagnostics.routes.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-bold text-slate-500">المسارات النشطة / الاحتياطية على الراوتر:</div>
                {diagnostics.routes.slice(0, 8).map((rt, idx) => (
                  <div
                    key={rt.id || idx}
                    className="rounded-xl bg-slate-50 dark:bg-[#171C28] px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs font-mono"
                    dir="ltr"
                  >
                    <div>
                      <span className="font-bold text-slate-900 dark:text-white">{rt.dst}</span>{' '}
                      <span className="text-sky-500">via {rt.gateway}</span>{' '}
                      <span className="text-slate-400">dist={rt.distance} {rt.comment ? `(${rt.comment})` : ''}</span>
                    </div>
                    {rt.id && (
                      <button
                        type="button"
                        onClick={() => void handleToggleRoute(rt.id!, Boolean(rt.disabled), rt.comment)}
                        className={`font-sans min-h-[30px] px-3 rounded-lg text-[11px] font-bold ${
                          rt.disabled ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'
                        }`}
                      >
                        {rt.disabled ? 'تفعيل المسار' : 'تعطيل / تحويل'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {failoverEvents.length > 0 && (
              <div className="space-y-1 pt-2 border-t border-slate-100 dark:border-white/[0.06]">
                <div className="text-xs font-bold text-slate-500">سجل أحداث Failover الأخيرة:</div>
                {failoverEvents.slice(0, 6).map((ev) => (
                  <div key={ev.id} className="text-xs flex items-center justify-between py-1">
                    <span>{ev.fromGateway} ← {ev.toGateway} ({ev.reason})</span>
                    <span className="font-mono text-[10px] text-slate-400" dir="ltr">
                      {ev.createdAt.slice(0, 16).replace('T', ' ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Config .rsc Diff Snapshot (#74) */}
          <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                <GitCompare className="w-4 h-4 text-indigo-500" />
                <span>مقارنة تغييرات إعدادات الراوتر (.rsc Line Diff)</span>
              </div>
              <button
                type="button"
                disabled={diffBusy}
                onClick={() => void handleCaptureConfigDiff()}
                className="min-h-[38px] px-4 rounded-xl bg-indigo-600 text-white text-xs font-bold disabled:opacity-60"
              >
                {diffBusy ? 'جاري السحب والمقارنة...' : 'التقاط ومقارنة الآن'}
              </button>
            </div>
            {configDiffs.length > 0 && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {configDiffs.map((df) => (
                    <button
                      key={df.id}
                      type="button"
                      onClick={() => setActiveDiffId(df.id)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold border ${
                        activeDiffId === df.id
                          ? 'bg-indigo-600 border-indigo-600 text-white'
                          : 'border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {df.summary} · {df.createdAt.slice(5, 16).replace('T', ' ')}
                    </button>
                  ))}
                </div>
                {(() => {
                  const chosen = configDiffs.find((d) => d.id === activeDiffId) || configDiffs[0];
                  if (!chosen) return null;
                  return (
                    <pre
                      dir="ltr"
                      className="rounded-2xl bg-[#070A10] border border-white/[0.08] p-3 text-[11px] font-mono overflow-x-auto max-h-56 text-left space-y-0.5"
                    >
                      {chosen.diffLines.map((ln, idx) => (
                        <div
                          key={idx}
                          className={
                            ln.type === 'add'
                              ? 'text-emerald-400'
                              : ln.type === 'del'
                                ? 'text-red-400'
                                : 'text-slate-400'
                          }
                        >
                          {ln.type === 'add' ? '+ ' : ln.type === 'del' ? '- ' : '  '}
                          {ln.text}
                        </div>
                      ))}
                    </pre>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Security Audit (#88) + Dual-Homed WireGuard (#80) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                  <Shield className="w-4 h-4 text-red-500" />
                  <span>التدقيق الأمني وكشف المستخدمين</span>
                </div>
                <button
                  type="button"
                  disabled={auditBusy}
                  onClick={() => void handleRunSecurityAudit()}
                  className="min-h-[36px] px-3.5 rounded-xl bg-red-600 text-white text-xs font-bold disabled:opacity-60"
                >
                  {auditBusy ? 'جاري التدقيق...' : 'فحص الأمان الآن'}
                </button>
              </div>
              {securityAudit && (
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
                    <span className="font-bold">نقاط أمان الراوتر:</span>
                    <span
                      className={`font-mono font-extrabold text-base ${
                        securityAudit.score >= 80
                          ? 'text-emerald-500'
                          : securityAudit.score >= 50
                            ? 'text-amber-500'
                            : 'text-red-500'
                      }`}
                    >
                      {securityAudit.score}/100
                    </span>
                  </div>
                  {securityAudit.newAdminUsersDetected.length > 0 && (
                    <div className="rounded-xl bg-red-500/15 border border-red-500/30 p-2.5 text-red-500 font-bold">
                      تحذير: تم رصد مستخدمين إداريين جدد: {securityAudit.newAdminUsersDetected.join(', ')}
                    </div>
                  )}
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {securityAudit.findings.map((f, i) => (
                      <div key={i} className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-2.5">
                        <div
                          className={`font-bold ${
                            f.severity === 'critical'
                              ? 'text-red-500'
                              : f.severity === 'warning'
                                ? 'text-amber-500'
                                : 'text-emerald-500'
                          }`}
                        >
                          {f.title}
                        </div>
                        <div className="text-slate-500 text-[11px]">{f.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <form
              onSubmit={(e) => void handleGenerateDualWg(e)}
              className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3"
            >
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                <KeyRound className="w-4 h-4 text-sky-500" />
                <span>نفق WireGuard احتياطي مزدوج (Dual-Homed VPS)</span>
              </div>
              <p className="text-xs text-slate-500">
                ولّد سكربت واجهة wg-backup ثانٍ على المايكروتك ليبقى الراوتر متصلاً بسيرفر احتياطي تلقائياً عند تعطل المسار الرئيسي.
              </p>
              <div className="grid grid-cols-3 gap-2">
                <input
                  type="text"
                  dir="ltr"
                  value={dualWgEndpoint}
                  onChange={(e) => setDualWgEndpoint(e.target.value)}
                  placeholder="Backup VPS IP/Host"
                  className="col-span-2 min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono"
                />
                <input
                  type="number"
                  dir="ltr"
                  value={dualWgPort}
                  onChange={(e) => setDualWgPort(e.target.value)}
                  placeholder="51821"
                  className="min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono"
                />
              </div>
              <button
                type="submit"
                className="w-full min-h-[40px] rounded-xl bg-sky-600 text-white text-xs font-bold"
              >
                توليد سكربت WireGuard المزدوج
              </button>
            </form>
          </div>
        </div>
      )}

      {/* TAB 8: INFO & BACKUPS (#19) */}
      {activeTab === 'info' && (
        <div className="space-y-5">
          {/* Backup Trigger Card */}
          <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                <Archive className="w-4 h-4 text-sky-500" />
                <span>النسخ الاحتياطي وتصدير الإعدادات</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleCreateBackup('backup')}
                  className="min-h-[38px] px-3.5 rounded-xl bg-sky-600 text-white text-xs font-bold"
                >
                  حفظ .backup
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreateBackup('rsc')}
                  className="min-h-[38px] px-3.5 rounded-xl bg-teal-600 text-white text-xs font-bold"
                >
                  تصدير .rsc
                </button>
              </div>
            </div>

            {backups.length > 0 && (
              <div className="divide-y divide-slate-100 dark:divide-white/[0.06] pt-1">
                {backups.map((b) => (
                  <div key={b.id} className="py-2 flex items-center justify-between text-xs">
                    <span className="font-mono font-bold text-slate-800 dark:text-slate-200" dir="ltr">
                      {b.filename}
                    </span>
                    <span className="font-mono text-slate-400" dir="ltr">
                      {b.createdAt.slice(0, 16).replace('T', ' ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {diagnosticTiles.map((tile) => {
              const Icon = tile.icon;
              return (
                <button
                  key={tile.key}
                  type="button"
                  onClick={() => setActiveDiagKey(tile.key)}
                  className={`relative overflow-hidden min-h-[84px] rounded-[20px] bg-gradient-to-br ${tile.color} text-white p-4 flex items-center justify-between gap-3 text-right shadow-md hover:opacity-95 active:scale-[0.98] transition-all`}
                >
                  <span className="text-sm font-bold leading-snug">{tile.title}</span>
                  <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center shrink-0">
                    <Icon className="w-5 h-5" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 7: ALERTS (#58) */}
      {activeTab === 'alerts' && (
        <div className="space-y-4 max-w-2xl">
          <div className="rounded-[20px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-4 flex items-center justify-between">
            <div>
              <div className="font-bold text-sm text-slate-900 dark:text-white">إشعارات هذا الراوتر</div>
              <div className={`text-xs font-bold mt-0.5 ${rules.enabled ? 'text-emerald-500' : 'text-slate-400'}`}>
                {rules.enabled ? 'شغّالة' : 'متوقفة'}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={rules.enabled}
              onClick={() => void handleSaveRules({ ...rules, enabled: !rules.enabled })}
              className={`w-14 h-8 rounded-full p-1 transition-colors ${
                rules.enabled ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-700'
              }`}
            >
              <span
                className={`block w-6 h-6 rounded-full bg-white transition-transform ${
                  rules.enabled ? '-translate-x-6' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">شروط التنبيه</h3>
            {rulesSaved && (
              <span className="text-xs font-bold text-emerald-500 inline-flex items-center gap-1">
                <Check className="w-3.5 h-3.5" /> تم الحفظ
              </span>
            )}
          </div>

          <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] divide-y divide-slate-100 dark:divide-white/[0.06]">
            {[
              {
                label: 'الراوتر لا يرد لمدة',
                icon: AlertTriangle,
                value: rules.offlineMinutes,
                options: [1, 3, 5, 10],
                suffix: 'د',
                onChange: (v: number) => void handleSaveRules({ ...rules, offlineMinutes: v }),
              },
              {
                label: 'حمل المعالج فوق',
                icon: Cpu,
                value: rules.cpuThreshold,
                options: [70, 80, 85, 90, 95],
                suffix: '%',
                onChange: (v: number) => void handleSaveRules({ ...rules, cpuThreshold: v }),
              },
              {
                label: 'فقدان حزم Ping فوق',
                icon: Radio,
                value: rules.packetLossThreshold,
                options: [5, 10, 15, 25, 40],
                suffix: '%',
                onChange: (v: number) => void handleSaveRules({ ...rules, packetLossThreshold: v }),
              },
              {
                label: 'الحرارة فوق',
                icon: Thermometer,
                value: rules.tempThreshold,
                options: [65, 70, 75, 80, 85],
                suffix: '°',
                onChange: (v: number) => void handleSaveRules({ ...rules, tempThreshold: v }),
              },
              {
                label: 'تنبيه قبل انتهاء اشتراك المشتركين بـ',
                icon: Users,
                value: rules.expiryReminderDays,
                options: [1, 2, 3, 5, 7],
                suffix: 'يوم',
                onChange: (v: number) => void handleSaveRules({ ...rules, expiryReminderDays: v }),
              },
            ].map((row, i) => {
              const Icon = row.icon;
              return (
                <div key={i} className="px-4 py-3.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 text-sm font-semibold text-slate-800 dark:text-slate-200">
                    <Icon className="w-4 h-4 text-sky-500 shrink-0" />
                    <span>{row.label}</span>
                  </div>
                  <select
                    value={row.value}
                    onChange={(e) => row.onChange(Number(e.target.value))}
                    className="min-h-[40px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono font-bold text-slate-900 dark:text-white"
                  >
                    {row.options.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt} {row.suffix}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}

            {[
              {
                key: 'alertOnMonitoredPortDown' as const,
                title: 'وقوع منفذ مراقب',
                subtitle: 'تنبيه فوري عند انقطاع منفذ',
              },
              {
                key: 'alertOnPortSpeedDrop' as const,
                title: 'نزول سرعة المنفذ',
                subtitle: 'تنبيه عند تحول سرعة 1G إلى 100M',
              },
              {
                key: 'alertOnPingDeviceDown' as const,
                title: 'توقف الأجهزة المراقبة',
                subtitle: 'تنبيه عند انقطاع Ping لأي سيكتر أو جهاز',
              },
            ].map((sw) => (
              <div key={sw.key} className="px-4 py-3.5 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-slate-900 dark:text-white">{sw.title}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{sw.subtitle}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={rules[sw.key]}
                  onClick={() => void handleSaveRules({ ...rules, [sw.key]: !rules[sw.key] })}
                  className={`w-12 h-7 rounded-full p-1 transition-colors shrink-0 ${
                    rules[sw.key] ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <span
                    className={`block w-5 h-5 rounded-full bg-white transition-transform ${
                      rules[sw.key] ? '-translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Port Configuration Sheet (#28) */}
      {editingPort && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4">
          <div className="w-full max-w-md rounded-t-[28px] sm:rounded-[28px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                إعدادات المنفذ {editingPort.name}
              </h3>
              <button
                type="button"
                onClick={() => setEditingPort(null)}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={(e) => void handleSavePort(e)} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">
                  تسمية المنفذ
                </label>
                <input
                  type="text"
                  required
                  value={editPortLabel}
                  onChange={(e) => setEditPortLabel(e.target.value)}
                  className="w-full min-h-[46px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-sm font-mono text-slate-900 dark:text-white"
                  dir="ltr"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">
                  تصنيف المنفذ (Role)
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {PORT_ROLES.map((role) => (
                    <button
                      key={role}
                      type="button"
                      onClick={() => setEditPortRole(role)}
                      className={`min-h-[38px] rounded-xl text-xs font-mono font-bold border ${
                        editPortRole === role
                          ? 'bg-sky-600 border-sky-600 text-white'
                          : 'border-slate-200 dark:border-white/[0.09] text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {role}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-600 dark:text-slate-300 mb-1.5">
                  السرعة الطبيعية المتوقعة
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['100M', '1G', '10G'] as const).map((sp) => (
                    <button
                      key={sp}
                      type="button"
                      onClick={() => setEditPortSpeed(sp)}
                      className={`min-h-[40px] rounded-xl text-xs font-mono font-bold border ${
                        editPortSpeed === sp
                          ? 'bg-sky-600 border-sky-600 text-white'
                          : 'border-slate-200 dark:border-white/[0.09] text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {sp}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
                  {editPortMonitored ? <Eye className="w-4 h-4 text-sky-500" /> : <EyeOff className="w-4 h-4 text-slate-400" />}
                  <span>مراقبة المنفذ وإرسال تنبيه عند التوقف</span>
                </div>
                <button
                  type="button"
                  onClick={() => setEditPortMonitored((p) => !p)}
                  className={`w-12 h-7 rounded-full p-1 transition-colors ${
                    editPortMonitored ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-700'
                  }`}
                >
                  <span
                    className={`block w-5 h-5 rounded-full bg-white transition-transform ${
                      editPortMonitored ? '-translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="space-y-2.5">
                <button
                  type="submit"
                  className="w-full min-h-[48px] rounded-2xl bg-sky-600 hover:bg-sky-500 text-white font-bold text-sm"
                >
                  حفظ التغييرات
                </button>

                {router.permissionMode === 'full-control' &&
                  (editingPort.type === 'ether' || editingPort.poeStatus) && (
                    <button
                      type="button"
                      disabled={poeCycling}
                      onClick={() => void handleCyclePoe()}
                      className="w-full min-h-[44px] rounded-2xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-500 font-bold text-xs inline-flex items-center justify-center gap-2 disabled:opacity-60"
                    >
                      <Power className="w-4 h-4" />
                      <span>
                        {poeCycling
                          ? 'جاري فصل وإعادة الطاقة PoE...'
                          : `إعادة تشغيل الطاقة (PoE Cycle) على ${editingPort.name}`}
                      </span>
                    </button>
                  )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Script Viewer Modal (#6, #9) */}
      {scriptModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm sm:p-4">
          <div className="w-full max-w-2xl rounded-t-[28px] sm:rounded-[28px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">{scriptModal.title}</h3>
              <button
                type="button"
                onClick={() => setScriptModal(null)}
                className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <pre
              dir="ltr"
              className="rounded-2xl bg-[#070A10] text-emerald-300 border border-white/[0.08] p-4 text-[11px] font-mono overflow-x-auto max-h-64 text-left"
            >
              {scriptModal.script}
            </pre>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(scriptModal.script);
                setScriptCopied(true);
                setTimeout(() => setScriptCopied(false), 1800);
              }}
              className="w-full min-h-[44px] rounded-xl bg-sky-600 text-white text-xs font-bold inline-flex items-center justify-center gap-2"
            >
              {scriptCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{scriptCopied ? 'تم النسخ' : 'نسخ السكربت'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Read-Only Diagnostic Modal */}
      {activeDiagKey && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm sm:p-4">
          <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-t-[28px] sm:rounded-[28px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-200/80 dark:border-white/[0.07]">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">
                {diagnosticTiles.find((t) => t.key === activeDiagKey)?.title} — {router.identity || router.name}
              </h3>
              <button
                type="button"
                onClick={() => setActiveDiagKey(null)}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {!diagnostics ? (
              <div className="p-6 text-center text-xs text-slate-400">
                {router.status === 'online'
                  ? 'جاري جلب البيانات الحية من الراوتر...'
                  : 'يجب أن يكون الراوتر متصلاً حياً لقراءة هذه التشخيصات'}
              </div>
            ) : activeDiagKey === 'dnsSettings' ? (
              <div className="space-y-2 text-sm font-mono">
                <div className="flex justify-between py-2 border-b border-slate-100 dark:border-white/[0.06]">
                  <span className="text-slate-500 font-sans">خوادم DNS</span>
                  <span className="text-slate-900 dark:text-white" dir="ltr">
                    {diagnostics.dnsSettings.servers}
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100 dark:border-white/[0.06]">
                  <span className="text-slate-500 font-sans">Allow Remote Requests</span>
                  <span className="text-emerald-500">
                    {diagnostics.dnsSettings.allowRemoteRequests ? 'Yes' : 'No'}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-sans">الذاكرة المؤقتة</span>
                  <span className="text-slate-900 dark:text-white">
                    {diagnostics.dnsSettings.cacheUsedKb} / {diagnostics.dnsSettings.cacheSizeKb} KB
                  </span>
                </div>
              </div>
            ) : activeDiagKey === 'ntpStatus' ? (
              <div className="space-y-2 text-sm font-mono">
                <div className="flex justify-between py-2 border-b border-slate-100 dark:border-white/[0.06]">
                  <span className="text-slate-500 font-sans">التفعيل</span>
                  <span className="text-emerald-500">
                    {diagnostics.ntpStatus?.enabled ? 'مفعّل' : 'معطّل'}
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-slate-100 dark:border-white/[0.06]">
                  <span className="text-slate-500 font-sans">السيرفرات</span>
                  <span dir="ltr">{diagnostics.ntpStatus?.servers || '—'}</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-slate-500 font-sans">حالة المزامنة</span>
                  <span dir="ltr">{diagnostics.ntpStatus?.status || '—'}</span>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {activeDiagKey === 'logs' && (
                  <div className="flex flex-wrap gap-1.5 pb-1">
                    {['all', 'ppp', 'error', 'warning', 'dhcp', 'system'].map((tp) => (
                      <button
                        key={tp}
                        type="button"
                        onClick={() => setLogTopicFilter(tp)}
                        className={`px-3 py-1 rounded-lg text-xs font-mono font-bold ${
                          logTopicFilter === tp
                            ? 'bg-sky-600 text-white'
                            : 'bg-slate-100 dark:bg-[#171C28] text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {tp === 'all' ? 'الكل' : tp}
                      </button>
                    ))}
                  </div>
                )}
                {(() => {
                  const rawList =
                    (diagnostics[activeDiagKey as keyof DiagnosticDataset] as Array<Record<string, unknown>> | undefined) ||
                    [];
                  const filteredList =
                    activeDiagKey === 'logs' && logTopicFilter !== 'all'
                      ? rawList.filter((item) =>
                          String(item.topics || '').toLowerCase().includes(logTopicFilter)
                        )
                      : rawList;
                  if (filteredList.length === 0) {
                    return <div className="p-6 text-center text-xs text-slate-400">لا توجد قيود في هذه القائمة على الراوتر</div>;
                  }
                  return filteredList.map((item, idx) => (
                    <div
                      key={idx}
                      className="rounded-2xl bg-slate-50 dark:bg-[#171C28] border border-slate-200/80 dark:border-white/[0.07] p-3.5 text-xs font-mono space-y-1"
                      dir="ltr"
                    >
                      {Object.entries(item).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between gap-4">
                          <span className="text-slate-400">{k}</span>
                          <span className="text-slate-900 dark:text-white font-semibold text-right break-all">
                            {Array.isArray(v) ? v.join(', ') : String(v)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ));
                })()}
              </div>
            )}
          </div>
        </div>
      )}
      {/* Connection Settings Editor Modal */}
      {showConnEditor && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm sm:p-4">
          <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-t-[28px] sm:rounded-[28px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.08] p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200/80 dark:border-white/[0.07]">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  تعديل إعدادات الاتصال — {router.name}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  غيّر طريقة الربط أو Public IP / MikroTik DDNS والمنفذ دون حذف الراوتر
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowConnEditor(false)}
                className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={(e) => void handleSaveConnectionSettings(e)} className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  اسم الراوتر
                </label>
                <input
                  type="text"
                  required
                  value={editConnName}
                  onChange={(e) => setEditConnName(e.target.value)}
                  className="w-full min-h-[46px] rounded-2xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3.5 text-sm text-slate-900 dark:text-white"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-2">
                  طريقة الاتصال
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[
                    { id: 'direct' as const, label: 'API مباشر (Public IP / DDNS)', sub: '8728 / 8729 SSL / 443 REST' },
                    { id: 'agent' as const, label: 'Agent HTTPS (خلف NAT)', sub: 'دفع عبر /tool fetch' },
                    { id: 'wireguard' as const, label: 'WireGuard (v7)', sub: 'يتطلب VPS مع wg0', vps: true },
                  ].map((m) => {
                    const needsVps = Boolean(m.vps && capabilities && !capabilities.wireguardReady);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setConnError(null);
                          setEditConnType(m.id);
                        }}
                        className={`text-right rounded-2xl border p-3 ${
                          editConnType === m.id
                            ? 'border-sky-500 bg-sky-500/10 text-sky-600 dark:text-sky-400'
                            : 'border-slate-200 dark:border-white/[0.08] text-slate-700 dark:text-slate-300'
                        } ${needsVps ? 'opacity-65' : ''}`}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs font-extrabold">
                          <span dir="ltr">{m.label}</span>
                          {needsVps && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500">
                              VPS فقط
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] opacity-80 mt-0.5">{m.sub}</div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {editConnType === 'direct' && (
                <div className="space-y-3 rounded-2xl bg-slate-50 dark:bg-[#171C28] border border-slate-200/80 dark:border-white/[0.07] p-4">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setEditUseExisting(true)}
                      className={`min-h-[38px] px-3 rounded-xl border text-xs font-bold ${
                        editUseExisting
                          ? 'border-sky-500 bg-sky-500/15 text-sky-600 dark:text-sky-400'
                          : 'border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      مستخدم API جاهز (ربط فوري)
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditUseExisting(false)}
                      className={`min-h-[38px] px-3 rounded-xl border text-xs font-bold ${
                        !editUseExisting
                          ? 'border-sky-500 bg-sky-500/15 text-sky-600 dark:text-sky-400'
                          : 'border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      توليد سكربت جديد
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                        Public IP أو MikroTik DDNS
                      </label>
                      <input
                        type="text"
                        required
                        dir="ltr"
                        value={editApiHost}
                        onChange={(e) => setEditApiHost(e.target.value)}
                        placeholder="xxxx.sn.mynetname.net"
                        className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-white dark:bg-[#11151E] px-3 text-sm font-mono text-left text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                        منفذ API (8728 / 8729 / 443)
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        dir="ltr"
                        value={editApiPort}
                        onChange={(e) => setEditApiPort(e.target.value)}
                        className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-white dark:bg-[#11151E] px-3 text-sm font-mono text-left text-slate-900 dark:text-white"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                        اسم مستخدم API
                      </label>
                      <input
                        type="text"
                        required={editUseExisting}
                        dir="ltr"
                        value={editApiUser}
                        onChange={(e) => setEditApiUser(e.target.value)}
                        className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-white dark:bg-[#11151E] px-3 text-sm font-mono text-left text-slate-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                        كلمة مرور API
                      </label>
                      <input
                        type="password"
                        dir="ltr"
                        value={editApiPass}
                        onChange={(e) => setEditApiPass(e.target.value)}
                        placeholder={editUseExisting ? 'أدخل كلمة مرور الراوتر' : 'اتركه كما هو أو اكتب جديدة'}
                        className="w-full min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-white dark:bg-[#11151E] px-3 text-sm font-mono text-left text-slate-900 dark:text-white"
                      />
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                  مستوى الصلاحيات
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setEditPermMode('read-only')}
                    className={`min-h-[40px] rounded-xl border text-xs font-bold ${
                      editPermMode === 'read-only'
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500'
                        : 'border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    قراءة ومراقبة فقط
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditPermMode('full-control')}
                    className={`min-h-[40px] rounded-xl border text-xs font-bold ${
                      editPermMode === 'full-control'
                        ? 'border-sky-500 bg-sky-500/10 text-sky-500'
                        : 'border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    تحكم وإدارة كاملة
                  </button>
                </div>
              </div>

              {connError && (
                <div className="rounded-2xl bg-red-500/10 border border-red-500/25 px-4 py-3 text-xs font-semibold text-red-500">
                  {connError}
                </div>
              )}

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowConnEditor(false)}
                  className="min-h-[44px] px-4 rounded-xl border border-slate-200 dark:border-white/[0.09] text-xs font-bold text-slate-600 dark:text-slate-300"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={connSaving}
                  className="min-h-[44px] px-6 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold disabled:opacity-60"
                >
                  {connSaving
                    ? 'جاري الحفظ والفحص...'
                    : editConnType === 'direct' && editUseExisting
                      ? 'حفظ وفحص الاتصال الآن'
                      : 'حفظ وتوليد السكربت'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {cpeSub && (
        <CpeDetailModal
          token={token}
          subscriber={cpeSub}
          onClose={() => setCpeSub(null)}
          onUpdateSubscriber={
            onUpdateSubscriber ||
            (async () => {
              // No-op fallback if opened standalone
            })
          }
        />
      )}
    </div>
  );
};
