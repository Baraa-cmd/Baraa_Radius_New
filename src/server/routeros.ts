import { execFile } from 'child_process';
import crypto from 'crypto';
import net from 'net';
import tls from 'tls';
import { promisify } from 'util';
import type {
  ApiPermissionMode,
  ConnectionType,
  NeighborDevice,
  RouterPort,
} from '../types.ts';

const execFileAsync = promisify(execFile);

const WG_INTERFACE = process.env.WG_INTERFACE || 'wg0';
export const WG_SERVER_PORT = Number(process.env.WG_SERVER_PORT || 51820);
export const WG_GATEWAY_CIDR = '10.77.0.1/32';
export const WG_SUBNET_PREFIX = '10.77.0.';

// MAC OUI Vendor Lookup table (#48)
const OUI_TABLE: Record<string, string> = {
  'DC:2C:6E': 'MikroTik',
  '48:A9:8A': 'MikroTik',
  'C4:AD:34': 'MikroTik',
  'E4:8D:8C': 'MikroTik',
  'B8:69:F4': 'MikroTik',
  '4C:5E:0C': 'MikroTik',
  'D4:CA:6D': 'MikroTik',
  '08:55:31': 'MikroTik',
  '74:83:C2': 'Ubiquiti',
  'F4:92:BF': 'Ubiquiti',
  '24:5A:4C': 'Ubiquiti',
  '18:E8:29': 'Ubiquiti',
  '78:8A:20': 'Ubiquiti',
  'BC:E0:01': 'TP-Link',
  '60:83:E7': 'TP-Link',
  '14:4D:67': 'TP-Link',
  '30:07:5C': 'TP-Link',
  '3C:64:CF': 'TP-Link',
  '50:C7:BF': 'TP-Link',
  'C8:3A:35': 'Tenda',
  'CC:2D:21': 'Tenda',
  'D8:32:14': 'Tenda',
  '00:E0:FC': 'Huawei',
  '48:46:FB': 'Huawei',
  '70:72:3C': 'Huawei',
  'C4:E9:84': 'TP-Link',
  '54:E6:FC': 'TP-Link',
  '1C:7E:E5': 'D-Link',
  'EC:22:80': 'D-Link',
  '00:1E:58': 'D-Link',
  '54:22:F8': 'ZTE',
  '74:9D:79': 'Ruijie',
  '00:1D:0F': 'Totolink',
  '00:04:56': 'Cambium',
  '20:B5:C6': 'Mimosa',
};

export function lookupMacVendor(mac: string): string {
  if (!mac) return 'غير معروف';
  const clean = mac.trim().toUpperCase().slice(0, 8);
  return OUI_TABLE[clean] || 'جهاز شبكة';
}

export function parseRouterOsUptime(uptimeStr: string): number {
  if (!uptimeStr) return 0;
  let total = 0;
  const w = uptimeStr.match(/(\d+)w/);
  const d = uptimeStr.match(/(\d+)d/);
  const h = uptimeStr.match(/(\d+)h/);
  const m = uptimeStr.match(/(\d+)m/);
  const s = uptimeStr.match(/(\d+)s/);
  if (w) total += Number(w[1]) * 604800;
  if (d) total += Number(d[1]) * 86400;
  if (h) total += Number(h[1]) * 3600;
  if (m) total += Number(m[1]) * 60;
  if (s) total += Number(s[1]);
  return total;
}

