export type ThemeMode = 'dark' | 'light';

export type UserRole = 'admin' | 'accountant' | 'technician' | 'viewer';

export type RouterStatus = 'pending' | 'online' | 'offline';

export type ConnectionType = 'direct' | 'agent' | 'wireguard' | 'sstp' | 'ovpn';

export type ApiPermissionMode = 'read-only' | 'full-control';

export type PortRole = 'WAN' | 'ISP' | 'Tower' | 'Switch' | 'LAN' | 'Unassigned';

export interface RouterPort {
  id: string;
  name: string;
  label: string;
  role: PortRole;
  type: 'ether' | 'sfp' | 'bonding' | 'bridge';
  status: 'up' | 'down';
  speed: string;
  expectedSpeed: '100M' | '1G' | '10G';
  duplex: 'Full' | 'Half' | 'None';
  monitored: boolean;
  rxMbps: number;
  txMbps: number;
  rxBytesToday: number;
  txBytesToday: number;
  rxErrors: number;
  rxDrops: number;
  sfpTempC: number | null;
  sfpRxDbm: number | null;
  sfpTxDbm: number | null;
  disconnectCount: number;
  lastDisconnect?: string;
}

export interface PortDisconnectEvent {
  id: number;
  portName: string;
  disconnectedAt: string;
  recoveredAt: string | null;
  durationSeconds: number | null;
}

export interface MonitoredDevice {
  id: string;
  name: string;
  ip: string;
  sectorGroup: string;
  latencyMs: number | null;
  packetLossPct: number;
  status: 'up' | 'down' | 'unknown';
  lastChecked: string;
  downSince: string | null;
}

export interface NeighborDevice {
  id: string;
  identity: string;
  platform: string;
  board: string;
  interfaceName: string;
  ip: string;
  mac: string;
  signalDbm?: number | null;
}

export interface RouterAlertItem {
  id: string;
  routerId: string;
  routerName: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  timestamp: string;
  acknowledged: boolean;
}

export interface RouterAlertRules {
  enabled: boolean;
  offlineMinutes: number;
  cpuThreshold: number;
  freeRamThreshold: number;
  tempThreshold: number;
  subscriberDropPercent: number;
  portErrorsPerMin: number;
  packetLossThreshold: number;
  alertOnMonitoredPortDown: boolean;
  alertOnPortSpeedDrop: boolean;
  alertOnPingDeviceDown: boolean;
  expiryReminderDays: number;
}

export interface TrafficSample {
  time: string;
  rxMbps: number;
  txMbps: number;
}

export interface DailyTrafficPoint {
  date: string;
  rxGb: number;
  txGb: number;
}

export interface CpuCoreLoad {
  core: number;
  load: number;
}

export interface RouterBackupItem {
  id: string;
  routerId: string;
  kind: 'backup' | 'rsc';
  filename: string;
  contentPreview: string;
  createdAt: string;
}

export interface RouterDevice {
  id: string;
  ownerId: string;
  name: string;
  connectionType: ConnectionType;
  permissionMode: ApiPermissionMode;
  apiHost: string;
  apiPort: number;
  apiUsername: string;
  tunnelIp: string;
  wireguardPort: number;
  wireguardPublicKey: string;
  latestHandshakeAt: string | null;
  tunnelRttMs: number | null;
  status: RouterStatus;
  lastError: string | null;
  // Auto-fetched hardware & OS fields (null until real router syncs)
  identity: string | null;
  model: string | null;
  boardName: string | null;
  serialNumber: string | null;
  routerOsVersion: string | null;
  firmwareVersion: string | null;
  upgradeFirmware: string | null;
  architecture: string | null;
  cpuCores: number | null;
  cpuCoreLoads: CpuCoreLoad[];
  ramTotalMb: number | null;
  voltage: number | null;
  fanRpm: number[];
  activeConnections: number | null;
  uptimeText: string | null;
  cpuPercent: number | null;
  ramPercent: number | null;
  tempCelsius: number | null;
  pppoeOnline: number;
  pppoeSecretsCount: number;
  hotspotOnline: number;
  dhcpLeasesCount: number;
  neighborsCount: number;
  currentRxMbps: number;
  currentTxMbps: number;
  trafficHistory: TrafficSample[];
  dailyTraffic: DailyTrafficPoint[];
  ports: RouterPort[];
  portDisconnects: PortDisconnectEvent[];
  monitoredDevices: MonitoredDevice[];
  neighbors: NeighborDevice[];
  alertRules: RouterAlertRules;
  lastSync: string | null;
}

