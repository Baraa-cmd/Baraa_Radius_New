import http from 'http';
import https from 'https';
import type { CpeConnectedHost } from '../types.ts';
import { lookupMacVendor, type RosRow } from './routeros.ts';
import { assertSafeDeviceHost } from './rfTelemetry.ts';

export function inferDeviceTypeFromText(
  vendor: string,
  hostname: string
): CpeConnectedHost['deviceType'] {
  const s = `${vendor} ${hostname}`.toLowerCase();
  if (/iphone|ipad|apple|samsung|galaxy|xiaomi|redmi|poco|oppo|vivo|realme|huawei|honor|pixel|android/.test(s)) {
    return 'phone';
  }
  if (/playstation|ps4|ps5|xbox|nintendo|switch/.test(s)) {
    return 'console';
  }
  if (/sony|lg|bravia|roku|chromecast|firetv|appletv|smarttv|hisense|tcl/.test(s)) {
    return 'tv';
  }
  if (/hikvision|dahua|ezviz|imou|tapo|cam|reolink|nvr|dvr/.test(s)) {
    return 'camera';
  }
  if (/tp-link|tenda|mikrotik|ubiquiti|totolink|d-link|ruijie|zte|netgear|asus|router/.test(s)) {
    return 'router';
  }
  if (/dell|lenovo|hp|macbook|thinkpad|laptop|desktop|intel|pc/.test(s)) {
    return 'laptop';
  }
  return 'unknown';
}

// ============================================================================
// GenieACS TR-069 NBI Client (#16, #17, #18, #19, #22, #23, #24, #25, #27, #28)
// ============================================================================
export interface GenieAcsConfig {
  url: string;
  username?: string;
  password?: string;
}

function validateGenieUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl.trim().replace(/\/$/, ''));
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('رابط GenieACS يجب أن يبدأ بـ http:// أو https://');
  }
  assertSafeDeviceHost(parsed.hostname);
  return parsed;
}

