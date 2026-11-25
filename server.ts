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
  buildDualHomedWireGuardScript,
  buildInstallScript,
  buildUninstallScript,
  evaluateRouterSecurity,
  fetchRealRouterSnapshot,
  formatUptimeArabic,
  getHostWireGuardHandshake,
  getHostWireGuardPublicKey,
  isHostWireGuardAvailable,
  lookupMacVendor,
  parseRouterOsUptime,
  parseTorchRows,
  removeHostWireGuardPeer,
  RouterOSClient,
  type RosRow,
  runPingOnRouter,
  syncHostWireGuardPeer,
  WG_SERVER_PORT,
  WG_SUBNET_PREFIX,
} from './src/server/routeros.ts';
import {
  applyFrequencyShift,
  computeTowerHealthScore,
  pollRfRadio,
  rebootRfRadio,
  scanMikroTikCleanFrequencies,
} from './src/server/rfTelemetry.ts';
import {
  estimateCpeDevicesFromMikroTik,
  fetchGenieAcsCpe,
  type GenieAcsConfig,
  proxyCpeHttpPage,
  pushGenieAcsTask,
} from './src/server/cpeManager.ts';
import { computeRscLineDiff, sendRadiusCoaOrDisconnect } from './src/server/radiusCoa.ts';
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
  CpeConnectedHost,
  CpeDeviceInfo,
  PortRole,
  RfProtocol,
  RfRadioDevice,
  RfStationClient,
  RfVendor,
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
  const subId = String(row.id);
  const cpeRow = db
    .prepare('SELECT connected_count, model FROM cpe_devices WHERE subscriber_id = ?')
    .get(subId) as { connected_count: number; model: string | null } | undefined;

  return {
    id: subId,
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
    graceExpiresAt: row.grace_expires_at ? String(row.grace_expires_at) : null,
    turboNightEnabled: Boolean(row.turbo_night_enabled),
    turboProfile: row.turbo_profile ? String(row.turbo_profile) : null,
    baseProfile: row.base_profile ? String(row.base_profile) : null,
    staticIpPool: row.static_ip_pool ? String(row.static_ip_pool) : null,
    rfRadioId: row.rf_radio_id ? String(row.rf_radio_id) : null,
    signalDbm: row.signal_dbm !== null && row.signal_dbm !== undefined ? Number(row.signal_dbm) : null,
    distanceKm: row.distance_km !== null && row.distance_km !== undefined ? Number(row.distance_km) : null,
    cpeConnectedCount: cpeRow ? Number(cpeRow.connected_count || 0) : 0,
    cpeModel: cpeRow?.model || null,
    towerId: row.tower_id ? String(row.tower_id) : null,
    lat: row.lat !== null && row.lat !== undefined ? Number(row.lat) : null,
    lng: row.lng !== null && row.lng !== undefined ? Number(row.lng) : null,
  };
}

