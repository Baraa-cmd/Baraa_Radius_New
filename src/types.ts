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
  txDrops?: number;
  poeStatus?: string | null;
  poeWatts?: number | null;
  poeVoltage?: number | null;
  sfpTempC: number | null;
  sfpRxDbm: number | null;
  sfpTxDbm: number | null;
  sfpVoltageV?: number | null;
  sfpBiasMa?: number | null;
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
  graceExpiresAt?: string | null;
  turboNightEnabled?: boolean;
  turboProfile?: string | null;
  baseProfile?: string | null;
  staticIpPool?: string | null;
  rfRadioId?: string | null;
  signalDbm?: number | null;
  distanceKm?: number | null;
  cpeConnectedCount?: number;
  cpeModel?: string | null;
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
  healthScore?: number;
  onlineRadios?: number;
  totalRadios?: number;
  onlineSubs?: number;
  totalSubs?: number;
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
  turboNightEnabled?: boolean;
  turboStartHour?: number;
  turboEndHour?: number;
  turboDefaultProfile?: string;
  genieacsUrl?: string;
  genieacsUser?: string;
  hasGenieacsPass?: boolean;
  radiusHost?: string;
  radiusCoaPort?: number;
  hasRadiusSecret?: boolean;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  allowedTowerIds: string[];
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
  allowedTowerIds?: string[];
}

export interface DiagnosticDataset {
  ipAddresses: Array<{ address: string; network: string; iface: string }>;
  routes: Array<{ dst: string; gateway: string; distance: string; active?: boolean; disabled?: boolean; comment?: string; id?: string }>;
  dhcpLeases: Array<{ address: string; mac: string; hostName: string; status: string }>;
  arpTable: Array<{ address: string; mac: string; iface: string }>;
  pppoeServers: Array<{ serviceName: string; iface: string; maxMtu: string }>;
  pppProfiles: Array<{ name: string; localAddress: string; rateLimit: string }>;
  hotspotActive: Array<{ user: string; address: string; uptime: string }>;
  simpleQueues: Array<{ name: string; target: string; maxLimit: string }>;
  vlans: Array<{ name: string; vlanId: string; iface: string }>;
  bridgePorts?: Array<{ iface: string; bridge: string; pvid: string; status: string }>;
  wirelessClients: Array<{ mac: string; iface: string; signal: string; txRate: string }>;
  services: Array<{ name: string; port: string; disabled: boolean }>;
  dnsSettings: { servers: string; allowRemoteRequests: boolean; cacheUsedKb: number; cacheSizeKb: number };
  logs: Array<{ time: string; topics: string; message: string }>;
  ipPools?: Array<{ name: string; ranges: string; usedCount: number; totalApprox: number }>;
  arpConflicts?: Array<{ ip: string; macs: string[] }>;
  rogueDhcpAlerts?: Array<{ iface: string; mac: string; validServer: string; time: string }>;
  ntpStatus?: { enabled: boolean; servers: string; status: string; syncedServer?: string };
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

export type RfVendor = 'mikrotik' | 'ubiquiti' | 'mimosa' | 'cambium';
export type RfProtocol = 'ros' | 'snmp' | 'airos';

export interface RfStationClient {
  mac: string;
  signalDbm: number | null;
  chain0Dbm?: number | null;
  chain1Dbm?: number | null;
  ccqPct?: number | null;
  txRateMbps?: number | null;
  rxRateMbps?: number | null;
  distanceKm?: number | null;
  uptime?: string;
  iface?: string;
  subscriberId?: string | null;
  subscriberUsername?: string | null;
}

export interface RfRadioDevice {
  id: string;
  ownerId: string;
  routerId: string | null;
  towerId: string | null;
  name: string;
  host: string;
  vendor: RfVendor;
  protocol: RfProtocol;
  port: number;
  status: 'online' | 'offline' | 'pending';
  lastError: string | null;
  model: string | null;
  ssid: string | null;
  frequencyMhz: number | null;
  channelWidthMhz: number | null;
  txPowerDbm: number | null;
  ccqPct: number | null;
  airtimePct: number | null;
  signalDbm: number | null;
  noiseFloorDbm: number | null;
  snrDb: number | null;
  chain0Dbm: number | null;
  chain1Dbm: number | null;
  chainImbalanceDb: number | null;
  txRateMbps: number | null;
  rxRateMbps: number | null;
  distanceKm: number | null;
  lanSpeed: string | null;
  clients: RfStationClient[];
  lastSync: string | null;
}

export interface RfSignalSample {
  id: number;
  radioId: string;
  signalDbm: number | null;
  noiseFloorDbm: number | null;
  ccqPct: number | null;
  airtimePct: number | null;
  recordedAt: string;
}

export interface CpeConnectedHost {
  mac: string;
  ip: string;
  hostname: string;
  vendor: string;
  deviceType: 'phone' | 'laptop' | 'tv' | 'console' | 'camera' | 'router' | 'unknown';
  rssiDbm: number | null;
  band: '2.4GHz' | '5GHz' | 'LAN' | 'Unknown';
  active: boolean;
  rxBytes?: number;
  txBytes?: number;
  ttlHint?: number;
  blocked?: boolean;
}

export interface CpeDeviceInfo {
  subscriberId: string;
  source: 'genieacs' | 'mikrotik_conntrack' | 'unconfigured';
  tr069DeviceId: string | null;
  cpeHost: string | null;
  cpePort: number;
  model: string | null;
  serialNumber: string | null;
  firmware: string | null;
  uptimeSec: number | null;
  cpuPct: number | null;
  ramPct: number | null;
  wanIp: string | null;
  wifiSsid24: string | null;
  wifiChannel24: string | null;
  wifiSsid5: string | null;
  wifiChannel5: string | null;
  connectedCount: number;
  connectedHosts: CpeConnectedHost[];
  tr143DownMbps: number | null;
  tr143UpMbps: number | null;
  lastSyncedAt: string | null;
  hasConfigBackup: boolean;
}

export interface SubscriberSessionRecord {
  id: number;
  subscriberId: string;
  ip: string;
  mac: string;
  loginAt: string;
  logoutAt: string | null;
  durationSec: number;
  rxGb: number;
  txGb: number;
  disconnectCause: string;
}

export interface TorchEntry {
  srcAddress: string;
  dstAddress: string;
  protocol: string;
  srcPort: string;
  dstPort: string;
  rxMbps: number;
  txMbps: number;
}

export interface LatencyProbeRecord {
  id: number;
  routerId: string;
  target: string;
  label: string;
  latencyMs: number | null;
  packetLossPct: number;
  recordedAt: string;
}

export interface FailoverEventRecord {
  id: number;
  routerId: string;
  routerName: string;
  fromGateway: string;
  toGateway: string;
  reason: string;
  createdAt: string;
}

export interface ConfigDiffRecord {
  id: string;
  routerId: string;
  summary: string;
  addedCount: number;
  removedCount: number;
  diffLines: Array<{ type: 'add' | 'del' | 'ctx'; text: string }>;
  createdAt: string;
}

export interface SecurityAuditResult {
  score: number;
  adminUsers: Array<{ name: string; group: string; address: string }>;
  newAdminUsersDetected: string[];
  findings: Array<{ severity: 'critical' | 'warning' | 'ok'; title: string; detail: string }>;
}

