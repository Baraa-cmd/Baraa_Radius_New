import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.BRO_RADIUS_DB_PATH || path.resolve(process.cwd(), 'bro-radius.db');

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    network_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS routers (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    connection_type TEXT NOT NULL,
    permission_mode TEXT NOT NULL,
    api_host TEXT NOT NULL,
    api_port INTEGER NOT NULL DEFAULT 8728,
    api_username TEXT NOT NULL,
    api_password_enc TEXT NOT NULL,
    tunnel_ip TEXT NOT NULL,
    wireguard_port INTEGER NOT NULL,
    wireguard_public_key TEXT NOT NULL,
    wireguard_private_key_enc TEXT NOT NULL,
    latest_handshake_at TEXT,
    tunnel_rtt_ms REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT,
    identity TEXT,
    model TEXT,
    board_name TEXT,
    serial_number TEXT,
    routeros_version TEXT,
    firmware_version TEXT,
    upgrade_firmware TEXT,
    architecture TEXT,
    cpu_cores INTEGER,
    cpu_core_loads_json TEXT NOT NULL DEFAULT '[]',
    ram_total_mb REAL,
    voltage REAL,
    fan_rpm_json TEXT NOT NULL DEFAULT '[]',
    active_connections INTEGER,
    uptime_text TEXT,
    cpu_percent INTEGER,
    ram_percent INTEGER,
    temp_celsius INTEGER,
    pppoe_online INTEGER NOT NULL DEFAULT 0,
    pppoe_secrets_count INTEGER NOT NULL DEFAULT 0,
    hotspot_online INTEGER NOT NULL DEFAULT 0,
    dhcp_leases_count INTEGER NOT NULL DEFAULT 0,
    neighbors_count INTEGER NOT NULL DEFAULT 0,
    current_rx_mbps REAL NOT NULL DEFAULT 0,
    current_tx_mbps REAL NOT NULL DEFAULT 0,
    traffic_history_json TEXT NOT NULL DEFAULT '[]',
    daily_traffic_json TEXT NOT NULL DEFAULT '[]',
    ports_json TEXT NOT NULL DEFAULT '[]',
    neighbors_json TEXT NOT NULL DEFAULT '[]',
    alert_rules_json TEXT NOT NULL,
    last_sync TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS port_traffic_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    router_id TEXT NOT NULL,
    port_name TEXT NOT NULL,
    rx_mbps REAL NOT NULL,
    tx_mbps REAL NOT NULL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY(router_id) REFERENCES routers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS port_disconnects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    router_id TEXT NOT NULL,
    port_name TEXT NOT NULL,
    disconnected_at TEXT NOT NULL,
    recovered_at TEXT,
    duration_seconds INTEGER,
    FOREIGN KEY(router_id) REFERENCES routers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS monitored_devices (
    id TEXT PRIMARY KEY,
    router_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    sector_group TEXT NOT NULL DEFAULT 'عام',
    latency_ms REAL,
    packet_loss_pct INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_checked TEXT NOT NULL,
    down_since TEXT,
    FOREIGN KEY(router_id) REFERENCES routers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subscribers (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    router_id TEXT NOT NULL,
    router_name TEXT NOT NULL,
    username TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    area TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    mac TEXT NOT NULL DEFAULT '',
    mac_vendor TEXT NOT NULL DEFAULT 'غير معروف',
    profile TEXT NOT NULL DEFAULT 'default',
    disabled INTEGER NOT NULL DEFAULT 0,
    uptime_text TEXT NOT NULL DEFAULT 'غير متصل',
    uptime_seconds INTEGER NOT NULL DEFAULT 0,
    online INTEGER NOT NULL DEFAULT 0,
    live_rx_mbps REAL NOT NULL DEFAULT 0,
    live_tx_mbps REAL NOT NULL DEFAULT 0,
    flap_count_today INTEGER NOT NULL DEFAULT 0,
    rx_today_gb REAL NOT NULL DEFAULT 0,
    tx_today_gb REAL NOT NULL DEFAULT 0,
    rx_week_gb REAL NOT NULL DEFAULT 0,
    tx_week_gb REAL NOT NULL DEFAULT 0,
    rx_month_gb REAL NOT NULL DEFAULT 0,
    tx_month_gb REAL NOT NULL DEFAULT 0,
    billing_status TEXT NOT NULL DEFAULT 'active',
    debt_amount_iqd INTEGER NOT NULL DEFAULT 0,
    activated_at TEXT,
    expires_at TEXT,
    expires_in_days INTEGER NOT NULL DEFAULT 30,
    tower_id TEXT,
    lat REAL,
    lng REAL,
    UNIQUE(router_id, username),
    FOREIGN KEY(router_id) REFERENCES routers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    subscriber_id TEXT NOT NULL,
    subscriber_name TEXT NOT NULL,
    amount_iqd INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    recorded_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS towers (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    azimuth_deg INTEGER NOT NULL DEFAULT 0,
    beamwidth_deg INTEGER NOT NULL DEFAULT 90,
    radius_meters INTEGER NOT NULL DEFAULT 1500
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    router_id TEXT NOT NULL,
    router_name TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    actor_role TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS backups (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    router_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_preview TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notification_settings (
    owner_id TEXT PRIMARY KEY,
    web_push_enabled INTEGER NOT NULL DEFAULT 0,
    telegram_enabled INTEGER NOT NULL DEFAULT 0,
    telegram_bot_token_enc TEXT NOT NULL DEFAULT '',
    telegram_chat_id TEXT NOT NULL DEFAULT '',
    daily_digest_enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS hotspot_vouchers (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    router_id TEXT NOT NULL,
    router_name TEXT NOT NULL,
    code TEXT NOT NULL,
    profile TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export function getNextTunnelOctet(): number {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get('next_tunnel_octet') as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 10;
  const next = current >= 245 ? 10 : current + 1;
  db.prepare(
    'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('next_tunnel_octet', String(next));
  return current;
}

export function runRetentionCleanup(): void {
  const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM port_traffic_history WHERE recorded_at < ?').run(cutoff30d);
  db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff90d);
  db.prepare('DELETE FROM alerts WHERE acknowledged = 1 AND created_at < ?').run(cutoff30d);
}