export type SubscriberBillingStatus = 'active' | 'expiring' | 'expired' | 'debtor';

export interface SubscriberRecord {
  id: string;
  ownerId: string;
  routerId: string;
  routerName: string;
  username: string;
  fullName: string;
  phone: string;
  area: string;
  ip: string;
  mac: string;
  macVendor: string;
  profile: string;
  disabled: boolean;
  uptimeText: string;
  uptimeSeconds: number;
  online: boolean;
  liveRxMbps: number;
  liveTxMbps: number;
  flapCountToday: number;
  rxTodayGb: number;
  txTodayGb: number;
  rxWeekGb: number;
  txWeekGb: number;
  rxMonthGb: number;
  txMonthGb: number;
  billingStatus: SubscriberBillingStatus;
  debtAmountIqd: number;
  activatedAt: string | null;
  expiresAt: string | null;
  expiresInDays: number;
  towerId: string | null;
  lat: number | null;
  lng: number | null;
}

export interface PaymentRecord {
  id: string;
  subscriberId: string;
  subscriberName: string;
  amountIqd: number;
  note: string;
  recordedBy: string;
  createdAt: string;
}

export interface TowerNode {
  id: string;
  ownerId: string;
  name: string;
  lat: number;
  lng: number;
  azimuthDeg: number;
  beamwidthDeg: number;
  radiusMeters: number;
}

export interface AuditLogEntry {
  id: string;
  actorName: string;
  actorRole: UserRole;
  action: string;
  target: string;
  createdAt: string;
}

export interface NotificationSettings {
  webPushEnabled: boolean;
  telegramEnabled: boolean;
  telegramChatId: string;
  hasTelegramToken: boolean;
  dailyDigestEnabled: boolean;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

export interface ProvisionResult {
  routerId: string;
  connectionType: ConnectionType;
  permissionMode: ApiPermissionMode;
  tunnelIp: string;
  listenPort: number;
  routerPublicKey: string;
  apiUsername: string;
  apiPort: number;
  installScript: string;
  uninstallScript: string;
}

export interface AuthUser {
  id: string;
  ownerId: string;
  name: string;
  email: string;
  networkName: string;
  role: UserRole;
}

export interface DiagnosticDataset {
  ipAddresses: Array<{ address: string; network: string; iface: string }>;
  routes: Array<{ dst: string; gateway: string; distance: string }>;
  dhcpLeases: Array<{ address: string; mac: string; hostName: string; status: string }>;
  arpTable: Array<{ address: string; mac: string; iface: string }>;
  pppoeServers: Array<{ serviceName: string; iface: string; maxMtu: string }>;
  pppProfiles: Array<{ name: string; localAddress: string; rateLimit: string }>;
  hotspotActive: Array<{ user: string; address: string; uptime: string }>;
  simpleQueues: Array<{ name: string; target: string; maxLimit: string }>;
  vlans: Array<{ name: string; vlanId: string; iface: string }>;
  wirelessClients: Array<{ mac: string; iface: string; signal: string; txRate: string }>;
  services: Array<{ name: string; port: string; disabled: boolean }>;
  dnsSettings: { servers: string; allowRemoteRequests: boolean; cacheUsedKb: number; cacheSizeKb: number };
  logs: Array<{ time: string; topics: string; message: string }>;
}

export interface ServerCapabilities {
  wireguardReady: boolean;
  wireguardEndpoint: string;
  wireguardPort?: number;
  viaRelay?: boolean;
  appUrl: string;
  isPreviewAuthProxy: boolean;
}

export interface VpsRelayStatus {
  configured: boolean;
  verified: boolean;
  host: string;
  relayPort: number;
  wgPort: number;
  instanceOcid?: string;
  wgPublicKey: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  activePeersCount?: number;
}
