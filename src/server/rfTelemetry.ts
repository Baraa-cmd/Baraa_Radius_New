import dgram from 'dgram';
import http from 'http';
import https from 'https';
import type { RfProtocol, RfStationClient, RfVendor } from '../types.ts';
import { RouterOSClient, type RosRow } from './routeros.ts';

// Validate target host for RF / CPE polling (block loopback, link-local metadata 169.254.x.x, multicast)
export function assertSafeDeviceHost(host: string): string {
  const clean = host.trim();
  if (!/^[a-zA-Z0-9.-]{3,128}$/.test(clean)) {
    throw new Error('عنوان الجهاز غير صالح');
  }
  const lower = clean.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local')) {
    throw new Error('عنوان Host غير مسموح به لأسباب أمنية');
  }
  const parts = clean.split('.').map((p) => Number(p));
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 127 || a === 0 || (a === 169 && b === 254) || a >= 224) {
      throw new Error('عنوان IP محظور (Loopback / Link-Local / Metadata)');
    }
  }
  return clean;
}

// ============================================================================
// Pure-Node Zero-Dependency SNMP v2c BER Client (UDP)
// ============================================================================
function encodeBerLength(len: number): Buffer {
  if (len < 128) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function wrapTlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeBerLength(value.length), value]);
}

function encodeOid(oidStr: string): Buffer {
  const parts = oidStr.split('.').map((p) => Number(p));
  if (parts.length < 2) return Buffer.alloc(0);
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    if (val < 128) {
      out.push(val);
    } else {
      const sub: number[] = [];
      sub.unshift(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        sub.unshift(0x80 | (val & 0x7f));
        val >>= 7;
      }
      out.push(...sub);
    }
  }
  return wrapTlv(0x06, Buffer.from(out));
}

function encodeInt(val: number): Buffer {
  if (val === 0) return wrapTlv(0x02, Buffer.from([0]));
  const bytes: number[] = [];
  let n = val;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return wrapTlv(0x02, Buffer.from(bytes));
}

function buildSnmpGetPacket(community: string, reqId: number, oids: string[], getNext = false): Buffer {
  const varBinds = Buffer.concat(
    oids.map((oid) => wrapTlv(0x30, Buffer.concat([encodeOid(oid), Buffer.from([0x05, 0x00])])))
  );
  const pduTag = getNext ? 0xa1 : 0xa0;
  const pdu = wrapTlv(
    pduTag,
    Buffer.concat([
      encodeInt(reqId),
      encodeInt(0), // error-status
      encodeInt(0), // error-index
      wrapTlv(0x30, varBinds),
    ])
  );
  const msg = wrapTlv(
    0x30,
    Buffer.concat([
      encodeInt(1), // SNMPv2c
      wrapTlv(0x04, Buffer.from(community, 'utf8')),
      pdu,
    ])
  );
  return msg;
}

function readBerLength(buf: Buffer, offset: number): { len: number; next: number } {
  const first = buf[offset];
  if ((first & 0x80) === 0) {
    return { len: first, next: offset + 1 };
  }
  const numBytes = first & 0x7f;
  let len = 0;
  for (let i = 0; i < numBytes; i++) {
    len = (len << 8) | buf[offset + 1 + i];
  }
  return { len, next: offset + 1 + numBytes };
}