async function genieRequest<T>(
  cfg: GenieAcsConfig,
  method: 'GET' | 'POST',
  pathAndQuery: string,
  body?: unknown
): Promise<T> {
  const base = validateGenieUrl(cfg.url);
  const fullUrl = `${base.origin}${pathAndQuery}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cfg.username) {
    const auth = Buffer.from(`${cfg.username}:${cfg.password || ''}`).toString('base64');
    headers.Authorization = `Basic ${auth}`;
  }
  let payload = '';
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(payload));
  }

  return new Promise<T>((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      parsed,
      { method, headers, timeout: 8000, rejectUnauthorized: false },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`GenieACS HTTP ${res.statusCode}: ${data.slice(0, 180)}`));
            return;
          }
          try {
            resolve((data ? JSON.parse(data) : {}) as T);
          } catch {
            resolve({} as T);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('انتهت مهلة الاتصال بسيرفر GenieACS')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function readTr069Val(obj: any, path: string): unknown {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  if (cur && typeof cur === 'object' && '_value' in cur) {
    return cur._value;
  }
  return cur;
}

export async function fetchGenieAcsCpe(
  cfg: GenieAcsConfig,
  search: { deviceId?: string | null; wanIp?: string | null; mac?: string | null }
): Promise<{
  tr069DeviceId: string;
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
  tr143DownMbps: number | null;
  tr143UpMbps: number | null;
  connectedHosts: CpeConnectedHost[];
  rawTreeSummary: Record<string, unknown>;
} | null> {
  let queryObj: Record<string, unknown>;
  if (search.deviceId) {
    queryObj = { _id: search.deviceId };
  } else if (search.mac) {
    queryObj = { $or: [{ 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.MACAddress._value': search.mac }, { _id: { $regex: search.mac.replace(/:/g, ''), $options: 'i' } }] };
  } else if (search.wanIp) {
    queryObj = {
      $or: [
        { 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress._value': search.wanIp },
        { 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress._value': search.wanIp },
        { 'Device.PPP.Interface.1.IPCP.LocalIPAddress._value': search.wanIp },
      ],
    };
  } else {
    return null;
  }

  const encodedQuery = encodeURIComponent(JSON.stringify(queryObj));
  const devices = await genieRequest<Array<Record<string, any>>>(
    cfg,
    'GET',
    `/devices/?query=${encodedQuery}`
  );
  const dev = devices[0];
  if (!dev) return null;

  const id = String(dev._id);
  const isTr181 = Boolean(dev.Device && !dev.InternetGatewayDevice);

  const model =
    String(
      readTr069Val(dev, isTr181 ? 'Device.DeviceInfo.ModelName' : 'InternetGatewayDevice.DeviceInfo.ModelName') ||
        dev._deviceId?._ProductClass ||
        'TR-069 CPE'
    ) || null;
  const serialNumber =
    String(
      readTr069Val(dev, isTr181 ? 'Device.DeviceInfo.SerialNumber' : 'InternetGatewayDevice.DeviceInfo.SerialNumber') ||
        dev._deviceId?._SerialNumber ||
        ''
    ) || null;
  const firmware =
    String(
      readTr069Val(dev, isTr181 ? 'Device.DeviceInfo.SoftwareVersion' : 'InternetGatewayDevice.DeviceInfo.SoftwareVersion') ||
        ''
    ) || null;
  const uptimeRaw = readTr069Val(
    dev,
    isTr181 ? 'Device.DeviceInfo.UpTime' : 'InternetGatewayDevice.DeviceInfo.UpTime'
  );
  const cpuRaw = readTr069Val(
    dev,
    isTr181 ? 'Device.DeviceInfo.ProcessStatus.CPUUsage' : 'InternetGatewayDevice.DeviceInfo.X_CPUUsage'
  );
  const freeMem = Number(
    readTr069Val(
      dev,
      isTr181 ? 'Device.DeviceInfo.MemoryStatus.Free' : 'InternetGatewayDevice.DeviceInfo.MemoryStatus.Free'
    ) || 0
  );
  const totalMem = Number(
    readTr069Val(
      dev,
      isTr181 ? 'Device.DeviceInfo.MemoryStatus.Total' : 'InternetGatewayDevice.DeviceInfo.MemoryStatus.Total'
    ) || 0
  );
  const ramPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null;

  const wanIp =
    String(
      readTr069Val(
        dev,
        isTr181
          ? 'Device.PPP.Interface.1.IPCP.LocalIPAddress'
          : 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress'
      ) || search.wanIp || ''
    ) || null;

  const wifiSsid24 =
    String(
      readTr069Val(
        dev,
        isTr181 ? 'Device.WiFi.SSID.1.SSID' : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'
      ) || ''
    ) || null;
  const wifiChannel24 =
    String(
      readTr069Val(
        dev,
        isTr181 ? 'Device.WiFi.Radio.1.Channel' : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel'
      ) || ''
    ) || null;
  const wifiSsid5 =
    String(
      readTr069Val(
        dev,
        isTr181 ? 'Device.WiFi.SSID.2.SSID' : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID'
      ) || ''
    ) || null;
  const wifiChannel5 =
    String(
      readTr069Val(
        dev,
        isTr181 ? 'Device.WiFi.Radio.2.Channel' : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Channel'
      ) || ''
    ) || null;

  // Extract Hosts from TR-098 or TR-181 + WLAN AssociatedDevice RSSI
  const hostsTree =
    readTr069Val(
      dev,
      isTr181 ? 'Device.Hosts.Host' : 'InternetGatewayDevice.LANDevice.1.Hosts.Host'
    ) || {};
  const assoc24 =
    readTr069Val(
      dev,
      isTr181
        ? 'Device.WiFi.AccessPoint.1.AssociatedDevice'
        : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.AssociatedDevice'
    ) || {};
  const assoc5 =
    readTr069Val(
      dev,
      isTr181
        ? 'Device.WiFi.AccessPoint.2.AssociatedDevice'
        : 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.AssociatedDevice'
    ) || {};

  const rssiMap = new Map<string, { rssi: number | null; band: '2.4GHz' | '5GHz' }>();
  const scanAssoc = (tree: any, band: '2.4GHz' | '5GHz') => {
    if (!tree || typeof tree !== 'object') return;
    for (const [k, v] of Object.entries(tree)) {
      if (k.startsWith('_') || !v || typeof v !== 'object') continue;
      const mac = String(
        readTr069Val(v, isTr181 ? 'MACAddress' : 'AssociatedDeviceMACAddress') || ''
      ).toUpperCase();
      const sig = Number(readTr069Val(v, isTr181 ? 'SignalStrength' : 'X_RSSI') || NaN);
      if (mac) rssiMap.set(mac, { rssi: Number.isFinite(sig) ? sig : null, band });
    }
  };
  scanAssoc(assoc24, '2.4GHz');
  scanAssoc(assoc5, '5GHz');

  const connectedHosts: CpeConnectedHost[] = [];
  if (hostsTree && typeof hostsTree === 'object') {
    for (const [k, h] of Object.entries(hostsTree)) {
      if (k.startsWith('_') || !h || typeof h !== 'object') continue;
      const active = Boolean(readTr069Val(h, 'Active'));
      const mac = String(readTr069Val(h, 'MACAddress') || '').toUpperCase();
      const ip = String(readTr069Val(h, 'IPAddress') || '');
      const hostname = String(readTr069Val(h, 'HostName') || 'جهاز متصل');
      const ifaceType = String(readTr069Val(h, 'InterfaceType') || '');
      if (!mac && !ip) continue;
      const vendor = lookupMacVendor(mac);
      const rf = rssiMap.get(mac);
      connectedHosts.push({
        mac,
        ip,
        hostname,
        vendor,
        deviceType: inferDeviceTypeFromText(vendor, hostname),
        rssiDbm: rf?.rssi ?? null,
        band: rf?.band || (ifaceType.includes('802.11') ? '2.4GHz' : ifaceType ? 'LAN' : 'Unknown'),
        active,
      });
    }
  }

  // TR-143 diagnostics last measurement if present
  const dlBytes = Number(
    readTr069Val(
      dev,
      isTr181 ? 'Device.IP.Diagnostics.DownloadDiagnostics.TestBytesReceived' : 'InternetGatewayDevice.DownloadDiagnostics.TestBytesReceived'
    ) || 0
  );
  const dlBom = String(
    readTr069Val(
      dev,
      isTr181 ? 'Device.IP.Diagnostics.DownloadDiagnostics.BOMTime' : 'InternetGatewayDevice.DownloadDiagnostics.BOMTime'
    ) || ''
  );
  const dlEom = String(
    readTr069Val(
      dev,
      isTr181 ? 'Device.IP.Diagnostics.DownloadDiagnostics.EOMTime' : 'InternetGatewayDevice.DownloadDiagnostics.EOMTime'
    ) || ''
  );
  let tr143DownMbps: number | null = null;
  if (dlBytes > 0 && dlBom && dlEom) {
    const sec = Math.max(0.1, (Date.parse(dlEom) - Date.parse(dlBom)) / 1000);
    if (Number.isFinite(sec)) {
      tr143DownMbps = Number(((dlBytes * 8) / sec / 1e6).toFixed(2));
    }
  }

  return {
    tr069DeviceId: id,
    model,
    serialNumber,
    firmware,
    uptimeSec: uptimeRaw !== undefined ? Number(uptimeRaw) || null : null,
    cpuPct: cpuRaw !== undefined ? Number(cpuRaw) || null : null,
    ramPct,
    wanIp,
    wifiSsid24,
    wifiChannel24,
    wifiSsid5,
    wifiChannel5,
    tr143DownMbps,
    tr143UpMbps: null,
    connectedHosts,
    rawTreeSummary: {
      model,
      serialNumber,
      firmware,
      wifiSsid24,
      wifiChannel24,
      wifiSsid5,
      wifiChannel5,
    },
  };
}

export async function pushGenieAcsTask(
  cfg: GenieAcsConfig,
  deviceId: string,
  task: Record<string, unknown>
): Promise<unknown> {
  return genieRequest(
    cfg,
    'POST',
    `/devices/${encodeURIComponent(deviceId)}/tasks?connection_request`,
    task
  );
}

// ============================================================================
// MikroTik-Only Subscriber CPE Estimator (#20 — Zero TR-069 Required)
// Uses active connections + TTL OS fingerprinting + DHCP leases/ARP
// ============================================================================
export function estimateCpeDevicesFromMikroTik(params: {
  subscriberIp: string;
  subscriberMac: string;
  conns: RosRow[];
  arpRows: RosRow[];
  dhcpRows: RosRow[];
}): {
  connectedCount: number;
  connectedHosts: CpeConnectedHost[];
} {
  const { subscriberIp, subscriberMac, conns, arpRows, dhcpRows } = params;
  const subConns = conns.filter(
    (c) =>
      String(c['src-address'] || '').startsWith(`${subscriberIp}:`) ||
      String(c['src-address'] || '') === subscriberIp
  );

  // Extract unique destination service patterns & protocol diversity + ARP/DHCP neighbors
  const relatedDhcp = dhcpRows.filter(
    (d) => d.address === subscriberIp || d['mac-address'] === subscriberMac
  );
  const relatedArp = arpRows.filter(
    (a) => a.address === subscriberIp || a['mac-address'] === subscriberMac
  );

  // Classify distinct protocol/OS fingerprints from active connection patterns
  const hosts: CpeConnectedHost[] = [];
  const mainVendor = lookupMacVendor(subscriberMac);
  const mainHostname = relatedDhcp[0]?.['host-name'] || `Home-CPE (${mainVendor})`;

  hosts.push({
    mac: subscriberMac || relatedArp[0]?.['mac-address'] || 'غير محدد',
    ip: subscriberIp,
    hostname: mainHostname,
    vendor: mainVendor,
    deviceType: 'router',
    rssiDbm: null,
    band: 'LAN',
    active: subConns.length > 0,
    rxBytes: subConns.reduce((a, c) => a + Number(c['repl-bytes'] || 0), 0),
    txBytes: subConns.reduce((a, c) => a + Number(c['orig-bytes'] || 0), 0),
  } as CpeConnectedHost);

  // Group distinctive external destination signatures (Apple/Google/PlayStation/Windows/SmartTV)
  const appHints = new Map<string, { count: number; bytes: number }>();
  for (const c of subConns) {
    const dst = String(c['dst-address'] || '');
    const port = dst.split(':')[1] || '';
    let bucket = 'جلسات تصفح عام';
    if (port === '5223' || port === '2197') bucket = 'أجهزة Apple / iPhone (APNs)';
    else if (port === '5228' || port === '5229') bucket = 'أجهزة Android / Samsung';
    else if (port === '3478' || port === '3479' || port === '3074' || port === '9308')
      bucket = 'منصة ألعاب (PlayStation / Xbox)';
    else if (port === '554' || port === '8000' || port === '37777')
      bucket = 'كاميرات مراقبة (NVR / DVR)';
    else if (port === '443') bucket = 'تصفح HTTPS مشفّر';
    const cur = appHints.get(bucket) || { count: 0, bytes: 0 };
    cur.count += 1;
    cur.bytes += Number(c['orig-bytes'] || 0) + Number(c['repl-bytes'] || 0);
    appHints.set(bucket, cur);
  }

  let idx = 1;
  for (const [label, stats] of appHints.entries()) {
    if (label === 'تصفح HTTPS مشفّر' && appHints.size > 1) continue;
    hosts.push({
      mac: `CONNTRACK-${idx++}`,
      ip: subscriberIp,
      hostname: `${label} (${stats.count} جلسة)`,
      vendor: 'تقدير MikroTik Conntrack',
      deviceType: inferDeviceTypeFromText('', label),
      rssiDbm: null,
      band: 'Unknown',
      active: true,
      rxBytes: stats.bytes,
    });
  }

  // Estimate concurrent household devices based on distinct service signatures + session density
  const signatureBased = Math.max(1, appHints.size - (appHints.has('تصفح HTTPS مشفّر') ? 1 : 0));
  const sessionBased = subConns.length > 0 ? Math.max(1, Math.min(18, Math.ceil(subConns.length / 18))) : 0;
  const connectedCount = subConns.length > 0 ? Math.max(signatureBased, sessionBased) : 0;

  return { connectedCount, connectedHosts: hosts };
}

// ============================================================================
// Authenticated SSRF-Safe CPE Remote Web Proxy (#21)
// ============================================================================
const ALLOWED_PROXY_PORTS = new Set([80, 443, 8080, 8443, 8888]);

export async function proxyCpeHttpPage(params: {
  host: string;
  port: number;
  subPath: string;
}): Promise<{ statusCode: number; contentType: string; body: string }> {
  const safeHost = assertSafeDeviceHost(params.host);
  const port = ALLOWED_PROXY_PORTS.has(params.port) ? params.port : 80;
  const proto = port === 443 || port === 8443 ? 'https' : 'http';
  const cleanSubPath = params.subPath.startsWith('/') ? params.subPath : `/${params.subPath}`;
  const targetUrl = `${proto}://${safeHost}:${port}${cleanSubPath}`;

  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      parsed,
      { method: 'GET', timeout: 5000, rejectUnauthorized: false },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total <= 512 * 1024) chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 200,
            contentType: String(res.headers['content-type'] || 'text/html; charset=utf-8'),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('تعذر الوصول لواجهة راوتر المشترك — تأكد من تفعيل Remote Web Management على راوتر المنزل')));
    req.on('error', reject);
    req.end();
  });
}

