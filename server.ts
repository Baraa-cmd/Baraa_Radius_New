import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  decryptSecret,
  encryptSecret,
  generateX25519Keypair,
  hashPassword,
  signToken,
  verifyPassword,
  verifyToken,
  type TokenPayload,
} from './src/server/crypto.ts';
import { db, getNextTunnelOctet, runRetentionCleanup } from './src/server/db.ts';
import {
  buildInstallScript,
  buildUninstallScript,
  fetchRealRouterSnapshot,
  formatUptimeArabic,
  getHostWireGuardHandshake,
  getHostWireGuardPublicKey,
  isHostWireGuardAvailable,
  lookupMacVendor,
  parseRouterOsUptime,
  removeHostWireGuardPeer,
  RouterOSClient,
  type RosRow,
  runPingOnRouter,
  syncHostWireGuardPeer,
  WG_SERVER_PORT,
  WG_SUBNET_PREFIX,
} from './src/server/routeros.ts';
import {
  buildOracleCloudShellScript,
  buildOracleRelayInstallScript,
  callVpsRelay,
  configureVpsRelay,
  deleteVpsRelayConfig,
  getVpsRelayConfig,
  saveVpsRelayConfig,
  type StoredVpsRelayConfig,
  toPublicVpsStatus,
} from './src/server/vpsRelay.ts';
import type {
  ApiPermissionMode,
  ConnectionType,
  PortRole,
  RouterAlertRules,
  RouterDevice,
  RouterPort,
  SubscriberBillingStatus,
  UserRole,
} from './src/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const WG_SERVER_ENDPOINT = process.env.WG_SERVER_ENDPOINT || '';

// Persistent Server X25519 Keypair stored in SQLite app_meta (never hardcoded)
function getOrCreateServerWgKeys(): { publicKey: string; privateKey: string } {
  const pubRow = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('wg_server_pub') as
    | { value: string }
    | undefined;
  const privRow = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('wg_server_priv_enc') as
    | { value: string }
    | undefined;
  if (pubRow && privRow) {
    return { publicKey: pubRow.value, privateKey: decryptSecret(privRow.value) };
  }
  const generated = generateX25519Keypair();
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
    'wg_server_pub',
    generated.publicKey
  );
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
    'wg_server_priv_enc',
    encryptSecret(generated.privateKey)
  );
  return generated;
}

const SERVER_WG_KEYS = getOrCreateServerWgKeys();

async function getActiveServerWgPublicKey(): Promise<string> {
  const hostPub = await getHostWireGuardPublicKey();
  return hostPub || SERVER_WG_KEYS.publicKey;
}

interface OwnerWgContext {
  ready: boolean;
  endpoint: string;
  wgPort: number;
  wgPublicKey: string;
  relayCfg: StoredVpsRelayConfig | null;
}

async function getOwnerWgContext(ownerId?: string): Promise<OwnerWgContext> {
  if (await isHostWireGuardAvailable()) {
    return {
      ready: true,
      endpoint: WG_SERVER_ENDPOINT,
      wgPort: WG_SERVER_PORT,
      wgPublicKey: await getActiveServerWgPublicKey(),
      relayCfg: null,
    };
  }
  if (ownerId) {
    const relayCfg = getVpsRelayConfig(ownerId);
    if (relayCfg && relayCfg.verified) {
      return {
        ready: true,
        endpoint: relayCfg.host,
        wgPort: relayCfg.wgPort,
        wgPublicKey: relayCfg.wgPublicKey,
        relayCfg,
      };
    }
  }
  return {
    ready: false,
    endpoint: WG_SERVER_ENDPOINT,
    wgPort: WG_SERVER_PORT,
    wgPublicKey: SERVER_WG_KEYS.publicKey,
    relayCfg: null,
  };
}

function isTunnelConnection(connType: string): boolean {
  return connType === 'wireguard' || connType === 'sstp' || connType === 'ovpn';
}

async function syncOwnerWireGuardPeer(
  ownerId: string,
  publicKey: string,
  tunnelIp: string
): Promise<void> {
  await syncHostWireGuardPeer(publicKey, tunnelIp);
  const relayCfg = getVpsRelayConfig(ownerId);
  if (relayCfg && relayCfg.verified) {
    await callVpsRelay(relayCfg, 'POST', '/wg/peer', { publicKey, tunnelIp }).catch(() => undefined);
  }
}

async function removeOwnerWireGuardPeer(ownerId: string, publicKey: string): Promise<void> {
  await removeHostWireGuardPeer(publicKey);
  const relayCfg = getVpsRelayConfig(ownerId);
  if (relayCfg && relayCfg.verified) {
    await callVpsRelay(relayCfg, 'DELETE', '/wg/peer', { publicKey }).catch(() => undefined);
  }
}

async function execCommandsOnRouter(
  routerRow: Record<string, unknown>,
  commands: string[][],
  allowTrap = false
): Promise<RosRow[][]> {
  const ownerId = String(routerRow.owner_id);
  const connType = String(routerRow.connection_type || 'direct');
  const host = String(routerRow.api_host || routerRow.tunnel_ip);
  const port = Number(routerRow.api_port || 8728);
  const username = String(routerRow.api_username);
  const password = decryptSecret(String(routerRow.api_password_enc));

  const wgCtx = await getOwnerWgContext(ownerId);
  if (wgCtx.relayCfg && isTunnelConnection(connType)) {
    const data = await callVpsRelay<{ results: RosRow[][] }>(wgCtx.relayCfg, 'POST', '/ros/commands', {
      host,
      port,
      username,
      password,
      commands,
      allowTrap,
    });
    return data.results;
  }

  const client = new RouterOSClient();
  try {
    await client.connect(host, port);
    await client.login(username, password);
    const results: RosRow[][] = [];
    for (const words of commands) {
      if (allowTrap) {
        results.push(await client.command(words).catch(() => [] as RosRow[]));
      } else {
        results.push(await client.command(words));
      }
    }
    return results;
  } finally {
    client.close();
  }
}

async function runPingViaContext(
  routerRow: Record<string, unknown>,
  targetIp: string
): Promise<{ status: 'up' | 'down'; latencyMs: number | null; packetLossPct: number }> {
  const ownerId = String(routerRow.owner_id);
  const connType = String(routerRow.connection_type || 'direct');
  const host = String(routerRow.api_host || routerRow.tunnel_ip);
  const port = Number(routerRow.api_port || 8728);
  const username = String(routerRow.api_username);
  const password = decryptSecret(String(routerRow.api_password_enc));

  const wgCtx = await getOwnerWgContext(ownerId);
  if (wgCtx.relayCfg && isTunnelConnection(connType)) {
    return callVpsRelay(wgCtx.relayCfg, 'POST', '/ros/ping', {
      host,
      port,
      username,
      password,
      targetIp,
    });
  }
  return runPingOnRouter(host, port, username, password, targetIp);
}

const DEFAULT_ALERT_RULES: RouterAlertRules = {
  enabled: true,
  offlineMinutes: 3,
  cpuThreshold: 85,
  freeRamThreshold: 10,
  tempThreshold: 75,
  subscriberDropPercent: 30,
  portErrorsPerMin: 200,
  packetLossThreshold: 15,
  alertOnMonitoredPortDown: true,
  alertOnPortSpeedDrop: true,
  alertOnPingDeviceDown: true,
  expiryReminderDays: 2,
};

// Login Rate Limiter (#83)
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 12) return false;
  entry.count += 1;
  return true;
}