function decodeOidBytes(buf: Buffer): string {
  if (buf.length === 0) return '';
  const first = buf[0];
  const parts = [Math.floor(first / 40), first % 40];
  let i = 1;
  while (i < buf.length) {
    let val = 0;
    while (i < buf.length) {
      const b = buf[i++];
      val = (val << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
    parts.push(val);
  }
  return parts.join('.');
}

function decodeSignedInt(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let val = (buf[0] & 0x80) !== 0 ? -1 : 0;
  for (let i = 0; i < buf.length; i++) {
    val = (val << 8) | buf[i];
  }
  return val;
}

function decodeUnsignedInt(buf: Buffer): number {
  let val = 0;
  for (let i = 0; i < buf.length; i++) {
    val = val * 256 + buf[i];
  }
  return val;
}

function parseSnmpResponse(buf: Buffer): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  let pos = 0;
  if (buf[pos] !== 0x30) return out;
  pos++;
  pos = readBerLength(buf, pos).next;
  // version
  if (buf[pos] !== 0x02) return out;
  pos++;
  const vLen = readBerLength(buf, pos);
  pos = vLen.next + vLen.len;
  // community
  if (buf[pos] !== 0x04) return out;
  pos++;
  const cLen = readBerLength(buf, pos);
  pos = cLen.next + cLen.len;
  // PDU (0xA2 GetResponse)
  if (buf[pos] !== 0xa2) return out;
  pos++;
  pos = readBerLength(buf, pos).next;
  // reqId, errStatus, errIndex
  for (let k = 0; k < 3; k++) {
    if (buf[pos] !== 0x02) return out;
    pos++;
    const l = readBerLength(buf, pos);
    pos = l.next + l.len;
  }
  // VarBindList
  if (buf[pos] !== 0x30) return out;
  pos++;
  const listLen = readBerLength(buf, pos);
  pos = listLen.next;
  const endPos = Math.min(buf.length, pos + listLen.len);
  while (pos < endPos) {
    if (buf[pos] !== 0x30) break;
    pos++;
    const vbLen = readBerLength(buf, pos);
    pos = vbLen.next;
    const vbEnd = pos + vbLen.len;
    if (buf[pos] !== 0x06) {
      pos = vbEnd;
      continue;
    }
    pos++;
    const oidLen = readBerLength(buf, pos);
    const oid = decodeOidBytes(buf.subarray(oidLen.next, oidLen.next + oidLen.len));
    pos = oidLen.next + oidLen.len;
    const valTag = buf[pos++];
    const valLen = readBerLength(buf, pos);
    const valSlice = buf.subarray(valLen.next, valLen.next + valLen.len);
    pos = valLen.next + valLen.len;

    if (valTag === 0x02) {
      out[oid] = decodeSignedInt(valSlice);
    } else if (valTag === 0x41 || valTag === 0x42 || valTag === 0x43 || valTag === 0x46) {
      out[oid] = decodeUnsignedInt(valSlice);
    } else if (valTag === 0x04) {
      out[oid] = valSlice.toString('utf8').replace(/\0/g, '').trim();
    } else if (valTag === 0x80 || valTag === 0x81 || valTag === 0x82 || valTag === 0x05) {
      out[oid] = null;
    } else {
      out[oid] = valSlice.toString('hex');
    }
  }
  return out;
}

export async function snmpGetMany(
  host: string,
  community: string,
  oids: string[],
  port = 161,
  timeoutMs = 3000
): Promise<Record<string, string | number | null>> {
  const safeHost = assertSafeDeviceHost(host);
  const merged: Record<string, string | number | null> = {};
  const chunkSize = 8;
  for (let i = 0; i < oids.length; i += chunkSize) {
    const chunk = oids.slice(i, i + chunkSize);
    const reqId = Math.floor(Math.random() * 0x7fff0000) + 1;
    const pkt = buildSnmpGetPacket(community || 'public', reqId, chunk, false);
    const res = await new Promise<Record<string, string | number | null>>((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const timer = setTimeout(() => {
        try {
          sock.close();
        } catch {
          // ignore
        }
        reject(new Error(`انتهت مهلة استجابة SNMP من ${safeHost}:${port}`));
      }, timeoutMs);
      sock.on('error', (err) => {
        clearTimeout(timer);
        try {
          sock.close();
        } catch {
          // ignore
        }
        reject(err);
      });
      sock.on('message', (msg) => {
        clearTimeout(timer);
        try {
          sock.close();
        } catch {
          // ignore
        }
        resolve(parseSnmpResponse(msg));
      });
      sock.send(pkt, port, safeHost);
    });
    Object.assign(merged, res);
  }
  return merged;
}

// ============================================================================
// Vendor-Specific RF Telemetry Result & Fetchers (#1, #2, #3, #5, #6, #7, #15)
// ============================================================================
export interface RfSyncSnapshot {
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
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const cleaned = String(v).replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export async function fetchMikroTikRfSnapshot(
  host: string,
  port: number,
  username: string,
  password: string
): Promise<RfSyncSnapshot> {
  const safeHost = assertSafeDeviceHost(host);
  const client = new RouterOSClient();
  try {
    await client.connect(safeHost, port || 8728, 6000);
    await client.login(username, password);
    const safe = (cmd: string[]) => client.command(cmd).catch(() => [] as RosRow[]);
    const [resRows, wlanRows, regRows, wifiRows, wifiRegRows, w60gRows, w60gStaRows, ethRows] =
      await Promise.all([
        safe(['/system/resource/print']),
        safe(['/interface/wireless/print']),
        safe(['/interface/wireless/registration-table/print']),
        safe(['/interface/wifi/print']),
        safe(['/interface/wifi/registration-table/print']),
        safe(['/interface/w60g/print']),
        safe(['/interface/w60g/station/print']),
        safe(['/interface/ethernet/print']),
      ]);

    const res0 = resRows[0] || {};
    const wl0 = wlanRows[0] || wifiRows[0] || w60gRows[0] || {};
    const rawFreq = numOrNull(wl0.frequency || wl0['channel.frequency']);
    const rawWidth = numOrNull(wl0['channel-width'] || wl0['channel.width']);
    const rawTxPower = numOrNull(wl0['tx-power'] || wl0['configuration.tx-power']);
    const noiseFloor = numOrNull(wl0['noise-floor']);

    const clients: RfStationClient[] = [];
    for (const r of regRows) {
      const sigStr = String(r['signal-strength'] || r['signal-strength-ch0'] || '');
      const sig = numOrNull(sigStr.split('@')[0]);
      const ch0 = numOrNull(r['signal-strength-ch0']?.split('@')[0]);
      const ch1 = numOrNull(r['signal-strength-ch1']?.split('@')[0]);
      const ccq = numOrNull(r['tx-ccq'] || r['rx-ccq']);
      const txMbps = numOrNull(r['tx-rate']);
      const rxMbps = numOrNull(r['rx-rate']);
      const distKm = r.distance ? Number((Number(r.distance) / 1).toFixed(2)) : null;
      clients.push({
        mac: String(r['mac-address'] || ''),
        signalDbm: sig,
        chain0Dbm: ch0,
        chain1Dbm: ch1,
        ccqPct: ccq,
        txRateMbps: txMbps && txMbps > 1000 ? Number((txMbps / 1e6).toFixed(1)) : txMbps,
        rxRateMbps: rxMbps && rxMbps > 1000 ? Number((rxMbps / 1e6).toFixed(1)) : rxMbps,
        distanceKm: Number.isFinite(distKm || NaN) ? distKm : null,
        uptime: String(r.uptime || ''),
        iface: String(r.interface || ''),
      });
    }
    for (const r of wifiRegRows) {
      const sig = numOrNull(r.signal);
      clients.push({
        mac: String(r['mac-address'] || ''),
        signalDbm: sig,
        txRateMbps: numOrNull(r['tx-rate']) ? Number((Number(r['tx-rate']) / 1e6).toFixed(1)) : null,
        rxRateMbps: numOrNull(r['rx-rate']) ? Number((Number(r['rx-rate']) / 1e6).toFixed(1)) : null,
        uptime: String(r.uptime || ''),
        iface: String(r.interface || ''),
      });
    }
    for (const r of w60gStaRows) {
      clients.push({
        mac: String(r['mac-address'] || r.remote || ''),
        signalDbm: numOrNull(r.rssi || r.signal),
        txRateMbps: numOrNull(r['phy-rate']),
        rxRateMbps: numOrNull(r['phy-rate']),
        distanceKm: numOrNull(r.distance) ? Number((Number(r.distance) / 1000).toFixed(2)) : null,
        iface: String(r.interface || 'wlan60-1'),
      });
    }

    const avgSig = clients.length
      ? Math.round(
          clients.reduce((a, c) => a + (c.signalDbm ?? -65), 0) / clients.length
        )
      : null;
    const avgCcq = clients.some((c) => c.ccqPct !== null)
      ? Math.round(
          clients.filter((c) => c.ccqPct !== null).reduce((a, c) => a + (c.ccqPct || 0), 0) /
            clients.filter((c) => c.ccqPct !== null).length
        )
      : null;
    const firstCh0 = clients.find((c) => c.chain0Dbm !== null)?.chain0Dbm ?? null;
    const firstCh1 = clients.find((c) => c.chain1Dbm !== null)?.chain1Dbm ?? null;
    const imbalance =
      firstCh0 !== null && firstCh1 !== null ? Math.abs(firstCh0 - firstCh1) : null;
    const snr =
      avgSig !== null && noiseFloor !== null ? Math.round(avgSig - noiseFloor) : null;
    const runningEth = ethRows.find((e) => e.running === 'true') || ethRows[0];
    const lanSpeed = runningEth
      ? String(runningEth.rate || runningEth.speed || (runningEth.running === 'true' ? '1G' : 'Down'))
      : null;

    return {
      model: String(res0['board-name'] || 'MikroTik Wireless'),
      ssid: String(wl0.ssid || wl0['configuration.ssid'] || ''),
      frequencyMhz: rawFreq,
      channelWidthMhz: rawWidth,
      txPowerDbm: rawTxPower,
      ccqPct: avgCcq,
      airtimePct: numOrNull(wl0['airtime-usage'] || wl0['airtime']),
      signalDbm: avgSig,
      noiseFloorDbm: noiseFloor,
      snrDb: snr,
      chain0Dbm: firstCh0,
      chain1Dbm: firstCh1,
      chainImbalanceDb: imbalance,
      txRateMbps: clients[0]?.txRateMbps ?? null,
      rxRateMbps: clients[0]?.rxRateMbps ?? null,
      distanceKm: clients[0]?.distanceKm ?? null,
      lanSpeed,
      clients,
    };
  } finally {
    client.close();
  }
}

function fetchHttpJson(
  urlStr: string,
  timeoutMs = 3500,
  cookieHeader?: string
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      parsed,
      {
        method: 'GET',
        timeout: timeoutMs,
        rejectUnauthorized: false,
        headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode || 0, body: data, headers: res.headers });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('انتهت مهلة HTTP للاتصال بالجهاز'));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function fetchUbiquitiAirOsHttp(
  host: string,
  port: number,
  username: string,
  password: string
): Promise<RfSyncSnapshot> {
  const safeHost = assertSafeDeviceHost(host);
  const proto = port === 80 ? 'http' : 'https';
  const base = `${proto}://${safeHost}:${port || 443}`;

  // airOS 8/6 login & status.cgi
  const initRes = await fetchHttpJson(`${base}/status.cgi`, 3500);
  let jsonBody = initRes.body;

  if (!jsonBody.trim().startsWith('{')) {
    // Attempt form login via /api/auth (airOS 8) or /login.cgi (airOS 6)
    const loginPayload = JSON.stringify({ username, password });
    const cookie = await new Promise<string>((resolve, reject) => {
      const parsed = new URL(`${base}/api/auth`);
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.request(
        parsed,
        {
          method: 'POST',
          timeout: 3500,
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(loginPayload),
          },
        },
        (res) => {
          const setCookies = res.headers['set-cookie'] || [];
          const ck = setCookies.map((c) => c.split(';')[0]).join('; ');
          res.resume();
          resolve(ck);
        }
      );
      req.on('error', reject);
      req.write(loginPayload);
      req.end();
    });
    const stRes = await fetchHttpJson(`${base}/status.cgi`, 3500, cookie);
    jsonBody = stRes.body;
  }

  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(jsonBody) as Record<string, any>;
  } catch {
    throw new Error('لم يرجع جهاز Ubiquiti استجابة JSON صالحة (تأكد من تفعيل SNMP أو بيانات الدخول)');
  }

  const wl = parsed.wireless || {};
  const hostInfo = parsed.host || {};
  const ifaces: Array<Record<string, any>> = Array.isArray(parsed.interfaces) ? parsed.interfaces : [];
  const eth = ifaces.find((i) => String(i.ifname || '').startsWith('eth')) || {};
  const ethStatus = eth.status || {};
  const signal = numOrNull(wl.signal);
  const noise = numOrNull(wl.noisef);
  const ch0 = numOrNull(wl.chainrssi?.[0]);
  const ch1 = numOrNull(wl.chainrssi?.[1]);
  const ch0Dbm = ch0 !== null ? -96 + ch0 : null;
  const ch1Dbm = ch1 !== null ? -96 + ch1 : null;
  const staList: Array<Record<string, any>> = Array.isArray(wl.sta) ? wl.sta : [];

  return {
    model: String(hostInfo.devmodel || 'Ubiquiti airMAX'),
    ssid: String(wl.essid || ''),
    frequencyMhz: numOrNull(wl.frequency),
    channelWidthMhz: numOrNull(wl.chanbw),
    txPowerDbm: numOrNull(wl.txpower),
    ccqPct: numOrNull(wl.ccq) ? Math.round(Number(wl.ccq) / 10) : null,
    airtimePct: numOrNull(wl.polling?.use),
    signalDbm: signal,
    noiseFloorDbm: noise,
    snrDb: signal !== null && noise !== null ? Math.round(signal - noise) : null,
    chain0Dbm: ch0Dbm,
    chain1Dbm: ch1Dbm,
    chainImbalanceDb:
      ch0Dbm !== null && ch1Dbm !== null ? Math.abs(ch0Dbm - ch1Dbm) : null,
    txRateMbps: numOrNull(wl.txrate),
    rxRateMbps: numOrNull(wl.rxrate),
    distanceKm: numOrNull(wl.distance) ? Number((Number(wl.distance) / 1000).toFixed(2)) : null,
    lanSpeed: ethStatus.speed ? `${ethStatus.speed}M` : null,
    clients: staList.map((s) => ({
      mac: String(s.mac || ''),
      signalDbm: numOrNull(s.signal),
      noiseFloorDbm: numOrNull(s.noisef),
      ccqPct: numOrNull(s.ccq),
      txRateMbps: numOrNull(s.tx),
      rxRateMbps: numOrNull(s.rx),
      distanceKm: numOrNull(s.distance) ? Number((Number(s.distance) / 1000).toFixed(2)) : null,
      uptime: String(s.uptime || ''),
    })) as RfStationClient[],
  };
}