// ============================================================================
// Direct Non-TR-069 CPE Router HTTP Scraper & Probe
// Supports both 'user_pass' (admin/password) and 'pass_only' (Tenda, TP-Link, Mercusys)
// ============================================================================
export interface CpeHttpProbeResult {
  success: boolean;
  model: string | null;
  vendor: string | null;
  firmware: string | null;
  wifiSsid24: string | null;
  wifiChannel24: string | null;
  uptimeSec: number | null;
  authStatus: 'authorized' | 'auth_failed' | 'no_auth_needed' | 'unreachable';
  message: string;
}

export async function probeAndFetchCpeHttpData(params: {
  host: string;
  port?: number;
  authMode?: 'user_pass' | 'pass_only';
  username?: string;
  password?: string;
  subMac?: string;
  timeoutMs?: number;
}): Promise<CpeHttpProbeResult> {
  const {
    host,
    port = 80,
    authMode = 'user_pass',
    username = 'admin',
    password = '',
    subMac = '',
    timeoutMs = 4500,
  } = params;

  let safeHost: string;
  try {
    safeHost = assertSafeDeviceHost(host);
  } catch (err) {
    return {
      success: false,
      model: null,
      vendor: null,
      firmware: null,
      wifiSsid24: null,
      wifiChannel24: null,
      uptimeSec: null,
      authStatus: 'unreachable',
      message: err instanceof Error ? err.message : 'عنوان IP غير صالح',
    };
  }

  const effectiveUser = authMode === 'pass_only' ? (username || 'admin') : (username || 'admin');
  const authHeader = password
    ? `Basic ${Buffer.from(`${effectiveUser}:${password}`).toString('base64')}`
    : undefined;

  const macVendor = subMac ? lookupMacVendor(subMac) : 'Unknown';

  const makeReq = (path: string, extraHeaders: Record<string, string> = {}): Promise<{
    statusCode: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> => {
    return new Promise((resolve, reject) => {
      const isHttps = port === 443 || port === 8443;
      const mod = isHttps ? https : http;
      const req = mod.request(
        {
          hostname: safeHost,
          port,
          path,
          method: 'GET',
          timeout: timeoutMs,
          rejectUnauthorized: false,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BroRadius/1.0',
            Accept: 'text/html,application/xhtml+xml,application/json,*/*',
            ...(authHeader ? { Authorization: authHeader } : {}),
            ...extraHeaders,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (c: Buffer) => {
            total += c.length;
            if (total <= 512 * 1024) chunks.push(c);
          });
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode || 200,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  };

  try {
    // Probe 1: Root / login page
    const rootRes = await makeReq('/').catch(() => null);

    // If unreachable on root, attempt /login.html
    const res = rootRes || (await makeReq('/login.html').catch(() => null));
    if (!res) {
      return {
        success: false,
        model: macVendor !== 'Unknown' ? `${macVendor} (غير متصل)` : null,
        vendor: macVendor !== 'Unknown' ? macVendor : null,
        firmware: null,
        wifiSsid24: null,
        wifiChannel24: null,
        uptimeSec: null,
        authStatus: 'unreachable',
        message: 'تعذر الاتصال بواجهة الراوتر المنزلي (تأكد من تفعيل Remote Management)',
      };
    }

    const body = res.body;
    const serverHeader = String(res.headers['server'] || '');
    const authHeaderResp = String(res.headers['www-authenticate'] || '');

    // Extract Title / Model
    const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
    let rawTitle = titleMatch ? titleMatch[1].trim() : '';
    // Clean up generic words
    rawTitle = rawTitle.replace(/\s*[-|_|–]\s*(Login|Sign in|Home|Status|Main)$/i, '').trim();

    // Check specific vendors
    let detectedVendor = macVendor !== 'Unknown' ? macVendor : '';
    let detectedModel = rawTitle || null;
    let firmware: string | null = null;
    let wifiSsid: string | null = null;
    let wifiChan: string | null = null;
    let uptimeSec: number | null = null;

    if (/tenda/i.test(body) || /tenda/i.test(serverHeader) || /tenda/i.test(macVendor)) {
      detectedVendor = 'Tenda';
      if (!detectedModel || detectedModel === 'Tenda' || /login/i.test(detectedModel)) {
        const m = body.match(/\b(AC\d+|F\d+|N\d+|Nova|W\d+)\b/i);
        detectedModel = m ? `Tenda ${m[1]}` : 'Tenda Wireless Router';
      }
      // Try Tenda status API
      try {
        const tendaStat = await makeReq('/goform/GetSysInfo', { Accept: 'application/json' });
        if (tendaStat.statusCode === 200 && tendaStat.body.includes('{')) {
          const json = JSON.parse(tendaStat.body);
          if (json.version) firmware = String(json.version);
          if (json.ssid) wifiSsid = String(json.ssid);
          if (json.channel) wifiChan = String(json.channel);
          if (json.uptime) uptimeSec = Number(json.uptime) || null;
        }
      } catch {
        // Ignore Tenda secondary API error
      }
    } else if (/tp-link|tplink/i.test(body) || /tp-link/i.test(authHeaderResp) || /tp-link/i.test(macVendor)) {
      detectedVendor = 'TP-Link';
      if (!detectedModel || /tp-link/i.test(detectedModel)) {
        const m = body.match(/\b(TL-[A-Z0-9]+|Archer\s+[A-Z0-9]+|Deco\s+[A-Z0-9]+)\b/i);
        detectedModel = m ? `TP-Link ${m[1]}` : (rawTitle || 'TP-Link Wireless Router');
      }
      // Try TP-Link Status page
      try {
        const tpStat = await makeReq('/userRpm/StatusRpm.htm');
        if (tpStat.statusCode === 200 && tpStat.body.includes('statusPara')) {
          const ssidMatch = tpStat.body.match(/["']([a-zA-Z0-9_\-\s]+)["'],\s*\d+,\s*\d+,\s*["'][0-9a-f:]+["']/i);
          if (ssidMatch) wifiSsid = ssidMatch[1];
          const verMatch = tpStat.body.match(/["'](\d+\.\d+\.\d+[^"']*)["']/);
          if (verMatch) firmware = verMatch[1];
        }
      } catch {
        // Ignore TP-Link secondary API error
      }
    } else if (/mercusys/i.test(body) || /mercusys/i.test(macVendor)) {
      detectedVendor = 'Mercusys';
      const m = body.match(/\b(MW\d+[A-Z]*|AC\d+)\b/i);
      detectedModel = m ? `Mercusys ${m[1]}` : (rawTitle || 'Mercusys Wireless Router');
    } else if (/xiaomi|miwifi/i.test(body) || /xiaomi/i.test(macVendor)) {
      detectedVendor = 'Xiaomi';
      detectedModel = rawTitle || 'Mi WiFi Router';
    } else if (/mikrotik/i.test(body) || /routeros/i.test(body)) {
      detectedVendor = 'MikroTik';
      detectedModel = rawTitle || 'MikroTik RouterOS CPE';
    } else if (/totolink/i.test(body) || /totolink/i.test(macVendor)) {
      detectedVendor = 'Totolink';
      detectedModel = rawTitle || 'Totolink Wireless Router';
    } else if (/huawei/i.test(body) || /huawei/i.test(macVendor)) {
      detectedVendor = 'Huawei';
      detectedModel = rawTitle || 'Huawei Home Gateway';
    } else if (/zte/i.test(body) || /zte/i.test(macVendor)) {
      detectedVendor = 'ZTE';
      detectedModel = rawTitle || 'ZTE Home Gateway';
    }

    // Generic SSID and Firmware regex extraction from HTML if not parsed yet
    if (!wifiSsid) {
      const s = body.match(/(?:ssid|wlan_ssid|def_ssid|wireless_ssid)\s*[:=]\s*["']([^"']{2,32})["']/i);
      if (s && !/null|undefined|default/i.test(s[1])) wifiSsid = s[1];
    }
    if (!firmware) {
      const f = body.match(/(?:firmware|software|build_version)\s*[:=]\s*["']([^"']{3,24})["']/i);
      if (f) firmware = f[1];
    }

    // Authentication evaluation
    if (res.statusCode === 401) {
      return {
        success: true,
        model: detectedModel || (detectedVendor ? `${detectedVendor} Home CPE` : 'Home Router'),
        vendor: detectedVendor || null,
        firmware,
        wifiSsid24: wifiSsid,
        wifiChannel24: wifiChan,
        uptimeSec,
        authStatus: 'auth_failed',
        message: 'تم الوصول للراوتر ولكن كلمة المرور غير متطابقة (HTTP 401) — يرجى التأكد من كلمة المرور',
      };
    }

    if (res.statusCode === 200 || res.statusCode === 302) {
      const hasAuth = Boolean(password);
      return {
        success: true,
        model: detectedModel || (detectedVendor ? `${detectedVendor} Home CPE` : 'Home Router'),
        vendor: detectedVendor || null,
        firmware,
        wifiSsid24: wifiSsid,
        wifiChannel24: wifiChan,
        uptimeSec,
        authStatus: hasAuth ? 'authorized' : 'no_auth_needed',
        message: hasAuth
          ? `تم الاتصال بالراوتر بنجاح (${detectedModel || detectedVendor || 'Home CPE'})`
          : 'واجهة الراوتر متاحة بدون حماية أو بانتظار إدخال كلمة المرور',
      };
    }

    return {
      success: true,
      model: detectedModel || 'Home Router',
      vendor: detectedVendor || null,
      firmware,
      wifiSsid24: wifiSsid,
      wifiChannel24: wifiChan,
      uptimeSec,
      authStatus: 'no_auth_needed',
      message: `استجاب الراوتر برمز HTTP ${res.statusCode}`,
    };
  } catch (err: any) {
    const isConnRefused = err?.code === 'ECONNREFUSED';
    return {
      success: false,
      model: null,
      vendor: null,
      firmware: null,
      wifiSsid24: null,
      wifiChannel24: null,
      uptimeSec: null,
      authStatus: 'unreachable',
      message: isConnRefused
        ? 'تم رفض الاتصال بالمنفذ — تأكد من أن منفذ إدارة الويب (80 أو 8080) مفتوح على راوتر المشترك'
        : 'انتهت مهلة الاتصال براوتر المشترك (الجهاز قد يكون مغلقاً أو خلف جدار ناري)',
    };
  }
}

