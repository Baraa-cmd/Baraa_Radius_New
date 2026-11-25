import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell,
  MapPin,
  Moon,
  Network,
  Plus,
  Router,
  Settings,
  Sun,
  Users,
} from 'lucide-react';
import { AddRouterModal } from './components/AddRouterModal';
import { AuthScreen } from './components/AuthScreen';
import { BroLogo } from './components/BroLogo';
import { DirectManagementModal } from './components/DirectManagementModal';
import { NetworkHomeView } from './components/NetworkHomeView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { RouterDetailView } from './components/RouterDetailView';
import { SettingsView } from './components/SettingsView';
import { SubscribersHubView } from './components/SubscribersHubView';
import { SubscribersMapView } from './components/SubscribersMapView';
import type {
  AuthUser,
  PaymentRecord,
  RouterAlertItem,
  RouterDevice,
  SubscriberRecord,
  ThemeMode,
  TowerNode,
} from './types';

type MainTab = 'network' | 'subscribers' | 'map' | 'settings';

const SESSION_STORAGE_KEY = 'bro_radius_session_v1';

function loadStoredSession(): { token: string; user: AuthUser } | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string; user?: AuthUser };
    if (parsed?.token && parsed?.user?.id) {
      return { token: parsed.token, user: parsed.user };
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [initialSession] = useState(() => loadStoredSession());
  const [token, setToken] = useState<string | null>(initialSession?.token || null);
  const [user, setUser] = useState<AuthUser | null>(initialSession?.user || null);

  const [activeTab, setActiveTab] = useState<MainTab>('network');
  const [selectedRouterId, setSelectedRouterId] = useState<string | null>(null);
  const [focusedMapSubId, setFocusedMapSubId] = useState<string | null>(null);

  const [routers, setRouters] = useState<RouterDevice[]>([]);
  const [subscribers, setSubscribers] = useState<SubscriberRecord[]>([]);
  const [alerts, setAlerts] = useState<RouterAlertItem[]>([]);
  const [towers, setTowers] = useState<TowerNode[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [hotspotVouchers, setHotspotVouchers] = useState<
    Array<{ code: string; profile: string; createdAt: string; routerName: string }>
  >([]);
  const [loadingDashboard, setLoadingDashboard] = useState(false);

  const [showAddRouter, setShowAddRouter] = useState(false);
  const [showDirectManage, setShowDirectManage] = useState(false);

  const seenAlertIdsRef = useRef<Set<string>>(new Set());

  const clearSession = useCallback(() => {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
    setToken(null);
    setUser(null);
    setSelectedRouterId(null);
    setActiveTab('network');
  }, []);

  useEffect(() => {
    const isDark = theme === 'dark';
    document.documentElement.classList.toggle('dark', isDark);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', isDark ? '#090B10' : '#F4F6FA');
    }
  }, [theme]);

  const loadDashboard = useCallback(async (authToken: string) => {
    setLoadingDashboard(true);
    try {
      const res = await fetch('/api/dashboard', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.status === 401) {
        clearSession();
        return;
      }
      if (res.ok) {
        const data = await res.json();
        const incomingAlerts = (data.alerts || []) as RouterAlertItem[];
        setRouters(data.routers || []);
        setSubscribers(data.subscribers || []);
        setAlerts(incomingAlerts);
        setTowers(data.towers || []);
        setPayments(data.payments || []);
        setHotspotVouchers(data.hotspotVouchers || []);

        // Browser Web Notification for newly arrived unread alerts (#71)
        if ('Notification' in window && Notification.permission === 'granted') {
          for (const alt of incomingAlerts) {
            if (!alt.acknowledged && !seenAlertIdsRef.current.has(alt.id)) {
              seenAlertIdsRef.current.add(alt.id);
              if (seenAlertIdsRef.current.size > 1) {
                new Notification(`Bro Radius · ${alt.routerName}`, { body: alt.title });
              }
            }
          }
        } else {
          incomingAlerts.forEach((a) => seenAlertIdsRef.current.add(a.id));
        }
      }
    } finally {
      setLoadingDashboard(false);
    }
  }, [clearSession]);

  useEffect(() => {
    if (initialSession?.token) {
      void loadDashboard(initialSession.token);
    }
  }, [initialSession?.token, loadDashboard]);

  useEffect(() => {
    if (!token) return;
    const keepAlive = () => {
      void fetch('/api/capabilities', {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    };
    const timer = window.setInterval(keepAlive, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') keepAlive();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [token]);

  const handleAuthenticated = (newToken: string, newUser: AuthUser) => {
    seenAlertIdsRef.current.clear();
    try {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: newToken, user: newUser }));
    } catch {
      // Ignore storage errors
    }
    setToken(newToken);
    setUser(newUser);
    void loadDashboard(newToken);
  };

  const handleLogout = () => {
    clearSession();
  };

  const handleUpdateRouter = (updated: RouterDevice) => {
    setRouters((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
  };

  const handleRouterAdded = (newRouter: RouterDevice) => {
    setRouters((prev) => {
      if (prev.some((r) => r.id === newRouter.id)) {
        return prev.map((r) => (r.id === newRouter.id ? newRouter : r));
      }
      return [newRouter, ...prev];
    });
    if (token) void loadDashboard(token);
  };

  const handleDeleteRouter = async (routerId: string) => {
    if (!token) return;
    const res = await fetch(`/api/routers/${routerId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setRouters((prev) => prev.filter((r) => r.id !== routerId));
      setSubscribers((prev) => prev.filter((s) => s.routerId !== routerId));
      if (selectedRouterId === routerId) setSelectedRouterId(null);
    }
  };

  const handleAckAlert = async (alertId: string) => {
    if (!token) return;
    setAlerts((prev) => prev.map((a) => (a.id === alertId ? { ...a, acknowledged: true } : a)));
    await fetch(`/api/alerts/${alertId}/ack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  };

  const handleUpdateSubscriber = async (
    subId: string,
    patch: Partial<SubscriberRecord> & { graceHours?: number }
  ) => {
    if (!token) return;
    const res = await fetch(`/api/subscribers/${subId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const data = await res.json();
      setSubscribers((prev) => prev.map((s) => (s.id === subId ? data.subscriber : s)));
    }
  };

  const handleDisconnectSubscriber = async (subId: string) => {
    if (!token) return;
    const res = await fetch(`/api/subscribers/${subId}/disconnect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      setSubscribers((prev) => prev.map((s) => (s.id === subId ? data.subscriber : s)));
    }
  };

  const handleCreatePayment = async (
    subId: string,
    amountIqd: number,
    note: string,
    renewDays: number
  ) => {
    if (!token) return;
    const res = await fetch(`/api/subscribers/${subId}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ amountIqd, note, renewDays }),
    });
    if (res.ok) {
      const data = await res.json();
      setSubscribers((prev) => prev.map((s) => (s.id === subId ? data.subscriber : s)));
      if (data.payment) setPayments((prev) => [data.payment, ...prev]);
    }
  };

  const handleAddTower = async (tower: Omit<TowerNode, 'id' | 'ownerId'>) => {
    if (!token) return;
    const res = await fetch('/api/towers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(tower),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.tower) setTowers((prev) => [...prev, data.tower]);
    }
  };

  const handleDeleteTower = async (towerId: string) => {
    if (!token) return;
    const res = await fetch(`/api/towers/${towerId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setTowers((prev) => prev.filter((t) => t.id !== towerId));
    }
  };

  if (!token || !user) {
    return (
      <>
        <AuthScreen onAuthenticated={handleAuthenticated} />
        <OfflineIndicator />
      </>
    );
  }

  const openAlertCount = alerts.filter((a) => !a.acknowledged).length;
  const selectedRouter = routers.find((r) => r.id === selectedRouterId) || null;

  const navItems: Array<{ id: MainTab; label: string; icon: typeof Network }> = [
    { id: 'network', label: 'شبكتي', icon: Network },
    { id: 'subscribers', label: 'المشتركين', icon: Users },
    { id: 'map', label: 'الخريطة', icon: MapPin },
    { id: 'settings', label: 'الإعدادات', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-[#F4F6FA] dark:bg-[#090B10] text-slate-900 dark:text-slate-100 flex flex-col lg:flex-row">
      {/* Desktop Sidebar (Master List + Nav #96) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 border-l border-slate-200/80 dark:border-white/[0.07] bg-white dark:bg-[#0D1017] sticky top-0 h-screen p-5 justify-between">
        <div className="space-y-6">
          <div className="flex items-center gap-3 px-1">
            <BroLogo size="md" />
            <div>
              <div className="text-lg font-extrabold tracking-tight text-slate-900 dark:text-white" dir="ltr">
                Bro Radius
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate max-w-[140px]">
                {user.networkName}
              </div>
            </div>
          </div>

          <nav className="space-y-1.5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id && !selectedRouter;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedRouterId(null);
                    setActiveTab(item.id);
                  }}
                  className={`w-full min-h-[46px] px-3.5 rounded-2xl flex items-center justify-between text-sm font-bold transition-colors ${
                    active
                      ? 'bg-sky-600 text-white shadow-lg shadow-sky-900/20'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </span>
                  {item.id === 'settings' && openAlertCount > 0 && (
                    <span className="font-mono text-[11px] font-bold px-2 py-0.5 rounded-md bg-red-500 text-white">
                      {openAlertCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="pt-4 border-t border-slate-200/80 dark:border-white/[0.07] space-y-2">
            <div className="flex items-center justify-between px-2 text-xs font-bold text-slate-400">
              <span>الراوترات ({routers.length})</span>
              <button
                type="button"
                onClick={() => setShowAddRouter(true)}
                className="text-sky-500 hover:text-sky-400 inline-flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" /> إضافة
              </button>
            </div>
            <div className="space-y-1">
              {routers.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    setActiveTab('network');
                    setSelectedRouterId(r.id);
                  }}
                  className={`w-full min-h-[40px] px-3 rounded-xl flex items-center justify-between text-xs font-semibold transition-colors ${
                    selectedRouterId === r.id
                      ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="flex items-center gap-2 truncate">
                    <Router className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{r.name}</span>
                  </span>
                  <span
                    className={`font-mono text-[10px] shrink-0 ${
                      r.status === 'online'
                        ? 'text-emerald-500'
                        : r.status === 'pending'
                          ? 'text-amber-500'
                          : 'text-red-500'
                    }`}
                    dir="ltr"
                  >
                    {r.status === 'online' ? r.pppoeOnline : r.status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-2.5 pt-4 border-t border-slate-200/80 dark:border-white/[0.07]">
          <PWAInstallButton />
          <button
            type="button"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            className="w-full min-h-[44px] px-3.5 rounded-2xl border border-slate-200/80 dark:border-white/[0.08] text-xs font-bold text-slate-700 dark:text-slate-300 flex items-center justify-center gap-2 hover:bg-slate-100 dark:hover:bg-white/[0.04]"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-sky-600" />}
            <span>{theme === 'dark' ? 'الوضع النهاري' : 'الوضع الليلي'}</span>
          </button>
        </div>
      </aside>

      {/* Mobile Compact Top App Bar */}
      <header className="lg:hidden sticky top-0 z-30 h-[52px] px-4 bg-white/90 dark:bg-[#0D1017]/90 backdrop-blur-md border-b border-slate-200/80 dark:border-white/[0.07] flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={() => {
            setSelectedRouterId(null);
            setActiveTab('network');
          }}
          className="flex items-center gap-2.5 shrink-0"
        >
          <BroLogo size="sm" />
          <span className="text-base font-extrabold tracking-tight text-slate-900 dark:text-white whitespace-nowrap" dir="ltr">
            Bro Radius
          </span>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          <PWAInstallButton compact />
          <button
            type="button"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.05]"
            aria-label="تبديل المظهر"
          >
            {theme === 'dark' ? <Sun className="w-5 h-5 text-amber-400" /> : <Moon className="w-5 h-5 text-sky-600" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedRouterId(null);
              setActiveTab('settings');
            }}
            className="relative min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.05]"
            aria-label="التنبيهات"
          >
            <Bell className="w-5 h-5" />
            {openAlertCount > 0 && (
              <span className="absolute top-2 right-2 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-[10px] font-mono font-bold text-white flex items-center justify-center">
                {openAlertCount}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 min-w-0 px-4 sm:px-6 lg:px-8 py-5 pb-24 lg:pb-10">
        <div className="max-w-6xl mx-auto">
          {selectedRouter ? (
            <RouterDetailView
              token={token}
              router={selectedRouter}
              subscribers={subscribers}
              alerts={alerts}
              onBack={() => setSelectedRouterId(null)}
              onUpdateRouter={handleUpdateRouter}
              onDeleteRouter={handleDeleteRouter}
              onAckAlert={(id) => void handleAckAlert(id)}
              onDisconnectSubscriber={handleDisconnectSubscriber}
              onToggleSubscriberDisabled={(subId, disabled) =>
                handleUpdateSubscriber(subId, { disabled })
              }
            />
          ) : activeTab === 'network' ? (
            <NetworkHomeView
              routers={routers}
              alerts={alerts}
              loading={loadingDashboard}
              selectedRouterId={selectedRouterId}
              onRefresh={() => loadDashboard(token)}
              onSelectRouter={(id) => setSelectedRouterId(id)}
              onOpenAddRouter={() => setShowAddRouter(true)}
              onOpenDirectManage={() => setShowDirectManage(true)}
            />
          ) : activeTab === 'subscribers' ? (
            <SubscribersHubView
              token={token}
              subscribers={subscribers}
              payments={payments}
              towers={towers}
              onUpdateSubscriber={handleUpdateSubscriber}
              onCreatePayment={handleCreatePayment}
              onLocateOnMap={(subId) => {
                setFocusedMapSubId(subId);
                setActiveTab('map');
              }}
            />
          ) : activeTab === 'map' ? (
            <SubscribersMapView
              subscribers={subscribers}
              towers={towers}
              focusedSubId={focusedMapSubId}
              onClearFocused={() => setFocusedMapSubId(null)}
              onUpdateSubscriber={handleUpdateSubscriber}
              onAddTower={handleAddTower}
              onDeleteTower={handleDeleteTower}
            />
          ) : (
            <SettingsView
              token={token}
              user={user}
              theme={theme}
              onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              alerts={alerts}
              onAckAlert={(id) => void handleAckAlert(id)}
              onRefreshDashboard={() => loadDashboard(token)}
              onLogout={handleLogout}
            />
          )}
        </div>
      </main>

      {/* Mobile Bottom Tab Bar */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-40 h-[60px] pb-safe bg-white/95 dark:bg-[#0D1017]/95 backdrop-blur-md border-t border-slate-200/80 dark:border-white/[0.07] grid grid-cols-4 items-center">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeTab === item.id && !selectedRouter;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setSelectedRouterId(null);
                setActiveTab(item.id);
              }}
              className={`h-full flex flex-col items-center justify-center gap-0.5 transition-colors ${
                active ? 'text-sky-600 dark:text-sky-400' : 'text-slate-500 dark:text-slate-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[11px] font-bold">{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Modals */}
      {showAddRouter && (
        <AddRouterModal
          token={token}
          onClose={() => setShowAddRouter(false)}
          onRouterAdded={handleRouterAdded}
        />
      )}

      {showDirectManage && (
        <DirectManagementModal
          token={token}
          routers={routers}
          vouchers={hotspotVouchers}
          onVoucherCreated={setHotspotVouchers}
          onSelectRouter={(id) => {
            setActiveTab('network');
            setSelectedRouterId(id);
          }}
          onClose={() => setShowDirectManage(false)}
        />
      )}

      <OfflineIndicator />
    </div>
  );
}