export async function fetchSnmpRfSnapshot(
  host: string,
  vendor: RfVendor,
  community: string,
  port = 161
): Promise<RfSyncSnapshot> {
  // Vendor-specific OID bundles + MIB-2 common OIDs
  const sysDescr = '1.3.6.1.2.1.1.1.0';
  const ifSpeed1 = '1.3.6.1.2.1.2.2.1.5.1';
  const ifSpeed2 = '1.3.6.1.2.1.2.2.1.5.2';

  const vendorOids: Record<RfVendor, string[]> = {
    ubiquiti: [
      sysDescr,
      ifSpeed1,
      ifSpeed2,
      '1.3.6.1.4.1.41112.1.4.5.1.2.1', // ubntWlStatSsid
      '1.3.6.1.4.1.41112.1.4.1.1.4.1', // ubntRadioFreq
      '1.3.6.1.4.1.41112.1.4.1.1.6.1', // ubntRadioTxPower
      '1.3.6.1.4.1.41112.1.4.5.1.5.1', // ubntWlStatSignal
      '1.3.6.1.4.1.41112.1.4.5.1.8.1', // ubntWlStatNoiseFloor
      '1.3.6.1.4.1.41112.1.4.5.1.7.1', // ubntWlStatCcq
      '1.3.6.1.4.1.41112.1.4.5.1.9.1', // ubntWlStatTxRate
      '1.3.6.1.4.1.41112.1.4.5.1.10.1', // ubntWlStatRxRate
      '1.3.6.1.4.1.41112.1.4.6.1.1.1', // ubntAirMaxQuality
    ],
    mimosa: [
      sysDescr,
      ifSpeed1,
      '1.3.6.1.4.1.43356.2.1.2.1.1.0', // mimosaPhySsid / DeviceName
      '1.3.6.1.4.1.43356.2.1.2.6.1.1.3.1', // center freq MHz
      '1.3.6.1.4.1.43356.2.1.2.6.1.1.4.1', // channel width MHz
      '1.3.6.1.4.1.43356.2.1.2.6.1.1.6.1', // txPower
      '1.3.6.1.4.1.43356.2.1.2.6.2.1.2.1', // rxPower / Signal dBm
      '1.3.6.1.4.1.43356.2.1.2.6.2.1.3.1', // noise floor
      '1.3.6.1.4.1.43356.2.1.2.6.2.1.5.1', // SNR
      '1.3.6.1.4.1.43356.2.1.2.6.2.1.8.1', // txPhyMbps
      '1.3.6.1.4.1.43356.2.1.2.6.2.1.9.1', // rxPhyMbps
    ],
    cambium: [
      sysDescr,
      ifSpeed1,
      '1.3.6.1.4.1.17713.21.1.2.1.0', // cambium ePMP SSID
      '1.3.6.1.4.1.17713.21.1.2.3.0', // RF Frequency
      '1.3.6.1.4.1.17713.21.1.2.4.0', // Channel Bandwidth
      '1.3.6.1.4.1.17713.21.1.2.12.0', // DL RSSI
      '1.3.6.1.4.1.17713.21.1.2.13.0', // DL SNR
      '1.3.6.1.4.1.17713.21.1.2.21.0', // DL Airtime %
    ],
    mikrotik: [
      sysDescr,
      ifSpeed1,
      '1.3.6.1.4.1.14988.1.1.1.1.1.7.1', // mtxrWlStatSsid
      '1.3.6.1.4.1.14988.1.1.1.1.1.6.1', // mtxrWlStatFreq
      '1.3.6.1.4.1.14988.1.1.1.1.1.4.1', // mtxrWlStatStrength
      '1.3.6.1.4.1.14988.1.1.1.3.1.9.1', // mtxrWlApNoiseFloor
    ],
  };

  const raw = await snmpGetMany(host, community || 'public', vendorOids[vendor], port || 161);
  const descr = raw[sysDescr] ? String(raw[sysDescr]) : `${vendor.toUpperCase()} SNMP`;
  const spdBps = Number(raw[ifSpeed1] || raw[ifSpeed2] || 0);
  const lanSpeed =
    spdBps >= 1e9 ? '1G' : spdBps >= 1e8 ? '100M' : spdBps > 0 ? '10M' : null;

  if (vendor === 'ubiquiti') {
    const sig = numOrNull(raw['1.3.6.1.4.1.41112.1.4.5.1.5.1']);
    const noise = numOrNull(raw['1.3.6.1.4.1.41112.1.4.5.1.8.1']);
    return {
      model: descr.slice(0, 64),
      ssid: raw['1.3.6.1.4.1.41112.1.4.5.1.2.1'] ? String(raw['1.3.6.1.4.1.41112.1.4.5.1.2.1']) : null,
      frequencyMhz: numOrNull(raw['1.3.6.1.4.1.41112.1.4.1.1.4.1']),
      channelWidthMhz: null,
      txPowerDbm: numOrNull(raw['1.3.6.1.4.1.41112.1.4.1.1.6.1']),
      ccqPct: numOrNull(raw['1.3.6.1.4.1.41112.1.4.5.1.7.1']),
      airtimePct: numOrNull(raw['1.3.6.1.4.1.41112.1.4.6.1.1.1']),
      signalDbm: sig,
      noiseFloorDbm: noise,
      snrDb: sig !== null && noise !== null ? Math.round(sig - noise) : null,
      chain0Dbm: null,
      chain1Dbm: null,
      chainImbalanceDb: null,
      txRateMbps: numOrNull(raw['1.3.6.1.4.1.41112.1.4.5.1.9.1'])
        ? Number((Number(raw['1.3.6.1.4.1.41112.1.4.5.1.9.1']) / 1e6).toFixed(1))
        : null,
      rxRateMbps: numOrNull(raw['1.3.6.1.4.1.41112.1.4.5.1.10.1'])
        ? Number((Number(raw['1.3.6.1.4.1.41112.1.4.5.1.10.1']) / 1e6).toFixed(1))
        : null,
      distanceKm: null,
      lanSpeed,
      clients: [],
    };
  }

  if (vendor === 'mimosa') {
    const sig = numOrNull(raw['1.3.6.1.4.1.43356.2.1.2.6.2.1.2.1']);
    const noise = numOrNull(raw['1.3.6.1.4.1.43356.2.1.2.6.2.1.3.1']);
    const snr = numOrNull(raw['1.3.6.1.4.1.43356.2.1.2.6.2.1.5.1']);
    return {
      model: descr.slice(0, 64),
      ssid: raw['1.3.6.1.4.1.43356.2.1.2.1.1.0'] ? String(raw['1.3.6.1.4.1.43356.2.1.2.1.1.0']) : null,
      frequencyMhz: numOrNull(raw['1.3.6.1.4.1.43356.2.1.2.6.1.1.3.1']),
      channelWidthMhz: numOrNull(raw['1.3.6.1.4.1.43356.2.1.2.6.1.1.4.1']),
      txPowerDbm: numOrNull(raw['1.3.6.1.4.1.43356.2.1.2.6.1.1.6.1']),
      ccqPct: null,
      airtimePct: null,
      signalDbm: sig,
      noiseFloorDbm: noise,
      snrDb: snr ?? (sig !== null && noise !== null ? Math.round(sig - noise) : null),
      chain0Dbm: null,
      chain1Dbm: null,
      chainImbalanceDb: null,
      txRateMbps: numOrNull(raw['1.3.6.1.4.1.43356.2.1.2.6.2.1.8.1']),
      rxRateMbps: numOrNull(raw['1.3.6.1.4.1.43356.2.1.2.6.2.1.9.1']),
      distanceKm: null,
      lanSpeed,
      clients: [],
    };
  }

  if (vendor === 'cambium') {
    const sig = numOrNull(raw['1.3.6.1.4.1.17713.21.1.2.12.0']);
    const snr = numOrNull(raw['1.3.6.1.4.1.17713.21.1.2.13.0']);
    return {
      model: descr.slice(0, 64),
      ssid: raw['1.3.6.1.4.1.17713.21.1.2.1.0'] ? String(raw['1.3.6.1.4.1.17713.21.1.2.1.0']) : null,
      frequencyMhz: numOrNull(raw['1.3.6.1.4.1.17713.21.1.2.3.0']),
      channelWidthMhz: numOrNull(raw['1.3.6.1.4.1.17713.21.1.2.4.0']),
      txPowerDbm: null,
      ccqPct: null,
      airtimePct: numOrNull(raw['1.3.6.1.4.1.17713.21.1.2.21.0']),
      signalDbm: sig,
      noiseFloorDbm: sig !== null && snr !== null ? sig - snr : null,
      snrDb: snr,
      chain0Dbm: null,
      chain1Dbm: null,
      chainImbalanceDb: null,
      txRateMbps: null,
      rxRateMbps: null,
      distanceKm: null,
      lanSpeed,
      clients: [],
    };
  }

  const sig = numOrNull(raw['1.3.6.1.4.1.14988.1.1.1.1.1.4.1']);
  const noise = numOrNull(raw['1.3.6.1.4.1.14988.1.1.1.3.1.9.1']);
  return {
    model: descr.slice(0, 64),
    ssid: raw['1.3.6.1.4.1.14988.1.1.1.1.1.7.1'] ? String(raw['1.3.6.1.4.1.14988.1.1.1.1.1.7.1']) : null,
    frequencyMhz: numOrNull(raw['1.3.6.1.4.1.14988.1.1.1.1.1.6.1']),
    channelWidthMhz: null,
    txPowerDbm: null,
    ccqPct: null,
    airtimePct: null,
    signalDbm: sig,
    noiseFloorDbm: noise,
    snrDb: sig !== null && noise !== null ? Math.round(sig - noise) : null,
    chain0Dbm: null,
    chain1Dbm: null,
    chainImbalanceDb: null,
    txRateMbps: null,
    rxRateMbps: null,
    distanceKm: null,
    lanSpeed,
    clients: [],
  };
}