export function formatUptimeArabic(uptimeStr: string): string {
  const sec = parseRouterOsUptime(uptimeStr);
  if (sec <= 0) return uptimeStr || 'غير متصل';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days} يوم ${hours} س`;
  if (hours > 0) return `${hours} س ${mins} د`;
  return `${Math.max(1, mins)} د`;
}

// Host WireGuard integration when `wg` binary is available on Linux VPS (#1, #2)
export async function syncHostWireGuardPeer(
  publicKey: string,
  tunnelIp: string
): Promise<{ appliedOnHost: boolean; reason?: string }> {
  try {
    await execFileAsync('wg', [
      'set',
      WG_INTERFACE,
      'peer',
      publicKey,
      'allowed-ips',
      `${tunnelIp}/32`,
    ]);
    return { appliedOnHost: true };
  } catch (err) {
    return {
      appliedOnHost: false,
      reason: err instanceof Error ? err.message : 'wg binary unavailable',
    };
  }
}

export async function removeHostWireGuardPeer(publicKey: string): Promise<void> {
  try {
    await execFileAsync('wg', ['set', WG_INTERFACE, 'peer', publicKey, 'remove']);
  } catch {
    // Ignore when wg binary is absent
  }
}

export async function getHostWireGuardHandshake(
  publicKey: string
): Promise<{ connected: boolean; latestHandshakeEpoch: number | null }> {
  try {
    const { stdout } = await execFileAsync('wg', ['show', WG_INTERFACE, 'latest-handshakes']);
    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      const [key, epochStr] = line.trim().split(/\s+/);
      if (key === publicKey) {
        const epoch = Number(epochStr);
        const ageSec = Math.floor(Date.now() / 1000) - epoch;
        return { connected: epoch > 0 && ageSec < 180, latestHandshakeEpoch: epoch };
      }
    }
    return { connected: false, latestHandshakeEpoch: null };
  } catch {
    return { connected: false, latestHandshakeEpoch: null };
  }
}

export async function isHostWireGuardAvailable(): Promise<boolean> {
  if (!process.env.WG_SERVER_ENDPOINT) return false;
  try {
    await execFileAsync('wg', ['show', WG_INTERFACE]);
    return true;
  } catch {
    return false;
  }
}

export async function getHostWireGuardPublicKey(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('wg', ['show', WG_INTERFACE, 'public-key']);
    const key = stdout.trim();
    return key || null;
  } catch {
    return null;
  }
}

export function buildInstallScript(params: {
  connectionType: ConnectionType;
  permissionMode: ApiPermissionMode;
  tunnelIpCidr: string;
  listenPort: number;
  routerPrivateKey: string;
  serverPublicKey: string;
  serverEndpoint: string;
  serverPort?: number;
  apiUsername: string;
  apiPassword: string;
  apiPort: number;
  agentUrl?: string;
  agentToken?: string;
}): string {
  const policy = params.permissionMode === 'full-control' ? 'read,write,api,test' : 'read,api,test';
  const gatewayHost = WG_GATEWAY_CIDR.split('/')[0];

  if (params.connectionType === 'direct') {
    const svcName = params.apiPort === 8729 ? 'api-ssl' : params.apiPort === 443 ? 'www-ssl' : 'api';
    return [
      `# Bro Radius - Direct Public API / DDNS (${params.permissionMode})`,
      `:do { /user remove [find name=${params.apiUsername}] } on-error={}`,
      `:do { /user group remove [find name=bro-radius-grp] } on-error={}`,
      `:do { /ip firewall filter remove [find comment="BRO-RADIUS"] } on-error={}`,
      `/user group add name=bro-radius-grp policy=${policy}`,
      `/user add name=${params.apiUsername} group=bro-radius-grp password="${params.apiPassword}" comment="Bro Radius (${params.permissionMode})"`,
      `/ip service set [find name=${svcName}] disabled=no port=${params.apiPort}`,
      `/ip cloud set ddns-enabled=yes`,
      `:local f [/ip firewall filter find where chain=input dynamic=no]; :if ([:len $f] > 0) do={ /ip firewall filter add chain=input protocol=tcp dst-port=${params.apiPort} action=accept comment="BRO-RADIUS" place-before=[:pick $f 0] } else={ /ip firewall filter add chain=input protocol=tcp dst-port=${params.apiPort} action=accept comment="BRO-RADIUS" }`,
      `:delay 1s`,
      `:put ("BRO-RADIUS DDNS: " . [/ip cloud get dns-name])`,
      `:put ("BRO-RADIUS PUBLIC IP: " . [/ip cloud get public-address])`,
    ].join('\n');
  }

  if (params.connectionType === 'agent') {
    const pushUrl = params.agentUrl || '';
    const tok = params.agentToken || '';
    return [
      `# Bro Radius - Cloud HTTPS Agent (Works behind NAT / CGNAT)`,
      `:do { /system scheduler remove [find name=bro-radius-agent] } on-error={}`,
      `:do { /system script remove [find name=bro-radius-agent] } on-error={}`,
      `/system script add name=bro-radius-agent policy=read,write,test source=":local id [/system identity get name]; :local cpu [/system resource get cpu-load]; :local tot [/system resource get total-memory]; :local fre [/system resource get free-memory]; :local ver [/system resource get version]; :local brd [/system resource get board-name]; :local up [/system resource get uptime]; :local arch [/system resource get architecture-name]; :local cores [/system resource get cpu-count]; :local ppp [/ppp active print count-only]; :local sec [/ppp secret print count-only]; :local hs [/ip hotspot active print count-only]; :local dhcp [/ip dhcp-server lease print count-only]; :local mdl \\$brd; :local ser \\"\\"; :do { :set mdl [/system routerboard get model]; :set ser [/system routerboard get serial-number] } on-error={}; :local json (\\"{\\\\\\"identity\\\\\\":\\\\\\"\\".\\$id.\\"\\\\\\",\\\\\\"model\\\\\\":\\\\\\"\\".\\$mdl.\\"\\\\\\",\\\\\\"boardName\\\\\\":\\\\\\"\\".\\$brd.\\"\\\\\\",\\\\\\"serialNumber\\\\\\":\\\\\\"\\".\\$ser.\\"\\\\\\",\\\\\\"routerOsVersion\\\\\\":\\\\\\"\\".\\$ver.\\"\\\\\\",\\\\\\"architecture\\\\\\":\\\\\\"\\".\\$arch.\\"\\\\\\",\\\\\\"cpuCores\\\\\\":\\".\\$cores.\\",\\\\\\"cpuPercent\\\\\\":\\".\\$cpu.\\",\\\\\\"totalMem\\\\\\":\\".\\$tot.\\",\\\\\\"freeMem\\\\\\":\\".\\$fre.\\",\\\\\\"uptime\\\\\\":\\\\\\"\\".\\$up.\\"\\\\\\",\\\\\\"pppoeOnline\\\\\\":\\".\\$ppp.\\",\\\\\\"pppoeSecretsCount\\\\\\":\\".\\$sec.\\",\\\\\\"hotspotOnline\\\\\\":\\".\\$hs.\\",\\\\\\"dhcpLeasesCount\\\\\\":\\".\\$dhcp.\\"}\\"); /tool fetch url=\\"${pushUrl}\\" mode=https http-method=post http-header-field=\\"Content-Type: application/json,X-Agent-Token: ${tok}\\" http-data=\\$json check-certificate=no output=none"`,
      `/system scheduler add name=bro-radius-agent interval=20s on-event="/system script run bro-radius-agent" start-time=startup`,
      `/system script run bro-radius-agent`,
      `:put "BRO-RADIUS: HTTPS Agent active"`,
    ].join('\n');
  }

  const endpointPort = params.serverPort || WG_SERVER_PORT;
  const endpointLine = params.serverEndpoint
    ? `endpoint-address=${params.serverEndpoint} endpoint-port=${endpointPort}`
    : `:put "NOTE: Set server endpoint-address in WireGuard Peer if required"`;

  if (params.connectionType === 'sstp' || params.connectionType === 'ovpn') {
    const ifaceType = params.connectionType === 'sstp' ? 'sstp-client' : 'ovpn-client';
    const connectHost = params.serverEndpoint || gatewayHost;
    return [
      `# Bro Radius - RouterOS v6/v7 (${params.connectionType.toUpperCase()})`,
      `:do { /interface ${ifaceType} remove [find name=bro-radius-vpn] } on-error={}`,
      `:do { /user remove [find name=${params.apiUsername}] } on-error={}`,
      `:do { /user group remove [find name=bro-radius-grp] } on-error={}`,
      `/interface ${ifaceType} add name=bro-radius-vpn connect-to=${connectHost} user="${params.apiUsername}" password="${params.apiPassword}" disabled=no comment="BRO-RADIUS"`,
      `/user group add name=bro-radius-grp policy=${policy}`,
      `/user add name=${params.apiUsername} group=bro-radius-grp password="${params.apiPassword}" comment="Bro Radius (${params.permissionMode})"`,
      `/ip service set [find name=api] disabled=no port=${params.apiPort}`,
      `/ip firewall filter add chain=input in-interface=bro-radius-vpn action=accept comment="BRO-RADIUS" place-before=0`,
      `:put "BRO-RADIUS: ${params.connectionType.toUpperCase()} client configured"`,
    ].join('\n');
  }

  return [
    `:do { /interface wireguard remove [find name=bro-radius-wg] } on-error={}`,
    `:do { /ip address remove [find comment="BRO-RADIUS"] } on-error={}`,
    `:do { /ip firewall nat remove [find comment="BRO-RADIUS"] } on-error={}`,
    `:do { /ip firewall filter remove [find comment="BRO-RADIUS"] } on-error={}`,
    `:do { /user remove [find name=${params.apiUsername}] } on-error={}`,
    `:do { /user group remove [find name=bro-radius-grp] } on-error={}`,
    `/interface wireguard add name=bro-radius-wg private-key="${params.routerPrivateKey}" listen-port=${params.listenPort} comment="BRO-RADIUS"`,
    `/interface wireguard peers add interface=bro-radius-wg public-key="${params.serverPublicKey}" ${endpointLine} allowed-address=${WG_GATEWAY_CIDR} persistent-keepalive=25s comment="BRO-RADIUS"`,
    `/ip address add address=${params.tunnelIpCidr} interface=bro-radius-wg comment="BRO-RADIUS"`,
    `:do { /user group add name=bro-radius-grp policy=${policy}; :put "BRO-RADIUS: group ok" } on-error={ :put "BRO-RADIUS: group not added" }`,
    `:do { /user add name=${params.apiUsername} group=bro-radius-grp password="${params.apiPassword}" address=${WG_GATEWAY_CIDR} comment="Bro Radius (${params.permissionMode})"; :put "BRO-RADIUS: user ok" } on-error={ :put "BRO-RADIUS: user not added" }`,
    `/ip service set [find name=api] disabled=no`,
    `:do { :local cur [/ip service get [find name=api] address]; :if ([:len $cur] > 0) do={ :local out "${WG_GATEWAY_CIDR}"; :foreach a in=$cur do={ :local s [:tostr $a]; :if ($s != "" && $s != "${WG_GATEWAY_CIDR}") do={ :set out ($out . "," . $s) } }; /ip service set [find name=api] address=[:toarray $out] } } on-error={}`,
    `:do { :local p [/ip service get [find name=api] port]; /ip firewall nat add chain=dstnat in-interface=bro-radius-wg protocol=tcp dst-port=${params.apiPort} action=redirect to-ports=$p comment="BRO-RADIUS" } on-error={}`,
    `:local f [/ip firewall filter find where chain=input dynamic=no]; :if ([:len $f] > 0) do={ /ip firewall filter add chain=input in-interface=bro-radius-wg src-address=${gatewayHost} action=accept comment="BRO-RADIUS" place-before=[:pick $f 0] } else={ /ip firewall filter add chain=input in-interface=bro-radius-wg src-address=${gatewayHost} action=accept comment="BRO-RADIUS" }`,
    `:put "BRO-RADIUS: done - return to Bro Radius"`,
  ].join('\n');
}