function isValidIpv4(ip: string): boolean {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function isValidHost(host: string): boolean {
  const clean = host.trim();
  return /^[a-zA-Z0-9.-]{3,128}$/.test(clean);
}

function addAuditLog(ownerId: string, actorName: string, actorRole: UserRole, action: string, target: string): void {
  db.prepare(
    'INSERT INTO audit_logs (id, owner_id, actor_name, actor_role, action, target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(`aud-${crypto.randomUUID()}`, ownerId, actorName, actorRole, action, target, new Date().toISOString());
}

async function sendTelegramAlert(ownerId: string, title: string, detail: string): Promise<boolean> {
  const row = db
    .prepare('SELECT telegram_enabled, telegram_bot_token_enc, telegram_chat_id FROM notification_settings WHERE owner_id = ?')
    .get(ownerId) as
    | { telegram_enabled: number; telegram_bot_token_enc: string; telegram_chat_id: string }
    | undefined;
  if (!row || !row.telegram_enabled || !row.telegram_bot_token_enc || !row.telegram_chat_id) {
    return false;
  }
  const botToken = decryptSecret(row.telegram_bot_token_enc);
  if (!botToken) return false;
  try {
    const text = `🔔 *Bro Radius*\n*${title}*\n${detail}`;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: row.telegram_chat_id,
        text,
        parse_mode: 'Markdown',
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function createAlert(
  ownerId: string,
  routerId: string,
  routerName: string,
  severity: 'critical' | 'warning' | 'info',
  title: string,
  detail: string
): void {
  const nowIso = new Date().toISOString();
  db.prepare(
    'INSERT INTO alerts (id, owner_id, router_id, router_name, severity, title, detail, timestamp, acknowledged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
  ).run(`alt-${crypto.randomUUID()}`, ownerId, routerId, routerName, severity, title, detail, 'الآن', nowIso);
  void sendTelegramAlert(ownerId, `${routerName}: ${title}`, detail);
}

function hydrateRouter(row: Record<string, unknown>): RouterDevice {
  const routerId = String(row.id);
  const devicesRows = db
    .prepare('SELECT * FROM monitored_devices WHERE router_id = ?')
    .all(routerId) as Array<Record<string, unknown>>;
  const disconnectsRows = db
    .prepare('SELECT * FROM port_disconnects WHERE router_id = ? ORDER BY id DESC LIMIT 30')
    .all(routerId) as Array<Record<string, unknown>>;

  return {
    id: routerId,
    ownerId: String(row.owner_id),
    name: String(row.name),
    connectionType: row.connection_type as ConnectionType,
    permissionMode: row.permission_mode as ApiPermissionMode,
    apiHost: String(row.api_host),
    apiPort: Number(row.api_port),
    apiUsername: String(row.api_username),
    tunnelIp: String(row.tunnel_ip),
    wireguardPort: Number(row.wireguard_port),
    wireguardPublicKey: String(row.wireguard_public_key),
    latestHandshakeAt: row.latest_handshake_at ? String(row.latest_handshake_at) : null,
    tunnelRttMs: row.tunnel_rtt_ms !== null && row.tunnel_rtt_ms !== undefined ? Number(row.tunnel_rtt_ms) : null,
    status: row.status as RouterDevice['status'],
    lastError: row.last_error ? String(row.last_error) : null,
    identity: row.identity ? String(row.identity) : null,
    model: row.model ? String(row.model) : null,
    boardName: row.board_name ? String(row.board_name) : null,
    serialNumber: row.serial_number ? String(row.serial_number) : null,
    routerOsVersion: row.routeros_version ? String(row.routeros_version) : null,
    firmwareVersion: row.firmware_version ? String(row.firmware_version) : null,
    upgradeFirmware: row.upgrade_firmware ? String(row.upgrade_firmware) : null,
    architecture: row.architecture ? String(row.architecture) : null,
    cpuCores: row.cpu_cores !== null && row.cpu_cores !== undefined ? Number(row.cpu_cores) : null,
    cpuCoreLoads: JSON.parse(String(row.cpu_core_loads_json || '[]')),
    ramTotalMb: row.ram_total_mb !== null && row.ram_total_mb !== undefined ? Number(row.ram_total_mb) : null,
    voltage: row.voltage !== null && row.voltage !== undefined ? Number(row.voltage) : null,
    fanRpm: JSON.parse(String(row.fan_rpm_json || '[]')),
    activeConnections:
      row.active_connections !== null && row.active_connections !== undefined ? Number(row.active_connections) : null,
    uptimeText: row.uptime_text ? String(row.uptime_text) : null,
    cpuPercent: row.cpu_percent !== null && row.cpu_percent !== undefined ? Number(row.cpu_percent) : null,
    ramPercent: row.ram_percent !== null && row.ram_percent !== undefined ? Number(row.ram_percent) : null,
    tempCelsius: row.temp_celsius !== null && row.temp_celsius !== undefined ? Number(row.temp_celsius) : null,
    pppoeOnline: Number(row.pppoe_online || 0),
    pppoeSecretsCount: Number(row.pppoe_secrets_count || 0),
    hotspotOnline: Number(row.hotspot_online || 0),
    dhcpLeasesCount: Number(row.dhcp_leases_count || 0),
    neighborsCount: Number(row.neighbors_count || 0),
    currentRxMbps: Number(row.current_rx_mbps || 0),
    currentTxMbps: Number(row.current_tx_mbps || 0),
    trafficHistory: JSON.parse(String(row.traffic_history_json || '[]')),
    dailyTraffic: JSON.parse(String(row.daily_traffic_json || '[]')),
    ports: JSON.parse(String(row.ports_json || '[]')),
    portDisconnects: disconnectsRows.map((d) => ({
      id: Number(d.id),
      portName: String(d.port_name),
      disconnectedAt: String(d.disconnected_at),
      recoveredAt: d.recovered_at ? String(d.recovered_at) : null,
      durationSeconds: d.duration_seconds !== null ? Number(d.duration_seconds) : null,
    })),
    monitoredDevices: devicesRows.map((d) => ({
      id: String(d.id),
      name: String(d.name),
      ip: String(d.ip),
      sectorGroup: String(d.sector_group || 'عام'),
      latencyMs: d.latency_ms !== null && d.latency_ms !== undefined ? Number(d.latency_ms) : null,
      packetLossPct: Number(d.packet_loss_pct || 0),
      status: d.status as 'up' | 'down' | 'unknown',
      lastChecked: String(d.last_checked),
      downSince: d.down_since ? String(d.down_since) : null,
    })),
    neighbors: JSON.parse(String(row.neighbors_json || '[]')),
    alertRules: JSON.parse(String(row.alert_rules_json || JSON.stringify(DEFAULT_ALERT_RULES))),
    lastSync: row.last_sync ? String(row.last_sync) : null,
  };
}

function hydrateSubscriber(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    routerId: String(row.router_id),
    routerName: String(row.router_name),
    username: String(row.username),
    fullName: String(row.full_name),
    phone: String(row.phone || ''),
    area: String(row.area || ''),
    ip: String(row.ip || ''),
    mac: String(row.mac || ''),
    macVendor: String(row.mac_vendor || 'غير معروف'),
    profile: String(row.profile || 'default'),
    disabled: Boolean(row.disabled),
    uptimeText: String(row.uptime_text || 'غير متصل'),
    uptimeSeconds: Number(row.uptime_seconds || 0),
    online: Boolean(row.online),
    liveRxMbps: Number(row.live_rx_mbps || 0),
    liveTxMbps: Number(row.live_tx_mbps || 0),
    flapCountToday: Number(row.flap_count_today || 0),
    rxTodayGb: Number(row.rx_today_gb || 0),
    txTodayGb: Number(row.tx_today_gb || 0),
    rxWeekGb: Number(row.rx_week_gb || 0),
    txWeekGb: Number(row.tx_week_gb || 0),
    rxMonthGb: Number(row.rx_month_gb || 0),
    txMonthGb: Number(row.tx_month_gb || 0),
    billingStatus: row.billing_status as SubscriberBillingStatus,
    debtAmountIqd: Number(row.debt_amount_iqd || 0),
    activatedAt: row.activated_at ? String(row.activated_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    expiresInDays: Number(row.expires_in_days || 0),
    towerId: row.tower_id ? String(row.tower_id) : null,
    lat: row.lat !== null && row.lat !== undefined ? Number(row.lat) : null,
    lng: row.lng !== null && row.lng !== undefined ? Number(row.lng) : null,
  };
}

// Perform a real sync against the MikroTik router and store all fetched real telemetry in SQLite
async function performRealRouterSync(routerRow: Record<string, unknown>): Promise<RouterDevice> {
  const routerId = String(routerRow.id);
  const ownerId = String(routerRow.owner_id);
  const routerName = String(routerRow.name);
  const connType = String(routerRow.connection_type || 'direct') as ConnectionType;

  if (connType === 'agent') {
    if (String(routerRow.status) === 'pending' || !routerRow.last_sync) {
      throw new Error(
        'بانتظار وصول أول إشارة حية من الراوتر عبر Agent HTTPS — نفّذ السكربت في Winbox وتأكد أن رابط التطبيق منشور (Publish) أو على VPS.'
      );
    }
    return hydrateRouter(routerRow);
  }

  const host = String(routerRow.api_host || routerRow.tunnel_ip);
  const port = Number(routerRow.api_port || 8728);
  const username = String(routerRow.api_username);
  const password = decryptSecret(String(routerRow.api_password_enc));
  const prevPorts = JSON.parse(String(routerRow.ports_json || '[]')) as RouterPort[];
  const alertRules = JSON.parse(String(routerRow.alert_rules_json || JSON.stringify(DEFAULT_ALERT_RULES))) as RouterAlertRules;
  const prevStatus = String(routerRow.status);

  const wgCtx = await getOwnerWgContext(ownerId);
  if (connType === 'wireguard' && !wgCtx.ready) {
    const wgErr =
      'نفق WireGuard غير مفعّل بعد — انتقل إلى "الإعدادات" لربط خادم Oracle Cloud VPS، أو حوّل الراوتر إلى API مباشر (Public IP / DDNS).';
    const nextStatus = prevStatus === 'pending' ? 'pending' : 'offline';
    db.prepare('UPDATE routers SET status = ?, last_error = ? WHERE id = ?').run(nextStatus, wgErr, routerId);
    throw new Error(wgErr);
  }

  const useRelay = Boolean(wgCtx.relayCfg && isTunnelConnection(connType));
  const wgCheck = useRelay
    ? { connected: false }
    : await getHostWireGuardHandshake(String(routerRow.wireguard_public_key));

  try {
    const snap = useRelay
      ? await callVpsRelay<Awaited<ReturnType<typeof fetchRealRouterSnapshot>>>(
          wgCtx.relayCfg!,
          'POST',
          '/ros/snapshot',
          {
            host,
            port,
            username,
            password,
            existingPorts: prevPorts,
          },
          20000
        )
      : await fetchRealRouterSnapshot(host, port, username, password, prevPorts);
    const nowIso = new Date().toISOString();
    const nowTimeLabel = new Date().toLocaleTimeString('en-GB', { hour12: false });

    // Compute aggregate traffic of active non-bridge/non-bonding or WAN/ISP/ether ports
    const etherPorts = snap.ports.filter((p) => p.type === 'ether' || p.type === 'sfp');
    const totalRxMbps = Number(etherPorts.reduce((a, p) => a + p.rxMbps, 0).toFixed(2));
    const totalTxMbps = Number(etherPorts.reduce((a, p) => a + p.txMbps, 0).toFixed(2));

    const prevHistory = JSON.parse(String(routerRow.traffic_history_json || '[]')) as Array<{
      time: string;
      rxMbps: number;
      txMbps: number;
    }>;
    const nextHistory = [...prevHistory.slice(-19), { time: nowTimeLabel, rxMbps: totalRxMbps, txMbps: totalTxMbps }];

    // Store per-port historical metrics (#23)
    const insertPortHist = db.prepare(
      'INSERT INTO port_traffic_history (router_id, port_name, rx_mbps, tx_mbps, recorded_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const p of snap.ports) {
      insertPortHist.run(routerId, p.name, p.rxMbps, p.txMbps, nowIso);
    }

    // Track port disconnects, downshifts, and root-cause correlation (#24, #30, #76)
    const prevPortMap = new Map(prevPorts.map((p) => [p.name, p]));
    let downPortRootCause: string | null = null;
    for (const p of snap.ports) {
      const old = prevPortMap.get(p.name);
      if (old && old.status === 'up' && p.status === 'down') {
        p.disconnectCount = (old.disconnectCount || 0) + 1;
        p.lastDisconnect = nowIso;
        db.prepare(
          'INSERT INTO port_disconnects (router_id, port_name, disconnected_at) VALUES (?, ?, ?)'
        ).run(routerId, p.name, nowIso);
        if (p.monitored && alertRules.enabled && alertRules.alertOnMonitoredPortDown) {
          downPortRootCause = p.label;
          createAlert(
            ownerId,
            routerId,
            routerName,
            'critical',
            `واقف: ${p.label} (${p.name})`,
            `المنفذ المراقب ${p.label} فقد الاتصال للتو.`
          );
        }
      } else if (old && old.status === 'down' && p.status === 'up') {
        // Recovery event (#30, #40)
        const openEv = db
          .prepare('SELECT id, disconnected_at FROM port_disconnects WHERE router_id = ? AND port_name = ? AND recovered_at IS NULL ORDER BY id DESC LIMIT 1')
          .get(routerId, p.name) as { id: number; disconnected_at: string } | undefined;
        if (openEv) {
          const durSec = Math.max(1, Math.round((Date.now() - Date.parse(openEv.disconnected_at)) / 1000));
          db.prepare('UPDATE port_disconnects SET recovered_at = ?, duration_seconds = ? WHERE id = ?').run(
            nowIso,
            durSec,
            openEv.id
          );
          if (p.monitored && alertRules.enabled) {
            createAlert(
              ownerId,
              routerId,
              routerName,
              'info',
              `عودة المنفذ للعمل: ${p.label}`,
              `عاد المنفذ ${p.label} للعمل بعد انقطاع دام ${durSec} ثانية.`
            );
          }
        }
      }

      if (
        alertRules.enabled &&
        alertRules.alertOnPortSpeedDrop &&
        p.status === 'up' &&
        p.expectedSpeed === '1G' &&
        p.speed === '100M' &&
        (!old || old.speed !== '100M')
      ) {
        createAlert(
          ownerId,
          routerId,
          routerName,
          'warning',
          `نزول سرعة المنفذ: ${p.label}`,
          `انخفضت سرعة المنفذ ${p.label} إلى 100M بدلاً من 1G المتوقعة.`
        );
      }
    }

    // Recovery alert if router itself was offline (#40)
    if (prevStatus === 'offline' && alertRules.enabled) {
      createAlert(
        ownerId,
        routerId,
        routerName,
        'info',
        'عودة الراوتر للاتصال',
        `استعاد الراوتر ${snap.identity} الاتصال عبر النفق بزمن استجابة ${snap.rttMs}ms.`
      );
    }

    // Daily traffic rollup from real interface byte counters
    const totalRxGb = Number((etherPorts.reduce((a, p) => a + p.rxBytesToday, 0) / 1e9).toFixed(2));
    const totalTxGb = Number((etherPorts.reduce((a, p) => a + p.txBytesToday, 0) / 1e9).toFixed(2));
    const todayKey = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
    const prevDaily = JSON.parse(String(routerRow.daily_traffic_json || '[]')) as Array<{
      date: string;
      rxGb: number;
      txGb: number;
    }>;
    const filteredDaily = prevDaily.filter((d) => d.date !== todayKey);
    const nextDaily = [{ date: todayKey, rxGb: totalRxGb, txGb: totalTxGb }, ...filteredDaily].slice(0, 30);

    db.prepare(`
      UPDATE routers SET
        status = 'online',
        last_error = NULL,
        latest_handshake_at = COALESCE(?, latest_handshake_at),
        tunnel_rtt_ms = ?,
        identity = ?,
        model = ?,
        board_name = ?,
        serial_number = ?,
        routeros_version = ?,
        firmware_version = ?,
        upgrade_firmware = ?,
        architecture = ?,
        cpu_cores = ?,
        cpu_core_loads_json = ?,
        ram_total_mb = ?,
        voltage = ?,
        fan_rpm_json = ?,
        active_connections = ?,
        uptime_text = ?,
        cpu_percent = ?,
        ram_percent = ?,
        temp_celsius = ?,
        pppoe_online = ?,
        pppoe_secrets_count = ?,
        hotspot_online = ?,
        dhcp_leases_count = ?,
        neighbors_count = ?,
        current_rx_mbps = ?,
        current_tx_mbps = ?,
        traffic_history_json = ?,
        daily_traffic_json = ?,
        ports_json = ?,
        neighbors_json = ?,
        last_sync = ?
      WHERE id = ?
    `).run(
      wgCheck.connected || (useRelay && connType === 'wireguard') ? nowIso : null,
      snap.rttMs,
      snap.identity,
      snap.model,
      snap.boardName,
      snap.serialNumber,
      snap.routerOsVersion,
      snap.firmwareVersion,
      snap.upgradeFirmware,
      snap.architecture,
      snap.cpuCores,
      JSON.stringify(snap.cpuCoreLoads),
      snap.ramTotalMb,
      snap.voltage,
      JSON.stringify(snap.fanRpm),
      snap.activeConnections,
      snap.uptimeText,
      snap.cpuPercent,
      snap.ramPercent,
      snap.tempCelsius,
      snap.pppoeActive.length,
      snap.pppoeSecrets.length,
      snap.hotspotOnline,
      snap.dhcpLeasesCount,
      snap.neighbors.length,
      totalRxMbps,
      totalTxMbps,
      JSON.stringify(nextHistory),
      JSON.stringify(nextDaily),
      JSON.stringify(snap.ports),
      JSON.stringify(snap.neighbors),
      nowIso,
      routerId
    );

    // Sync real PPPoE active + secrets into SQLite subscribers table (#41, #42, #46, #48)
    const activeByName = new Map(snap.pppoeActive.map((a) => [a.name, a]));
    const queueByName = new Map(
      snap.queues.map((q) => [String(q.name || '').replace(/^<pppoe-|>$/g, ''), q])
    );

    const existingSubs = db
      .prepare('SELECT id, username, online, flap_count_today FROM subscribers WHERE router_id = ?')
      .all(routerId) as Array<{ id: string; username: string; online: number; flap_count_today: number }>;
    const existingSubMap = new Map(existingSubs.map((s) => [s.username, s]));

    const allUsernames = new Set<string>([
      ...snap.pppoeSecrets.map((s) => s.name).filter(Boolean),
      ...snap.pppoeActive.map((a) => a.name).filter(Boolean),
    ]);

    const secretMap = new Map(snap.pppoeSecrets.map((s) => [s.name, s]));

    for (const uname of allUsernames) {
      const act = activeByName.get(uname);
      const sec = secretMap.get(uname);
      const qRow = queueByName.get(uname);
      const isOnline = Boolean(act);
      const prevSub = existingSubMap.get(uname);
      const flapped = prevSub && prevSub.online === 1 && !isOnline ? 1 : 0;
      const mac = act?.['caller-id'] || sec?.['caller-id'] || '';
      const vendor = lookupMacVendor(mac);
      const ip = act?.address || sec?.['remote-address'] || '';
      const uptimeSec = act?.uptime ? parseRouterOsUptime(act.uptime) : 0;
      const uptimeText = act?.uptime ? formatUptimeArabic(act.uptime) : 'غير متصل';

      let liveRxMbps = 0;
      let liveTxMbps = 0;
      if (qRow?.rate) {
        const [txStr, rxStr] = qRow.rate.split('/');
        liveTxMbps = Number((Number(txStr || 0) / 1e6).toFixed(2));
        liveRxMbps = Number((Number(rxStr || 0) / 1e6).toFixed(2));
      }

      if (prevSub) {
        db.prepare(`
          UPDATE subscribers SET
            router_name = ?,
            ip = COALESCE(NULLIF(?, ''), ip),
            mac = COALESCE(NULLIF(?, ''), mac),
            mac_vendor = CASE WHEN ? != '' THEN ? ELSE mac_vendor END,
            profile = COALESCE(NULLIF(?, ''), profile),
            disabled = ?,
            uptime_text = ?,
            uptime_seconds = ?,
            online = ?,
            live_rx_mbps = ?,
            live_tx_mbps = ?,
            flap_count_today = flap_count_today + ?
          WHERE id = ?
        `).run(
          routerName,
          ip,
          mac,
          mac,
          vendor,
          sec?.profile || '',
          sec?.disabled === 'true' ? 1 : 0,
          uptimeText,
          uptimeSec,
          isOnline ? 1 : 0,
          liveRxMbps,
          liveTxMbps,
          flapped,
          prevSub.id
        );
      } else {
        db.prepare(`
          INSERT INTO subscribers (
            id, owner_id, router_id, router_name, username, full_name, area,
            ip, mac, mac_vendor, profile, disabled, uptime_text, uptime_seconds,
            online, live_rx_mbps, live_tx_mbps, billing_status, expires_in_days
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 30)
        `).run(
          `sub-${crypto.randomUUID()}`,
          ownerId,
          routerId,
          routerName,
          uname,
          sec?.comment || uname,
          '',
          ip,
          mac,
          vendor,
          sec?.profile || 'default',
          sec?.disabled === 'true' ? 1 : 0,
          uptimeText,
          uptimeSec,
          isOnline ? 1 : 0,
          liveRxMbps,
          liveTxMbps
        );
      }
    }

    // Ping monitored devices from inside MikroTik (#32, #33, #76 root-cause correlation)
    const devs = db
      .prepare('SELECT * FROM monitored_devices WHERE router_id = ?')
      .all(routerId) as Array<Record<string, unknown>>;

    if (!downPortRootCause) {
      for (const dev of devs) {
        try {
          const pingRes = await runPingViaContext(routerRow, String(dev.ip));
          const prevDevStatus = String(dev.status);
          const downSince =
            pingRes.status === 'down'
              ? dev.down_since
                ? String(dev.down_since)
                : nowIso
              : null;

          db.prepare(
            'UPDATE monitored_devices SET latency_ms = ?, packet_loss_pct = ?, status = ?, last_checked = ?, down_since = ? WHERE id = ?'
          ).run(pingRes.latencyMs, pingRes.packetLossPct, pingRes.status, nowIso, downSince, String(dev.id));

          if (alertRules.enabled && alertRules.alertOnPingDeviceDown) {
            if (prevDevStatus !== 'down' && pingRes.status === 'down') {
              createAlert(
                ownerId,
                routerId,
                routerName,
                'critical',
                `توقف الجهاز المراقب: ${dev.name}`,
                `الجهاز ${dev.name} (${dev.ip}) لا يستجيب لطلبات Ping من داخل الراوتر.`
              );
            } else if (prevDevStatus === 'down' && pingRes.status === 'up' && dev.down_since) {
              const durSec = Math.max(1, Math.round((Date.now() - Date.parse(String(dev.down_since))) / 1000));
              createAlert(
                ownerId,
                routerId,
                routerName,
                'info',
                `عودة الجهاز للعمل: ${dev.name}`,
                `استعاد الجهاز ${dev.name} (${dev.ip}) الاستجابة بعد توقف ${durSec} ثانية.`
              );
            } else if (pingRes.packetLossPct >= alertRules.packetLossThreshold && pingRes.status === 'up') {
              createAlert(
                ownerId,
                routerId,
                routerName,
                'warning',
                `فقدان حزم مرتفع: ${dev.name}`,
                `نسبة الفقد (${pingRes.packetLossPct}%) على ${dev.ip} تجاوزت الحد المسموح.`
              );
            }
          }
        } catch {
          // Skip device if ping command failed transiently
        }
      }
    }

    const updatedRow = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId) as Record<string, unknown>;
    return hydrateRouter(updatedRow);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'فشل الاتصال بالراوتر عبر RouterOS API';
    const nextStatus = prevStatus === 'pending' ? 'pending' : 'offline';
    db.prepare('UPDATE routers SET status = ?, last_error = ? WHERE id = ?').run(
      nextStatus,
      message,
      routerId
    );
    if (prevStatus === 'online' && alertRules.enabled) {
      createAlert(
        ownerId,
        routerId,
        routerName,
        'critical',
        `انقطاع الاتصال بالراوتر: ${routerName}`,
        message
      );
    }
    throw new Error(message);
  }
}

interface AuthedRequest extends Request {
  user?: TokenPayload;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول أولاً' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى إعادة تسجيل الدخول' });
    return;
  }
  req.user = payload;
  next();
}