export async function pollRfRadio(params: {
  host: string;
  vendor: RfVendor;
  protocol: RfProtocol;
  port: number;
  username: string;
  secret: string;
}): Promise<RfSyncSnapshot> {
  if (params.protocol === 'ros') {
    return fetchMikroTikRfSnapshot(params.host, params.port || 8728, params.username, params.secret);
  }
  if (params.protocol === 'airos') {
    return fetchUbiquitiAirOsHttp(params.host, params.port || 443, params.username, params.secret);
  }
  return fetchSnmpRfSnapshot(params.host, params.vendor, params.secret || 'public', params.port || 161);
}

// ============================================================================
// Spectral / Clean Frequency Scan (#4) + Frequency Shift (#8) + Reboot (#14)
// ============================================================================
export async function scanMikroTikCleanFrequencies(
  host: string,
  port: number,
  username: string,
  password: string,
  iface = 'wlan1'
): Promise<Array<{ frequencyMhz: number; usagePct: number; noiseDbm: number; rating: 'clean' | 'busy' | 'noisy' }>> {
  const safeHost = assertSafeDeviceHost(host);
  const client = new RouterOSClient();
  try {
    await client.connect(safeHost, port || 8728, 7000);
    await client.login(username, password);
    const wlans = await client.command(['/interface/wireless/print']).catch(() => [] as RosRow[]);
    const targetIface = wlans[0]?.name || iface;
    const rows = await client
      .command(['/interface/wireless/frequency-monitor', `=number=${targetIface}`, '=duration=2'])
      .catch(() => [] as RosRow[]);
    return rows
      .filter((r) => r.freq || r.frequency)
      .map((r) => {
        const freq = Number(String(r.freq || r.frequency).replace(/[^\d]/g, '')) || 5180;
        const use = Number(String(r.use || r['nf-use'] || '0').replace(/[^\d.]/g, '')) || 0;
        const noise = Number(String(r['noise-floor'] || '-95').replace(/[^\d.-]/g, '')) || -95;
        const rating: 'clean' | 'busy' | 'noisy' =
          use < 18 && noise <= -90 ? 'clean' : use < 45 ? 'busy' : 'noisy';
        return { frequencyMhz: freq, usagePct: Math.round(use), noiseDbm: Math.round(noise), rating };
      })
      .sort((a, b) => a.usagePct - b.usagePct || a.noiseDbm - b.noiseDbm);
  } finally {
    client.close();
  }
}