export function buildUninstallScript(apiUsername: string): string {
  return [
    `:do { /system scheduler remove [find name=bro-radius-agent] } on-error={}`,
    `:do { /system script remove [find name=bro-radius-agent] } on-error={}`,
    `:do { /interface wireguard remove [find name=bro-radius-wg] } on-error={}`,
    `:do { /interface sstp-client remove [find name=bro-radius-vpn] } on-error={}`,
    `:do { /interface ovpn-client remove [find name=bro-radius-vpn] } on-error={}`,
    `:do { /ip address remove [find comment="BRO-RADIUS"] } on-error={}`,
    `:do { /ip firewall nat remove [find comment="BRO-RADIUS"] } on-error={}`,
    `:do { /ip firewall filter remove [find comment="BRO-RADIUS"] } on-error={}`,
    `:do { /user remove [find name=${apiUsername}] } on-error={}`,
    `:do { /user group remove [find name=bro-radius-grp] } on-error={}`,
    `:put "BRO-RADIUS: removed cleanly"`,
  ].join('\n');
}

// =========================================================================
// Real MikroTik RouterOS Binary API Client (Port 8728 / custom API port)
// =========================================================================

function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) {
    const v = len | 0x8000;
    return Buffer.from([(v >> 8) & 0xff, v & 0xff]);
  }
  if (len < 0x200000) {
    const v = len | 0xc00000;
    return Buffer.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  if (len < 0x10000000) {
    const v = len | 0xe0000000;
    return Buffer.from([(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  return Buffer.from([0xf0, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

function encodeSentence(words: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const w of words) {
    const wb = Buffer.from(w, 'utf8');
    parts.push(encodeLength(wb.length), wb);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeLength(buf: Buffer, offset: number): { length: number; bytesRead: number } | null {
  if (offset >= buf.length) return null;
  const b0 = buf[offset];
  if ((b0 & 0x80) === 0) return { length: b0, bytesRead: 1 };
  if ((b0 & 0xc0) === 0x80) {
    if (offset + 1 >= buf.length) return null;
    return { length: ((b0 & 0x3f) << 8) + buf[offset + 1], bytesRead: 2 };
  }
  if ((b0 & 0xe0) === 0xc0) {
    if (offset + 2 >= buf.length) return null;
    return {
      length: ((b0 & 0x1f) << 16) + (buf[offset + 1] << 8) + buf[offset + 2],
      bytesRead: 3,
    };
  }
  if ((b0 & 0xf0) === 0xe0) {
    if (offset + 3 >= buf.length) return null;
    return {
      length:
        ((b0 & 0x0f) << 24) + (buf[offset + 1] << 16) + (buf[offset + 2] << 8) + buf[offset + 3],
      bytesRead: 4,
    };
  }
  if (offset + 4 >= buf.length) return null;
  return {
    length:
      (buf[offset + 1] << 24) + (buf[offset + 2] << 16) + (buf[offset + 3] << 8) + buf[offset + 4],
    bytesRead: 5,
  };
}

export type RosRow = Record<string, string>;

export class RouterOSClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private currentSentence: string[] = [];
  private sentenceQueue: string[][] = [];
  private waiter: ((sentence: string[]) => void) | null = null;
  private errorWaiter: ((err: Error) => void) | null = null;
  private commandChain: Promise<unknown> = Promise.resolve();

  async connect(host: string, port: number, timeoutMs = 6000): Promise<number> {
    const start = Date.now();
    const useTls = port === 8729;
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = useTls
        ? tls.connect({ host, port, rejectUnauthorized: false })
        : net.createConnection({ host, port });
      this.socket = sock;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(
            new Error(
              `انتهت مهلة الاتصال بـ ${host}:${port} — تأكد أن الراوتر يملك Public IP أو DDNS مفتوح وأنه لا يحمل IP محلي فقط`
            )
          );
        }
      }, timeoutMs);

      sock.once(useTls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(Date.now() - start);
        }
      });

      sock.on('data', (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.parseIncoming();
      });

      sock.on('close', () => {
        clearTimeout(timer);
        const closeErr = new Error(`أُغلق الاتصال من الراوتر (${host}:${port})`);
        if (!settled) {
          settled = true;
          reject(closeErr);
        } else if (this.errorWaiter) {
          const ew = this.errorWaiter;
          this.waiter = null;
          this.errorWaiter = null;
          ew(closeErr);
        }
      });

      sock.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        let friendly = err.message;
        if (err.code === 'ECONNREFUSED') {
          friendly = `تم رفض الاتصال على ${host}:${port} — فعّل خدمة api في /ip service واسمح بالمنفذ في Firewall`;
        } else if (err.code === 'ENOTFOUND') {
          friendly = `تعذر حل اسم النطاق أو العنوان (${host})`;
        } else if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH') {
          friendly = `الراوتر ${host}:${port} غير قابل للوصول من الخادم السحابي`;
        } else if (err.code === 'ECONNRESET') {
          friendly = `تم قطع الاتصال فجأة من الراوتر (${host}:${port}) — تحقق من السماح للآي بي في /ip service`;
        }
        const wrapped = new Error(friendly);
        if (!settled) {
          settled = true;
          reject(wrapped);
        } else if (this.errorWaiter) {
          const ew = this.errorWaiter;
          this.waiter = null;
          this.errorWaiter = null;
          ew(wrapped);
        }
      });
    });
  }

  private parseIncoming(): void {
    let offset = 0;
    while (offset < this.buffer.length) {
      const dec = decodeLength(this.buffer, offset);
      if (!dec) break;
      if (dec.length === 0) {
        offset += dec.bytesRead;
        const done = this.currentSentence;
        this.currentSentence = [];
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          this.errorWaiter = null;
          w(done);
        } else {
          this.sentenceQueue.push(done);
        }
        continue;
      }
      if (offset + dec.bytesRead + dec.length > this.buffer.length) break;
      const word = this.buffer
        .subarray(offset + dec.bytesRead, offset + dec.bytesRead + dec.length)
        .toString('utf8');
      this.currentSentence.push(word);
      offset += dec.bytesRead + dec.length;
    }
    if (offset > 0) {
      this.buffer = this.buffer.subarray(offset);
    }
  }

  private nextSentence(timeoutMs = 6000): Promise<string[]> {
    if (this.sentenceQueue.length > 0) {
      return Promise.resolve(this.sentenceQueue.shift()!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.errorWaiter = null;
        reject(new Error('انتهت مهلة قراءة الاستجابة من المايكروتك'));
      }, timeoutMs);
      this.waiter = (s) => {
        clearTimeout(timer);
        resolve(s);
      };
      this.errorWaiter = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  }

  private async runCommandSequential(words: string[]): Promise<RosRow[]> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('الاتصال بالراوتر مغلق');
    }
    this.socket.write(encodeSentence(words));
    const rows: RosRow[] = [];
    while (true) {
      const s = await this.nextSentence();
      const type = s[0];
      if (type === '!done') {
        const meta: RosRow = {};
        for (const w of s.slice(1)) {
          if (w.startsWith('=')) {
            const idx = w.indexOf('=', 1);
            if (idx > 1) meta[w.slice(1, idx)] = w.slice(idx + 1);
          }
        }
        if (Object.keys(meta).length > 0 && rows.length === 0) rows.push(meta);
        return rows;
      }
      if (type === '!trap' || type === '!fatal') {
        const msg = s.find((w) => w.startsWith('=message='))?.slice(9) || 'خطأ في تنفيذ أمر RouterOS';
        throw new Error(msg);
      }
      if (type === '!re') {
        const row: RosRow = {};
        for (const w of s.slice(1)) {
          if (w.startsWith('=')) {
            const idx = w.indexOf('=', 1);
            if (idx > 1) row[w.slice(1, idx)] = w.slice(idx + 1);
          }
        }
        rows.push(row);
      }
    }
  }

  command(words: string[]): Promise<RosRow[]> {
    const next = this.commandChain.then(
      () => this.runCommandSequential(words),
      () => this.runCommandSequential(words)
    );
    this.commandChain = next.catch(() => undefined);
    return next;
  }

  async login(username: string, password: string): Promise<void> {
    // RouterOS 6.43+ & 7.x single-step login
    try {
      const res = await this.command(['/login', `=name=${username}`, `=password=${password}`]);
      if (res.length > 0 && res[0].ret) {
        const challenge = Buffer.from(res[0].ret, 'hex');
        const md5 = crypto
          .createHash('md5')
          .update(Buffer.concat([Buffer.from([0]), Buffer.from(password, 'utf8'), challenge]))
          .digest('hex');
        await this.command(['/login', `=name=${username}`, `=response=00${md5}`]);
      }
    } catch (err) {
      // Legacy RouterOS < 6.43 fallback if single-step params trapped
      const msg = err instanceof Error ? err.message : '';
      if (msg.toLowerCase().includes('parameter') || msg.toLowerCase().includes('unknown')) {
        const res = await this.command(['/login']);
        if (res.length > 0 && res[0].ret) {
          const challenge = Buffer.from(res[0].ret, 'hex');
          const md5 = crypto
            .createHash('md5')
            .update(Buffer.concat([Buffer.from([0]), Buffer.from(password, 'utf8'), challenge]))
            .digest('hex');
          await this.command(['/login', `=name=${username}`, `=response=00${md5}`]);
          return;
        }
      }
      throw err;
    }
  }

  close(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
  }
}