function requireRole(allowed: UserRole[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !allowed.includes(req.user.role)) {
      res.status(403).json({ error: 'صلاحيات حسابك لا تسمح بهذا الإجراء' });
      return;
    }
    next();
  };
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // =========================================================================
  // Auth (Real accounts only — zero demo users or fake accounts #12, #83, #91)
  // =========================================================================
  app.post('/api/auth/register', (req: Request, res: Response) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(ip)) {
      res.status(429).json({ error: 'محاولات كثيرة متتالية — يرجى الانتظار 15 دقيقة' });
      return;
    }
    const { name, email, password, networkName } = req.body as Record<string, unknown>;
    if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'يرجى تعبئة الاسم والبريد الإلكتروني وكلمة المرور' });
      return;
    }
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();
    const cleanNet =
      typeof networkName === 'string' && networkName.trim() ? networkName.trim() : `شبكة ${cleanName}`;
    if (!cleanEmail.includes('@') || password.length < 6 || cleanName.length < 2) {
      res.status(400).json({ error: 'تأكد من صحة البريد الإلكتروني وأن كلمة المرور 6 أحرف على الأقل' });
      return;
    }
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
    if (existing) {
      res.status(409).json({ error: 'هذا البريد الإلكتروني مسجل مسبقاً' });
      return;
    }

    const userId = `usr-${crypto.randomUUID()}`;
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const nowIso = new Date().toISOString();

    db.prepare(
      'INSERT INTO users (id, owner_id, name, email, network_name, role, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, userId, cleanName, cleanEmail, cleanNet, 'admin', passwordHash, salt, nowIso);

    db.prepare('INSERT OR IGNORE INTO notification_settings (owner_id) VALUES (?)').run(userId);
    addAuditLog(userId, cleanName, 'admin', 'إنشاء حساب شبكة جديد', cleanNet);

    const token = signToken({
      sub: userId,
      ownerId: userId,
      email: cleanEmail,
      name: cleanName,
      networkName: cleanNet,
      role: 'admin',
    });

    res.status(201).json({
      token,
      user: {
        id: userId,
        ownerId: userId,
        name: cleanName,
        email: cleanEmail,
        networkName: cleanNet,
        role: 'admin',
      },
    });
  });

  app.post('/api/auth/login', (req: Request, res: Response) => {
    const ip = req.ip || 'unknown';
    if (!checkRateLimit(ip)) {
      res.status(429).json({ error: 'تم تجاوز الحد المسموح لمحاولات الدخول — انتظر 15 دقيقة' });
      return;
    }
    const { email, password } = req.body as Record<string, unknown>;
    if (typeof email !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'يرجى إدخال البريد الإلكتروني وكلمة المرور' });
      return;
    }
    const cleanEmail = email.trim().toLowerCase();
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail) as
      | Record<string, unknown>
      | undefined;
    if (!row || !verifyPassword(password, String(row.salt), String(row.password_hash))) {
      res.status(401).json({ error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
      return;
    }

    const token = signToken({
      sub: String(row.id),
      ownerId: String(row.owner_id),
      email: String(row.email),
      name: String(row.name),
      networkName: String(row.network_name),
      role: row.role as UserRole,
    });

    res.json({
      token,
      user: {
        id: String(row.id),
        ownerId: String(row.owner_id),
        name: String(row.name),
        email: String(row.email),
        networkName: String(row.network_name),
        role: row.role as UserRole,
      },
    });
  });

  // =========================================================================
  // Dashboard & Multi-tenant State (#86)
  // =========================================================================
  app.get('/api/dashboard', requireAuth, (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;

    const routerRows = db
      .prepare('SELECT * FROM routers WHERE owner_id = ? ORDER BY created_at DESC')
      .all(ownerId) as Array<Record<string, unknown>>;
    const subRows = db
      .prepare('SELECT * FROM subscribers WHERE owner_id = ? ORDER BY username ASC')
      .all(ownerId) as Array<Record<string, unknown>>;
    const alertRows = db
      .prepare('SELECT * FROM alerts WHERE owner_id = ? ORDER BY created_at DESC LIMIT 60')
      .all(ownerId) as Array<Record<string, unknown>>;
    const towerRows = db
      .prepare('SELECT * FROM towers WHERE owner_id = ?')
      .all(ownerId) as Array<Record<string, unknown>>;
    const paymentRows = db
      .prepare('SELECT * FROM payments WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(ownerId) as Array<Record<string, unknown>>;
    const voucherRows = db
      .prepare('SELECT * FROM hotspot_vouchers WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(ownerId) as Array<Record<string, unknown>>;

    res.json({
      routers: routerRows.map(hydrateRouter),
      subscribers: subRows.map(hydrateSubscriber),
      alerts: alertRows.map((a) => ({
        id: String(a.id),
        routerId: String(a.router_id),
        routerName: String(a.router_name),
        severity: a.severity,
        title: String(a.title),
        detail: String(a.detail),
        timestamp: String(a.timestamp),
        acknowledged: Boolean(a.acknowledged),
      })),
      towers: towerRows.map((t) => ({
        id: String(t.id),
        ownerId: String(t.owner_id),
        name: String(t.name),
        lat: Number(t.lat),
        lng: Number(t.lng),
        azimuthDeg: Number(t.azimuth_deg),
        beamwidthDeg: Number(t.beamwidth_deg),
        radiusMeters: Number(t.radius_meters),
      })),
      payments: paymentRows.map((p) => ({
        id: String(p.id),
        subscriberId: String(p.subscriber_id),
        subscriberName: String(p.subscriber_name),
        amountIqd: Number(p.amount_iqd),
        note: String(p.note),
        recordedBy: String(p.recorded_by),
        createdAt: String(p.created_at),
      })),
      hotspotVouchers: voucherRows.map((v) => ({
        code: String(v.code),
        profile: String(v.profile),
        createdAt: String(v.created_at),
        routerName: String(v.router_name),
      })),
    });
  });

  // =========================================================================
  // Server Connection Capabilities, Oracle VPS Relay & HTTPS Push Agent Ingest
  // =========================================================================
  app.get('/api/capabilities', async (req: Request, res: Response) => {
    let ownerId: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const payload = verifyToken(authHeader.slice('Bearer '.length).trim());
      if (payload) ownerId = payload.ownerId;
    }
    const wgCtx = await getOwnerWgContext(ownerId);
    const appUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.json({
      wireguardReady: wgCtx.ready,
      wireguardEndpoint: wgCtx.endpoint,
      wireguardPort: wgCtx.wgPort,
      viaRelay: Boolean(wgCtx.relayCfg),
      appUrl,
      isPreviewAuthProxy: appUrl.includes('ais-dev-'),
    });
  });

  app.get('/api/vps/status', requireAuth, requireRole(['admin']), (req: AuthedRequest, res: Response) => {
    const cfg = getVpsRelayConfig(req.user!.ownerId);
    const relaySecret = cfg ? decryptSecret(cfg.relaySecretEnc) : '';
    const wgPrivateKey = cfg ? decryptSecret(cfg.wgPrivateKeyEnc) : '';
    const installScript = cfg
      ? buildOracleRelayInstallScript({
          host: cfg.host,
          relayPort: cfg.relayPort,
          wgPort: cfg.wgPort,
          relaySecret,
          wgPrivateKey,
        })
      : null;
    const cloudShellScript = cfg
      ? buildOracleCloudShellScript({
          host: cfg.host,
          relayPort: cfg.relayPort,
          wgPort: cfg.wgPort,
          relaySecret,
          wgPrivateKey,
          instanceOcid: cfg.instanceOcid,
        })
      : null;
    res.json({
      status: toPublicVpsStatus(cfg),
      installScript,
      cloudShellScript,
    });
  });

  app.post('/api/vps/configure', requireAuth, requireRole(['admin']), (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const { host, relayPort = 8443, wgPort = 51820, instanceOcid } = req.body as Record<string, unknown>;
    if (typeof host !== 'string' || !host.trim() || !isValidHost(host.trim())) {
      res.status(400).json({ error: 'يرجى إدخال عنوان Public IP أو Hostname صحيح لسيرفر Oracle VPS' });
      return;
    }
    const cleanRelayPort = Number(relayPort);
    const cleanWgPort = Number(wgPort);
    if (!Number.isInteger(cleanRelayPort) || cleanRelayPort < 1 || cleanRelayPort > 65535) {
      res.status(400).json({ error: 'منفذ البوابة HTTPS غير صالح (1-65535)' });
      return;
    }
    if (!Number.isInteger(cleanWgPort) || cleanWgPort < 1 || cleanWgPort > 65535) {
      res.status(400).json({ error: 'منفذ WireGuard UDP غير صالح (1-65535)' });
      return;
    }

    const { cfg, relaySecret, wgPrivateKey } = configureVpsRelay(
      ownerId,
      host.trim(),
      cleanRelayPort,
      cleanWgPort,
      typeof instanceOcid === 'string' ? instanceOcid : undefined
    );
    const installScript = buildOracleRelayInstallScript({
      host: cfg.host,
      relayPort: cfg.relayPort,
      wgPort: cfg.wgPort,
      relaySecret,
      wgPrivateKey,
    });
    const cloudShellScript = buildOracleCloudShellScript({
      host: cfg.host,
      relayPort: cfg.relayPort,
      wgPort: cfg.wgPort,
      relaySecret,
      wgPrivateKey,
      instanceOcid: cfg.instanceOcid,
    });
    addAuditLog(ownerId, req.user!.name, req.user!.role, 'توليد ربط Oracle Cloud VPS', cfg.host);
    res.json({
      status: toPublicVpsStatus(cfg),
      installScript,
      cloudShellScript,
    });
  });

  app.post('/api/vps/verify', requireAuth, requireRole(['admin']), async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const cfg = getVpsRelayConfig(ownerId);
    if (!cfg) {
      res.status(400).json({ error: 'احفظ عنوان IP الخاص بـ Oracle VPS أولاً قبل الفحص' });
      return;
    }

    try {
      const health = await callVpsRelay<{
        ok: boolean;
        publicKey: string;
        peersCount?: number;
      }>(cfg, 'GET', '/health');

      cfg.verified = true;
      cfg.wgPublicKey = health.publicKey || cfg.wgPublicKey;
      cfg.lastCheckedAt = new Date().toISOString();
      cfg.lastError = null;
      cfg.activePeersCount = health.peersCount ?? 0;

      // Push all existing WireGuard routers for this tenant onto the Oracle VPS wg0 interface
      const wgRouters = db
        .prepare("SELECT wireguard_public_key, tunnel_ip FROM routers WHERE owner_id = ? AND connection_type = 'wireguard'")
        .all(ownerId) as Array<{ wireguard_public_key: string; tunnel_ip: string }>;
      for (const r of wgRouters) {
        await callVpsRelay(cfg, 'POST', '/wg/peer', {
          publicKey: r.wireguard_public_key,
          tunnelIp: r.tunnel_ip,
        }).catch(() => undefined);
      }
      cfg.activePeersCount = Math.max(cfg.activePeersCount, wgRouters.length);
      saveVpsRelayConfig(ownerId, cfg);

      addAuditLog(ownerId, req.user!.name, req.user!.role, 'تفعيل ربط Oracle VPS بنجاح', cfg.host);
      res.json({ ok: true, status: toPublicVpsStatus(cfg) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'تعذر الوصول لبوابة Oracle VPS';
      cfg.verified = false;
      cfg.lastCheckedAt = new Date().toISOString();
      cfg.lastError = msg;
      saveVpsRelayConfig(ownerId, cfg);
      res.status(502).json({ ok: false, error: msg, status: toPublicVpsStatus(cfg) });
    }
  });

  app.delete('/api/vps', requireAuth, requireRole(['admin']), (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    deleteVpsRelayConfig(ownerId);
    addAuditLog(ownerId, req.user!.name, req.user!.role, 'إلغاء ربط Oracle Cloud VPS', 'VPS');
    res.json({ deleted: true, status: toPublicVpsStatus(null) });
  });

  app.post('/api/agent/ingest', (req: Request, res: Response) => {
    const agentToken = String(req.headers['x-agent-token'] || '').trim();
    if (!agentToken) {
      res.status(401).json({ error: 'Missing X-Agent-Token header' });
      return;
    }
    const mapRow = db
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(`agent_tok_${agentToken}`) as { value: string } | undefined;
    if (!mapRow) {
      res.status(401).json({ error: 'Invalid agent token' });
      return;
    }
    const routerRow = db
      .prepare('SELECT * FROM routers WHERE id = ?')
      .get(mapRow.value) as Record<string, unknown> | undefined;
    if (!routerRow) {
      res.status(404).json({ error: 'Router not found' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const nowIso = new Date().toISOString();
    const totalMem = Number(body.totalMem || 0);
    const freeMem = Number(body.freeMem || 0);
    const ramTotalMb = totalMem > 0 ? Math.round(totalMem / (1024 * 1024)) : null;
    const ramPercent =
      totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null;
    const uptimeText = body.uptime ? formatUptimeArabic(String(body.uptime)) : null;

    db.prepare(`
      UPDATE routers SET
        status = 'online',
        last_error = NULL,
        identity = COALESCE(?, identity),
        model = COALESCE(?, model),
        board_name = COALESCE(?, board_name),
        serial_number = COALESCE(?, serial_number),
        routeros_version = COALESCE(?, routeros_version),
        architecture = COALESCE(?, architecture),
        cpu_cores = COALESCE(?, cpu_cores),
        cpu_percent = COALESCE(?, cpu_percent),
        ram_total_mb = COALESCE(?, ram_total_mb),
        ram_percent = COALESCE(?, ram_percent),
        uptime_text = COALESCE(?, uptime_text),
        pppoe_online = COALESCE(?, pppoe_online),
        pppoe_secrets_count = COALESCE(?, pppoe_secrets_count),
        hotspot_online = COALESCE(?, hotspot_online),
        dhcp_leases_count = COALESCE(?, dhcp_leases_count),
        last_sync = ?
      WHERE id = ?
    `).run(
      typeof body.identity === 'string' ? body.identity : null,
      typeof body.model === 'string' ? body.model : null,
      typeof body.boardName === 'string' ? body.boardName : null,
      typeof body.serialNumber === 'string' ? body.serialNumber : null,
      typeof body.routerOsVersion === 'string' ? body.routerOsVersion : null,
      typeof body.architecture === 'string' ? body.architecture : null,
      body.cpuCores !== undefined ? Number(body.cpuCores) : null,
      body.cpuPercent !== undefined ? Number(body.cpuPercent) : null,
      ramTotalMb,
      ramPercent,
      uptimeText,
      body.pppoeOnline !== undefined ? Number(body.pppoeOnline) : null,
      body.pppoeSecretsCount !== undefined ? Number(body.pppoeSecretsCount) : null,
      body.hotspotOnline !== undefined ? Number(body.hotspotOnline) : null,
      body.dhcpLeasesCount !== undefined ? Number(body.dhcpLeasesCount) : null,
      nowIso,
      String(routerRow.id)
    );

    res.json({ ok: true, syncedAt: nowIso });
  });

  // =========================================================================
  // Provision New Router (NO Model selector, starts strictly as PENDING #5)
  // =========================================================================
  app.post(
    '/api/routers/provision',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const wgCtx = await getOwnerWgContext(ownerId);
      const {
        name,
        connectionType,
        permissionMode = 'read-only',
        apiHost,
        apiPort = 8728,
        apiUsername,
        apiPassword,
        useExistingCredentials = false,
      } = req.body as Record<string, unknown>;

      if (typeof name !== 'string' || name.trim().length < 2) {
        res.status(400).json({ error: 'يرجى كتابة اسم تعريفي للراوتر (حرفان على الأقل)' });
        return;
      }

      const cleanName = name.trim().slice(0, 48);
      const connType: ConnectionType =
        connectionType === 'direct' ||
        connectionType === 'agent' ||
        connectionType === 'wireguard' ||
        connectionType === 'sstp' ||
        connectionType === 'ovpn'
          ? connectionType
          : wgCtx.ready
            ? 'wireguard'
            : 'direct';
      const permMode: ApiPermissionMode =
        permissionMode === 'full-control' ? 'full-control' : 'read-only';

      if ((connType === 'wireguard' || connType === 'sstp' || connType === 'ovpn') && !wgCtx.ready) {
        res.status(400).json({
          error:
            'نفق WireGuard غير مفعّل بعد — انتقل إلى "الإعدادات -> ربط خادم Oracle Cloud VPS" لتفعيله، أو اختر "API مباشر (Public IP / DDNS)".',
        });
        return;
      }

      const parsedPort = Number(apiPort);
      const cleanPort =
        Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 8728;

      const octet = getNextTunnelOctet();
      const tunnelIp = `${WG_SUBNET_PREFIX}${octet}`;
      const tunnelIpCidr = `${tunnelIp}/16`;
      const listenPort = 13280 + (octet % 100);
      const wgKeys = generateX25519Keypair();

      const chosenApiUser =
        typeof apiUsername === 'string' && apiUsername.trim()
          ? apiUsername.trim().slice(0, 32)
          : 'broradius';
      const chosenApiPass = useExistingCredentials
        ? typeof apiPassword === 'string'
          ? apiPassword
          : ''
        : typeof apiPassword === 'string' && apiPassword.trim()
          ? apiPassword.trim()
          : crypto.randomBytes(18).toString('base64url');

      let resolvedHost = connType === 'agent' ? 'https-agent' : tunnelIp;
      if (connType === 'direct') {
        if (typeof apiHost !== 'string' || !apiHost.trim() || !isValidHost(apiHost.trim())) {
          res.status(400).json({
            error:
              'يرجى إدخال عنوان Public IP أو MikroTik Cloud DDNS صحيح للراوتر (مثل xxx.sn.mynetname.net)',
          });
          return;
        }
        resolvedHost = apiHost.trim();
      } else if (typeof apiHost === 'string' && apiHost.trim()) {
        if (!isValidHost(apiHost.trim())) {
          res.status(400).json({ error: 'عنوان الاتصال (IP أو Hostname) غير صالح' });
          return;
        }
        resolvedHost = apiHost.trim();
      }

      const routerId = `rtr-${crypto.randomBytes(4).toString('hex')}`;
      const nowIso = new Date().toISOString();

      if (connType === 'wireguard') {
        await syncOwnerWireGuardPeer(ownerId, wgKeys.publicKey, tunnelIp);
      }

      let agentToken: string | undefined;
      let agentUrl: string | undefined;
      if (connType === 'agent') {
        agentToken = crypto.randomBytes(24).toString('hex');
        const appBase = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
        agentUrl = `${appBase}/api/agent/ingest`;
        db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
          `agent_tok_${agentToken}`,
          routerId
        );
      }

      const installScript = buildInstallScript({
        connectionType: connType,
        permissionMode: permMode,
        tunnelIpCidr,
        listenPort,
        routerPrivateKey: wgKeys.privateKey,
        serverPublicKey: wgCtx.wgPublicKey,
        serverEndpoint: wgCtx.endpoint,
        serverPort: wgCtx.wgPort,
        apiUsername: chosenApiUser,
        apiPassword: chosenApiPass,
        apiPort: cleanPort,
        agentUrl,
        agentToken,
      });

      const uninstallScript = buildUninstallScript(chosenApiUser);

      db.prepare(`
        INSERT INTO routers (
          id, owner_id, name, connection_type, permission_mode,
          api_host, api_port, api_username, api_password_enc,
          tunnel_ip, wireguard_port, wireguard_public_key, wireguard_private_key_enc,
          status, alert_rules_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        routerId,
        ownerId,
        cleanName,
        connType,
        permMode,
        resolvedHost,
        cleanPort,
        chosenApiUser,
        encryptSecret(chosenApiPass),
        tunnelIp,
        listenPort,
        wgKeys.publicKey,
        encryptSecret(wgKeys.privateKey),
        JSON.stringify(DEFAULT_ALERT_RULES),
        nowIso
      );

      addAuditLog(ownerId, req.user!.name, req.user!.role, 'إضافة راوتر (بانتظار الربط)', cleanName);

      const createdRow = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId) as Record<string, unknown>;
      res.status(201).json({
        router: hydrateRouter(createdRow),
        provision: {
          routerId,
          connectionType: connType,
          permissionMode: permMode,
          tunnelIp,
          listenPort,
          routerPublicKey: wgKeys.publicKey,
          apiUsername: chosenApiUser,
          apiPort: cleanPort,
          installScript,
          uninstallScript,
        },
      });
    }
  );

  // Verify live WireGuard handshake + fetch REAL router hardware/ports/PPPoE (#2, #3, #11)
  app.post('/api/routers/:id/verify', requireAuth, async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const row = db
      .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'الراوتر غير موجود' });
      return;
    }

    try {
      const updated = await performRealRouterSync(row);
      addAuditLog(ownerId, req.user!.name, req.user!.role, 'نجاح الربط والمزامنة الحية', updated.name);
      res.json({ verified: true, router: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'تعذر الوصول إلى الراوتر';
      const updatedRow = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.status(502).json({
        verified: false,
        error: `فشل الاتصال بالراوتر (${row.api_host}:${row.api_port}): ${msg}`,
        router: hydrateRouter(updatedRow),
      });
    }
  });

  // Rotate WireGuard Keys (#6)
  app.post(
    '/api/routers/:id/rotate-keys',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'الراوتر غير موجود' });
        return;
      }

      const wgCtx = await getOwnerWgContext(ownerId);
      await removeOwnerWireGuardPeer(ownerId, String(row.wireguard_public_key));
      const newKeys = generateX25519Keypair();
      const newApiPass = crypto.randomBytes(18).toString('base64url');
      await syncOwnerWireGuardPeer(ownerId, newKeys.publicKey, String(row.tunnel_ip));

      db.prepare(`
        UPDATE routers SET
          wireguard_public_key = ?,
          wireguard_private_key_enc = ?,
          api_password_enc = ?,
          status = 'pending'
        WHERE id = ?
      `).run(newKeys.publicKey, encryptSecret(newKeys.privateKey), encryptSecret(newApiPass), req.params.id);

      const installScript = buildInstallScript({
        connectionType: row.connection_type as ConnectionType,
        permissionMode: row.permission_mode as ApiPermissionMode,
        tunnelIpCidr: `${row.tunnel_ip}/16`,
        listenPort: Number(row.wireguard_port),
        routerPrivateKey: newKeys.privateKey,
        serverPublicKey: wgCtx.wgPublicKey,
        serverEndpoint: wgCtx.endpoint,
        serverPort: wgCtx.wgPort,
        apiUsername: String(row.api_username),
        apiPassword: newApiPass,
        apiPort: Number(row.api_port),
      });

      addAuditLog(ownerId, req.user!.name, req.user!.role, 'تدوير مفاتيح WireGuard', String(row.name));
      const updated = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.json({
        router: hydrateRouter(updated),
        installScript,
        uninstallScript: buildUninstallScript(String(row.api_username)),
      });
    }
  );

  // Get Uninstall Script & Delete Router (#9)
  app.get('/api/routers/:id/uninstall-script', requireAuth, (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare('SELECT api_username FROM routers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.user!.ownerId) as { api_username: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'الراوتر غير موجود' });
      return;
    }
    res.json({ uninstallScript: buildUninstallScript(row.api_username) });
  });

  // Edit Router Connection Settings (allows switching existing pending routers to direct/agent)
  app.patch(
    '/api/routers/:id',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'الراوتر غير موجود' });
        return;
      }

      const wgCtx = await getOwnerWgContext(ownerId);
      const {
        name,
        connectionType,
        permissionMode,
        apiHost,
        apiPort,
        apiUsername,
        apiPassword,
        useExistingCredentials = false,
      } = req.body as Record<string, unknown>;

      const nextName =
        typeof name === 'string' && name.trim().length >= 2 ? name.trim().slice(0, 48) : String(row.name);
      const nextConn: ConnectionType =
        connectionType === 'direct' ||
        connectionType === 'agent' ||
        connectionType === 'wireguard' ||
        connectionType === 'sstp' ||
        connectionType === 'ovpn'
          ? connectionType
          : (row.connection_type as ConnectionType);

      if ((nextConn === 'wireguard' || nextConn === 'sstp' || nextConn === 'ovpn') && !wgCtx.ready) {
        res.status(400).json({
          error:
            'نفق WireGuard غير مفعّل بعد — انتقل إلى "الإعدادات -> ربط خادم Oracle Cloud VPS" لتفعيله، أو اختر "API مباشر (Public IP / DDNS)".',
        });
        return;
      }

      const nextPerm: ApiPermissionMode =
        permissionMode === 'full-control' || permissionMode === 'read-only'
          ? permissionMode
          : (row.permission_mode as ApiPermissionMode);

      const parsedPort = Number(apiPort);
      const nextPort =
        Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
          ? parsedPort
          : Number(row.api_port || 8728);

      let nextHost = String(row.api_host);
      if (nextConn === 'direct') {
        if (typeof apiHost !== 'string' || !apiHost.trim() || !isValidHost(apiHost.trim())) {
          res.status(400).json({
            error:
              'يرجى إدخال عنوان Public IP أو MikroTik Cloud DDNS صحيح للراوتر (مثل xxx.sn.mynetname.net)',
          });
          return;
        }
        nextHost = apiHost.trim();
      } else if (nextConn === 'agent') {
        nextHost = 'https-agent';
      } else if (typeof apiHost === 'string' && apiHost.trim()) {
        if (!isValidHost(apiHost.trim())) {
          res.status(400).json({ error: 'عنوان الاتصال (IP أو Hostname) غير صالح' });
          return;
        }
        nextHost = apiHost.trim();
      }

      const nextUser =
        typeof apiUsername === 'string' && apiUsername.trim()
          ? apiUsername.trim().slice(0, 32)
          : String(row.api_username);

      const existingPass = decryptSecret(String(row.api_password_enc));
      const nextPass =
        typeof apiPassword === 'string' && (apiPassword.length > 0 || useExistingCredentials)
          ? apiPassword
          : existingPass;

      let agentToken: string | undefined;
      let agentUrl: string | undefined;
      if (nextConn === 'agent') {
        agentToken = crypto.randomBytes(24).toString('hex');
        const appBase = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
        agentUrl = `${appBase}/api/agent/ingest`;
        db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
          `agent_tok_${agentToken}`,
          String(row.id)
        );
      }

      db.prepare(`
        UPDATE routers SET
          name = ?,
          connection_type = ?,
          permission_mode = ?,
          api_host = ?,
          api_port = ?,
          api_username = ?,
          api_password_enc = ?,
          last_error = NULL
        WHERE id = ?
      `).run(
        nextName,
        nextConn,
        nextPerm,
        nextHost,
        nextPort,
        nextUser,
        encryptSecret(nextPass),
        req.params.id
      );

      if (nextConn === 'wireguard') {
        await syncOwnerWireGuardPeer(ownerId, String(row.wireguard_public_key), String(row.tunnel_ip));
      }

      const installScript = buildInstallScript({
        connectionType: nextConn,
        permissionMode: nextPerm,
        tunnelIpCidr: `${row.tunnel_ip}/16`,
        listenPort: Number(row.wireguard_port),
        routerPrivateKey: decryptSecret(String(row.wireguard_private_key_enc)),
        serverPublicKey: wgCtx.wgPublicKey,
        serverEndpoint: wgCtx.endpoint,
        serverPort: wgCtx.wgPort,
        apiUsername: nextUser,
        apiPassword: nextPass,
        apiPort: nextPort,
        agentUrl,
        agentToken,
      });

      addAuditLog(ownerId, req.user!.name, req.user!.role, 'تحديث إعدادات الاتصال بالراوتر', nextName);
      const updated = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.json({
        router: hydrateRouter(updated),
        installScript,
        uninstallScript: buildUninstallScript(nextUser),
      });
    }
  );

  app.delete(
    '/api/routers/:id',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const row = db
        .prepare('SELECT id, name, wireguard_public_key FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as { id: string; name: string; wireguard_public_key: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'الراوتر غير موجود' });
        return;
      }
      await removeOwnerWireGuardPeer(ownerId, row.wireguard_public_key);
      db.prepare('DELETE FROM routers WHERE id = ?').run(row.id);
      addAuditLog(ownerId, req.user!.name, req.user!.role, 'حذف راوتر', row.name);
      res.json({ deleted: true });
    }
  );

  // Real Live Telemetry Poll (#22)
  app.get('/api/routers/:id/telemetry', requireAuth, async (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'الراوتر غير موجود' });
      return;
    }
    if (row.status === 'pending') {
      res.json({ router: hydrateRouter(row) });
      return;
    }
    try {
      const updated = await performRealRouterSync(row);
      res.json({ router: updated });
    } catch (err) {
      const updatedRow = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.status(502).json({
        error: err instanceof Error ? err.message : 'تعذر قراءة التحديث الحي من الراوتر',
        router: hydrateRouter(updatedRow),
      });
    }
  });

  // Port history query (#23)
  app.get('/api/routers/:id/port-history', requireAuth, (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare('SELECT id FROM routers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.user!.ownerId);
    if (!row) {
      res.status(404).json({ error: 'الراوتر غير موجود' });
      return;
    }
    const range = String(req.query.range || '24h');
    const hours = range === '30d' ? 720 : range === '7d' ? 168 : 24;
    const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const samples = db
      .prepare(
        'SELECT port_name, rx_mbps, tx_mbps, recorded_at FROM port_traffic_history WHERE router_id = ? AND recorded_at >= ? ORDER BY id ASC LIMIT 500'
      )
      .all(req.params.id, sinceIso);
    res.json({ samples });
  });

  // Update Port label, role (WAN/ISP/Tower/LAN), monitored, expectedSpeed (#28)
  app.patch(
    '/api/routers/:id/ports/:portId',
    requireAuth,
    requireRole(['admin', 'technician']),
    (req: AuthedRequest, res: Response) => {
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'الراوتر غير موجود' });
        return;
      }
      const ports = JSON.parse(String(row.ports_json || '[]')) as RouterPort[];
      const port = ports.find((p) => p.id === req.params.portId);
      if (!port) {
        res.status(404).json({ error: 'المنفذ غير موجود' });
        return;
      }

      const { label, monitored, expectedSpeed, role } = req.body as Record<string, unknown>;
      if (typeof label === 'string' && label.trim()) port.label = label.trim().slice(0, 32);
      if (typeof monitored === 'boolean') port.monitored = monitored;
      if (expectedSpeed === '100M' || expectedSpeed === '1G' || expectedSpeed === '10G') {
        port.expectedSpeed = expectedSpeed;
      }
      const validRoles: PortRole[] = ['WAN', 'ISP', 'Tower', 'Switch', 'LAN', 'Unassigned'];
      if (typeof role === 'string' && validRoles.includes(role as PortRole)) {
        port.role = role as PortRole;
      }

      db.prepare('UPDATE routers SET ports_json = ? WHERE id = ?').run(
        JSON.stringify(ports),
        req.params.id
      );
      addAuditLog(req.user!.ownerId, req.user!.name, req.user!.role, 'تعديل إعدادات منفذ', `${row.name} · ${port.name}`);
      const updated = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.json({ port, router: hydrateRouter(updated) });
    }
  );

  // Live Read-Only Diagnostics from RouterOS API (#13, Info tab)
  app.get('/api/routers/:id/diagnostics', requireAuth, async (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'الراوتر غير موجود' });
      return;
    }
    if (row.status === 'pending') {
      res.status(400).json({ error: 'يجب إتمام ربط الراوتر أولاً قبل قراءة التشخيصات' });
      return;
    }
    if (row.connection_type === 'agent') {
      res.status(400).json({ error: 'تشخيصات الجداول المباشرة تتطلب ربطاً عبر API مباشر (Public IP / DDNS) أو WireGuard' });
      return;
    }

    try {
      const [
        ips,
        routes,
        dhcp,
        arp,
        pppoeSrv,
        pppProf,
        hsAct,
        queues,
        vlans,
        wl,
        svcs,
        dns,
        logs,
      ] = await execCommandsOnRouter(
        row,
        [
          ['/ip/address/print'],
          ['/ip/route/print'],
          ['/ip/dhcp-server/lease/print'],
          ['/ip/arp/print'],
          ['/interface/pppoe-server/server/print'],
          ['/ppp/profile/print'],
          ['/ip/hotspot/active/print'],
          ['/queue/simple/print'],
          ['/interface/vlan/print'],
          ['/interface/wireless/registration-table/print'],
          ['/ip/service/print'],
          ['/ip/dns/print'],
          ['/log/print'],
        ],
        true
      );

      const dns0 = dns[0] || {};
      res.json({
        ipAddresses: ips.slice(0, 60).map((r) => ({
          address: r.address || '',
          network: r.network || '',
          iface: r.interface || '',
        })),
        routes: routes.slice(0, 60).map((r) => ({
          dst: r['dst-address'] || '',
          gateway: r.gateway || '',
          distance: r.distance || '',
        })),
        dhcpLeases: dhcp.slice(0, 80).map((r) => ({
          address: r.address || '',
          mac: r['mac-address'] || '',
          hostName: r['host-name'] || '-',
          status: r.status || '',
        })),
        arpTable: arp.slice(0, 80).map((r) => ({
          address: r.address || '',
          mac: r['mac-address'] || '',
          iface: r.interface || '',
        })),
        pppoeServers: pppoeSrv.slice(0, 30).map((r) => ({
          serviceName: r['service-name'] || '',
          iface: r.interface || '',
          maxMtu: r['max-mtu'] || '',
        })),
        pppProfiles: pppProf.slice(0, 40).map((r) => ({
          name: r.name || '',
          localAddress: r['local-address'] || '-',
          rateLimit: r['rate-limit'] || 'غير محدد',
        })),
        hotspotActive: hsAct.slice(0, 60).map((r) => ({
          user: r.user || '',
          address: r.address || '',
          uptime: r.uptime || '',
        })),
        simpleQueues: queues.slice(0, 60).map((r) => ({
          name: r.name || '',
          target: r.target || '',
          maxLimit: r['max-limit'] || '',
        })),
        vlans: vlans.slice(0, 40).map((r) => ({
          name: r.name || '',
          vlanId: r['vlan-id'] || '',
          iface: r.interface || '',
        })),
        wirelessClients: wl.slice(0, 60).map((r) => ({
          mac: r['mac-address'] || '',
          iface: r.interface || '',
          signal: r['signal-strength'] || '',
          txRate: r['tx-rate'] || '',
        })),
        services: svcs.map((r) => ({
          name: r.name || '',
          port: r.port || '',
          disabled: r.disabled === 'true',
        })),
        dnsSettings: {
          servers: dns0.servers || dns0['dynamic-servers'] || 'غير محدد',
          allowRemoteRequests: dns0['allow-remote-requests'] === 'true',
          cacheUsedKb: Number(dns0['cache-used'] || 0),
          cacheSizeKb: Number(dns0['cache-size'] || 0),
        },
        logs: logs.slice(-50).reverse().map((r) => ({
          time: r.time || '',
          topics: r.topics || '',
          message: r.message || '',
        })),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'تعذر قراءة التشخيصات من الراوتر' });
    }
  });

  // Router Backups (.backup & .rsc export) (#19)
  app.get('/api/routers/:id/backups', requireAuth, (req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare('SELECT * FROM backups WHERE router_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(req.params.id, req.user!.ownerId) as Array<Record<string, unknown>>;
    res.json({
      backups: rows.map((b) => ({
        id: String(b.id),
        routerId: String(b.router_id),
        kind: b.kind,
        filename: String(b.filename),
        contentPreview: String(b.content_preview),
        createdAt: String(b.created_at),
      })),
    });
  });

  app.post(
    '/api/routers/:id/backups',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'الراوتر غير موجود' });
        return;
      }
      if (row.permission_mode !== 'full-control') {
        res.status(403).json({ error: 'النسخ الاحتياطي يتطلب ربط الراوتر بصلاحية التحكم الكامل' });
        return;
      }
      const kind = (req.body as { kind?: string }).kind === 'rsc' ? 'rsc' : 'backup';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `bro-${row.identity || row.id}-${stamp}.${kind}`;

      try {
        await execCommandsOnRouter(row, [
          kind === 'backup'
            ? ['/system/backup/save', `=name=${filename}`]
            : ['/export', `=file=${filename}`],
        ]);
        const id = `bak-${crypto.randomUUID()}`;
        const nowIso = new Date().toISOString();
        db.prepare(
          'INSERT INTO backups (id, owner_id, router_id, kind, filename, content_preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, ownerId, String(row.id), kind, filename, `تم الحفظ على ذاكرة الراوتر: ${filename}`, nowIso);
        addAuditLog(ownerId, req.user!.name, req.user!.role, `أخذ نسخة ${kind}`, filename);
        res.status(201).json({ id, filename, createdAt: nowIso });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'فشل أخذ النسخة الاحتياطية من الراوتر' });
      }
    }
  );

  // Monitored Ping Devices + Real Ping Execution (#32, #33, #37)
  app.post(
    '/api/routers/:id/devices',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'الراوتر غير موجود' });
        return;
      }
      const { name, ip, sectorGroup = 'عام' } = req.body as Record<string, unknown>;
      if (typeof name !== 'string' || typeof ip !== 'string' || !name.trim() || !isValidIpv4(ip)) {
        res.status(400).json({ error: 'يرجى إدخال اسم الجهاز وعنوان IPv4 صحيح' });
        return;
      }
      const cleanIp = ip.trim();
      const id = `dev-${crypto.randomBytes(4).toString('hex')}`;
      let status: 'up' | 'down' | 'unknown' = 'unknown';
      let latencyMs: number | null = null;
      let packetLossPct = 0;

      if (row.status === 'online') {
        try {
          const pingRes = await runPingViaContext(row, cleanIp);
          status = pingRes.status;
          latencyMs = pingRes.latencyMs;
          packetLossPct = pingRes.packetLossPct;
        } catch {
          status = 'unknown';
        }
      }

      db.prepare(
        'INSERT INTO monitored_devices (id, router_id, owner_id, name, ip, sector_group, latency_ms, packet_loss_pct, status, last_checked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        id,
        req.params.id,
        ownerId,
        name.trim().slice(0, 40),
        cleanIp,
        typeof sectorGroup === 'string' && sectorGroup.trim() ? sectorGroup.trim().slice(0, 24) : 'عام',
        latencyMs,
        packetLossPct,
        status,
        new Date().toISOString()
      );

      addAuditLog(ownerId, req.user!.name, req.user!.role, 'إضافة جهاز للمراقبة', `${name.trim()} (${cleanIp})`);
      const updated = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.status(201).json({ router: hydrateRouter(updated) });
    }
  );

  app.delete(
    '/api/routers/:id/devices/:deviceId',
    requireAuth,
    requireRole(['admin', 'technician']),
    (req: AuthedRequest, res: Response) => {
      db.prepare('DELETE FROM monitored_devices WHERE id = ? AND router_id = ? AND owner_id = ?').run(
        req.params.deviceId,
        req.params.id,
        req.user!.ownerId
      );
      const updated = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.json({ router: hydrateRouter(updated) });
    }
  );

  // Update Alert Rules
  app.patch(
    '/api/routers/:id/alerts',
    requireAuth,
    requireRole(['admin', 'technician']),
    (req: AuthedRequest, res: Response) => {
      const row = db
        .prepare('SELECT alert_rules_json FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, req.user!.ownerId) as { alert_rules_json: string } | undefined;
      if (!row) {
        res.status(404).json({ error: 'الراوتر غير موجود' });
        return;
      }
      const prev = JSON.parse(row.alert_rules_json) as RouterAlertRules;
      const next: RouterAlertRules = { ...prev, ...(req.body as Partial<RouterAlertRules>) };
      db.prepare('UPDATE routers SET alert_rules_json = ? WHERE id = ?').run(
        JSON.stringify(next),
        req.params.id
      );
      res.json({ alertRules: next });
    }
  );

  app.post('/api/alerts/:alertId/ack', requireAuth, (req: AuthedRequest, res: Response) => {
    db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ? AND owner_id = ?').run(
      req.params.alertId,
      req.user!.ownerId
    );
    res.json({ ok: true });
  });

  // =========================================================================
  // Subscribers: Real Session Disconnect, Profile Change, Billing, Payments, CSV (#44-#54)
  // =========================================================================
  app.post(
    '/api/subscribers/:id/disconnect',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const sub = db
        .prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!sub) {
        res.status(404).json({ error: 'المشترك غير موجود' });
        return;
      }
      const router = db
        .prepare('SELECT * FROM routers WHERE id = ?')
        .get(String(sub.router_id)) as Record<string, unknown>;
      if (router.permission_mode !== 'full-control') {
        res.status(403).json({ error: 'فصل الجلسة يتطلب ربط الراوتر بصلاحية التحكم الكامل' });
        return;
      }

      try {
        const [activeRows] = await execCommandsOnRouter(router, [
          ['/ppp/active/print', `?name=${sub.username}`],
        ]);
        const removeCmds = activeRows
          .filter((r) => r['.id'])
          .map((r) => ['/ppp/active/remove', `=.id=${r['.id']}`]);
        if (removeCmds.length > 0) {
          await execCommandsOnRouter(router, removeCmds);
        }
        db.prepare('UPDATE subscribers SET online = 0, uptime_text = ? WHERE id = ?').run(
          'غير متصل',
          req.params.id
        );
        addAuditLog(ownerId, req.user!.name, req.user!.role, 'فصل جلسة PPPoE', String(sub.username));
        const updated = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
        res.json({ subscriber: hydrateSubscriber(updated) });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'تعذر فصل الجلسة على الراوتر' });
      }
    }
  );

  app.patch(
    '/api/subscribers/:id',
    requireAuth,
    requireRole(['admin', 'accountant', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const sub = db
        .prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!sub) {
        res.status(404).json({ error: 'المشترك غير موجود' });
        return;
      }

      const {
        fullName,
        phone,
        area,
        billingStatus,
        debtAmountIqd,
        expiresInDays,
        graceHours,
        profile,
        disabled,
        towerId,
        lat,
        lng,
      } = req.body as Record<string, unknown>;

      // If profile or disabled changed, apply on real MikroTik router if full-control
      if (typeof profile === 'string' || typeof disabled === 'boolean') {
        const router = db
          .prepare('SELECT * FROM routers WHERE id = ?')
          .get(String(sub.router_id)) as Record<string, unknown>;
        if (router && router.status === 'online' && router.permission_mode === 'full-control') {
          try {
            const [secrets] = await execCommandsOnRouter(router, [
              ['/ppp/secret/print', `?name=${sub.username}`],
            ]);
            if (secrets[0]?.['.id']) {
              const args = ['/ppp/secret/set', `=.id=${secrets[0]['.id']}`];
              if (typeof profile === 'string' && profile.trim()) args.push(`=profile=${profile.trim()}`);
              if (typeof disabled === 'boolean') args.push(`=disabled=${disabled ? 'yes' : 'no'}`);
              await execCommandsOnRouter(router, [args]);
            }
          } catch (err) {
            res.status(502).json({ error: err instanceof Error ? err.message : 'فشل تطبيق التعديل على المايكروتك' });
            return;
          }
        }
      }

      const nextExpiresDays =
        typeof graceHours === 'number'
          ? Math.max(1, Math.ceil(graceHours / 24))
          : typeof expiresInDays === 'number'
            ? Math.round(expiresInDays)
            : Number(sub.expires_in_days);

      const nextExpiresAt = new Date(Date.now() + nextExpiresDays * 86400 * 1000).toISOString();

      db.prepare(`
        UPDATE subscribers SET
          full_name = COALESCE(?, full_name),
          phone = COALESCE(?, phone),
          area = COALESCE(?, area),
          billing_status = COALESCE(?, billing_status),
          debt_amount_iqd = COALESCE(?, debt_amount_iqd),
          expires_in_days = ?,
          expires_at = ?,
          profile = COALESCE(?, profile),
          disabled = COALESCE(?, disabled),
          tower_id = COALESCE(?, tower_id),
          lat = COALESCE(?, lat),
          lng = COALESCE(?, lng)
        WHERE id = ?
      `).run(
        typeof fullName === 'string' ? fullName.trim() : null,
        typeof phone === 'string' ? phone.trim() : null,
        typeof area === 'string' ? area.trim() : null,
        typeof billingStatus === 'string' ? billingStatus : null,
        typeof debtAmountIqd === 'number' ? Math.max(0, Math.round(debtAmountIqd)) : null,
        nextExpiresDays,
        nextExpiresAt,
        typeof profile === 'string' ? profile.trim() : null,
        typeof disabled === 'boolean' ? (disabled ? 1 : 0) : null,
        typeof towerId === 'string' ? towerId : null,
        typeof lat === 'number' ? Number(lat.toFixed(6)) : null,
        typeof lng === 'number' ? Number(lng.toFixed(6)) : null,
        req.params.id
      );

      addAuditLog(ownerId, req.user!.name, req.user!.role, 'تحديث بيانات مشترك', String(sub.username));
      const updated = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(req.params.id) as Record<string, unknown>;
      res.json({ subscriber: hydrateSubscriber(updated) });
    }
  );

  // Payment & Debt Ledger (#52)
  app.post(
    '/api/subscribers/:id/payments',
    requireAuth,
    requireRole(['admin', 'accountant']),
    (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const sub = db
        .prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!sub) {
        res.status(404).json({ error: 'المشترك غير موجود' });
        return;
      }
      const { amountIqd, note = '', renewDays = 30 } = req.body as Record<string, unknown>;
      const amt = Number(amountIqd);
      if (!Number.isFinite(amt) || amt <= 0) {
        res.status(400).json({ error: 'يرجى إدخال مبلغ صحيح أكبر من صفر' });
        return;
      }
      const payId = `pay-${crypto.randomUUID()}`;
      const nowIso = new Date().toISOString();
      db.prepare(
        'INSERT INTO payments (id, owner_id, subscriber_id, subscriber_name, amount_iqd, note, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(payId, ownerId, String(sub.id), String(sub.full_name), Math.round(amt), String(note).slice(0, 120), req.user!.name, nowIso);

      const remainingDebt = Math.max(0, Number(sub.debt_amount_iqd || 0) - Math.round(amt));
      const nextDays = Number(renewDays) > 0 ? Number(renewDays) : Number(sub.expires_in_days);
      const nextStatus: SubscriberBillingStatus = remainingDebt > 0 ? 'debtor' : 'active';

      db.prepare('UPDATE subscribers SET debt_amount_iqd = ?, billing_status = ?, expires_in_days = ?, activated_at = ? WHERE id = ?').run(
        remainingDebt,
        nextStatus,
        nextDays,
        nowIso,
        String(sub.id)
      );

      addAuditLog(ownerId, req.user!.name, req.user!.role, 'تسجيل دفعة مالية', `${sub.username} (${amt} د.ع)`);
      const updatedSub = db.prepare('SELECT * FROM subscribers WHERE id = ?').get(String(sub.id)) as Record<string, unknown>;
      res.status(201).json({
        subscriber: hydrateSubscriber(updatedSub),
        payment: {
          id: payId,
          subscriberId: String(sub.id),
          subscriberName: String(sub.full_name),
          amountIqd: Math.round(amt),
          note: String(note),
          recordedBy: req.user!.name,
          createdAt: nowIso,
        },
      });
    }
  );

  // CSV Export (#50)
  app.get('/api/subscribers/export.csv', requireAuth, (req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare('SELECT * FROM subscribers WHERE owner_id = ? ORDER BY username ASC')
      .all(req.user!.ownerId) as Array<Record<string, unknown>>;
    const header = 'Username,FullName,Router,Profile,IP,MAC,Vendor,Status,DebtIQD,ExpiresInDays,Online\n';
    const body = rows
      .map((r) =>
        [
          r.username,
          `"${String(r.full_name || '').replace(/"/g, '""')}"`,
          `"${String(r.router_name || '').replace(/"/g, '""')}"`,
          r.profile,
          r.ip,
          r.mac,
          r.mac_vendor,
          r.billing_status,
          r.debt_amount_iqd,
          r.expires_in_days,
          r.online ? 'Yes' : 'No',
        ].join(',')
      )
      .join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bro-radius-subscribers.csv"');
    res.send('\uFEFF' + header + body);
  });

  // =========================================================================
  // Towers & GIS Sector Coverage (#62)
  // =========================================================================
  app.post(
    '/api/towers',
    requireAuth,
    requireRole(['admin', 'technician']),
    (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const { name, lat, lng, azimuthDeg = 0, beamwidthDeg = 120, radiusMeters = 1500 } = req.body as Record<string, unknown>;
      if (typeof name !== 'string' || typeof lat !== 'number' || typeof lng !== 'number') {
        res.status(400).json({ error: 'يرجى تحديد اسم البرج والإحداثيات' });
        return;
      }
      const id = `twr-${crypto.randomUUID()}`;
      db.prepare(
        'INSERT INTO towers (id, owner_id, name, lat, lng, azimuth_deg, beamwidth_deg, radius_meters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        id,
        ownerId,
        name.trim().slice(0, 48),
        Number(lat.toFixed(6)),
        Number(lng.toFixed(6)),
        Number(azimuthDeg) || 0,
        Number(beamwidthDeg) || 120,
        Number(radiusMeters) || 1500
      );
      addAuditLog(ownerId, req.user!.name, req.user!.role, 'إضافة برج على الخريطة', name.trim());
      res.status(201).json({
        tower: { id, ownerId, name: name.trim(), lat, lng, azimuthDeg: Number(azimuthDeg), beamwidthDeg: Number(beamwidthDeg), radiusMeters: Number(radiusMeters) },
      });
    }
  );

  app.delete(
    '/api/towers/:id',
    requireAuth,
    requireRole(['admin', 'technician']),
    (req: AuthedRequest, res: Response) => {
      db.prepare('DELETE FROM towers WHERE id = ? AND owner_id = ?').run(req.params.id, req.user!.ownerId);
      res.json({ deleted: true });
    }
  );

  // =========================================================================
  // Hotspot Voucher Creation via Real RouterOS API
  // =========================================================================
  app.post(
    '/api/hotspot/vouchers',
    requireAuth,
    requireRole(['admin', 'accountant', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const { routerId, profile } = req.body as Record<string, unknown>;
      const router = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(String(routerId || ''), ownerId) as Record<string, unknown> | undefined;
      if (!router) {
        res.status(404).json({ error: 'يرجى ربط راوتر أولاً قبل إصدار الكروت' });
        return;
      }
      if (router.status !== 'online' || router.permission_mode !== 'full-control') {
        res.status(403).json({ error: 'إصدار كروت الهوتسبوت يتطلب راوتراً متصلاً بصلاحية التحكم الكامل' });
        return;
      }
      const cleanProfile = typeof profile === 'string' && profile.trim() ? profile.trim().slice(0, 24) : 'default';
      const code = `BRO${Math.floor(100000 + Math.random() * 899999)}`;

      try {
        await execCommandsOnRouter(router, [
          [
            '/ip/hotspot/user/add',
            `=name=${code}`,
            `=password=${code}`,
            `=profile=${cleanProfile}`,
            '=comment=BroRadius',
          ],
        ]);
        const nowIso = new Date().toISOString();
        db.prepare(
          'INSERT INTO hotspot_vouchers (id, owner_id, router_id, router_name, code, profile, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(`vch-${crypto.randomUUID()}`, ownerId, String(router.id), String(router.name), code, cleanProfile, nowIso);
        addAuditLog(ownerId, req.user!.name, req.user!.role, 'إصدار كرت هوتسبوت', `${code} (${cleanProfile})`);
        const voucherRows = db
          .prepare('SELECT * FROM hotspot_vouchers WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20')
          .all(ownerId) as Array<Record<string, unknown>>;
        res.status(201).json({
          voucher: { code, profile: cleanProfile, createdAt: nowIso, routerName: String(router.name) },
          vouchers: voucherRows.map((v) => ({
            code: String(v.code),
            profile: String(v.profile),
            createdAt: String(v.created_at),
            routerName: String(v.router_name),
          })),
        });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'فشل إضافة الكرت على المايكروتك' });
      }
    }
  );

  // =========================================================================
  // RBAC Team Members (#84), Telegram/Push Settings (#71,#72), Digest (#77), Audit Log (#78), Test Alert (#79)
  // =========================================================================
  app.get('/api/settings', requireAuth, (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const notif = db
      .prepare('SELECT * FROM notification_settings WHERE owner_id = ?')
      .get(ownerId) as Record<string, unknown> | undefined;
    const members = db
      .prepare('SELECT id, name, email, role, created_at FROM users WHERE owner_id = ? ORDER BY created_at ASC')
      .all(ownerId) as Array<Record<string, unknown>>;
    const auditLogs = db
      .prepare('SELECT * FROM audit_logs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 60')
      .all(ownerId) as Array<Record<string, unknown>>;

    res.json({
      notifications: {
        webPushEnabled: Boolean(notif?.web_push_enabled),
        telegramEnabled: Boolean(notif?.telegram_enabled),
        telegramChatId: String(notif?.telegram_chat_id || ''),
        hasTelegramToken: Boolean(notif?.telegram_bot_token_enc),
        dailyDigestEnabled: notif ? Boolean(notif.daily_digest_enabled) : true,
      },
      teamMembers: members.map((m) => ({
        id: String(m.id),
        name: String(m.name),
        email: String(m.email),
        role: m.role,
        createdAt: String(m.created_at),
      })),
      auditLogs: auditLogs.map((a) => ({
        id: String(a.id),
        actorName: String(a.actor_name),
        actorRole: a.actor_role,
        action: String(a.action),
        target: String(a.target),
        createdAt: String(a.created_at),
      })),
    });
  });

  app.post(
    '/api/team',
    requireAuth,
    requireRole(['admin']),
    (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const { name, email, password, role } = req.body as Record<string, unknown>;
      if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
        res.status(400).json({ error: 'يرجى تعبئة الاسم والبريد الإلكتروني وكلمة المرور' });
        return;
      }
      const validRoles: UserRole[] = ['admin', 'accountant', 'technician', 'viewer'];
      const chosenRole: UserRole = validRoles.includes(role as UserRole) ? (role as UserRole) : 'viewer';
      const cleanEmail = email.trim().toLowerCase();
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail)) {
        res.status(409).json({ error: 'هذا البريد الإلكتروني مسجل مسبقاً' });
        return;
      }
      const id = `usr-${crypto.randomUUID()}`;
      const salt = crypto.randomBytes(16).toString('hex');
      const nowIso = new Date().toISOString();
      db.prepare(
        'INSERT INTO users (id, owner_id, name, email, network_name, role, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, ownerId, name.trim(), cleanEmail, req.user!.networkName, chosenRole, hashPassword(password, salt), salt, nowIso);
      addAuditLog(ownerId, req.user!.name, req.user!.role, 'إضافة عضو فريق', `${name.trim()} (${chosenRole})`);
      res.status(201).json({ member: { id, name: name.trim(), email: cleanEmail, role: chosenRole, createdAt: nowIso } });
    }
  );

  app.delete('/api/team/:id', requireAuth, requireRole(['admin']), (req: AuthedRequest, res: Response) => {
    if (req.params.id === req.user!.sub) {
      res.status(400).json({ error: 'لا يمكنك حذف حسابك الشخصي' });
      return;
    }
    db.prepare('DELETE FROM users WHERE id = ? AND owner_id = ?').run(req.params.id, req.user!.ownerId);
    res.json({ deleted: true });
  });

  app.patch('/api/settings/notifications', requireAuth, requireRole(['admin']), (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const { webPushEnabled, telegramEnabled, telegramBotToken, telegramChatId, dailyDigestEnabled } =
      req.body as Record<string, unknown>;

    db.prepare('INSERT OR IGNORE INTO notification_settings (owner_id) VALUES (?)').run(ownerId);
    const cur = db
      .prepare('SELECT * FROM notification_settings WHERE owner_id = ?')
      .get(ownerId) as Record<string, unknown>;

    const nextTokenEnc =
      typeof telegramBotToken === 'string' && telegramBotToken.trim()
        ? encryptSecret(telegramBotToken.trim())
        : String(cur.telegram_bot_token_enc || '');

    db.prepare(`
      UPDATE notification_settings SET
        web_push_enabled = ?,
        telegram_enabled = ?,
        telegram_bot_token_enc = ?,
        telegram_chat_id = ?,
        daily_digest_enabled = ?
      WHERE owner_id = ?
    `).run(
      typeof webPushEnabled === 'boolean' ? (webPushEnabled ? 1 : 0) : Number(cur.web_push_enabled),
      typeof telegramEnabled === 'boolean' ? (telegramEnabled ? 1 : 0) : Number(cur.telegram_enabled),
      nextTokenEnc,
      typeof telegramChatId === 'string' ? telegramChatId.trim() : String(cur.telegram_chat_id || ''),
      typeof dailyDigestEnabled === 'boolean' ? (dailyDigestEnabled ? 1 : 0) : Number(cur.daily_digest_enabled),
      ownerId
    );
    res.json({ ok: true });
  });

  app.post('/api/settings/test-alert', requireAuth, async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const nowIso = new Date().toISOString();
    db.prepare(
      'INSERT INTO alerts (id, owner_id, router_id, router_name, severity, title, detail, timestamp, acknowledged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
    ).run(
      `alt-${crypto.randomUUID()}`,
      ownerId,
      'system',
      req.user!.networkName,
      'info',
      'اختبار التنبيهات الفوري',
      'تم التحقق من وصول إشعارات Bro Radius بنجاح.',
      'الآن',
      nowIso
    );
    const tgSent = await sendTelegramAlert(
      ownerId,
      'اختبار التنبيهات الفوري',
      'تم التحقق من اتصال بوت تيليجرام مع منصة Bro Radius بنجاح.'
    );
    res.json({ ok: true, telegramSent: tgSent });
  });

  app.get('/api/digest', requireAuth, (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const routersCount = (
      db.prepare('SELECT COUNT(*) as c FROM routers WHERE owner_id = ?').get(ownerId) as { c: number }
    ).c;
    const onlineRouters = (
      db.prepare("SELECT COUNT(*) as c FROM routers WHERE owner_id = ? AND status = 'online'").get(ownerId) as { c: number }
    ).c;
    const openAlerts = (
      db.prepare('SELECT COUNT(*) as c FROM alerts WHERE owner_id = ? AND acknowledged = 0').get(ownerId) as { c: number }
    ).c;
    const expiringSubs = (
      db.prepare('SELECT COUNT(*) as c FROM subscribers WHERE owner_id = ? AND expires_in_days <= 2').get(ownerId) as { c: number }
    ).c;
    const debtors = (
      db.prepare('SELECT COALESCE(SUM(debt_amount_iqd), 0) as s FROM subscribers WHERE owner_id = ?').get(ownerId) as { s: number }
    ).s;

    res.json({
      generatedAt: new Date().toISOString(),
      routersCount,
      onlineRouters,
      openAlerts,
      expiringSubs,
      totalDebtIqd: debtors,
    });
  });

  // Background Poller Worker every 60s (#87) + Retention Cleanup (#90)
  setInterval(() => {
    const activeRouters = db
      .prepare("SELECT * FROM routers WHERE status != 'pending' AND connection_type != 'agent'")
      .all() as Array<Record<string, unknown>>;
    for (const r of activeRouters) {
      void performRealRouterSync(r).catch(() => {
        // Error already persisted in router row & alert
      });
    }
    runRetentionCleanup();
  }, 60 * 1000);

  if (!IS_PROD) {
    app.get(['/dev-sw.js', '/sw.js'], (_req: Request, res: Response) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.send(`
        self.addEventListener('install', () => { self.skipWaiting(); });
        self.addEventListener('activate', (event) => {
          event.waitUntil((async () => {
            try {
              const keys = await caches.keys();
              await Promise.all(keys.map((k) => caches.delete(k)));
            } catch {}
            try {
              await self.registration.unregister();
            } catch {}
          })());
        });
      `);
    });
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Restore WireGuard peers on VPS boot if wg0 is active
  if (await isHostWireGuardAvailable()) {
    const wgRouters = db
      .prepare("SELECT wireguard_public_key, tunnel_ip FROM routers WHERE connection_type = 'wireguard'")
      .all() as Array<{ wireguard_public_key: string; tunnel_ip: string }>;
    for (const r of wgRouters) {
      await syncHostWireGuardPeer(r.wireguard_public_key, r.tunnel_ip);
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Bro Radius server running on http://0.0.0.0:${PORT}`);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection in Bro Radius:', reason);
});

startServer().catch((err) => {
  console.error('Failed to start Bro Radius server:', err);
  process.exit(1);
});