export async function applyFrequencyShift(params: {
  host: string;
  port: number;
  username: string;
  password: string;
  frequencyMhz: number;
  scheduleTime?: string; // HH:MM:SS optional
}): Promise<void> {
  const safeHost = assertSafeDeviceHost(params.host);
  if (!Number.isInteger(params.frequencyMhz) || params.frequencyMhz < 2400 || params.frequencyMhz > 68000) {
    throw new Error('التردد المطلوب خارج النطاق المسموح');
  }
  const client = new RouterOSClient();
  try {
    await client.connect(safeHost, params.port || 8728, 6000);
    await client.login(params.username, params.password);
    const wlans = await client.command(['/interface/wireless/print']).catch(() => [] as RosRow[]);
    if (!wlans[0]?.['.id']) {
      throw new Error('لم يتم العثور على واجهة لاسلكية على الجهاز');
    }
    const ifaceName = wlans[0].name || 'wlan1';
    if (params.scheduleTime && /^\d{2}:\d{2}(:\d{2})?$/.test(params.scheduleTime.trim())) {
      const timeStr = params.scheduleTime.trim().length === 5 ? `${params.scheduleTime.trim()}:00` : params.scheduleTime.trim();
      await client.command([
        '/system/scheduler/add',
        `=name=bro-freq-${params.frequencyMhz}`,
        `=start-time=${timeStr}`,
        '=interval=0s',
        `=on-event=/interface wireless set [find name="${ifaceName}"] frequency=${params.frequencyMhz}; /system scheduler remove [find name="bro-freq-${params.frequencyMhz}"]`,
      ]);
    } else {
      await client.command([
        '/interface/wireless/set',
        `=.id=${wlans[0]['.id']}`,
        `=frequency=${params.frequencyMhz}`,
      ]);
    }
  } finally {
    client.close();
  }
}