export interface LiveRouterSnapshot {
  rttMs: number;
  identity: string;
  model: string;
  boardName: string;
  serialNumber: string;
  routerOsVersion: string;
  firmwareVersion: string;
  upgradeFirmware: string;
  architecture: string;
  cpuCores: number;
  cpuCoreLoads: Array<{ core: number; load: number }>;
  ramTotalMb: number;
  ramPercent: number;
  cpuPercent: number;
  uptimeText: string;
  tempCelsius: number | null;
  voltage: number | null;
  fanRpm: number[];
  activeConnections: number;
  ports: RouterPort[];
  neighbors: NeighborDevice[];
  pppoeActive: RosRow[];
  pppoeSecrets: RosRow[];
  hotspotOnline: number;
  dhcpLeasesCount: number;
  queues: RosRow[];
}

async function restGet<T>(baseUrl: string, authHeader: string, path: string): Promise<T> {
  const res = await fetch(`${baseUrl}/rest/${path}`, {
    headers: { Authorization: authHeader },
    signal: AbortSignal.timeout(5500),
  });
  if (res.status === 401) throw new Error('اسم المستخدم أو كلمة مرور RouterOS غير صحيحة');
  if (!res.ok) throw new Error(`HTTP ${res.status} من REST API`);
  return (await res.json()) as T;
}

