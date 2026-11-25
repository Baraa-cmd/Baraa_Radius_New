import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Bell,
  Check,
  CheckCircle2,
  Copy,
  FileCheck,
  LogOut,
  Moon,
  Plus,
  RefreshCw,
  Send,
  Server,
  Shield,
  Sun,
  Terminal,
  Trash2,
  Users,
} from 'lucide-react';
import type {
  AuditLogEntry,
  AuthUser,
  NotificationSettings,
  RouterAlertItem,
  ServerCapabilities,
  TeamMember,
  ThemeMode,
  UserRole,
  VpsRelayStatus,
} from '../types';
import { PWAInstallButton } from './PWAInstallButton';

interface SettingsViewProps {
  token: string;
  user: AuthUser;
  theme: ThemeMode;
  onToggleTheme: () => void;
  alerts: RouterAlertItem[];
  onAckAlert: (alertId: string) => void;
  onRefreshDashboard: () => Promise<void>;
  onLogout: () => void;
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'مدير النظام',
  technician: 'فني شبكات',
  accountant: 'محاسب',
  viewer: 'مشاهدة فقط',
};

export const SettingsView: React.FC<SettingsViewProps> = ({
  token,
  user,
  theme,
  onToggleTheme,
  alerts,
  onAckAlert,
  onRefreshDashboard,
  onLogout,
}) => {
  const [notif, setNotif] = useState<NotificationSettings>({
    webPushEnabled: false,
    telegramEnabled: false,
    telegramChatId: '',
    hasTelegramToken: false,
    dailyDigestEnabled: true,
  });
  const [tgTokenInput, setTgTokenInput] = useState('');
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [digest, setDigest] = useState<{
    routersCount: number;
    onlineRouters: number;
    openAlerts: number;
    expiringSubs: number;
    totalDebtIqd: number;
  } | null>(null);

  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('technician');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ServerCapabilities | null>(null);
  const [vpsStatus, setVpsStatus] = useState<VpsRelayStatus | null>(null);
  const [vpsHost, setVpsHost] = useState('');
  const [vpsRelayPort, setVpsRelayPort] = useState('8443');
  const [vpsWgPort, setVpsWgPort] = useState('51820');
  const [vpsInstanceOcid, setVpsInstanceOcid] = useState('');
  const [vpsInstallScript, setVpsInstallScript] = useState<string | null>(null);
  const [vpsCloudShellScript, setVpsCloudShellScript] = useState<string | null>(null);
  const [vpsBusy, setVpsBusy] = useState<'save' | 'verify' | 'delete' | null>(null);
  const [vpsError, setVpsError] = useState<string | null>(null);
  const [vpsNeedsReload, setVpsNeedsReload] = useState(false);
  const [vpsCopied, setVpsCopied] = useState<'ssh' | 'cloudshell' | null>(null);

  const loadSettings = async () => {
    const reqs: Array<Promise<Response>> = [
      fetch('/api/settings', { headers: { Authorization: `Bearer ${token}` } }),
      fetch('/api/digest', { headers: { Authorization: `Bearer ${token}` } }),
      fetch('/api/capabilities', { headers: { Authorization: `Bearer ${token}` } }),
    ];
    if (user.role === 'admin') {
      reqs.push(fetch('/api/vps/status', { headers: { Authorization: `Bearer ${token}` } }));
    }
    const [setRes, digRes, capRes, vpsRes] = await Promise.all(reqs);
    if (setRes.status === 401 || digRes.status === 401 || capRes.status === 401 || vpsRes?.status === 401) {
      onLogout();
      return;
    }
    if (setRes.ok) {
      const data = await setRes.json();
      setNotif(data.notifications);
      setTeamMembers(data.teamMembers || []);
      setAuditLogs(data.auditLogs || []);
    }
    if (digRes.ok) {
      setDigest(await digRes.json());
    }
    if (capRes.ok) {
      setCapabilities((await capRes.json()) as ServerCapabilities);
    }
    if (vpsRes && vpsRes.ok) {
      const vData = (await vpsRes.json()) as {
        status: VpsRelayStatus;
        installScript: string | null;
        cloudShellScript: string | null;
      };
      setVpsStatus(vData.status);
      if (vData.status.host) setVpsHost(vData.status.host);
      if (vData.status.relayPort) setVpsRelayPort(String(vData.status.relayPort));
      if (vData.status.wgPort) setVpsWgPort(String(vData.status.wgPort));
      if (vData.status.instanceOcid) setVpsInstanceOcid(vData.status.instanceOcid);
      setVpsInstallScript(vData.installScript);
      setVpsCloudShellScript(vData.cloudShellScript);
      if (vData.status.lastError) setVpsError(vData.status.lastError);
    }
  };

  useEffect(() => {
    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleEnableWebPush = async () => {
    if (!('Notification' in window)) {
      setStatusMsg('المتصفح لا يدعم إشعارات النظام');
      return;
    }
    const perm = await Notification.requestPermission();
    const enabled = perm === 'granted';
    await fetch('/api/settings/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ webPushEnabled: enabled }),
    });
    setNotif((prev) => ({ ...prev, webPushEnabled: enabled }));
    setStatusMsg(enabled ? 'تم تفعيل إشعارات المتصفح الفورية' : 'تم رفض إذن الإشعارات');
  };

  const handleSaveTelegram = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/settings/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        telegramEnabled: notif.telegramEnabled,
        telegramChatId: notif.telegramChatId,
        telegramBotToken: tgTokenInput.trim() || undefined,
        dailyDigestEnabled: notif.dailyDigestEnabled,
      }),
    });
    if (res.ok) {
      setTgTokenInput('');
      setStatusMsg('تم حفظ إعدادات الإشعارات بنجاح');
      void loadSettings();
    }
  };

  const handleTestAlert = async () => {
    const res = await fetch('/api/settings/test-alert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (res.ok) {
      if (notif.webPushEnabled && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Bro Radius', { body: 'تم التحقق من وصول التنبيه الفوري بنجاح' });
      }
      setStatusMsg(
        data.telegramSent
          ? 'تم إرسال تنبيه تجريبي للتطبيق ولبوت تيليجرام'
          : 'تم تسجيل تنبيه تجريبي داخل التطبيق'
      );
      await onRefreshDashboard();
    }
  };

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: newName, email: newEmail, password: newPass, role: newRole }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatusMsg(data.error || 'تعذر إضافة العضو');
      return;
    }
    setNewName('');
    setNewEmail('');
    setNewPass('');
    setStatusMsg('تمت إضافة عضو الفريق');
    void loadSettings();
  };

  const handleDeleteMember = async (id: string) => {
    const res = await fetch(`/api/team/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      void loadSettings();
    }
  };

  const hardRefreshSession = async () => {
    if ('serviceWorker' in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      } catch {
        // Ignore SW unregister errors
      }
    }
    if ('caches' in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        // Ignore CacheStorage errors
      }
    }
    window.location.replace(`${window.location.pathname}?_r=${Date.now()}`);
  };

  const isInIframe = typeof window !== 'undefined' && window.self !== window.top;

  const parseJsonResponse = async (
    res: Response
  ): Promise<{
    ok: boolean;
    reason?: 'proxy_cookie' | 'server_restart' | 'invalid';
    data: Record<string, any>;
  }> => {
    if (res.url && res.url.includes('__cookie_check')) {
      return { ok: false, reason: 'proxy_cookie', data: {} };
    }
    const text = await res.text();
    const trimmed = text.trimStart();
    if (trimmed.startsWith('<')) {
      return {
        ok: false,
        reason: res.status >= 500 ? 'server_restart' : 'proxy_cookie',
        data: {},
      };
    }
    try {
      return { ok: true, data: text ? (JSON.parse(text) as Record<string, any>) : {} };
    } catch {
      return { ok: false, reason: 'invalid', data: {} };
    }
  };

  const handleConfigureVps = async (e: React.FormEvent) => {
    e.preventDefault();
    setVpsError(null);
    setVpsNeedsReload(false);
    setVpsBusy('save');
    try {
      const res = await fetch('/api/vps/configure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          host: vpsHost.trim(),
          relayPort: Number(vpsRelayPort) || 8443,
          wgPort: Number(vpsWgPort) || 51820,
          instanceOcid: vpsInstanceOcid.trim(),
        }),
      });
      const parsed = await parseJsonResponse(res);
      if (!parsed.ok) {
        if (parsed.reason === 'server_restart') {
          setVpsError(`الخادم يعيد التشغيل مؤقتاً (HTTP ${res.status}) — انتظر 5 ثوانٍ ثم أعد المحاولة`);
        } else {
          setVpsNeedsReload(true);
          setVpsError(
            isInIframe
              ? 'المتصفح داخل نافذة المعاينة يحجب ملفات الجلسة — افتح التطبيق في تبويب مستقل بالمتصفح أدناه'
              : 'انتهت جلسة المتصفح المؤقتة — اضغط «تجديد الجلسة وإعادة التحميل» بالأسفل ثم أعد المحاولة'
          );
        }
        return;
      }
      const data = parsed.data;
      if (res.status === 401) {
        onLogout();
        return;
      }
      if (!res.ok) {
        setVpsError(data.error || `تعذر حفظ إعدادات Oracle VPS (HTTP ${res.status})`);
        return;
      }
      setVpsStatus(data.status);
      setVpsInstallScript(data.installScript);
      setVpsCloudShellScript(data.cloudShellScript || null);
      setStatusMsg('تم حفظ الإعدادات وتوليد أوامر التشغيل — انسخ أمر Oracle Cloud Shell وشغّله ثم اضغط "فحص وتفعيل الربط"');
    } catch {
      setVpsNeedsReload(true);
      setVpsError('تعذر الاتصال بالخادم — اضغط «تجديد الجلسة وإعادة التحميل» بالأسفل');
    } finally {
      setVpsBusy(null);
    }
  };

  const handleVerifyVps = async () => {
    setVpsError(null);
    setVpsNeedsReload(false);
    setVpsBusy('verify');
    try {
      const res = await fetch('/api/vps/verify', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const parsed = await parseJsonResponse(res);
      if (!parsed.ok) {
        if (parsed.reason === 'server_restart') {
          setVpsError(`الخادم يعيد التشغيل مؤقتاً (HTTP ${res.status}) — انتظر 5 ثوانٍ ثم أعد الفحص`);
        } else {
          setVpsNeedsReload(true);
          setVpsError(
            isInIframe
              ? 'المتصفح داخل نافذة المعاينة يحجب ملفات الجلسة — افتح التطبيق في تبويب مستقل بالمتصفح أدناه'
              : 'انتهت جلسة المتصفح المؤقتة — اضغط «تجديد الجلسة وإعادة التحميل» بالأسفل ثم أعد الفحص'
          );
        }
        return;
      }
      const data = parsed.data;
      if (res.status === 401) {
        onLogout();
        return;
      }
      if (data.status) setVpsStatus(data.status);
      if (!res.ok || !data.ok) {
        setVpsError(data.error || `تعذر الاتصال ببوابة Oracle VPS (HTTP ${res.status})`);
        return;
      }
      setStatusMsg('تم الربط بنجاح مع Oracle Cloud VPS وتفعيل WireGuard (wg0) لجميع الراوترات');
      void loadSettings();
    } catch {
      setVpsNeedsReload(true);
      setVpsError('انقطع الاتصال بالخادم — اضغط «تجديد الجلسة وإعادة التحميل» بالأسفل');
    } finally {
      setVpsBusy(null);
    }
  };

  const handleDeleteVps = async () => {
    setVpsError(null);
    setVpsBusy('delete');
    try {
      const res = await fetch('/api/vps', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setVpsStatus(null);
        setVpsHost('');
        setVpsInstanceOcid('');
        setVpsInstallScript(null);
        setVpsCloudShellScript(null);
        setStatusMsg('تم إلغاء ربط Oracle Cloud VPS');
        void loadSettings();
      }
    } finally {
      setVpsBusy(null);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 dark:text-white">الإعدادات والفريق والتنبيهات</h1>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
          إدارة الصلاحيات (RBAC)، بوت تيليجرام، الملخص اليومي، وسجل التدقيق
        </p>
      </div>

      {statusMsg && (
        <div className="rounded-2xl bg-sky-500/10 border border-sky-500/25 px-4 py-3 text-xs font-bold text-sky-600 dark:text-sky-400">
          {statusMsg}
        </div>
      )}

      {/* Account Card */}
      <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-bold text-slate-900 dark:text-white">{user.name}</span>
            <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-600 dark:text-sky-400">
              {ROLE_LABELS[user.role]}
            </span>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            {user.networkName} · <span className="font-mono" dir="ltr">{user.email}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onToggleTheme}
            className="min-h-[44px] px-4 rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] text-xs font-bold text-slate-800 dark:text-slate-200 inline-flex items-center gap-2"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-sky-600" />}
            <span>{theme === 'dark' ? 'الوضع النهاري' : 'الوضع الليلي'}</span>
          </button>

          <button
            type="button"
            onClick={onLogout}
            className="min-h-[44px] px-4 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-xs font-bold inline-flex items-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            <span>خروج</span>
          </button>
        </div>
      </div>

      {/* Daily Digest Summary (#77) */}
      {digest && (
        <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-3">
          <div className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
            <FileCheck className="w-4 h-4 text-teal-500" />
            <span>الملخص التشغيلي والمالي اليومي</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
              <div className="text-slate-500">الراوترات</div>
              <div className="text-base font-extrabold font-mono text-slate-900 dark:text-white mt-0.5">
                {digest.onlineRouters}/{digest.routersCount}
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
              <div className="text-slate-500">تنبيهات مفتوحة</div>
              <div className="text-base font-extrabold font-mono text-amber-500 mt-0.5">
                {digest.openAlerts}
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
              <div className="text-slate-500">تنتهي قريباً</div>
              <div className="text-base font-extrabold font-mono text-sky-500 mt-0.5">
                {digest.expiringSubs}
              </div>
            </div>
            <div className="rounded-xl bg-slate-50 dark:bg-[#171C28] p-3">
              <div className="text-slate-500">إجمالي الديون</div>
              <div className="text-base font-extrabold font-mono text-red-500 mt-0.5">
                {digest.totalDebtIqd.toLocaleString()} د.ع
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Notifications: Web Push (#71), Telegram (#72), Test Alert (#79) */}
      <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
            <Send className="w-4 h-4 text-sky-500" />
            <span>قنوات التنبيه الفورية (Web Push + Telegram)</span>
          </div>
          <button
            type="button"
            onClick={() => void handleTestAlert()}
            className="min-h-[38px] px-4 rounded-xl bg-sky-500/15 text-sky-600 dark:text-sky-400 text-xs font-bold"
          >
            إرسال تنبيه تجريبي
          </button>
        </div>

        <div className="flex items-center justify-between rounded-2xl bg-slate-50 dark:bg-[#171C28] p-3.5 text-xs">
          <div>
            <div className="font-bold text-slate-900 dark:text-white">إشعارات المتصفح / PWA (Web Push)</div>
            <div className="text-slate-500">تنبيه فوري على الهاتف والكمبيوتر عند أي انقطاع</div>
          </div>
          <button
            type="button"
            onClick={() => void handleEnableWebPush()}
            className={`min-h-[38px] px-4 rounded-xl font-bold ${
              notif.webPushEnabled ? 'bg-emerald-600 text-white' : 'bg-sky-600 text-white'
            }`}
          >
            {notif.webPushEnabled ? 'مفعّل' : 'تفعيل'}
          </button>
        </div>

        {user.role === 'admin' && (
          <form onSubmit={(e) => void handleSaveTelegram(e)} className="space-y-3 pt-2">
            <div className="flex items-center justify-between text-xs font-bold text-slate-700 dark:text-slate-300">
              <span>تفعيل بوت تيليجرام للتنبيهات الفورية</span>
              <input
                type="checkbox"
                checked={notif.telegramEnabled}
                onChange={(e) => setNotif((p) => ({ ...p, telegramEnabled: e.target.checked }))}
                className="w-4 h-4 accent-sky-500"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="password"
                dir="ltr"
                value={tgTokenInput}
                onChange={(e) => setTgTokenInput(e.target.value)}
                placeholder={notif.hasTelegramToken ? 'Token محفوظ (اكتب لتحديثه)' : 'Bot Token (من @BotFather)'}
                className="min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono text-slate-900 dark:text-white"
              />
              <input
                type="text"
                dir="ltr"
                value={notif.telegramChatId}
                onChange={(e) => setNotif((p) => ({ ...p, telegramChatId: e.target.value }))}
                placeholder="Chat ID (مثال: 123456789)"
                className="min-h-[44px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono text-slate-900 dark:text-white"
              />
            </div>
            <button
              type="submit"
              className="min-h-[42px] px-5 rounded-xl bg-sky-600 text-white text-xs font-bold"
            >
              حفظ إعدادات تيليجرام
            </button>
          </form>
        )}
      </div>

      {/* Team RBAC Management (#84) */}
      {user.role === 'admin' && (
        <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-4">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
            <Users className="w-4 h-4 text-sky-500" />
            <span>فريق العمل والصلاحيات (RBAC)</span>
          </div>

          <form onSubmit={(e) => void handleAddMember(e)} className="grid grid-cols-1 sm:grid-cols-5 gap-2.5">
            <input
              type="text"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="الاسم"
              className="min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs text-slate-900 dark:text-white"
            />
            <input
              type="email"
              required
              dir="ltr"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="البريد"
              className="min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono text-slate-900 dark:text-white"
            />
            <input
              type="password"
              required
              minLength={6}
              dir="ltr"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              placeholder="كلمة المرور"
              className="min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono text-slate-900 dark:text-white"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
              className="min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-2.5 text-xs font-bold text-slate-900 dark:text-white"
            >
              <option value="technician">فني شبكات</option>
              <option value="accountant">محاسب</option>
              <option value="viewer">مشاهدة فقط</option>
              <option value="admin">مدير</option>
            </select>
            <button
              type="submit"
              className="min-h-[42px] rounded-xl bg-sky-600 text-white text-xs font-bold inline-flex items-center justify-center gap-1"
            >
              <Plus className="w-4 h-4" /> إضافة
            </button>
          </form>

          <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
            {teamMembers.map((m) => (
              <div key={m.id} className="py-2.5 flex items-center justify-between text-xs">
                <div>
                  <span className="font-bold text-slate-900 dark:text-white">{m.name}</span> ·{' '}
                  <span className="text-sky-500 font-bold">{ROLE_LABELS[m.role]}</span>
                  <div className="font-mono text-slate-400 text-[11px]" dir="ltr">
                    {m.email}
                  </div>
                </div>
                {m.id !== user.id && (
                  <button
                    type="button"
                    onClick={() => void handleDeleteMember(m.id)}
                    className="p-2 text-slate-400 hover:text-red-500"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Oracle Cloud VPS & WireGuard Relay Connection */}
      {user.role === 'admin' && (
        <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
              <Terminal className="w-4 h-4 text-sky-500" />
              <span>ربط خادم Oracle Cloud VPS (بوابة WireGuard)</span>
            </div>
            <span
              className={`text-xs font-bold px-2.5 py-1 rounded-lg ${
                vpsStatus?.verified || capabilities?.wireguardReady
                  ? 'bg-emerald-500/15 text-emerald-500'
                  : vpsStatus?.configured
                    ? 'bg-sky-500/15 text-sky-500'
                    : 'bg-amber-500/15 text-amber-500'
              }`}
            >
              {vpsStatus?.verified
                ? `متصل بنجاح (${vpsStatus.host}:${vpsStatus.wgPort})`
                : capabilities?.wireguardReady
                  ? `wg0 نشط (${capabilities.wireguardEndpoint}:${capabilities.wireguardPort || 51820})`
                  : vpsStatus?.configured
                    ? 'بانتظار تنفيذ السكربت وتفعيل الربط'
                    : 'غير مربوط بعد'}
            </span>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            اربط Bro Radius بسيرفر Oracle Cloud (Ubuntu) لتشغيل نفق WireGuard المشفر والوصول لأي راوتر MikroTik حتى لو كان خلف CGNAT أو بدون Public IP.
          </p>

          <form onSubmit={(e) => void handleConfigureVps(e)} className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-bold text-slate-500 mb-1">
                عنوان Oracle Public IP (أو النطاق)
              </label>
              <input
                type="text"
                dir="ltr"
                required
                value={vpsHost}
                onChange={(e) => setVpsHost(e.target.value)}
                placeholder="مثال: 130.61.xx.xx"
                className="w-full min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-500 mb-1">
                منفذ البوابة HTTPS
              </label>
              <input
                type="number"
                dir="ltr"
                min={1}
                max={65535}
                value={vpsRelayPort}
                onChange={(e) => setVpsRelayPort(e.target.value)}
                className="w-full min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-500 mb-1">
                منفذ WireGuard UDP
              </label>
              <input
                type="number"
                dir="ltr"
                min={1}
                max={65535}
                value={vpsWgPort}
                onChange={(e) => setVpsWgPort(e.target.value)}
                className="w-full min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono text-slate-900 dark:text-white"
              />
            </div>
            <div className="sm:col-span-4">
              <label className="block text-[11px] font-bold text-slate-500 mb-1">
                Instance OCID (اختياري — للتثبيت مباشرة من Oracle Cloud Shell بدون SSH)
              </label>
              <input
                type="text"
                dir="ltr"
                value={vpsInstanceOcid}
                onChange={(e) => setVpsInstanceOcid(e.target.value)}
                placeholder="ocid1.instance.oc1..."
                className="w-full min-h-[42px] rounded-xl border border-slate-200 dark:border-white/[0.09] bg-slate-50 dark:bg-[#171C28] px-3 text-xs font-mono text-slate-900 dark:text-white"
              />
            </div>
            <div className="sm:col-span-4 flex flex-wrap items-center gap-2.5 pt-1">
              <button
                type="submit"
                disabled={vpsBusy !== null}
                className="min-h-[42px] px-4 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold disabled:opacity-60"
              >
                {vpsBusy === 'save' ? 'جاري التجهيز...' : 'حفظ وتوليد أمر التثبيت'}
              </button>

              {vpsStatus?.configured && (
                <button
                  type="button"
                  disabled={vpsBusy !== null}
                  onClick={() => void handleVerifyVps()}
                  className="min-h-[42px] px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-60"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${vpsBusy === 'verify' ? 'animate-spin' : ''}`} />
                  <span>{vpsBusy === 'verify' ? 'جاري الفحص...' : 'فحص وتفعيل الربط مع Oracle VPS'}</span>
                </button>
              )}

              {vpsStatus?.configured && (
                <button
                  type="button"
                  disabled={vpsBusy !== null}
                  onClick={() => void handleDeleteVps()}
                  className="min-h-[42px] px-3.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-500 text-xs font-bold inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>إلغاء الربط</span>
                </button>
              )}
            </div>
          </form>

          {vpsError && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/25 px-3.5 py-2.5 text-xs font-bold text-red-500 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{vpsError}</span>
              </div>
              {vpsNeedsReload && (
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {isInIframe && (
                    <a
                      href={window.location.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-h-[34px] px-3 rounded-lg bg-sky-600 text-white text-xs font-bold inline-flex items-center"
                    >
                      فتح في تبويب مستقل بالمتصفح
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => void hardRefreshSession()}
                    className="min-h-[34px] px-3 rounded-lg bg-red-600 text-white text-xs font-bold shrink-0"
                  >
                    تجديد الجلسة وإعادة التحميل
                  </button>
                </div>
              )}
            </div>
          )}

          {vpsStatus?.verified && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs rounded-2xl bg-emerald-500/10 border border-emerald-500/20 p-3.5">
              <div>
                <div className="text-slate-500 dark:text-slate-400">حالة واجهة wg0</div>
                <div className="font-bold text-emerald-500 mt-0.5">نشط ومتصل بالتطبيق</div>
              </div>
              <div>
                <div className="text-slate-500 dark:text-slate-400">عدد الأقران (Peers)</div>
                <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5">
                  {vpsStatus.activePeersCount}
                </div>
              </div>
              <div>
                <div className="text-slate-500 dark:text-slate-400">المفتاح العام للسيرفر</div>
                <div className="font-mono text-[11px] text-slate-700 dark:text-slate-300 truncate mt-0.5" dir="ltr">
                  {vpsStatus.wgPublicKey}
                </div>
              </div>
            </div>
          )}

          {vpsInstallScript && !vpsStatus?.verified && (
            <div className="space-y-4 pt-1">
              {vpsCloudShellScript && (
                <div className="rounded-2xl border border-sky-500/25 bg-sky-500/5 p-3.5 space-y-2.5">
                  <div className="text-xs font-bold text-sky-700 dark:text-sky-300">
                    الطريقة الأسهل من متصفح Oracle بدون SSH أو مفتاح:
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    1. في أعلى صفحة Oracle Cloud اضغط على أيقونة <span dir="ltr" className="font-mono font-bold">&gt;_</span> (Cloud Shell) لتفتح الشاشة السوداء في المتصفح.
                    <br />
                    2. انسخ هذا الأمر والصقه بداخلها — سيفتح المنافذ ويثبت WireGuard داخل السيرفر تلقائياً، ثم اضغط <span className="font-bold">«فحص وتفعيل الربط مع Oracle VPS»</span>.
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(vpsCloudShellScript);
                      setVpsCopied('cloudshell');
                      setTimeout(() => setVpsCopied(null), 1800);
                    }}
                    className="inline-flex items-center gap-1.5 min-h-[40px] px-4 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold"
                  >
                    {vpsCopied === 'cloudshell' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{vpsCopied === 'cloudshell' ? 'تم نسخ أمر Oracle Cloud Shell' : 'نسخ أمر Oracle Cloud Shell (بدون SSH)'}</span>
                  </button>
                </div>
              )}

              <div className="space-y-2">
                <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 px-3.5 py-2.5 text-xs text-amber-700 dark:text-amber-300">
                  أو عبر SSH داخل أوبونتو (مع التأكد من فتح <span dir="ltr" className="font-mono font-bold">TCP {vpsRelayPort}</span> و <span dir="ltr" className="font-mono font-bold">UDP {vpsWgPort}</span> في VCN):
                </div>
                <pre
                  dir="ltr"
                  className="rounded-2xl bg-[#070A10] text-emerald-300 border border-white/[0.08] p-3.5 text-[11px] font-mono overflow-x-auto max-h-48 text-left whitespace-pre-wrap break-all"
                >
                  {vpsInstallScript}
                </pre>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(vpsInstallScript);
                    setVpsCopied('ssh');
                    setTimeout(() => setVpsCopied(null), 1800);
                  }}
                  className="inline-flex items-center gap-1.5 min-h-[36px] px-3.5 rounded-xl bg-sky-500/15 text-sky-600 dark:text-sky-400 text-xs font-bold"
                >
                  {vpsCopied === 'ssh' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{vpsCopied === 'ssh' ? 'تم نسخ أمر SSH' : 'نسخ أمر SSH'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* PWA Install Card */}
      <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-sky-500/15 text-sky-500 flex items-center justify-center shrink-0">
            <Server className="w-5 h-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-slate-900 dark:text-white">تشغيل كتطبيق هاتف (PWA)</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              ثبّت Bro Radius على الشاشة الرئيسية للوصول الفوري
            </div>
          </div>
        </div>
        <div className="shrink-0">
          <PWAInstallButton compact />
        </div>
      </div>

      {/* Audit Log (#78) */}
      <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200/80 dark:border-white/[0.07] flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
          <Shield className="w-4 h-4 text-emerald-500" />
          <span>سجل العمليات والتدقيق (Audit Log)</span>
        </div>
        <div className="divide-y divide-slate-100 dark:divide-white/[0.06] max-h-64 overflow-y-auto">
          {auditLogs.length === 0 ? (
            <div className="p-5 text-center text-xs text-slate-400">لا توجد عمليات مسجلة بعد</div>
          ) : (
            auditLogs.map((log) => (
              <div key={log.id} className="px-5 py-3 flex items-center justify-between text-xs gap-3">
                <div>
                  <span className="font-bold text-slate-900 dark:text-white">{log.action}</span>{' '}
                  <span className="text-slate-500">({log.target})</span>
                  <div className="text-[11px] text-slate-400">
                    بواسطة: {log.actorName} ({ROLE_LABELS[log.actorRole]})
                  </div>
                </div>
                <span className="font-mono text-[10px] text-slate-400 shrink-0" dir="ltr">
                  {log.createdAt.slice(0, 16).replace('T', ' ')}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Alerts Log */}
      <div className="rounded-[22px] bg-white dark:bg-[#11151E] border border-slate-200/80 dark:border-white/[0.07] overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200/80 dark:border-white/[0.07] flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
          <Bell className="w-4 h-4 text-sky-500" />
          <span>سجل التنبيهات الأخيرة</span>
        </div>
        <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
          {alerts.length === 0 ? (
            <div className="p-5 text-center text-xs text-slate-400">لا توجد تنبيهات مسجلة حالياً</div>
          ) : (
            alerts.map((alt) => (
              <div key={alt.id} className="p-4 flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-slate-900 dark:text-white">{alt.title}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{alt.detail}</div>
                  <div className="text-[11px] text-slate-400 mt-1">
                    {alt.routerName} · {alt.timestamp}
                  </div>
                </div>
                {alt.acknowledged ? (
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-500 shrink-0">
                    <CheckCircle2 className="w-4 h-4" /> مقروء
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAckAlert(alt.id)}
                    className="min-h-[38px] px-3 rounded-lg bg-sky-500/15 text-sky-600 dark:text-sky-400 text-xs font-bold shrink-0"
                  >
                    تأكيد
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