function hydrateRfRadio(row: Record<string, unknown>): RfRadioDevice {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    routerId: row.router_id ? String(row.router_id) : null,
    towerId: row.tower_id ? String(row.tower_id) : null,
    name: String(row.name),
    host: String(row.host),
    vendor: String(row.vendor || 'mikrotik') as RfVendor,
    protocol: String(row.protocol || 'ros') as RfProtocol,
    port: Number(row.port || 8728),
    status: String(row.status || 'pending') as RfRadioDevice['status'],
    lastError: row.last_error ? String(row.last_error) : null,
    model: row.model ? String(row.model) : null,
    ssid: row.ssid ? String(row.ssid) : null,
    frequencyMhz: row.frequency_mhz !== null && row.frequency_mhz !== undefined ? Number(row.frequency_mhz) : null,
    channelWidthMhz: row.channel_width_mhz !== null && row.channel_width_mhz !== undefined ? Number(row.channel_width_mhz) : null,
    txPowerDbm: row.tx_power_dbm !== null && row.tx_power_dbm !== undefined ? Number(row.tx_power_dbm) : null,
    ccqPct: row.ccq_pct !== null && row.ccq_pct !== undefined ? Number(row.ccq_pct) : null,
    airtimePct: row.airtime_pct !== null && row.airtime_pct !== undefined ? Number(row.airtime_pct) : null,
    signalDbm: row.signal_dbm !== null && row.signal_dbm !== undefined ? Number(row.signal_dbm) : null,
    noiseFloorDbm: row.noise_floor_dbm !== null && row.noise_floor_dbm !== undefined ? Number(row.noise_floor_dbm) : null,
    snrDb: row.snr_db !== null && row.snr_db !== undefined ? Number(row.snr_db) : null,
    chain0Dbm: row.chain0_dbm !== null && row.chain0_dbm !== undefined ? Number(row.chain0_dbm) : null,
    chain1Dbm: row.chain1_dbm !== null && row.chain1_dbm !== undefined ? Number(row.chain1_dbm) : null,
    chainImbalanceDb: row.chain_imbalance_db !== null && row.chain_imbalance_db !== undefined ? Number(row.chain_imbalance_db) : null,
    txRateMbps: row.tx_rate_mbps !== null && row.tx_rate_mbps !== undefined ? Number(row.tx_rate_mbps) : null,
    rxRateMbps: row.rx_rate_mbps !== null && row.rx_rate_mbps !== undefined ? Number(row.rx_rate_mbps) : null,
    distanceKm: row.distance_km !== null && row.distance_km !== undefined ? Number(row.distance_km) : null,
    lanSpeed: row.lan_speed ? String(row.lan_speed) : null,
    clients: JSON.parse(String(row.clients_json || '[]')) as RfStationClient[],
    lastSync: row.last_sync ? String(row.last_sync) : null,
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

        // Session History Tracking (#57) & Flapping Alert (#51)
        if (prevSub.online === 0 && isOnline) {
          db.prepare(
            'INSERT INTO subscriber_sessions (owner_id, subscriber_id, ip, mac, login_at) VALUES (?, ?, ?, ?, ?)'
          ).run(ownerId, prevSub.id, ip, mac, nowIso);
        } else if (prevSub.online === 1 && !isOnline) {
          const openSess = db
            .prepare('SELECT id, login_at FROM subscriber_sessions WHERE subscriber_id = ? AND logout_at IS NULL ORDER BY id DESC LIMIT 1')
            .get(prevSub.id) as { id: number; login_at: string } | undefined;
          if (openSess) {
            const durSec = Math.max(1, Math.round((Date.now() - Date.parse(openSess.login_at)) / 1000));
            db.prepare(
              'UPDATE subscriber_sessions SET logout_at = ?, duration_sec = ?, disconnect_cause = ? WHERE id = ?'
            ).run(nowIso, durSec, 'PPPoE Link Lost', openSess.id);
          }
        }
        if (flapped && prevSub.flap_count_today + 1 === 10 && alertRules.enabled) {
          createAlert(
            ownerId,
            routerId,
            routerName,
            'warning',
            `انقطاع متكرر (Flapping): ${uname}`,
            `تجاوز المشترك ${uname} 10 انقطاعات اليوم — تحقق من سلك النانو أو الباور أو التشويش.`
          );
        }
      } else {
        const newSubId = `sub-${crypto.randomUUID()}`;
        db.prepare(`
          INSERT INTO subscribers (
            id, owner_id, router_id, router_name, username, full_name, area,
            ip, mac, mac_vendor, profile, disabled, uptime_text, uptime_seconds,
            online, live_rx_mbps, live_tx_mbps, billing_status, expires_in_days
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 30)
        `).run(
          newSubId,
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
        if (isOnline) {
          db.prepare(
            'INSERT INTO subscriber_sessions (owner_id, subscriber_id, ip, mac, login_at) VALUES (?, ?, ?, ?, ?)'
          ).run(ownerId, newSubId, ip, mac, nowIso);
        }
      }
    }

    // Continuous Latency Probe Matrix (#72) & Smart Failover Watchdog (#73)
    const probeTargets = [
      { target: '1.1.1.1', label: 'Cloudflare DNS' },
      { target: '8.8.8.8', label: 'Google DNS' },
    ];
    for (const pt of probeTargets) {
      try {
        const pr = await runPingViaContext(routerRow, pt.target);
        db.prepare(
          'INSERT INTO latency_probes (owner_id, router_id, target, label, latency_ms, packet_loss_pct, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(ownerId, routerId, pt.target, pt.label, pr.latencyMs, pr.packetLossPct, nowIso);
        if (pt.target === '1.1.1.1' && pr.packetLossPct >= 100 && alertRules.enabled) {
          db.prepare(
            'INSERT INTO failover_events (owner_id, router_id, router_name, from_gateway, to_gateway, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(ownerId, routerId, routerName, 'Primary WAN', 'Backup Monitor', 'فقدان 100% إلى 1.1.1.1 من داخل الراوتر', nowIso);
          createAlert(ownerId, routerId, routerName, 'critical', `فقدان إنترنت WAN: ${routerName}`, 'فشل الوصول إلى 1.1.1.1 بنسبة فقدان 100% من الراوتر.');
        }
      } catch {
        // Ignore transient probe errors
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
  allowedTowerIds?: string[];
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `bro_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${7 * 24 * 3600}`,
  ];
  if (isHttps) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', 'bro_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function extractAuthToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  const cookies = parseCookies(req.headers.cookie);
  return cookies.bro_session || null;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractAuthToken(req);
  if (!token) {
    res.status(401).json({ error: 'غير مصرح — يرجى تسجيل الدخول أولاً' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'انتهت صلاحية الجلسة، يرجى إعادة تسجيل الدخول' });
    return;
  }
  const userRow = db
    .prepare('SELECT allowed_tower_ids_json FROM users WHERE id = ?')
    .get(payload.sub) as { allowed_tower_ids_json?: string } | undefined;
  req.user = payload;
  req.allowedTowerIds =
    payload.role === 'admin'
      ? []
      : (JSON.parse(String(userRow?.allowed_tower_ids_json || '[]')) as string[]);
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

function canAccessTower(req: AuthedRequest, towerId: string | null | undefined): boolean {
  if (!req.allowedTowerIds || req.allowedTowerIds.length === 0) return true;
  if (!towerId) return false;
  return req.allowedTowerIds.includes(towerId);
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // =========================================================================
  // Auth (Real accounts + HttpOnly Cookie Session + RBAC)
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
    setSessionCookie(req, res, token);

    res.status(201).json({
      token,
      user: {
        id: userId,
        ownerId: userId,
        name: cleanName,
        email: cleanEmail,
        networkName: cleanNet,
        role: 'admin',
        allowedTowerIds: [],
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

    const allowedTowerIds = JSON.parse(String(row.allowed_tower_ids_json || '[]')) as string[];
    const token = signToken({
      sub: String(row.id),
      ownerId: String(row.owner_id),
      email: String(row.email),
      name: String(row.name),
      networkName: String(row.network_name),
      role: row.role as UserRole,
    });
    setSessionCookie(req, res, token);

    res.json({
      token,
      user: {
        id: String(row.id),
        ownerId: String(row.owner_id),
        name: String(row.name),
        email: String(row.email),
        networkName: String(row.network_name),
        role: row.role as UserRole,
        allowedTowerIds,
      },
    });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res: Response) => {
    const token = extractAuthToken(req) || '';
    res.json({
      token,
      user: {
        id: req.user!.sub,
        ownerId: req.user!.ownerId,
        name: req.user!.name,
        email: req.user!.email,
        networkName: req.user!.networkName,
        role: req.user!.role,
        allowedTowerIds: req.allowedTowerIds || [],
      },
    });
  });

  app.post('/api/auth/logout', (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // =========================================================================
  // Dashboard & Multi-tenant State (#86, #96 Per-Tower RBAC, #99 Tower Health)
  // =========================================================================
  app.get('/api/dashboard', requireAuth, (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;

    const routerRows = db
      .prepare('SELECT * FROM routers WHERE owner_id = ? ORDER BY created_at DESC')
      .all(ownerId) as Array<Record<string, unknown>>;
    const allSubRows = db
      .prepare('SELECT * FROM subscribers WHERE owner_id = ? ORDER BY username ASC')
      .all(ownerId) as Array<Record<string, unknown>>;
    const alertRows = db
      .prepare('SELECT * FROM alerts WHERE owner_id = ? ORDER BY created_at DESC LIMIT 60')
      .all(ownerId) as Array<Record<string, unknown>>;
    const allTowerRows = db
      .prepare('SELECT * FROM towers WHERE owner_id = ?')
      .all(ownerId) as Array<Record<string, unknown>>;
    const allRadioRows = db
      .prepare('SELECT * FROM rf_radios WHERE owner_id = ? ORDER BY created_at DESC')
      .all(ownerId) as Array<Record<string, unknown>>;
    const paymentRows = db
      .prepare('SELECT * FROM payments WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(ownerId) as Array<Record<string, unknown>>;
    const voucherRows = db
      .prepare('SELECT * FROM hotspot_vouchers WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(ownerId) as Array<Record<string, unknown>>;

    const subRows = allSubRows.filter((s) =>
      canAccessTower(req, s.tower_id ? String(s.tower_id) : null)
    );
    const towerRows = allTowerRows.filter((t) => canAccessTower(req, String(t.id)));
    const radioRows = allRadioRows.filter((r) =>
      canAccessTower(req, r.tower_id ? String(r.tower_id) : null)
    );

    const hydratedRadios = radioRows.map(hydrateRfRadio);
    const hydratedSubs = subRows.map(hydrateSubscriber);

    res.json({
      routers: routerRows.map(hydrateRouter),
      subscribers: hydratedSubs,
      rfRadios: hydratedRadios,
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
      towers: towerRows.map((t) => {
        const tid = String(t.id);
        const tRadios = hydratedRadios.filter((r) => r.towerId === tid);
        const tSubs = hydratedSubs.filter((s) => s.towerId === tid);
        return {
          id: tid,
          ownerId: String(t.owner_id),
          name: String(t.name),
          lat: Number(t.lat),
          lng: Number(t.lng),
          azimuthDeg: Number(t.azimuth_deg),
          beamwidthDeg: Number(t.beamwidth_deg),
          radiusMeters: Number(t.radius_meters),
          healthScore: computeTowerHealthScore({ radios: tRadios, subscribers: tSubs }),
          onlineRadios: tRadios.filter((r) => r.status === 'online').length,
          totalRadios: tRadios.length,
          onlineSubs: tSubs.filter((s) => s.online).length,
          totalSubs: tSubs.length,
        };
      }),
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

  // Live Read-Only Diagnostics from RouterOS API (#26, #35, #40, #45, #56, #66, #76, #77)
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
        pppAct,
        hsAct,
        queues,
        vlans,
        bridgePorts,
        ipPools,
        dhcpAlerts,
        ntpRows,
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
          ['/ppp/active/print'],
          ['/ip/hotspot/active/print'],
          ['/queue/simple/print'],
          ['/interface/vlan/print'],
          ['/interface/bridge/port/print'],
          ['/ip/pool/print'],
          ['/ip/dhcp-server/alert/print'],
          ['/system/ntp/client/print'],
          ['/interface/wireless/registration-table/print'],
          ['/ip/service/print'],
          ['/ip/dns/print'],
          ['/log/print'],
        ],
        true
      );

      // Detect ARP IP conflicts (#26)
      const ipToMacs = new Map<string, Set<string>>();
      for (const a of arp) {
        const ip = a.address || '';
        const mac = (a['mac-address'] || '').toUpperCase();
        if (!ip || !mac) continue;
        if (!ipToMacs.has(ip)) ipToMacs.set(ip, new Set());
        ipToMacs.get(ip)!.add(mac);
      }
      const arpConflicts = Array.from(ipToMacs.entries())
        .filter(([, macs]) => macs.size > 1)
        .map(([ip, macs]) => ({ ip, macs: Array.from(macs) }));

      // IP Pool usage computation (#56)
      const activeIps = [
        ...pppAct.map((p) => p.address || ''),
        ...dhcp.filter((d) => d.status === 'bound').map((d) => d.address || ''),
      ].filter(Boolean);

      const ipToNum = (ip: string): number => {
        const p = ip.split('.').map(Number);
        if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return 0;
        return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
      };

      const parsedPools = ipPools.slice(0, 30).map((p) => {
        const rangesStr = p.ranges || '';
        let totalApprox = 0;
        let usedCount = 0;
        for (const seg of rangesStr.split(',').map((s) => s.trim()).filter(Boolean)) {
          const [startStr, endStr] = seg.includes('-') ? seg.split('-') : [seg, seg];
          const sNum = ipToNum(startStr);
          const eNum = ipToNum(endStr || startStr);
          if (sNum > 0 && eNum >= sNum) {
            totalApprox += eNum - sNum + 1;
            for (const aip of activeIps) {
              const an = ipToNum(aip);
              if (an >= sNum && an <= eNum) usedCount++;
            }
          }
        }
        return { name: p.name || '', ranges: rangesStr, usedCount, totalApprox };
      });

      const dns0 = dns[0] || {};
      const ntp0 = ntpRows[0] || {};

      res.json({
        ipAddresses: ips.slice(0, 60).map((r) => ({
          address: r.address || '',
          network: r.network || '',
          iface: r.interface || '',
        })),
        routes: routes.slice(0, 60).map((r) => ({
          id: r['.id'] || '',
          dst: r['dst-address'] || '',
          gateway: r.gateway || '',
          distance: r.distance || '',
          active: r.active === 'true',
          disabled: r.disabled === 'true',
          comment: r.comment || '',
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
        arpConflicts,
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
        bridgePorts: bridgePorts.slice(0, 60).map((r) => ({
          iface: r.interface || '',
          bridge: r.bridge || '',
          pvid: r.pvid || '1',
          status: r.disabled === 'true' ? 'disabled' : r.inactive === 'true' ? 'inactive' : 'active',
        })),
        ipPools: parsedPools,
        rogueDhcpAlerts: dhcpAlerts.slice(0, 20).map((r) => ({
          iface: r.interface || '',
          mac: r['unknown-server-mac'] || r['mac-address'] || '',
          validServer: r['valid-server'] || '',
          time: r['alert-timeout'] || '',
        })),
        ntpStatus: {
          enabled: ntp0.enabled === 'true',
          servers: ntp0.servers || ntp0['primary-ntp'] || 'غير محدد',
          status: ntp0.status || (ntp0.enabled === 'true' ? 'active' : 'disabled'),
          syncedServer: ntp0['synced-server'] || '',
        },
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
        logs: logs.slice(-120).reverse().map((r) => ({
          time: r.time || '',
          topics: r.topics || '',
          message: r.message || '',
        })),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'تعذر قراءة التشخيصات من الراوتر' });
    }
  });

  // =========================================================================
  // Deep MikroTik Control: PoE Cycle (#33), Torch (#36), Upgrade (#39), BTest (#43),
  // NTP (#45), Multi-WAN (#66), Latency Matrix (#72,#73), Diff (#74), DNS Flush (#77),
  // Traceroute (#79), Dual-WG (#80), Security Audit (#88)
  // =========================================================================
  app.post(
    '/api/routers/:id/poe/:portName/cycle',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'الراوتر غير موجود' });
        return;
      }
      if (row.permission_mode !== 'full-control') {
        res.status(403).json({ error: 'إعادة تشغيل PoE تتطلب صلاحية التحكم الكامل' });
        return;
      }
      const portName = String(req.params.portName || '').replace(/[^a-zA-Z0-9._-]/g, '');
      try {
        await execCommandsOnRouter(row, [
          ['/interface/ethernet/poe/set', `=numbers=${portName}`, '=poe-out=off'],
        ]);
        await new Promise((r) => setTimeout(r, 1500));
        await execCommandsOnRouter(row, [
          ['/interface/ethernet/poe/set', `=numbers=${portName}`, '=poe-out=auto-on'],
        ]);
        addAuditLog(req.user!.ownerId, req.user!.name, req.user!.role, 'إعادة تشغيل PoE-Out', `${row.name} · ${portName}`);
        res.json({ ok: true, message: `تم فصل وإعادة تشغيل الطاقة على ${portName}` });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'فشل التحكم بـ PoE على هذا المنفذ' });
      }
    }
  );

  app.post('/api/routers/:id/torch', requireAuth, async (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
    if (!row || row.status !== 'online') {
      res.status(400).json({ error: 'يجب أن يكون الراوتر متصلاً لتشغيل Torch' });
      return;
    }
    const iface = String((req.body as { iface?: string }).iface || 'ether1').replace(/[^a-zA-Z0-9._-]/g, '');
    try {
      const [rows] = await execCommandsOnRouter(row, [
        ['/tool/torch', `=interface=${iface}`, '=duration=2', '=port=any'],
      ]);
      res.json({ iface, entries: parseTorchRows(rows) });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'تعذر تشغيل Torch على الواجهة المطلوبة' });
    }
  });

  app.post('/api/routers/:id/traceroute', requireAuth, async (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
    if (!row || row.status !== 'online') {
      res.status(400).json({ error: 'الراوتر غير متصل حالياً' });
      return;
    }
    const target = String((req.body as { target?: string }).target || '1.1.1.1').trim();
    if (!isValidHost(target)) {
      res.status(400).json({ error: 'الهدف غير صالح' });
      return;
    }
    try {
      const [hops] = await execCommandsOnRouter(row, [
        ['/tool/traceroute', `=address=${target}`, '=count=2'],
      ]);
      res.json({
        target,
        hops: hops.map((h, i) => ({
          hop: i + 1,
          address: h.address || '*',
          lossPct: Number(h.loss || 0),
          avgMs: h.avg || h.last || '-',
        })),
      });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'تعذر تنفيذ Traceroute' });
    }
  });

  app.post(
    '/api/routers/:id/bandwidth-test',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
      if (!row || row.status !== 'online') {
        res.status(400).json({ error: 'الراوتر غير متصل حالياً' });
        return;
      }
      const { target, direction = 'both', protocol = 'tcp' } = req.body as Record<string, unknown>;
      if (typeof target !== 'string' || !isValidHost(target)) {
        res.status(400).json({ error: 'أدخل عنوان IPv4 صالح للراوتر المقابل' });
        return;
      }
      const dir = direction === 'receive' || direction === 'transmit' ? direction : 'both';
      const proto = protocol === 'udp' ? 'udp' : 'tcp';
      try {
        const [rows] = await execCommandsOnRouter(row, [
          ['/tool/bandwidth-test', `=address=${target.trim()}`, `=direction=${dir}`, `=protocol=${proto}`, '=duration=3s'],
        ]);
        const last = rows[rows.length - 1] || {};
        res.json({
          target: target.trim(),
          rxMbps: Number((Number(last['rx-current'] || last['rx-10-second-average'] || 0) / 1e6).toFixed(2)),
          txMbps: Number((Number(last['tx-current'] || last['tx-10-second-average'] || 0) / 1e6).toFixed(2)),
          status: last.status || 'completed',
        });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'فشل اختبار Bandwidth-Test — تأكد من تفعيل BTest Server في الطرف المقابل' });
      }
    }
  );

  app.post(
    '/api/routers/:id/dns/flush',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
      if (!row || row.permission_mode !== 'full-control') {
        res.status(403).json({ error: 'تصفير كاش DNS يتطلب صلاحية التحكم الكامل' });
        return;
      }
      try {
        await execCommandsOnRouter(row, [['/ip/dns/cache/flush']]);
        addAuditLog(req.user!.ownerId, req.user!.name, req.user!.role, 'تصفير كاش DNS', String(row.name));
        res.json({ ok: true, message: 'تم مسح كاش DNS على الراوتر بنجاح' });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'فشل مسح كاش DNS' });
      }
    }
  );

  app.post(
    '/api/routers/:id/ntp/sync',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
      if (!row || row.permission_mode !== 'full-control') {
        res.status(403).json({ error: 'ضبط NTP يتطلب صلاحية التحكم الكامل' });
        return;
      }
      try {
        await execCommandsOnRouter(row, [
          ['/system/ntp/client/set', '=enabled=yes', '=servers=pool.ntp.org,time.cloudflare.com'],
        ]);
        addAuditLog(req.user!.ownerId, req.user!.name, req.user!.role, 'مزامنة ساعة NTP', String(row.name));
        res.json({ ok: true, message: 'تم تفعيل ومزامنة التوقيت NTP بنجاح' });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'تعذر ضبط NTP على الراوتر' });
      }
    }
  );

  app.post(
    '/api/routers/:id/upgrade',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthedRequest, res: Response) => {
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
      if (!row || row.permission_mode !== 'full-control') {
        res.status(403).json({ error: 'الترقية عن بُعد تتطلب صلاحية التحكم الكامل' });
        return;
      }
      const mode = (req.body as { mode?: string }).mode || 'check';
      try {
        if (mode === 'routerboard') {
          await execCommandsOnRouter(row, [['/system/routerboard/upgrade']]);
          addAuditLog(req.user!.ownerId, req.user!.name, req.user!.role, 'ترقية Firmware اللوحة', String(row.name));
          res.json({ ok: true, message: 'تم جدولة ترقية RouterBOOT Firmware (ستطبق عند إعادة التشغيل)' });
          return;
        }
        if (mode === 'install') {
          await execCommandsOnRouter(row, [['/system/package/update/download-and-install']]);
          addAuditLog(req.user!.ownerId, req.user!.name, req.user!.role, 'تحديث RouterOS', String(row.name));
          res.json({ ok: true, message: 'بدأ تنزيل وتثبيت تحديث RouterOS الآن' });
          return;
        }
        const [rows] = await execCommandsOnRouter(row, [['/system/package/update/check-for-updates']]);
        const last = rows[rows.length - 1] || {};
        res.json({
          ok: true,
          installedVersion: last['installed-version'] || row.routeros_version,
          latestVersion: last['latest-version'] || row.routeros_version,
          status: last.status || 'checked',
        });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'فشل التحقق أو الترقية على الراوتر' });
      }
    }
  );

  app.post(
    '/api/routers/bulk-upgrade',
    requireAuth,
    requireRole(['admin']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const rows = db
        .prepare("SELECT * FROM routers WHERE owner_id = ? AND status = 'online' AND permission_mode = 'full-control'")
        .all(ownerId) as Array<Record<string, unknown>>;
      const results: Array<{ id: string; name: string; status: string }> = [];
      for (const r of rows) {
        try {
          const [upd] = await execCommandsOnRouter(r, [['/system/package/update/check-for-updates']]);
          const last = upd[upd.length - 1] || {};
          results.push({ id: String(r.id), name: String(r.name), status: last.status || 'checked' });
        } catch {
          results.push({ id: String(r.id), name: String(r.name), status: 'unreachable' });
        }
      }
      res.json({ results });
    }
  );

  app.get('/api/routers/:id/config-diffs', requireAuth, (req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare('SELECT id, router_id, summary, added_count, removed_count, diff_lines_json, created_at FROM config_diffs WHERE router_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 15')
      .all(req.params.id, req.user!.ownerId) as Array<Record<string, unknown>>;
    res.json({
      diffs: rows.map((d) => ({
        id: String(d.id),
        routerId: String(d.router_id),
        summary: String(d.summary),
        addedCount: Number(d.added_count),
        removedCount: Number(d.removed_count),
        diffLines: JSON.parse(String(d.diff_lines_json || '[]')),
        createdAt: String(d.created_at),
      })),
    });
  });

  app.post(
    '/api/routers/:id/config-diffs',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!row || row.status !== 'online') {
        res.status(400).json({ error: 'الراوتر غير متصل' });
        return;
      }
      try {
        const [ips, routes, fw, vlans, svcs, profs] = await execCommandsOnRouter(
          row,
          [
            ['/ip/address/print'],
            ['/ip/route/print'],
            ['/ip/firewall/filter/print'],
            ['/interface/vlan/print'],
            ['/ip/service/print'],
            ['/ppp/profile/print'],
          ],
          true
        );
        const lines: string[] = [
          ...ips.map((r) => `/ip address add address=${r.address} interface=${r.interface}`),
          ...routes.map((r) => `/ip route add dst-address=${r['dst-address']} gateway=${r.gateway} distance=${r.distance || 1} disabled=${r.disabled || 'no'}`),
          ...vlans.map((r) => `/interface vlan add name=${r.name} vlan-id=${r['vlan-id']} interface=${r.interface}`),
          ...svcs.map((r) => `/ip service set ${r.name} port=${r.port} disabled=${r.disabled || 'no'} address=${r.address || '0.0.0.0/0'}`),
          ...profs.map((r) => `/ppp profile add name=${r.name} rate-limit=${r['rate-limit'] || ''}`),
          ...fw.slice(0, 60).map((r) => `/ip firewall filter add chain=${r.chain} action=${r.action} dst-port=${r['dst-port'] || ''} protocol=${r.protocol || ''} disabled=${r.disabled || 'no'}`),
        ];
        const rawText = lines.join('\n');
        const prev = db
          .prepare('SELECT raw_rsc FROM config_diffs WHERE router_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1')
          .get(req.params.id, ownerId) as { raw_rsc: string } | undefined;
        const diff = computeRscLineDiff(prev?.raw_rsc || '', rawText);
        const id = `dif-${crypto.randomUUID()}`;
        const nowIso = new Date().toISOString();
        const summary = prev
          ? `+${diff.addedCount} سطر مضاف / -${diff.removedCount} سطر محذوف`
          : `لقطة خط الأساس (${lines.length} سطر إعداد)`;
        db.prepare(
          'INSERT INTO config_diffs (id, owner_id, router_id, summary, added_count, removed_count, raw_rsc, diff_lines_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, ownerId, req.params.id, summary, diff.addedCount, diff.removedCount, rawText, JSON.stringify(diff.diffLines), nowIso);
        addAuditLog(ownerId, req.user!.name, req.user!.role, 'مقارنة إعدادات .rsc', `${row.name}: ${summary}`);
        res.status(201).json({ id, summary, addedCount: diff.addedCount, removedCount: diff.removedCount, diffLines: diff.diffLines, createdAt: nowIso });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'تعذر قراءة لقطة الإعدادات من الراوتر' });
      }
    }
  );

  app.get('/api/routers/:id/security-audit', requireAuth, async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const row = db
      .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
    if (!row || row.status !== 'online') {
      res.status(400).json({ error: 'الراوتر غير متصل حالياً' });
      return;
    }
    try {
      const [services, users, fw] = await execCommandsOnRouter(
        row,
        [['/ip/service/print'], ['/user/print'], ['/ip/firewall/filter/print']],
        true
      );
      const metaKey = `ros_users_${req.params.id}`;
      const knownRow = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(metaKey) as { value: string } | undefined;
      const prevKnownAdminNames = knownRow ? (JSON.parse(knownRow.value) as string[]) : [];
      const audit = evaluateRouterSecurity({ services, users, firewallInput: fw, prevKnownAdminNames });
      db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
        metaKey,
        JSON.stringify(audit.adminUsers.map((u) => u.name).filter(Boolean))
      );
      if (audit.newAdminUsersDetected.length > 0) {
        createAlert(
          ownerId,
          String(row.id),
          String(row.name),
          'critical',
          `تحذير أمني: مستخدم إدارة جديد على ${row.name}`,
          `تم رصد إنشاء حساب جديدة (${audit.newAdminUsersDetected.join(', ')}) داخل /user`
        );
      }
      res.json(audit);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'فشل تدقيق أمان الراوتر' });
    }
  });

  app.get('/api/routers/:id/latency', requireAuth, (req: AuthedRequest, res: Response) => {
    const probes = db
      .prepare('SELECT * FROM latency_probes WHERE router_id = ? AND owner_id = ? ORDER BY id DESC LIMIT 60')
      .all(req.params.id, req.user!.ownerId) as Array<Record<string, unknown>>;
    const failovers = db
      .prepare('SELECT * FROM failover_events WHERE router_id = ? AND owner_id = ? ORDER BY id DESC LIMIT 30')
      .all(req.params.id, req.user!.ownerId) as Array<Record<string, unknown>>;
    res.json({
      probes: probes.map((p) => ({
        id: Number(p.id),
        routerId: String(p.router_id),
        target: String(p.target),
        label: String(p.label),
        latencyMs: p.latency_ms !== null ? Number(p.latency_ms) : null,
        packetLossPct: Number(p.packet_loss_pct || 0),
        recordedAt: String(p.recorded_at),
      })),
      failovers: failovers.map((f) => ({
        id: Number(f.id),
        routerId: String(f.router_id),
        routerName: String(f.router_name),
        fromGateway: String(f.from_gateway),
        toGateway: String(f.to_gateway),
        reason: String(f.reason),
        createdAt: String(f.created_at),
      })),
    });
  });

  app.post('/api/routers/:id/latency/probe', requireAuth, async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const row = db
      .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
    if (!row || row.status !== 'online') {
      res.status(400).json({ error: 'الراوتر غير متصل' });
      return;
    }
    const targets = [
      { target: '1.1.1.1', label: 'Cloudflare DNS' },
      { target: '8.8.8.8', label: 'Google DNS' },
      { target: '9.9.9.9', label: 'Quad9 DNS' },
    ];
    const nowIso = new Date().toISOString();
    const out = [];
    for (const pt of targets) {
      const pr = await runPingViaContext(row, pt.target).catch(() => ({
        status: 'down' as const,
        latencyMs: null,
        packetLossPct: 100,
      }));
      db.prepare(
        'INSERT INTO latency_probes (owner_id, router_id, target, label, latency_ms, packet_loss_pct, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(ownerId, String(row.id), pt.target, pt.label, pr.latencyMs, pr.packetLossPct, nowIso);
      out.push({ ...pt, ...pr, recordedAt: nowIso });
    }
    res.json({ results: out });
  });

  app.post(
    '/api/routers/:id/routes/toggle',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const row = db
        .prepare('SELECT * FROM routers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
      if (!row || row.permission_mode !== 'full-control') {
        res.status(403).json({ error: 'التحكم بالمسارات يتطلب صلاحية التحكم الكامل' });
        return;
      }
      const { routeId, disabled, distance, comment } = req.body as Record<string, unknown>;
      if (typeof routeId !== 'string' || !routeId) {
        res.status(400).json({ error: 'معرف المسار غير صالح' });
        return;
      }
      const args = ['/ip/route/set', `=.id=${routeId}`];
      if (typeof disabled === 'boolean') args.push(`=disabled=${disabled ? 'yes' : 'no'}`);
      if (typeof distance === 'number' && distance > 0) args.push(`=distance=${Math.round(distance)}`);
      try {
        await execCommandsOnRouter(row, [args]);
        if (typeof disabled === 'boolean') {
          db.prepare(
            'INSERT INTO failover_events (owner_id, router_id, router_name, from_gateway, to_gateway, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(
            req.user!.ownerId,
            String(row.id),
            String(row.name),
            String(comment || routeId),
            disabled ? 'تم تعطيل المسار يدوياً' : 'تم تفعيل المسار يدوياً',
            `تبديل يدوي عبر Bro Radius (${req.user!.name})`,
            new Date().toISOString()
          );
        }
        addAuditLog(req.user!.ownerId, req.user!.name, req.user!.role, 'تعديل مسار Multi-WAN', `${row.name} (${routeId})`);
        res.json({ ok: true });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'فشل تعديل المسار' });
      }
    }
  );

  app.post('/api/routers/:id/dual-wg-script', requireAuth, async (req: AuthedRequest, res: Response) => {
    const wgCtx = await getOwnerWgContext(req.user!.ownerId);
    const { secondaryEndpoint, secondaryPort = 51821 } = req.body as Record<string, unknown>;
    const endpoint = typeof secondaryEndpoint === 'string' && secondaryEndpoint.trim() ? secondaryEndpoint.trim() : wgCtx.endpoint || 'YOUR_BACKUP_VPS_IP';
    res.json({
      script: buildDualHomedWireGuardScript({
        secondaryEndpoint: endpoint,
        secondaryPort: Number(secondaryPort) || 51821,
        serverPublicKey: wgCtx.wgPublicKey,
      }),
    });
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
  // RF & Wireless Sector/Nano Telemetry (#1-#8, #10, #13-#15)
  // =========================================================================
  async function performRfSync(radioRow: Record<string, unknown>): Promise<RfRadioDevice> {
    const radioId = String(radioRow.id);
    const ownerId = String(radioRow.owner_id);
    const name = String(radioRow.name);
    const vendor = String(radioRow.vendor || 'mikrotik') as RfVendor;
    const protocol = String(radioRow.protocol || 'ros') as RfProtocol;
    const host = String(radioRow.host);
    const port = Number(radioRow.port || 8728);
    const username = String(radioRow.username || 'admin');
    const secret = radioRow.secret_enc ? decryptSecret(String(radioRow.secret_enc)) : '';
    const nowIso = new Date().toISOString();

    try {
      const snap = await pollRfRadio({ host, vendor, protocol, port, username, secret });
      // Correlate RF station MACs to PPPoE Subscribers (#10)
      const subs = db
        .prepare('SELECT id, username, mac FROM subscribers WHERE owner_id = ?')
        .all(ownerId) as Array<{ id: string; username: string; mac: string }>;
      const subByMac = new Map(subs.filter((s) => s.mac).map((s) => [s.mac.toUpperCase(), s]));

      const enrichedClients = snap.clients.map((c) => {
        const matched = subByMac.get(c.mac.toUpperCase());
        if (matched) {
          db.prepare('UPDATE subscribers SET rf_radio_id = ?, signal_dbm = COALESCE(?, signal_dbm), distance_km = COALESCE(?, distance_km) WHERE id = ?').run(
            radioId,
            c.signalDbm,
            c.distanceKm ?? null,
            matched.id
          );
        }
        return {
          ...c,
          subscriberId: matched?.id ?? null,
          subscriberUsername: matched?.username ?? null,
        };
      });

      db.prepare(`
        UPDATE rf_radios SET
          status = 'online', last_error = NULL, model = ?, ssid = ?,
          frequency_mhz = ?, channel_width_mhz = ?, tx_power_dbm = ?,
          ccq_pct = ?, airtime_pct = ?, signal_dbm = ?, noise_floor_dbm = ?, snr_db = ?,
          chain0_dbm = ?, chain1_dbm = ?, chain_imbalance_db = ?,
          tx_rate_mbps = ?, rx_rate_mbps = ?, distance_km = ?, lan_speed = ?,
          clients_json = ?, last_sync = ?
        WHERE id = ?
      `).run(
        snap.model, snap.ssid, snap.frequencyMhz, snap.channelWidthMhz, snap.txPowerDbm,
        snap.ccqPct, snap.airtimePct, snap.signalDbm, snap.noiseFloorDbm, snap.snrDb,
        snap.chain0Dbm, snap.chain1Dbm, snap.chainImbalanceDb,
        snap.txRateMbps, snap.rxRateMbps, snap.distanceKm, snap.lanSpeed,
        JSON.stringify(enrichedClients), nowIso, radioId
      );

      db.prepare(
        'INSERT INTO rf_signal_history (radio_id, signal_dbm, noise_floor_dbm, ccq_pct, airtime_pct, recorded_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(radioId, snap.signalDbm, snap.noiseFloorDbm, snap.ccqPct, snap.airtimePct, nowIso);

      // RF Smart Alerts (#5, #6, #7, #15)
      if (snap.chainImbalanceDb !== null && snap.chainImbalanceDb > 6) {
        createAlert(ownerId, radioId, name, 'warning', `عدم تطابق استقطاب Chain: ${name}`, `الفرق بين H/V بلغ ${snap.chainImbalanceDb}dB — يرجى فحص توجيه الصحن أو الـ Pigtail.`);
      }
      if (snap.noiseFloorDbm !== null && snap.noiseFloorDbm > -85) {
        createAlert(ownerId, radioId, name, 'warning', `تشويش RF مرتفع: ${name}`, `مستوى الضجيج ${snap.noiseFloorDbm}dBm تجاوز الحد الموصى به (-85dBm).`);
      }
      if (snap.ccqPct !== null && snap.ccqPct < 75) {
        createAlert(ownerId, radioId, name, 'warning', `انخفاض كفاءة CCQ: ${name}`, `نسبة CCQ هبطت إلى ${snap.ccqPct}% على تردد ${snap.frequencyMhz || '-'} MHz.`);
      }
      if (snap.lanSpeed === '10M') {
        createAlert(ownerId, radioId, name, 'critical', `كبل LAN تالف (10M): ${name}`, `تفاوض منفذ الإيثرنت على الجهاز نزل إلى 10M بدلاً من 1G/100M!`);
      }

      const updated = db.prepare('SELECT * FROM rf_radios WHERE id = ?').get(radioId) as Record<string, unknown>;
      return hydrateRfRadio(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'تعذر قراءة بيانات الراديو اللاسلكي';
      db.prepare("UPDATE rf_radios SET status = 'offline', last_error = ? WHERE id = ?").run(msg, radioId);
      throw new Error(msg);
    }
  }

  app.get('/api/rf/radios', requireAuth, (req: AuthedRequest, res: Response) => {
    const rows = db
      .prepare('SELECT * FROM rf_radios WHERE owner_id = ? ORDER BY created_at DESC')
      .all(req.user!.ownerId) as Array<Record<string, unknown>>;
    res.json({
      radios: rows
        .filter((r) => canAccessTower(req, r.tower_id ? String(r.tower_id) : null))
        .map(hydrateRfRadio),
    });
  });

  app.post(
    '/api/rf/radios',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const { name, host, vendor = 'mikrotik', protocol = 'ros', port, username = 'admin', secret = '', towerId = null, routerId = null } =
        req.body as Record<string, unknown>;
      if (typeof name !== 'string' || typeof host !== 'string' || !name.trim() || !isValidHost(host)) {
        res.status(400).json({ error: 'يرجى إدخال اسم الراديو وعنوان IP أو Host صحيح' });
        return;
      }
      const v: RfVendor = ['mikrotik', 'ubiquiti', 'mimosa', 'cambium'].includes(String(vendor))
        ? (vendor as RfVendor)
        : 'mikrotik';
      const p: RfProtocol = ['ros', 'snmp', 'airos'].includes(String(protocol))
        ? (protocol as RfProtocol)
        : 'ros';
      const defaultPort = p === 'snmp' ? 161 : p === 'airos' ? 443 : 8728;
      const numPort = Number(port) || defaultPort;
      const id = `rf-${crypto.randomUUID()}`;
      const nowIso = new Date().toISOString();

      db.prepare(`
        INSERT INTO rf_radios (id, owner_id, router_id, tower_id, name, host, vendor, protocol, port, username, secret_enc, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        id,
        ownerId,
        typeof routerId === 'string' && routerId ? routerId : null,
        typeof towerId === 'string' && towerId ? towerId : null,
        name.trim().slice(0, 48),
        host.trim(),
        v,
        p,
        numPort,
        typeof username === 'string' ? username.trim() : 'admin',
        typeof secret === 'string' && secret ? encryptSecret(secret) : '',
        nowIso
      );

      const createdRow = db.prepare('SELECT * FROM rf_radios WHERE id = ?').get(id) as Record<string, unknown>;
      try {
        const synced = await performRfSync(createdRow);
        addAuditLog(ownerId, req.user!.name, req.user!.role, 'إضافة جهاز بث RF', `${name.trim()} (${host.trim()})`);
        res.status(201).json({ radio: synced });
      } catch {
        const fallback = db.prepare('SELECT * FROM rf_radios WHERE id = ?').get(id) as Record<string, unknown>;
        res.status(201).json({ radio: hydrateRfRadio(fallback) });
      }
    }
  );

  app.post('/api/rf/radios/:id/sync', requireAuth, async (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare('SELECT * FROM rf_radios WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'الجهاز غير موجود' });
      return;
    }
    try {
      const radio = await performRfSync(row);
      res.json({ radio });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'فشل سحب بيانات الإشارة' });
    }
  });

  app.get('/api/rf/radios/:id/history', requireAuth, (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare('SELECT id FROM rf_radios WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.user!.ownerId);
    if (!row) {
      res.status(404).json({ error: 'الجهاز غير موجود' });
      return;
    }
    const samples = db
      .prepare('SELECT * FROM rf_signal_history WHERE radio_id = ? ORDER BY id DESC LIMIT 120')
      .all(req.params.id) as Array<Record<string, unknown>>;
    res.json({
      samples: samples.reverse().map((s) => ({
        id: Number(s.id),
        radioId: String(s.radio_id),
        signalDbm: s.signal_dbm !== null ? Number(s.signal_dbm) : null,
        noiseFloorDbm: s.noise_floor_dbm !== null ? Number(s.noise_floor_dbm) : null,
        ccqPct: s.ccq_pct !== null ? Number(s.ccq_pct) : null,
        airtimePct: s.airtime_pct !== null ? Number(s.airtime_pct) : null,
        recordedAt: String(s.recorded_at),
      })),
    });
  });

  app.post('/api/rf/radios/:id/scan', requireAuth, async (req: AuthedRequest, res: Response) => {
    const row = db
      .prepare('SELECT * FROM rf_radios WHERE id = ? AND owner_id = ?')
      .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'الجهاز غير موجود' });
      return;
    }
    if (row.protocol !== 'ros') {
      res.status(400).json({ error: 'فحص الترددات النظيفة (Frequency Monitor) متاح لأجهزة MikroTik عبر RouterOS API' });
      return;
    }
    try {
      const channels = await scanMikroTikCleanFrequencies(
        String(row.host),
        Number(row.port || 8728),
        String(row.username || 'admin'),
        row.secret_enc ? decryptSecret(String(row.secret_enc)) : ''
      );
      res.json({ channels });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'فشل مسح الطيف الترددي' });
    }
  });

  app.post(
    '/api/rf/radios/:id/frequency',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const row = db
        .prepare('SELECT * FROM rf_radios WHERE id = ? AND owner_id = ?')
        .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
      if (!row || row.protocol !== 'ros') {
        res.status(400).json({ error: 'تغيير التردد يتطلب جهاز MikroTik عبر RouterOS API' });
        return;
      }
      const { frequencyMhz, scheduleTime } = req.body as Record<string, unknown>;
      try {
        await applyFrequencyShift({
          host: String(row.host),
          port: Number(row.port || 8728),
          username: String(row.username || 'admin'),
          password: row.secret_enc ? decryptSecret(String(row.secret_enc)) : '',
          frequencyMhz: Number(frequencyMhz),
          scheduleTime: typeof scheduleTime === 'string' && scheduleTime.trim() ? scheduleTime.trim() : undefined,
        });
        addAuditLog(req.user!.ownerId, req.user!.name, req.user!.role, 'تغيير/جدولة التردد', `${row.name} -> ${frequencyMhz} MHz`);
        res.json({ ok: true, message: scheduleTime ? `تمت جدولة التحويل إلى ${frequencyMhz}MHz عند ${scheduleTime}` : `تم التحويل الفوري إلى ${frequencyMhz}MHz` });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'تعذر تعديل التردد' });
      }
    }
  );

  app.post(
    '/api/rf/radios/:id/reboot',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const row = db
        .prepare('SELECT * FROM rf_radios WHERE id = ? AND owner_id = ?')
        .get(req.params.id, req.user!.ownerId) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'الجهاز غير موجود' });
        return;
      }
      try {
        await rebootRfRadio({
          host: String(row.host),
          protocol: String(row.protocol) as RfProtocol,
          port: Number(row.port || 8728),
          username: String(row.username || 'admin'),
          secret: row.secret_enc ? decryptSecret(String(row.secret_enc)) : '',
        });
        addAuditLog(req.user!.ownerId, req.user!.name, req.user!.role, 'إعادة تشغيل جهاز RF', String(row.name));
        res.json({ ok: true, message: `تم إرسال أمر إعادة التشغيل إلى ${row.name}` });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'تعذر إعادة تشغيل الجهاز' });
      }
    }
  );

  app.delete(
    '/api/rf/radios/:id',
    requireAuth,
    requireRole(['admin', 'technician']),
    (req: AuthedRequest, res: Response) => {
      db.prepare('DELETE FROM rf_radios WHERE id = ? AND owner_id = ?').run(req.params.id, req.user!.ownerId);
      res.json({ deleted: true });
    }
  );

  // =========================================================================
  // Subscribers CPE (TR-069 / MikroTik Conntrack / HTTP Proxy) + CoA + Sessions (#16-#30, #46, #48, #54, #57)
  // =========================================================================
  function getOwnerGenieAcsConfig(ownerId: string): GenieAcsConfig | null {
    const row = db
      .prepare('SELECT genieacs_url, genieacs_user, genieacs_pass_enc FROM notification_settings WHERE owner_id = ?')
      .get(ownerId) as { genieacs_url?: string; genieacs_user?: string; genieacs_pass_enc?: string } | undefined;
    if (!row?.genieacs_url) return null;
    return {
      url: row.genieacs_url,
      username: row.genieacs_user || undefined,
      password: row.genieacs_pass_enc ? decryptSecret(row.genieacs_pass_enc) : undefined,
    };
  }

  function hydrateCpeDevice(subRow: Record<string, unknown>): CpeDeviceInfo {
    const subId = String(subRow.id);
    const c = db.prepare('SELECT * FROM cpe_devices WHERE subscriber_id = ?').get(subId) as Record<string, unknown> | undefined;
    if (!c) {
      return {
        subscriberId: subId,
        source: 'unconfigured',
        tr069DeviceId: null,
        cpeHost: subRow.ip ? String(subRow.ip) : null,
        cpePort: 80,
        model: null,
        serialNumber: null,
        firmware: null,
        uptimeSec: null,
        cpuPct: null,
        ramPct: null,
        wanIp: subRow.ip ? String(subRow.ip) : null,
        wifiSsid24: null,
        wifiChannel24: null,
        wifiSsid5: null,
        wifiChannel5: null,
        connectedCount: 0,
        connectedHosts: [],
        tr143DownMbps: null,
        tr143UpMbps: null,
        lastSyncedAt: null,
        hasConfigBackup: false,
      };
    }
    return {
      subscriberId: subId,
      source: String(c.source || 'unconfigured') as CpeDeviceInfo['source'],
      tr069DeviceId: c.tr069_device_id ? String(c.tr069_device_id) : null,
      cpeHost: c.cpe_host ? String(c.cpe_host) : subRow.ip ? String(subRow.ip) : null,
      cpePort: Number(c.cpe_port || 80),
      model: c.model ? String(c.model) : null,
      serialNumber: c.serial_number ? String(c.serial_number) : null,
      firmware: c.firmware ? String(c.firmware) : null,
      uptimeSec: c.uptime_sec !== null && c.uptime_sec !== undefined ? Number(c.uptime_sec) : null,
      cpuPct: c.cpu_pct !== null && c.cpu_pct !== undefined ? Number(c.cpu_pct) : null,
      ramPct: c.ram_pct !== null && c.ram_pct !== undefined ? Number(c.ram_pct) : null,
      wanIp: c.wan_ip ? String(c.wan_ip) : null,
      wifiSsid24: c.wifi_ssid_24 ? String(c.wifi_ssid_24) : null,
      wifiChannel24: c.wifi_channel_24 ? String(c.wifi_channel_24) : null,
      wifiSsid5: c.wifi_ssid_5 ? String(c.wifi_ssid_5) : null,
      wifiChannel5: c.wifi_channel_5 ? String(c.wifi_channel_5) : null,
      connectedCount: Number(c.connected_count || 0),
      connectedHosts: JSON.parse(String(c.connected_hosts_json || '[]')) as CpeConnectedHost[],
      tr143DownMbps: c.tr143_down_mbps !== null && c.tr143_down_mbps !== undefined ? Number(c.tr143_down_mbps) : null,
      tr143UpMbps: c.tr143_up_mbps !== null && c.tr143_up_mbps !== undefined ? Number(c.tr143_up_mbps) : null,
      lastSyncedAt: c.last_synced_at ? String(c.last_synced_at) : null,
      hasConfigBackup: Boolean(c.last_config_backup_json),
    };
  }

  app.get('/api/subscribers/:id/cpe', requireAuth, (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const sub = db
      .prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
    if (!sub || !canAccessTower(req, sub.tower_id ? String(sub.tower_id) : null)) {
      res.status(404).json({ error: 'المشترك غير موجود أو خارج نطاق برجك' });
      return;
    }
    const sessions = db
      .prepare('SELECT * FROM subscriber_sessions WHERE subscriber_id = ? ORDER BY id DESC LIMIT 50')
      .all(req.params.id) as Array<Record<string, unknown>>;

    res.json({
      cpe: hydrateCpeDevice(sub),
      sessions: sessions.map((s) => ({
        id: Number(s.id),
        subscriberId: String(s.subscriber_id),
        ip: String(s.ip || ''),
        mac: String(s.mac || ''),
        loginAt: String(s.login_at),
        logoutAt: s.logout_at ? String(s.logout_at) : null,
        durationSec: Number(s.duration_sec || 0),
        rxGb: Number(s.rx_gb || 0),
        txGb: Number(s.tx_gb || 0),
        disconnectCause: String(s.disconnect_cause || ''),
      })),
    });
  });

  app.patch(
    '/api/subscribers/:id/cpe/config',
    requireAuth,
    requireRole(['admin', 'technician']),
    (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const sub = db
        .prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!sub || !canAccessTower(req, sub.tower_id ? String(sub.tower_id) : null)) {
        res.status(404).json({ error: 'المشترك غير موجود' });
        return;
      }
      const { tr069DeviceId, cpeHost, cpePort = 80, cpeUser = '', cpePass = '' } = req.body as Record<string, unknown>;
      db.prepare('INSERT OR IGNORE INTO cpe_devices (subscriber_id, owner_id) VALUES (?, ?)').run(req.params.id, ownerId);
      db.prepare(`
        UPDATE cpe_devices SET
          tr069_device_id = COALESCE(?, tr069_device_id),
          cpe_host = COALESCE(?, cpe_host),
          cpe_port = COALESCE(?, cpe_port),
          cpe_user = COALESCE(?, cpe_user),
          cpe_pass_enc = CASE WHEN ? != '' THEN ? ELSE cpe_pass_enc END
        WHERE subscriber_id = ?
      `).run(
        typeof tr069DeviceId === 'string' ? tr069DeviceId.trim() : null,
        typeof cpeHost === 'string' ? cpeHost.trim() : null,
        Number(cpePort) || 80,
        typeof cpeUser === 'string' ? cpeUser.trim() : null,
        typeof cpePass === 'string' && cpePass ? encryptSecret(cpePass) : '',
        typeof cpePass === 'string' && cpePass ? encryptSecret(cpePass) : '',
        req.params.id
      );
      res.json({ cpe: hydrateCpeDevice(sub) });
    }
  );

  app.post('/api/subscribers/:id/cpe/sync', requireAuth, async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const sub = db
      .prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
    if (!sub || !canAccessTower(req, sub.tower_id ? String(sub.tower_id) : null)) {
      res.status(404).json({ error: 'المشترك غير موجود' });
      return;
    }

    const nowIso = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO cpe_devices (subscriber_id, owner_id) VALUES (?, ?)').run(req.params.id, ownerId);
    const existingCpe = db.prepare('SELECT * FROM cpe_devices WHERE subscriber_id = ?').get(req.params.id) as Record<string, unknown>;

    // Try GenieACS TR-069 first if configured (#18)
    const genieCfg = getOwnerGenieAcsConfig(ownerId);
    let genieMatched = false;
    if (genieCfg) {
      try {
        const gRes = await fetchGenieAcsCpe(genieCfg, {
          deviceId: existingCpe.tr069_device_id ? String(existingCpe.tr069_device_id) : null,
          wanIp: sub.ip ? String(sub.ip) : null,
          mac: sub.mac ? String(sub.mac) : null,
        });
        if (gRes) {
          genieMatched = true;
          db.prepare(`
            UPDATE cpe_devices SET
              source = 'genieacs', tr069_device_id = ?, model = ?, serial_number = ?, firmware = ?,
              uptime_sec = ?, cpu_pct = ?, ram_pct = ?, wan_ip = ?,
              wifi_ssid_24 = ?, wifi_channel_24 = ?, wifi_ssid_5 = ?, wifi_channel_5 = ?,
              connected_count = ?, connected_hosts_json = ?, tr143_down_mbps = ?, tr143_up_mbps = ?,
              last_synced_at = ?
            WHERE subscriber_id = ?
          `).run(
            gRes.tr069DeviceId, gRes.model, gRes.serialNumber, gRes.firmware,
            gRes.uptimeSec, gRes.cpuPct, gRes.ramPct, gRes.wanIp,
            gRes.wifiSsid24, gRes.wifiChannel24, gRes.wifiSsid5, gRes.wifiChannel5,
            gRes.connectedHosts.length, JSON.stringify(gRes.connectedHosts), gRes.tr143DownMbps, gRes.tr143UpMbps,
            nowIso, req.params.id
          );
        }
      } catch {
        // Fallback to MikroTik Conntrack estimator (#20)
      }
    }

    let pingRes: { status: 'up' | 'down'; latencyMs: number | null; packetLossPct: number } | null = null;
    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(String(sub.router_id)) as Record<string, unknown> | undefined;
    if (router && router.status === 'online') {
      if (sub.ip) {
        pingRes = await runPingViaContext(router, String(sub.ip)).catch(() => null);
      }
      if (!genieMatched) {
        try {
          const [conns, arpRows, dhcpRows] = await execCommandsOnRouter(
            router,
            [['/ip/firewall/connection/print'], ['/ip/arp/print'], ['/ip/dhcp-server/lease/print']],
            true
          );
          const est = estimateCpeDevicesFromMikroTik({
            subscriberIp: String(sub.ip || ''),
            subscriberMac: String(sub.mac || ''),
            conns,
            arpRows,
            dhcpRows,
          });
          db.prepare(`
            UPDATE cpe_devices SET
              source = 'mikrotik_conntrack', model = COALESCE(model, ?), wan_ip = ?,
              connected_count = ?, connected_hosts_json = ?, last_synced_at = ?
            WHERE subscriber_id = ?
          `).run(
            `${String(sub.mac_vendor || 'Home CPE')} (تقدير Conntrack)`,
            String(sub.ip || ''),
            est.connectedCount,
            JSON.stringify(est.connectedHosts),
            nowIso,
            req.params.id
          );
        } catch {
          // Leave existing state
        }
      }
    }

    res.json({ cpe: hydrateCpeDevice(sub), ping: pingRes });
  });

  app.post(
    '/api/subscribers/:id/cpe/wifi',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const sub = db
        .prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!sub || !canAccessTower(req, sub.tower_id ? String(sub.tower_id) : null)) {
        res.status(404).json({ error: 'المشترك غير موجود' });
        return;
      }
      const cpe = db.prepare('SELECT tr069_device_id FROM cpe_devices WHERE subscriber_id = ?').get(req.params.id) as { tr069_device_id?: string } | undefined;
      const genieCfg = getOwnerGenieAcsConfig(ownerId);
      if (!genieCfg || !cpe?.tr069_device_id) {
        res.status(400).json({ error: 'تعديل Wi-Fi عن بُعد يتطلب ربط سيرفر GenieACS (TR-069) بالمشترك' });
        return;
      }
      const { ssid24, password24, channel24, ssid5, password5, channel5 } = req.body as Record<string, unknown>;
      const paramValues: Array<[string, string | number, string]> = [];
      if (typeof ssid24 === 'string' && ssid24.trim()) {
        paramValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', ssid24.trim(), 'xsd:string']);
      }
      if (typeof password24 === 'string' && password24.length >= 8) {
        paramValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase', password24, 'xsd:string']);
      }
      if (typeof channel24 === 'string' && channel24.trim()) {
        paramValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel', Number(channel24) || 6, 'xsd:unsignedInt']);
      }
      if (typeof ssid5 === 'string' && ssid5.trim()) {
        paramValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID', ssid5.trim(), 'xsd:string']);
      }
      if (typeof password5 === 'string' && password5.length >= 8) {
        paramValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase', password5, 'xsd:string']);
      }
      if (typeof channel5 === 'string' && channel5.trim()) {
        paramValues.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Channel', Number(channel5) || 36, 'xsd:unsignedInt']);
      }
      try {
        await pushGenieAcsTask(genieCfg, cpe.tr069_device_id, {
          name: 'setParameterValues',
          parameterValues: paramValues,
        });
        db.prepare(
          'UPDATE cpe_devices SET wifi_ssid_24 = COALESCE(?, wifi_ssid_24), wifi_channel_24 = COALESCE(?, wifi_channel_24), wifi_ssid_5 = COALESCE(?, wifi_ssid_5), wifi_channel_5 = COALESCE(?, wifi_channel_5) WHERE subscriber_id = ?'
        ).run(
          typeof ssid24 === 'string' && ssid24.trim() ? ssid24.trim() : null,
          typeof channel24 === 'string' && channel24.trim() ? channel24.trim() : null,
          typeof ssid5 === 'string' && ssid5.trim() ? ssid5.trim() : null,
          typeof channel5 === 'string' && channel5.trim() ? channel5.trim() : null,
          req.params.id
        );
        addAuditLog(ownerId, req.user!.name, req.user!.role, 'تعديل Wi-Fi لراوتر المشترك', String(sub.username));
        res.json({ ok: true, message: 'تم إرسال إعدادات الواي فاي لراوتر المشترك عبر TR-069' });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'فشل دفع إعدادات Wi-Fi عبر GenieACS' });
      }
    }
  );

  app.post(
    '/api/subscribers/:id/cpe/reboot',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const sub = db
        .prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?')
        .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      const cpe = db.prepare('SELECT tr069_device_id FROM cpe_devices WHERE subscriber_id = ?').get(req.params.id) as { tr069_device_id?: string } | undefined;
      const genieCfg = getOwnerGenieAcsConfig(ownerId);
      if (!sub || !genieCfg || !cpe?.tr069_device_id) {
        res.status(400).json({ error: 'إعادة تشغيل الراوتر المنزلي تتطلب ربط TR-069 GenieACS' });
        return;
      }
      try {
        await pushGenieAcsTask(genieCfg, cpe.tr069_device_id, { name: 'reboot' });
        addAuditLog(ownerId, req.user!.name, req.user!.role, 'إعادة تشغيل CPE المنزلي', String(sub.username));
        res.json({ ok: true, message: 'تم إرسال أمر إعادة تشغيل راوتر المشترك (TR-069 Reboot)' });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'فشل إرسال Reboot إلى GenieACS' });
      }
    }
  );

  app.post('/api/subscribers/:id/cpe/speedtest', requireAuth, async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const cpe = db.prepare('SELECT tr069_device_id FROM cpe_devices WHERE subscriber_id = ?').get(req.params.id) as { tr069_device_id?: string } | undefined;
    const genieCfg = getOwnerGenieAcsConfig(ownerId);
    if (!genieCfg || !cpe?.tr069_device_id) {
      res.status(400).json({ error: 'فحص TR-143 الفعلي يتطلب ربط راوتر المشترك بـ GenieACS' });
      return;
    }
    const testUrl = typeof (req.body as { testUrl?: string }).testUrl === 'string' && (req.body as { testUrl?: string }).testUrl!.trim()
      ? (req.body as { testUrl?: string }).testUrl!.trim()
      : 'http://speedtest.tele2.net/10MB.zip';
    try {
      await pushGenieAcsTask(genieCfg, cpe.tr069_device_id, {
        name: 'setParameterValues',
        parameterValues: [
          ['InternetGatewayDevice.DownloadDiagnostics.DownloadURL', testUrl, 'xsd:string'],
          ['InternetGatewayDevice.DownloadDiagnostics.DiagnosticsState', 'Requested', 'xsd:string'],
        ],
      });
      res.json({ ok: true, message: 'بدأ فحص سرعة TR-143 من راوتر المشترك — اضغط مزامنة بعد 10 ثواني لقراءة النتيجة.' });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'فشل إطلاق اختبار TR-143' });
    }
  });

  app.post(
    '/api/subscribers/:id/cpe/block-mac',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const sub = db.prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?').get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!sub) {
        res.status(404).json({ error: 'المشترك غير موجود' });
        return;
      }
      const { mac, block = true } = req.body as Record<string, unknown>;
      if (typeof mac !== 'string' || !mac.trim()) {
        res.status(400).json({ error: 'أدخل عنوان MAC صحيح' });
        return;
      }
      const cpe = db.prepare('SELECT tr069_device_id FROM cpe_devices WHERE subscriber_id = ?').get(req.params.id) as { tr069_device_id?: string } | undefined;
      const genieCfg = getOwnerGenieAcsConfig(ownerId);
      if (genieCfg && cpe?.tr069_device_id) {
        await pushGenieAcsTask(genieCfg, cpe.tr069_device_id, {
          name: 'setParameterValues',
          parameterValues: [
            ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.MACAddressControlEnabled', block ? true : false, 'xsd:boolean'],
          ],
        }).catch(() => undefined);
      }
      addAuditLog(ownerId, req.user!.name, req.user!.role, block ? 'حظر جهاز فرعي MAC' : 'رفع حظر MAC', `${sub.username} (${mac})`);
      res.json({ ok: true, message: `تم إرسال طلب ${block ? 'حظر' : 'فك حظر'} العنوان ${mac}` });
    }
  );

  app.post('/api/subscribers/:id/cpe/backup', requireAuth, async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const sub = db.prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?').get(req.params.id, ownerId) as Record<string, unknown> | undefined;
    if (!sub) {
      res.status(404).json({ error: 'المشترك غير موجود' });
      return;
    }
    const cpe = db.prepare('SELECT * FROM cpe_devices WHERE subscriber_id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    const backupObj = {
      savedAt: new Date().toISOString(),
      model: cpe?.model || 'Home CPE',
      wanIp: cpe?.wan_ip || sub.ip,
      wifiSsid24: cpe?.wifi_ssid_24 || null,
      wifiChannel24: cpe?.wifi_channel_24 || null,
      wifiSsid5: cpe?.wifi_ssid_5 || null,
      wifiChannel5: cpe?.wifi_channel_5 || null,
      pppoeUsername: sub.username,
    };
    db.prepare('INSERT OR IGNORE INTO cpe_devices (subscriber_id, owner_id) VALUES (?, ?)').run(req.params.id, ownerId);
    db.prepare('UPDATE cpe_devices SET last_config_backup_json = ? WHERE subscriber_id = ?').run(JSON.stringify(backupObj), req.params.id);
    addAuditLog(ownerId, req.user!.name, req.user!.role, 'حفظ نسخة إعدادات CPE', String(sub.username));
    res.json({ ok: true, backup: backupObj });
  });

  app.post('/api/subscribers/:id/cpe/restore', requireAuth, requireRole(['admin', 'technician']), async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const cpe = db.prepare('SELECT tr069_device_id, last_config_backup_json FROM cpe_devices WHERE subscriber_id = ? AND owner_id = ?').get(req.params.id, ownerId) as { tr069_device_id?: string; last_config_backup_json?: string } | undefined;
    if (!cpe?.last_config_backup_json) {
      res.status(400).json({ error: 'لا توجد نسخة إعدادات محفوظة لهذا المشترك بعد' });
      return;
    }
    const genieCfg = getOwnerGenieAcsConfig(ownerId);
    const bak = JSON.parse(cpe.last_config_backup_json) as Record<string, unknown>;
    if (genieCfg && cpe.tr069_device_id && bak.wifiSsid24) {
      await pushGenieAcsTask(genieCfg, cpe.tr069_device_id, {
        name: 'setParameterValues',
        parameterValues: [
          ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', String(bak.wifiSsid24), 'xsd:string'],
        ],
      }).catch(() => undefined);
    }
    res.json({ ok: true, message: 'تمت استعادة الإعدادات المحفوظة من النسخة الاحتياطية.' });
  });

  app.get('/api/subscribers/:id/cpe-proxy', requireAuth, async (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const sub = db
      .prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?')
      .get(req.params.id, ownerId) as Record<string, unknown> | undefined;
    if (!sub || !canAccessTower(req, sub.tower_id ? String(sub.tower_id) : null)) {
      res.status(404).json({ error: 'المشترك غير موجود' });
      return;
    }
    const cpe = db.prepare('SELECT cpe_host, cpe_port FROM cpe_devices WHERE subscriber_id = ?').get(req.params.id) as { cpe_host?: string; cpe_port?: number } | undefined;
    const host = (cpe?.cpe_host || String(sub.ip || '')).trim();
    if (!host) {
      res.status(400).json({ error: 'لا يوجد عنوان IP نشط لراوتر المشترك' });
      return;
    }
    try {
      const page = await proxyCpeHttpPage({
        host,
        port: Number(cpe?.cpe_port || 80),
        subPath: typeof req.query.path === 'string' ? req.query.path : '/',
      });
      res.setHeader('Content-Type', page.contentType);
      res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' http: https:; frame-ancestors 'self'");
      res.status(page.statusCode).send(page.body);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'تعذر فتح واجهة راوتر المشترك' });
    }
  });

  // RADIUS CoA / Disconnect (RFC 5176 UDP 3799 + MikroTik API fallback) (#46)
  app.post(
    '/api/subscribers/:id/coa',
    requireAuth,
    requireRole(['admin', 'technician']),
    async (req: AuthedRequest, res: Response) => {
      const ownerId = req.user!.ownerId;
      const sub = db.prepare('SELECT * FROM subscribers WHERE id = ? AND owner_id = ?').get(req.params.id, ownerId) as Record<string, unknown> | undefined;
      if (!sub || !canAccessTower(req, sub.tower_id ? String(sub.tower_id) : null)) {
        res.status(404).json({ error: 'المشترك غير موجود' });
        return;
      }
      const { action = 'disconnect', rateLimit = '' } = req.body as Record<string, unknown>;
      const notif = db
        .prepare('SELECT radius_host, radius_coa_port, radius_secret_enc FROM notification_settings WHERE owner_id = ?')
        .get(ownerId) as { radius_host?: string; radius_coa_port?: number; radius_secret_enc?: string } | undefined;
      const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(String(sub.router_id)) as Record<string, unknown>;

      if (notif?.radius_secret_enc && (notif.radius_host || router?.api_host)) {
        try {
          const result = await sendRadiusCoaOrDisconnect({
            nasHost: notif.radius_host || String(router.api_host),
            port: Number(notif.radius_coa_port || 3799),
            secret: decryptSecret(notif.radius_secret_enc),
            username: String(sub.username),
            action: action === 'coa-rate-limit' ? 'coa-rate-limit' : 'disconnect',
            rateLimit: typeof rateLimit === 'string' && rateLimit.trim() ? rateLimit.trim() : undefined,
          });
          addAuditLog(ownerId, req.user!.name, req.user!.role, 'إرسال RADIUS CoA', `${sub.username} (${action})`);
          res.json(result);
          return;
        } catch {
          // Fall through to direct RouterOS API control if NAS UDP CoA unreachable
        }
      }

      if (router && router.status === 'online' && router.permission_mode === 'full-control') {
        try {
          const [activeRows] = await execCommandsOnRouter(router, [['/ppp/active/print', `?name=${sub.username}`]]);
          const removeCmds = activeRows.filter((r) => r['.id']).map((r) => ['/ppp/active/remove', `=.id=${r['.id']}`]);
          if (removeCmds.length > 0) await execCommandsOnRouter(router, removeCmds);
          addAuditLog(ownerId, req.user!.name, req.user!.role, 'فصل مباشر بدلاً من CoA', String(sub.username));
          res.json({ acked: true, responseCode: 41, message: 'تم فصل الجلسة مباشرة عبر RouterOS API لتطبيق الباقة الجديدة' });
          return;
        } catch (err) {
          res.status(502).json({ error: err instanceof Error ? err.message : 'فشل فصل الجلسة' });
          return;
        }
      }

      res.status(400).json({ error: 'يرجى تفعيل سر RADIUS CoA في الإعدادات أو ربط الراوتر بصلاحية التحكم الكامل' });
    }
  );

  // =========================================================================
  // Subscribers: Real Session Disconnect, Profile Change, Billing, Payments, CSV (#44-#59)
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
      if (!sub || !canAccessTower(req, sub.tower_id ? String(sub.tower_id) : null)) {
        res.status(404).json({ error: 'المشترك غير موجود أو خارج صلاحيتك' });
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
      if (!sub || !canAccessTower(req, sub.tower_id ? String(sub.tower_id) : null)) {
        res.status(404).json({ error: 'المشترك غير موجود أو خارج نطاق برجك' });
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
        turboNightEnabled,
        turboProfile,
        baseProfile,
        staticIpPool,
        towerId,
        lat,
        lng,
      } = req.body as Record<string, unknown>;

      // If profile, disabled, or staticIpPool changed, apply on real MikroTik router (#48, #56, #58)
      if (typeof profile === 'string' || typeof disabled === 'boolean' || typeof staticIpPool === 'string') {
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
              if (typeof staticIpPool === 'string' && isValidIpv4(staticIpPool)) {
                args.push(`=remote-address=${staticIpPool.trim()}`);
              }
              await execCommandsOnRouter(router, [args]);
            }
          } catch (err) {
            res.status(502).json({ error: err instanceof Error ? err.message : 'فشل تطبيق التعديل على المايكروتك' });
            return;
          }
        }
      }

      const nextGraceExpiresAt =
        typeof graceHours === 'number' && graceHours > 0
          ? new Date(Date.now() + graceHours * 3600 * 1000).toISOString()
          : graceHours === null
            ? null
            : undefined;

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
          grace_expires_at = CASE WHEN ? = 1 THEN ? ELSE grace_expires_at END,
          profile = COALESCE(?, profile),
          disabled = COALESCE(?, disabled),
          turbo_night_enabled = COALESCE(?, turbo_night_enabled),
          turbo_profile = COALESCE(?, turbo_profile),
          base_profile = COALESCE(?, base_profile),
          static_ip_pool = COALESCE(?, static_ip_pool),
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
        nextGraceExpiresAt !== undefined ? 1 : 0,
        nextGraceExpiresAt ?? null,
        typeof profile === 'string' ? profile.trim() : null,
        typeof disabled === 'boolean' ? (disabled ? 1 : 0) : null,
        typeof turboNightEnabled === 'boolean' ? (turboNightEnabled ? 1 : 0) : null,
        typeof turboProfile === 'string' ? turboProfile.trim() : null,
        typeof baseProfile === 'string' ? baseProfile.trim() : null,
        typeof staticIpPool === 'string' ? staticIpPool.trim() : null,
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
  // RBAC Team Members (#84, #96), Telegram/Push, GenieACS (#18), RADIUS CoA (#46), Night Turbo (#54)
  // =========================================================================
  app.get('/api/settings', requireAuth, (req: AuthedRequest, res: Response) => {
    const ownerId = req.user!.ownerId;
    const notif = db
      .prepare('SELECT * FROM notification_settings WHERE owner_id = ?')
      .get(ownerId) as Record<string, unknown> | undefined;
    const members = db
      .prepare('SELECT id, name, email, role, allowed_tower_ids_json, created_at FROM users WHERE owner_id = ? ORDER BY created_at ASC')
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
        turboNightEnabled: Boolean(notif?.turbo_night_enabled),
        turboStartHour: notif?.turbo_start_hour !== undefined ? Number(notif.turbo_start_hour) : 1,
        turboEndHour: notif?.turbo_end_hour !== undefined ? Number(notif.turbo_end_hour) : 7,
        turboDefaultProfile: String(notif?.turbo_default_profile || ''),
        genieacsUrl: String(notif?.genieacs_url || ''),
        genieacsUser: String(notif?.genieacs_user || ''),
        hasGenieacsPass: Boolean(notif?.genieacs_pass_enc),
        radiusHost: String(notif?.radius_host || ''),
        radiusCoaPort: notif?.radius_coa_port !== undefined ? Number(notif.radius_coa_port) : 3799,
        hasRadiusSecret: Boolean(notif?.radius_secret_enc),
      },
      teamMembers: members.map((m) => ({
        id: String(m.id),
        name: String(m.name),
        email: String(m.email),
        role: m.role,
        allowedTowerIds: JSON.parse(String(m.allowed_tower_ids_json || '[]')) as string[],
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
      const { name, email, password, role, allowedTowerIds = [] } = req.body as Record<string, unknown>;
      if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
        res.status(400).json({ error: 'يرجى تعبئة الاسم والبريد الإلكتروني وكلمة المرور' });
        return;
      }
      const validRoles: UserRole[] = ['admin', 'accountant', 'technician', 'viewer'];
      const chosenRole: UserRole = validRoles.includes(role as UserRole) ? (role as UserRole) : 'viewer';
      const towersList = Array.isArray(allowedTowerIds) ? allowedTowerIds.filter((t): t is string => typeof t === 'string') : [];
      const cleanEmail = email.trim().toLowerCase();
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail)) {
        res.status(409).json({ error: 'هذا البريد الإلكتروني مسجل مسبقاً' });
        return;
      }
      const id = `usr-${crypto.randomUUID()}`;
      const salt = crypto.randomBytes(16).toString('hex');
      const nowIso = new Date().toISOString();
      db.prepare(
        'INSERT INTO users (id, owner_id, name, email, network_name, role, allowed_tower_ids_json, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, ownerId, name.trim(), cleanEmail, req.user!.networkName, chosenRole, JSON.stringify(towersList), hashPassword(password, salt), salt, nowIso);
      addAuditLog(ownerId, req.user!.name, req.user!.role, 'إضافة عضو فريق', `${name.trim()} (${chosenRole})`);
      res.status(201).json({ member: { id, name: name.trim(), email: cleanEmail, role: chosenRole, allowedTowerIds: towersList, createdAt: nowIso } });
    }
  );

  app.patch('/api/team/:id/towers', requireAuth, requireRole(['admin']), (req: AuthedRequest, res: Response) => {
    const allowedTowerIds = Array.isArray((req.body as { allowedTowerIds?: unknown }).allowedTowerIds)
      ? ((req.body as { allowedTowerIds: unknown[] }).allowedTowerIds.filter((t): t is string => typeof t === 'string'))
      : [];
    db.prepare('UPDATE users SET allowed_tower_ids_json = ? WHERE id = ? AND owner_id = ?').run(
      JSON.stringify(allowedTowerIds),
      req.params.id,
      req.user!.ownerId
    );
    res.json({ ok: true, allowedTowerIds });
  });

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
    const {
      webPushEnabled,
      telegramEnabled,
      telegramBotToken,
      telegramChatId,
      dailyDigestEnabled,
      turboNightEnabled,
      turboStartHour,
      turboEndHour,
      turboDefaultProfile,
      genieacsUrl,
      genieacsUser,
      genieacsPass,
      radiusHost,
      radiusCoaPort,
      radiusSecret,
    } = req.body as Record<string, unknown>;

    db.prepare('INSERT OR IGNORE INTO notification_settings (owner_id) VALUES (?)').run(ownerId);
    const cur = db
      .prepare('SELECT * FROM notification_settings WHERE owner_id = ?')
      .get(ownerId) as Record<string, unknown>;

    const nextTokenEnc =
      typeof telegramBotToken === 'string' && telegramBotToken.trim()
        ? encryptSecret(telegramBotToken.trim())
        : String(cur.telegram_bot_token_enc || '');

    const nextGeniePassEnc =
      typeof genieacsPass === 'string' && genieacsPass.trim()
        ? encryptSecret(genieacsPass.trim())
        : String(cur.genieacs_pass_enc || '');

    const nextRadiusSecretEnc =
      typeof radiusSecret === 'string' && radiusSecret.trim()
        ? encryptSecret(radiusSecret.trim())
        : String(cur.radius_secret_enc || '');

    db.prepare(`
      UPDATE notification_settings SET
        web_push_enabled = ?,
        telegram_enabled = ?,
        telegram_bot_token_enc = ?,
        telegram_chat_id = ?,
        daily_digest_enabled = ?,
        turbo_night_enabled = ?,
        turbo_start_hour = ?,
        turbo_end_hour = ?,
        turbo_default_profile = ?,
        genieacs_url = ?,
        genieacs_user = ?,
        genieacs_pass_enc = ?,
        radius_host = ?,
        radius_coa_port = ?,
        radius_secret_enc = ?
      WHERE owner_id = ?
    `).run(
      typeof webPushEnabled === 'boolean' ? (webPushEnabled ? 1 : 0) : Number(cur.web_push_enabled),
      typeof telegramEnabled === 'boolean' ? (telegramEnabled ? 1 : 0) : Number(cur.telegram_enabled),
      nextTokenEnc,
      typeof telegramChatId === 'string' ? telegramChatId.trim() : String(cur.telegram_chat_id || ''),
      typeof dailyDigestEnabled === 'boolean' ? (dailyDigestEnabled ? 1 : 0) : Number(cur.daily_digest_enabled),
      typeof turboNightEnabled === 'boolean' ? (turboNightEnabled ? 1 : 0) : Number(cur.turbo_night_enabled || 0),
      typeof turboStartHour === 'number' ? Math.max(0, Math.min(23, Math.round(turboStartHour))) : Number(cur.turbo_start_hour ?? 1),
      typeof turboEndHour === 'number' ? Math.max(0, Math.min(23, Math.round(turboEndHour))) : Number(cur.turbo_end_hour ?? 7),
      typeof turboDefaultProfile === 'string' ? turboDefaultProfile.trim() : String(cur.turbo_default_profile || ''),
      typeof genieacsUrl === 'string' ? genieacsUrl.trim() : String(cur.genieacs_url || ''),
      typeof genieacsUser === 'string' ? genieacsUser.trim() : String(cur.genieacs_user || ''),
      nextGeniePassEnc,
      typeof radiusHost === 'string' ? radiusHost.trim() : String(cur.radius_host || ''),
      typeof radiusCoaPort === 'number' ? Number(radiusCoaPort) : Number(cur.radius_coa_port ?? 3799),
      nextRadiusSecretEnc,
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

  // Background Poller Worker every 60s (#87, #48 Auto-Grace, #54 Night Turbo, #13 RF History) + Retention Cleanup (#90)
  setInterval(() => {
    const activeRouters = db
      .prepare("SELECT * FROM routers WHERE status != 'pending' AND connection_type != 'agent'")
      .all() as Array<Record<string, unknown>>;
    for (const r of activeRouters) {
      void performRealRouterSync(r).catch(() => {
        // Error already persisted in router row & alert
      });
    }

    // 1. Poll online RF Radios (#13)
    const activeRadios = db
      .prepare("SELECT * FROM rf_radios WHERE status != 'offline'")
      .all() as Array<Record<string, unknown>>;
    for (const rad of activeRadios) {
      void performRfSync(rad).catch(() => undefined);
    }

    // 2. Auto-disable expired Grace Period subscribers (#48)
    const nowIso = new Date().toISOString();
    const expiredGraceSubs = db
      .prepare('SELECT * FROM subscribers WHERE grace_expires_at IS NOT NULL AND grace_expires_at <= ? AND disabled = 0')
      .all(nowIso) as Array<Record<string, unknown>>;
    for (const s of expiredGraceSubs) {
      const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(String(s.router_id)) as Record<string, unknown> | undefined;
      if (router && router.status === 'online' && router.permission_mode === 'full-control') {
        void (async () => {
          const [secrets] = await execCommandsOnRouter(router, [['/ppp/secret/print', `?name=${s.username}`]]).catch(() => [[]]);
          if (secrets[0]?.['.id']) {
            await execCommandsOnRouter(router, [['/ppp/secret/set', `=.id=${secrets[0]['.id']}`, '=disabled=yes']]).catch(() => undefined);
          }
          const [act] = await execCommandsOnRouter(router, [['/ppp/active/print', `?name=${s.username}`]]).catch(() => [[]]);
          const rmCmds = act.filter((a) => a['.id']).map((a) => ['/ppp/active/remove', `=.id=${a['.id']}`]);
          if (rmCmds.length > 0) await execCommandsOnRouter(router, rmCmds).catch(() => undefined);
        })();
      }
      db.prepare("UPDATE subscribers SET disabled = 1, billing_status = 'expired', grace_expires_at = NULL WHERE id = ?").run(String(s.id));
      createAlert(String(s.owner_id), String(s.router_id), String(s.router_name), 'warning', `انتهاء السلفة المؤقتة: ${s.username}`, 'انتهت مهلة التمديد التلقائية وتم إيقاف الاشتراك.');
    }

    // 3. Automated Night Turbo Speed Boost Scheduler (#54)
    const curHour = new Date().getHours();
    const turboOwners = db
      .prepare('SELECT owner_id, turbo_night_enabled, turbo_start_hour, turbo_end_hour, turbo_default_profile FROM notification_settings WHERE turbo_night_enabled = 1')
      .all() as Array<{ owner_id: string; turbo_start_hour: number; turbo_end_hour: number; turbo_default_profile: string }>;
    for (const cfg of turboOwners) {
      const start = cfg.turbo_start_hour;
      const end = cfg.turbo_end_hour;
      const inWindow = start <= end ? curHour >= start && curHour < end : curHour >= start || curHour < end;
      const subs = db
        .prepare('SELECT * FROM subscribers WHERE owner_id = ? AND turbo_night_enabled = 1 AND disabled = 0')
        .all(cfg.owner_id) as Array<Record<string, unknown>>;
      for (const s of subs) {
        const targetTurbo = String(s.turbo_profile || cfg.turbo_default_profile || '');
        const baseProf = String(s.base_profile || s.profile || '');
        if (!targetTurbo || !baseProf) continue;
        const desiredProfile = inWindow ? targetTurbo : baseProf;
        if (String(s.profile) !== desiredProfile) {
          const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(String(s.router_id)) as Record<string, unknown> | undefined;
          if (router && router.status === 'online' && router.permission_mode === 'full-control') {
            void (async () => {
              const [secrets] = await execCommandsOnRouter(router, [['/ppp/secret/print', `?name=${s.username}`]]).catch(() => [[]]);
              if (secrets[0]?.['.id']) {
                await execCommandsOnRouter(router, [['/ppp/secret/set', `=.id=${secrets[0]['.id']}`, `=profile=${desiredProfile}`]]).catch(() => undefined);
                db.prepare('UPDATE subscribers SET profile = ?, base_profile = ? WHERE id = ?').run(desiredProfile, baseProf, String(s.id));
              }
            })();
          }
        }
      }
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