async function fetchRealRouterSnapshotViaRest(
  host: string,
  port: number,
  username: string,
  password: string,
  existingPorts: RouterPort[]
): Promise<LiveRouterSnapshot> {
  const start = Date.now();
  const scheme = port === 443 || port === 8443 ? 'https' : 'http';
  const baseUrl = `${scheme}://${host}:${port}`;
  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  const [idObj, resObj, rbObj, healthArr, cpuArr, ethArr, nbArr, pppActArr, pppSecArr, hsArr, dhcpArr] =
    await Promise.all([
      restGet<Record<string, string>>(baseUrl, authHeader, 'system/identity'),
      restGet<Record<string, string>>(baseUrl, authHeader, 'system/resource'),
      restGet<Record<string, string>>(baseUrl, authHeader, 'system/routerboard').catch(() => ({} as Record<string, string>)),
      restGet<Array<Record<string, string>>>(baseUrl, authHeader, 'system/health').catch(() => []),
      restGet<Array<Record<string, string>>>(baseUrl, authHeader, 'system/resource/cpu').catch(() => []),
      restGet<Array<Record<string, string>>>(baseUrl, authHeader, 'interface/ethernet').catch(() => []),
      restGet<Array<Record<string, string>>>(baseUrl, authHeader, 'ip/neighbor').catch(() => []),
      restGet<Array<Record<string, string>>>(baseUrl, authHeader, 'ppp/active').catch(() => []),
      restGet<Array<Record<string, string>>>(baseUrl, authHeader, 'ppp/secret').catch(() => []),
      restGet<Array<Record<string, string>>>(baseUrl, authHeader, 'ip/hotspot/active').catch(() => []),
      restGet<Array<Record<string, string>>>(baseUrl, authHeader, 'ip/dhcp-server/lease').catch(() => []),
    ]);

  const rttMs = Date.now() - start;
  const totalMem = Number(resObj['total-memory'] || 0);
  const freeMem = Number(resObj['free-memory'] || 0);
  const ramTotalMb = totalMem > 0 ? Math.round(totalMem / (1024 * 1024)) : 0;
  const ramPercent = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0;

  let tempCelsius: number | null = null;
  let voltage: number | null = null;
  const fanRpm: number[] = [];
  for (const h of healthArr) {
    const n = String(h.name || '').toLowerCase();
    if (n.includes('temp')) tempCelsius = Math.round(Number(h.value));
    if (n.includes('volt')) voltage = Number(h.value);
    if (n.includes('fan')) fanRpm.push(Math.round(Number(h.value)));
  }

  const prevMap = new Map(existingPorts.map((p) => [p.name, p]));
  const ports: RouterPort[] = ethArr.map((row) => {
    const name = row.name || 'ether';
    const prev = prevMap.get(name);
    const isUp = row.running === 'true' || String(row.running) === 'true';
    return {
      id: name,
      name,
      label: prev?.label || row.comment || name,
      role: prev?.role || 'Unassigned',
      type: name.includes('sfp') ? 'sfp' : 'ether',
      status: isUp ? 'up' : 'down',
      speed: isUp ? (row.speed || '1G') : 'down',
      expectedSpeed: prev?.expectedSpeed || '1G',
      duplex: isUp ? 'Full' : 'None',
      monitored: prev?.monitored ?? false,
      rxMbps: 0,
      txMbps: 0,
      rxBytesToday: Number(row['rx-byte'] || 0),
      txBytesToday: Number(row['tx-byte'] || 0),
      rxErrors: Number(row['rx-fcs-error'] || 0),
      rxDrops: Number(row['rx-drop'] || 0),
      sfpTempC: null,
      sfpRxDbm: null,
      sfpTxDbm: null,
      disconnectCount: prev?.disconnectCount ?? 0,
      lastDisconnect: prev?.lastDisconnect,
    };
  });

  return {
    rttMs,
    identity: idObj.name || 'MikroTik',
    model: rbObj.model || resObj['board-name'] || 'MikroTik RouterOS',
    boardName: resObj['board-name'] || rbObj.model || '',
    serialNumber: rbObj['serial-number'] || '',
    routerOsVersion: resObj.version || '',
    firmwareVersion: rbObj['current-firmware'] || '',
    upgradeFirmware: rbObj['upgrade-firmware'] || '',
    architecture: resObj['architecture-name'] || '',
    cpuCores: Number(resObj['cpu-count'] || 1),
    cpuCoreLoads: cpuArr.map((c, idx) => ({ core: idx, load: Number(c.load || 0) })),
    ramTotalMb,
    ramPercent,
    cpuPercent: Number(resObj['cpu-load'] || 0),
    uptimeText: formatUptimeArabic(resObj.uptime || ''),
    tempCelsius,
    voltage,
    fanRpm,
    activeConnections: 0,
    ports,
    neighbors: nbArr.map((n, idx) => ({
      id: `nb-${idx}`,
      identity: n.identity || n.address || 'Unknown',
      platform: n.platform || 'Unknown',
      board: n.board || '',
      interfaceName: n.interface || '',
      ip: n.address || '',
      mac: n['mac-address'] || '',
      signalDbm: null,
    })),
    pppoeActive: pppActArr,
    pppoeSecrets: pppSecArr,
    hotspotOnline: hsArr.length,
    dhcpLeasesCount: dhcpArr.length,
    queues: [],
  };
}