export async function rebootRfRadio(params: {
  host: string;
  protocol: RfProtocol;
  port: number;
  username: string;
  secret: string;
}): Promise<void> {
  const safeHost = assertSafeDeviceHost(params.host);
  if (params.protocol === 'ros') {
    const client = new RouterOSClient();
    try {
      await client.connect(safeHost, params.port || 8728, 5000);
      await client.login(params.username, params.secret);
      await client.command(['/system/reboot']).catch(() => undefined);
      return;
    } finally {
      client.close();
    }
  }
  if (params.protocol === 'airos') {
    const proto = params.port === 80 ? 'http' : 'https';
    await fetchHttpJson(`${proto}://${safeHost}:${params.port || 443}/reboot.cgi`, 3000).catch(() => undefined);
    return;
  }
  throw new Error('إعادة التشغيل عن بُعد تتطلب بروتوكول RouterOS أو Ubiquiti HTTP');
}

// ============================================================================
// Dynamic Tower Health Score 0–100 (#99)
// ============================================================================
export function computeTowerHealthScore(params: {
  radios: Array<{
    status: string;
    ccqPct: number | null;
    noiseFloorDbm: number | null;
    chainImbalanceDb: number | null;
    lanSpeed: string | null;
  }>;
  subscribers: Array<{ online: boolean; flapCountToday: number }>;
}): number {
  let score = 100;
  if (params.radios.length > 0) {
    const offlineRadios = params.radios.filter((r) => r.status === 'offline').length;
    score -= Math.round((offlineRadios / params.radios.length) * 45);
    for (const r of params.radios) {
      if (r.ccqPct !== null && r.ccqPct < 80) score -= 8;
      if (r.noiseFloorDbm !== null && r.noiseFloorDbm > -85) score -= 7;
      if (r.chainImbalanceDb !== null && r.chainImbalanceDb > 6) score -= 6;
      if (r.lanSpeed === '10M') score -= 8;
    }
  }
  if (params.subscribers.length > 0) {
    const onlinePct = params.subscribers.filter((s) => s.online).length / params.subscribers.length;
    if (onlinePct < 0.7) score -= Math.round((0.7 - onlinePct) * 35);
    const flappingCount = params.subscribers.filter((s) => s.flapCountToday > 10).length;
    score -= Math.min(15, flappingCount * 3);
  }
  return Math.max(0, Math.min(100, score));
}