export async function fetchRealRouterSnapshot(
  host: string,
  port: number,
  username: string,
  password: string,
  existingPorts: RouterPort[] = []
): Promise<LiveRouterSnapshot> {
  if (port === 80 || port === 443 || port === 8080 || port === 8443) {
    return fetchRealRouterSnapshotViaRest(host, port, username, password, existingPorts);
  }
  const client = new RouterOSClient();
  try {
    const rttMs = await client.connect(host, port);
    await client.login(username, password);

    const safeCmd = (words: string[]) => client.command(words).catch(() => [] as RosRow[]);

    const idRows = await client.command(['/system/identity/print']);
    const resRows = await client.command(['/system/resource/print']);
    const rbRows = await safeCmd(['/system/routerboard/print']);
    const healthRows = await safeCmd(['/system/health/print']);
    const cpuRows = await safeCmd(['/system/resource/cpu/print']);
    const ethRows = await safeCmd(['/interface/ethernet/print']);
    const bondRows = await safeCmd(['/interface/bonding/print']);
    const bridgeRows = await safeCmd(['/interface/bridge/print']);
    const nbRows = await safeCmd(['/ip/neighbor/print']);
    const pppActRows = await safeCmd(['/ppp/active/print']);
    const pppSecRows = await safeCmd(['/ppp/secret/print']);
    const hsActRows = await safeCmd(['/ip/hotspot/active/print']);
    const dhcpRows = await safeCmd(['/ip/dhcp-server/lease/print']);
    const queueRows = await safeCmd(['/queue/simple/print']);
    const connRows = await safeCmd(['/ip/firewall/connection/print', '=count-only=']);

    const res0 = resRows[0] || {};
    const rb0 = rbRows[0] || {};
    const id0 = idRows[0] || {};

    const totalMemBytes = Number(res0['total-memory'] || 0);
    const freeMemBytes = Number(res0['free-memory'] || 0);
    const ramTotalMb = totalMemBytes > 0 ? Math.round(totalMemBytes / (1024 * 1024)) : 0;
    const ramPercent =
      totalMemBytes > 0 ? Math.round(((totalMemBytes - freeMemBytes) / totalMemBytes) * 100) : 0;

    // Parse health sensors (ROS v7 returns rows with name/value; v6 returns single object)
    let tempCelsius: number | null = null;
    let voltage: number | null = null;
    const fanRpm: number[] = [];
    for (const h of healthRows) {
      if (h.name && h.value) {
        const lower = h.name.toLowerCase();
        if (lower.includes('temp')) tempCelsius = Math.round(Number(h.value));
        if (lower.includes('volt')) voltage = Number(h.value);
        if (lower.includes('fan') && h.type === 'RPM') fanRpm.push(Math.round(Number(h.value)));
      } else {
        if (h.temperature) tempCelsius = Math.round(Number(h.temperature));
        if (h.voltage) voltage = Number(h.voltage);
      }
    }

    const cpuCoreLoads = cpuRows.map((c, idx) => ({
      core: idx,
      load: Number(c.load || 0),
    }));

    const prevMap = new Map(existingPorts.map((p) => [p.name, p]));
    const allIfaces = [
      ...ethRows.map((e) => ({ row: e, type: (e.name?.includes('sfp') ? 'sfp' : 'ether') as RouterPort['type'] })),
      ...bondRows.map((b) => ({ row: b, type: 'bonding' as const })),
      ...bridgeRows.map((br) => ({ row: br, type: 'bridge' as const })),
    ];

    // Fetch live monitor-traffic once for active interfaces
    const activeNames = allIfaces
      .filter((i) => i.row.running === 'true')
      .slice(0, 16)
      .map((i) => i.row.name)
      .filter(Boolean);

    const trafficByIface = new Map<string, { rxMbps: number; txMbps: number }>();
    if (activeNames.length > 0) {
      try {
        const mon = await client.command([
          '/interface/monitor-traffic',
          `=interface=${activeNames.join(',')}`,
          '=once=',
        ]);
        for (const m of mon) {
          if (m.name) {
            trafficByIface.set(m.name, {
              rxMbps: Number((Number(m['rx-bits-per-second'] || 0) / 1e6).toFixed(2)),
              txMbps: Number((Number(m['tx-bits-per-second'] || 0) / 1e6).toFixed(2)),
            });
          }
        }
      } catch {
        // Ignore if monitor-traffic fails on a virtual interface
      }
    }

    const ports: RouterPort[] = allIfaces.map(({ row, type }) => {
      const name = row.name || 'ether';
      const prev = prevMap.get(name);
      const isUp = row.running === 'true';
      const rawRate = row.rate || row.speed || '';
      const speed = isUp
        ? rawRate.includes('10Gbps') || rawRate.includes('10G')
          ? '10G'
          : rawRate.includes('1Gbps') || rawRate.includes('1G')
            ? '1G'
            : rawRate.includes('100Mbps') || rawRate.includes('100M')
              ? '100M'
              : rawRate || '1G'
        : 'down';
      const t = trafficByIface.get(name);

      return {
        id: name,
        name,
        label: prev?.label || row.comment || name,
        role: prev?.role || 'Unassigned',
        type,
        status: isUp ? 'up' : 'down',
        speed,
        expectedSpeed: prev?.expectedSpeed || '1G',
        duplex: isUp ? (row['full-duplex'] === 'false' ? 'Half' : 'Full') : 'None',
        monitored: prev?.monitored ?? false,
        rxMbps: t?.rxMbps ?? 0,
        txMbps: t?.txMbps ?? 0,
        rxBytesToday: Number(row['rx-byte'] || 0),
        txBytesToday: Number(row['tx-byte'] || 0),
        rxErrors: Number(row['rx-fcs-error'] || 0),
        rxDrops: Number(row['rx-drop'] || 0),
        sfpTempC: row['sfp-temperature'] ? Number(row['sfp-temperature']) : null,
        sfpRxDbm: row['sfp-rx-power'] ? Number(row['sfp-rx-power']) : null,
        sfpTxDbm: row['sfp-tx-power'] ? Number(row['sfp-tx-power']) : null,
        disconnectCount: prev?.disconnectCount ?? 0,
        lastDisconnect: prev?.lastDisconnect,
      };
    });

    const neighbors: NeighborDevice[] = nbRows.map((n, idx) => ({
      id: `nb-${idx}-${n.mac || n.address || idx}`,
      identity: n.identity || n.address || 'Unknown',
      platform: n.platform || 'Unknown',
      board: n.board || n['system-description'] || '',
      interfaceName: n.interface || '',
      ip: n.address || n['address4'] || '',
      mac: n['mac-address'] || '',
      signalDbm: null,
    }));

    return {
      rttMs,
      identity: id0.name || 'MikroTik',
      model: rb0.model || res0['board-name'] || 'MikroTik RouterOS',
      boardName: res0['board-name'] || rb0.model || '',
      serialNumber: rb0['serial-number'] || '',
      routerOsVersion: res0.version || '',
      firmwareVersion: rb0['current-firmware'] || '',
      upgradeFirmware: rb0['upgrade-firmware'] || '',
      architecture: res0['architecture-name'] || '',
      cpuCores: Number(res0['cpu-count'] || 1),
      cpuCoreLoads,
      ramTotalMb,
      ramPercent,
      cpuPercent: Number(res0['cpu-load'] || 0),
      uptimeText: formatUptimeArabic(res0.uptime || ''),
      tempCelsius,
      voltage,
      fanRpm,
      activeConnections: Number(connRows[0]?.ret || 0),
      ports,
      neighbors,
      pppoeActive: pppActRows,
      pppoeSecrets: pppSecRows,
      hotspotOnline: hsActRows.length,
      dhcpLeasesCount: dhcpRows.length,
      queues: queueRows,
    };
  } finally {
    client.close();
  }
}

export async function runPingOnRouter(
  host: string,
  port: number,
  username: string,
  password: string,
  targetIp: string
): Promise<{ status: 'up' | 'down'; latencyMs: number | null; packetLossPct: number }> {
  const client = new RouterOSClient();
  try {
    await client.connect(host, port, 4000);
    await client.login(username, password);
    const rows = await client.command(['/tool/ping', `=address=${targetIp}`, '=count=4']);
    const received = rows.filter((r) => r.time || r['avg-rtt']).length;
    const loss = Math.round(((4 - received) / 4) * 100);
    const times = rows
      .map((r) => parseFloat((r.time || '0').replace('ms', '')))
      .filter((n) => !Number.isNaN(n) && n > 0);
    const avg = times.length > 0 ? Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)) : null;
    return {
      status: received > 0 ? 'up' : 'down',
      latencyMs: avg,
      packetLossPct: loss,
    };
  } finally {
    client.close();
  }
}
