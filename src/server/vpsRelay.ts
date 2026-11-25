import crypto from 'crypto';
import https from 'https';
import zlib from 'zlib';
import { decryptSecret, encryptSecret, generateX25519Keypair } from './crypto.ts';
import { db } from './db.ts';
import type { VpsRelayStatus } from '../types.ts';

export interface StoredVpsRelayConfig {
  host: string;
  relayPort: number;
  wgPort: number;
  instanceOcid?: string;
  relaySecretEnc: string;
  wgPrivateKeyEnc: string;
  wgPublicKey: string;
  verified: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  activePeersCount?: number;
}

function metaKey(ownerId: string): string {
  return `vps_cfg_${ownerId}`;
}

export function getVpsRelayConfig(ownerId: string): StoredVpsRelayConfig | null {
  const row = db
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get(metaKey(ownerId)) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as StoredVpsRelayConfig;
  } catch {
    return null;
  }
}

export function saveVpsRelayConfig(ownerId: string, cfg: StoredVpsRelayConfig): void {
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(
    metaKey(ownerId),
    JSON.stringify(cfg)
  );
}

export function deleteVpsRelayConfig(ownerId: string): void {
  db.prepare('DELETE FROM app_meta WHERE key = ?').run(metaKey(ownerId));
}

export function toPublicVpsStatus(cfg: StoredVpsRelayConfig | null): VpsRelayStatus {
  if (!cfg) {
    return {
      configured: false,
      verified: false,
      host: '',
      relayPort: 8443,
      wgPort: 51820,
      instanceOcid: '',
      wgPublicKey: '',
      lastCheckedAt: null,
      lastError: null,
      activePeersCount: 0,
    };
  }
  return {
    configured: true,
    verified: cfg.verified,
    host: cfg.host,
    relayPort: cfg.relayPort,
    wgPort: cfg.wgPort,
    instanceOcid: cfg.instanceOcid || '',
    wgPublicKey: cfg.wgPublicKey,
    lastCheckedAt: cfg.lastCheckedAt,
    lastError: cfg.lastError,
    activePeersCount: cfg.activePeersCount ?? 0,
  };
}

export function configureVpsRelay(
  ownerId: string,
  host: string,
  relayPort: number,
  wgPort: number,
  instanceOcid?: string
): { cfg: StoredVpsRelayConfig; relaySecret: string; wgPrivateKey: string } {
  const existing = getVpsRelayConfig(ownerId);
  const relaySecret = existing
    ? decryptSecret(existing.relaySecretEnc)
    : crypto.randomBytes(32).toString('hex');
  const keys = existing
    ? {
        privateKey: decryptSecret(existing.wgPrivateKeyEnc),
        publicKey: existing.wgPublicKey,
      }
    : generateX25519Keypair();

  const cleanHost = host.trim();
  const cleanOcid =
    typeof instanceOcid === 'string'
      ? instanceOcid.trim()
      : existing && existing.host === cleanHost
        ? existing.instanceOcid || ''
        : '';

  const cfg: StoredVpsRelayConfig = {
    host: cleanHost,
    relayPort,
    wgPort,
    instanceOcid: cleanOcid,
    relaySecretEnc: encryptSecret(relaySecret),
    wgPrivateKeyEnc: encryptSecret(keys.privateKey),
    wgPublicKey: keys.publicKey,
    verified: false,
    lastCheckedAt: existing?.lastCheckedAt || null,
    lastError: null,
    activePeersCount: existing?.activePeersCount ?? 0,
  };
  saveVpsRelayConfig(ownerId, cfg);
  return { cfg, relaySecret, wgPrivateKey: keys.privateKey };
}

export async function callVpsRelay<T>(
  cfg: StoredVpsRelayConfig,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 12000
): Promise<T> {
  const secret = decryptSecret(cfg.relaySecretEnc);
  const payload = body !== undefined ? JSON.stringify(body) : undefined;

  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        host: cfg.host,
        port: cfg.relayPort,
        path,
        method,
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          Authorization: `Bearer ${secret}`,
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: Record<string, unknown> = {};
          try {
            parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            reject(new Error(`استجابة غير صالحة من بوابة Oracle VPS (HTTP ${res.statusCode})`));
            return;
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(
              new Error(
                typeof parsed.error === 'string'
                  ? parsed.error
                  : `خطأ من بوابة Oracle VPS (HTTP ${res.statusCode})`
              )
            );
            return;
          }
          resolve(parsed as T);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(
        new Error(
          `انتهت مهلة الاتصال ببوابة Oracle VPS (${cfg.host}:${cfg.relayPort}) — تأكد من فتح TCP ${cfg.relayPort} في VCN Security List و iptables`
        )
      );
    });

    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        reject(
          new Error(
            `بوابة Oracle VPS ترفض الاتصال على ${cfg.host}:${cfg.relayPort} — تأكد من تشغيل خدمة bro-wg-relay`
          )
        );
        return;
      }
      if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH') {
        reject(
          new Error(
            `تعذر الوصول إلى ${cfg.host}:${cfg.relayPort} — افتح المنفذ ${cfg.relayPort}/TCP في Oracle VCN Security List`
          )
        );
        return;
      }
      reject(new Error(`خطأ اتصال ببوابة Oracle VPS: ${err.message}`));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

const RELAY_SOURCE_JS = `import https from 'node:https';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.RELAY_PORT || 8443);
const SECRET = process.env.RELAY_SECRET || '';
const WG_IFACE = process.env.WG_INTERFACE || 'wg0';

function authorized(req) {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Bearer ') || !SECRET) return false;
  const tok = h.slice(7).trim();
  const a = Buffer.from(tok, 'utf8');
  const b = Buffer.from(SECRET, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) { const v = len | 0x8000; return Buffer.from([(v >> 8) & 0xff, v & 0xff]); }
  if (len < 0x200000) { const v = len | 0xc00000; return Buffer.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]); }
  if (len < 0x10000000) { const v = len | 0xe0000000; return Buffer.from([(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]); }
  return Buffer.from([0xf0, (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

function encodeSentence(words) {
  const parts = [];
  for (const w of words) {
    const wb = Buffer.from(w, 'utf8');
    parts.push(encodeLength(wb.length), wb);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function decodeLength(buf, offset) {
  if (offset >= buf.length) return null;
  const b0 = buf[offset];
  if ((b0 & 0x80) === 0) return { length: b0, bytesRead: 1 };
  if ((b0 & 0xc0) === 0x80) {
    if (offset + 1 >= buf.length) return null;
    return { length: ((b0 & 0x3f) << 8) + buf[offset + 1], bytesRead: 2 };
  }
  if ((b0 & 0xe0) === 0xc0) {
    if (offset + 2 >= buf.length) return null;
    return { length: ((b0 & 0x1f) << 16) + (buf[offset + 1] << 8) + buf[offset + 2], bytesRead: 3 };
  }
  if ((b0 & 0xf0) === 0xe0) {
    if (offset + 3 >= buf.length) return null;
    return { length: ((b0 & 0x0f) << 24) + (buf[offset + 1] << 16) + (buf[offset + 2] << 8) + buf[offset + 3], bytesRead: 4 };
  }
  if (offset + 4 >= buf.length) return null;
  return { length: (buf[offset + 1] << 24) + (buf[offset + 2] << 16) + (buf[offset + 3] << 8) + buf[offset + 4], bytesRead: 5 };
}

class RosClient {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.currentSentence = [];
    this.sentenceQueue = [];
    this.waiter = null;
    this.errorWaiter = null;
  }
  connect(host, port, timeoutMs = 6000) {
    const start = Date.now();
    const useTls = port === 8729;
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = useTls ? tls.connect({ host, port, rejectUnauthorized: false }) : net.createConnection({ host, port });
      this.socket = sock;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; sock.destroy(); reject(new Error('انتهت مهلة الاتصال بالراوتر عبر نفق Oracle VPS (' + host + ':' + port + ')')); }
      }, timeoutMs);
      sock.once(useTls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        if (!settled) { settled = true; resolve(Date.now() - start); }
      });
      sock.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.parse();
      });
      sock.on('close', () => {
        clearTimeout(timer);
        const err = new Error('أُغلق الاتصال من الراوتر (' + host + ':' + port + ')');
        if (!settled) { settled = true; reject(err); }
        else if (this.errorWaiter) { const ew = this.errorWaiter; this.waiter = null; this.errorWaiter = null; ew(err); }
      });
      sock.on('error', (e) => {
        clearTimeout(timer);
        const msg = e.code === 'ECONNREFUSED'
          ? 'تم رفض الاتصال على ' + host + ':' + port + ' — تأكد من تفعيل خدمة api في الراوتر'
          : 'فشل الوصول للراوتر ' + host + ':' + port + ' (' + e.message + ')';
        const wrapped = new Error(msg);
        if (!settled) { settled = true; reject(wrapped); }
        else if (this.errorWaiter) { const ew = this.errorWaiter; this.waiter = null; this.errorWaiter = null; ew(wrapped); }
      });
    });
  }
  parse() {
    let offset = 0;
    while (offset < this.buffer.length) {
      const dec = decodeLength(this.buffer, offset);
      if (!dec) break;
      if (dec.length === 0) {
        offset += dec.bytesRead;
        const done = this.currentSentence;
        this.currentSentence = [];
        if (this.waiter) { const w = this.waiter; this.waiter = null; this.errorWaiter = null; w(done); }
        else this.sentenceQueue.push(done);
        continue;
      }
      if (offset + dec.bytesRead + dec.length > this.buffer.length) break;
      this.currentSentence.push(this.buffer.subarray(offset + dec.bytesRead, offset + dec.bytesRead + dec.length).toString('utf8'));
      offset += dec.bytesRead + dec.length;
    }
    if (offset > 0) this.buffer = this.buffer.subarray(offset);
  }
  nextSentence(timeoutMs = 6000) {
    if (this.sentenceQueue.length > 0) return Promise.resolve(this.sentenceQueue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiter = null; this.errorWaiter = null; reject(new Error('انتهت مهلة القراءة من المايكروتك')); }, timeoutMs);
      this.waiter = (s) => { clearTimeout(t); resolve(s); };
      this.errorWaiter = (e) => { clearTimeout(t); reject(e); };
    });
  }
  async command(words) {
    if (!this.socket || this.socket.destroyed) throw new Error('الاتصال مغلق');
    this.socket.write(encodeSentence(words));
    const rows = [];
    while (true) {
      const s = await this.nextSentence();
      if (s[0] === '!done') {
        const meta = {};
        for (const w of s.slice(1)) {
          if (w.startsWith('=')) { const idx = w.indexOf('=', 1); if (idx > 1) meta[w.slice(1, idx)] = w.slice(idx + 1); }
        }
        if (Object.keys(meta).length > 0 && rows.length === 0) rows.push(meta);
        return rows;
      }
      if (s[0] === '!trap' || s[0] === '!fatal') {
        throw new Error((s.find((w) => w.startsWith('=message=')) || '').slice(9) || 'RouterOS API error');
      }
      if (s[0] === '!re') {
        const row = {};
        for (const w of s.slice(1)) {
          if (w.startsWith('=')) { const idx = w.indexOf('=', 1); if (idx > 1) row[w.slice(1, idx)] = w.slice(idx + 1); }
        }
        rows.push(row);
      }
    }
  }
  async login(user, pass) {
    try {
      const res = await this.command(['/login', '=name=' + user, '=password=' + pass]);
      if (res[0] && res[0].ret) {
        const ch = Buffer.from(res[0].ret, 'hex');
        const md5 = crypto.createHash('md5').update(Buffer.concat([Buffer.from([0]), Buffer.from(pass, 'utf8'), ch])).digest('hex');
        await this.command(['/login', '=name=' + user, '=response=00' + md5]);
      }
    } catch (e) {
      const msg = String(e.message || '').toLowerCase();
      if (msg.includes('parameter') || msg.includes('unknown')) {
        const res = await this.command(['/login']);
        if (res[0] && res[0].ret) {
          const ch = Buffer.from(res[0].ret, 'hex');
          const md5 = crypto.createHash('md5').update(Buffer.concat([Buffer.from([0]), Buffer.from(pass, 'utf8'), ch])).digest('hex');
          await this.command(['/login', '=name=' + user, '=response=00' + md5]);
          return;
        }
      }
      throw e;
    }
  }
  close() { if (this.socket && !this.socket.destroyed) this.socket.destroy(); }
}

function formatUptimeArabic(u) {
  if (!u) return 'غير متصل';
  const w = (u.match(/(\\d+)w/) || [])[1] || 0;
  const d = (u.match(/(\\d+)d/) || [])[1] || 0;
  const h = (u.match(/(\\d+)h/) || [])[1] || 0;
  const m = (u.match(/(\\d+)m/) || [])[1] || 0;
  const days = Number(w) * 7 + Number(d);
  if (days > 0) return days + ' يوم ' + h + ' س';
  if (Number(h) > 0) return h + ' س ' + m + ' د';
  return Math.max(1, Number(m)) + ' د';
}

const server = https.createServer({
  key: fs.readFileSync('/opt/bro-relay/key.pem'),
  cert: fs.readFileSync('/opt/bro-relay/cert.pem'),
}, async (req, res) => {
  if (!authorized(req)) return sendJson(res, 401, { error: 'Unauthorized relay token' });
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const { stdout: pubOut } = await execFileAsync('wg', ['show', WG_IFACE, 'public-key']);
      const { stdout: hsOut } = await execFileAsync('wg', ['show', WG_IFACE, 'latest-handshakes']).catch(() => ({ stdout: '' }));
      const lines = hsOut.trim() ? hsOut.trim().split('\\n') : [];
      const handshakes = {};
      for (const l of lines) {
        const [k, ep] = l.trim().split(/\\s+/);
        if (k) handshakes[k] = Number(ep || 0);
      }
      return sendJson(res, 200, { ok: true, publicKey: pubOut.trim(), peersCount: lines.length, handshakes });
    }

    const body = await readJson(req);

    if (req.method === 'POST' && req.url === '/wg/peer') {
      if (!/^[A-Za-z0-9+/=]{42,46}$/.test(String(body.publicKey || '')) || !/^10\\.77\\.\\d+\\.\\d+$/.test(String(body.tunnelIp || ''))) {
        return sendJson(res, 400, { error: 'Invalid WireGuard peer parameters' });
      }
      await execFileAsync('wg', ['set', WG_IFACE, 'peer', body.publicKey, 'allowed-ips', body.tunnelIp + '/32']);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && req.url === '/wg/peer') {
      if (!/^[A-Za-z0-9+/=]{42,46}$/.test(String(body.publicKey || ''))) {
        return sendJson(res, 400, { error: 'Invalid WireGuard publicKey' });
      }
      await execFileAsync('wg', ['set', WG_IFACE, 'peer', body.publicKey, 'remove']).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && req.url === '/ros/snapshot') {
      const client = new RosClient();
      try {
        const rttMs = await client.connect(body.host, Number(body.port || 8728));
        await client.login(body.username, body.password || '');
        const safe = (w) => client.command(w).catch(() => []);
        const idRows = await client.command(['/system/identity/print']);
        const resRows = await client.command(['/system/resource/print']);
        const rbRows = await safe(['/system/routerboard/print']);
        const healthRows = await safe(['/system/health/print']);
        const cpuRows = await safe(['/system/resource/cpu/print']);
        const ethRows = await safe(['/interface/ethernet/print']);
        const bondRows = await safe(['/interface/bonding/print']);
        const bridgeRows = await safe(['/interface/bridge/print']);
        const nbRows = await safe(['/ip/neighbor/print']);
        const pppActRows = await safe(['/ppp/active/print']);
        const pppSecRows = await safe(['/ppp/secret/print']);
        const hsActRows = await safe(['/ip/hotspot/active/print']);
        const dhcpRows = await safe(['/ip/dhcp-server/lease/print']);
        const queueRows = await safe(['/queue/simple/print']);
        const connRows = await safe(['/ip/firewall/connection/print', '=count-only=']);

        const res0 = resRows[0] || {};
        const rb0 = rbRows[0] || {};
        const id0 = idRows[0] || {};
        const totalMem = Number(res0['total-memory'] || 0);
        const freeMem = Number(res0['free-memory'] || 0);
        const prevMap = new Map((body.existingPorts || []).map((p) => [p.name, p]));
        const allIfaces = [
          ...ethRows.map((e) => ({ row: e, type: (e.name || '').includes('sfp') ? 'sfp' : 'ether' })),
          ...bondRows.map((b) => ({ row: b, type: 'bonding' })),
          ...bridgeRows.map((br) => ({ row: br, type: 'bridge' })),
        ];
        const activeNames = allIfaces.filter((i) => i.row.running === 'true').slice(0, 16).map((i) => i.row.name).filter(Boolean);
        const trafficMap = new Map();
        if (activeNames.length > 0) {
          const mon = await safe(['/interface/monitor-traffic', '=interface=' + activeNames.join(','), '=once=']);
          for (const m of mon) {
            if (m.name) trafficMap.set(m.name, { rxMbps: Number((Number(m['rx-bits-per-second'] || 0) / 1e6).toFixed(2)), txMbps: Number((Number(m['tx-bits-per-second'] || 0) / 1e6).toFixed(2)) });
          }
        }
        let tempCelsius = null, voltage = null; const fanRpm = [];
        for (const h of healthRows) {
          if (h.name && h.value) {
            const l = h.name.toLowerCase();
            if (l.includes('temp')) tempCelsius = Math.round(Number(h.value));
            if (l.includes('volt')) voltage = Number(h.value);
            if (l.includes('fan') && h.type === 'RPM') fanRpm.push(Math.round(Number(h.value)));
          } else {
            if (h.temperature) tempCelsius = Math.round(Number(h.temperature));
            if (h.voltage) voltage = Number(h.voltage);
          }
        }
        const ports = allIfaces.map(({ row, type }) => {
          const name = row.name || 'ether';
          const prev = prevMap.get(name);
          const isUp = row.running === 'true';
          const raw = row.rate || row.speed || '';
          const speed = isUp ? (raw.includes('10G') ? '10G' : raw.includes('1G') ? '1G' : raw.includes('100M') ? '100M' : raw || '1G') : 'down';
          const t = trafficMap.get(name);
          return {
            id: name, name, label: (prev && prev.label) || row.comment || name, role: (prev && prev.role) || 'Unassigned',
            type, status: isUp ? 'up' : 'down', speed, expectedSpeed: (prev && prev.expectedSpeed) || '1G',
            duplex: isUp ? (row['full-duplex'] === 'false' ? 'Half' : 'Full') : 'None',
            monitored: prev ? prev.monitored : false,
            rxMbps: t ? t.rxMbps : 0, txMbps: t ? t.txMbps : 0,
            rxBytesToday: Number(row['rx-byte'] || 0), txBytesToday: Number(row['tx-byte'] || 0),
            rxErrors: Number(row['rx-fcs-error'] || 0), rxDrops: Number(row['rx-drop'] || 0),
            sfpTempC: row['sfp-temperature'] ? Number(row['sfp-temperature']) : null,
            sfpRxDbm: row['sfp-rx-power'] ? Number(row['sfp-rx-power']) : null,
            sfpTxDbm: row['sfp-tx-power'] ? Number(row['sfp-tx-power']) : null,
            disconnectCount: (prev && prev.disconnectCount) || 0, lastDisconnect: prev && prev.lastDisconnect,
          };
        });
        return sendJson(res, 200, {
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
          cpuCoreLoads: cpuRows.map((c, idx) => ({ core: idx, load: Number(c.load || 0) })),
          ramTotalMb: totalMem > 0 ? Math.round(totalMem / (1024 * 1024)) : 0,
          ramPercent: totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0,
          cpuPercent: Number(res0['cpu-load'] || 0),
          uptimeText: formatUptimeArabic(res0.uptime || ''),
          tempCelsius, voltage, fanRpm,
          activeConnections: Number((connRows[0] && connRows[0].ret) || 0),
          ports,
          neighbors: nbRows.map((n, idx) => ({
            id: 'nb-' + idx + '-' + (n.mac || n.address || idx),
            identity: n.identity || n.address || 'Unknown',
            platform: n.platform || 'Unknown',
            board: n.board || n['system-description'] || '',
            interfaceName: n.interface || '',
            ip: n.address || n.address4 || '',
            mac: n['mac-address'] || '',
            signalDbm: null,
          })),
          pppoeActive: pppActRows, pppoeSecrets: pppSecRows,
          hotspotOnline: hsActRows.length, dhcpLeasesCount: dhcpRows.length, queues: queueRows,
        });
      } finally { client.close(); }
    }

    if (req.method === 'POST' && req.url === '/ros/ping') {
      const client = new RosClient();
      try {
        await client.connect(body.host, Number(body.port || 8728), 4000);
        await client.login(body.username, body.password || '');
        const rows = await client.command(['/tool/ping', '=address=' + body.targetIp, '=count=4']);
        const received = rows.filter((r) => r.time || r['avg-rtt']).length;
        const loss = Math.round(((4 - received) / 4) * 100);
        const times = rows.map((r) => parseFloat((r.time || '0').replace('ms', ''))).filter((n) => !Number.isNaN(n) && n > 0);
        const avg = times.length > 0 ? Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)) : null;
        return sendJson(res, 200, { status: received > 0 ? 'up' : 'down', latencyMs: avg, packetLossPct: loss });
      } finally { client.close(); }
    }

    if (req.method === 'POST' && req.url === '/ros/commands') {
      const client = new RosClient();
      try {
        await client.connect(body.host, Number(body.port || 8728));
        await client.login(body.username, body.password || '');
        const results = [];
        for (const words of body.commands || []) {
          if (body.allowTrap) {
            results.push(await client.command(words).catch(() => []));
          } else {
            results.push(await client.command(words));
          }
        }
        return sendJson(res, 200, { results });
      } finally { client.close(); }
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 502, { error: err instanceof Error ? err.message : 'Relay error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Bro Radius WireGuard Relay listening on :' + PORT);
});
`;

export function buildOracleRelayInstallScript(params: {
  host: string;
  relayPort: number;
  wgPort: number;
  relaySecret: string;
  wgPrivateKey: string;
}): string {
  const relayGzB64 = zlib.gzipSync(Buffer.from(RELAY_SOURCE_JS, 'utf8')).toString('base64');
  return [
    `sudo bash -c '`,
    `set -e`,
    `export DEBIAN_FRONTEND=noninteractive`,
    `echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections || true`,
    `echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections || true`,
    `apt-get update -y && apt-get install -y wireguard wireguard-tools openssl curl iptables-persistent`,
    `if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; fi`,
    `mkdir -p /etc/wireguard /opt/bro-relay`,
    `chmod 700 /etc/wireguard`,
    `cat << "WGEOF" > /etc/wireguard/wg0.conf`,
    `[Interface]`,
    `Address = 10.77.0.1/16`,
    `ListenPort = ${params.wgPort}`,
    `PrivateKey = ${params.wgPrivateKey}`,
    `SaveConfig = false`,
    `WGEOF`,
    `chmod 600 /etc/wireguard/wg0.conf`,
    `sysctl -w net.ipv4.ip_forward=1 >/dev/null`,
    `systemctl enable wg-quick@wg0 && systemctl restart wg-quick@wg0`,
    `echo "${relayGzB64}" | base64 -d | gunzip > /opt/bro-relay/relay.mjs`,
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout /opt/bro-relay/key.pem -out /opt/bro-relay/cert.pem -days 3650 -subj "/CN=${params.host}" >/dev/null 2>&1`,
    `chmod 600 /opt/bro-relay/key.pem`,
    `cat << "SVCEOF" > /etc/systemd/system/bro-wg-relay.service`,
    `[Unit]`,
    `Description=Bro Radius WireGuard Relay`,
    `After=network.target wg-quick@wg0.service`,
    `[Service]`,
    `Type=simple`,
    `Environment="RELAY_PORT=${params.relayPort}"`,
    `Environment="RELAY_SECRET=${params.relaySecret}"`,
    `Environment="WG_INTERFACE=wg0"`,
    `ExecStart=/usr/bin/node /opt/bro-relay/relay.mjs`,
    `Restart=always`,
    `RestartSec=2`,
    `[Install]`,
    `WantedBy=multi-user.target`,
    `SVCEOF`,
    `iptables -C INPUT -p udp --dport ${params.wgPort} -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p udp --dport ${params.wgPort} -j ACCEPT`,
    `iptables -C INPUT -p tcp --dport ${params.relayPort} -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport ${params.relayPort} -j ACCEPT`,
    `iptables -C INPUT -i wg0 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -i wg0 -j ACCEPT`,
    `if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow ${params.wgPort}/udp >/dev/null || true; ufw allow ${params.relayPort}/tcp >/dev/null || true; fi`,
    `netfilter-persistent save >/dev/null 2>&1 || true`,
    `systemctl daemon-reload && systemctl enable --now bro-wg-relay`,
    `echo "=== BRO RADIUS ORACLE RELAY READY (${params.host}:${params.relayPort}) ==="`,
    `'`,
  ].join('\n');
}

export function buildOracleCloudShellScript(params: {
  host: string;
  relayPort: number;
  wgPort: number;
  relaySecret: string;
  wgPrivateKey: string;
  instanceOcid?: string;
}): string | null {
  const ocid = (params.instanceOcid || '').trim();
  if (!/^ocid1\.instance\.[a-z0-9._-]+$/i.test(ocid)) {
    return null;
  }
  const innerScript = buildOracleRelayInstallScript({
    host: params.host,
    relayPort: params.relayPort,
    wgPort: params.wgPort,
    relaySecret: params.relaySecret,
    wgPrivateKey: params.wgPrivateKey,
  });
  const innerB64 = Buffer.from(innerScript, 'utf8').toString('base64');

  return [
    `INST="${ocid}"`,
    `COMP=$(oci compute instance get --instance-id "$INST" --query 'data."compartment-id"' --raw-output)`,
    `VNIC=$(oci compute vnic-attachment list --compartment-id "$COMP" --instance-id "$INST" --query 'data[0]."vnic-id"' --raw-output)`,
    `SUBNET=$(oci network vnic get --vnic-id "$VNIC" --query 'data."subnet-id"' --raw-output)`,
    `SL=$(oci network subnet get --subnet-id "$SUBNET" --query 'data."security-list-ids"[0]' --raw-output)`,
    `oci network security-list get --security-list-id "$SL" --query 'data."ingress-security-rules"' > /tmp/bro-in.json`,
    `python3 -c '`,
    `import json, base64`,
    `rules = json.load(open("/tmp/bro-in.json"))`,
    `if not any(r.get("protocol")=="6" and ((r.get("tcp-options") or {}).get("destination-port-range") or {}).get("min")==${params.relayPort} for r in rules):`,
    `    rules.append({"is-stateless": False, "protocol": "6", "source": "0.0.0.0/0", "source-type": "CIDR_BLOCK", "tcp-options": {"destination-port-range": {"min": ${params.relayPort}, "max": ${params.relayPort}}}, "description": "Bro Radius Relay HTTPS"})`,
    `if not any(r.get("protocol")=="17" and ((r.get("udp-options") or {}).get("destination-port-range") or {}).get("min")==${params.wgPort} for r in rules):`,
    `    rules.append({"is-stateless": False, "protocol": "17", "source": "0.0.0.0/0", "source-type": "CIDR_BLOCK", "udp-options": {"destination-port-range": {"min": ${params.wgPort}, "max": ${params.wgPort}}}, "description": "Bro Radius WireGuard"})`,
    `json.dump(rules, open("/tmp/bro-out.json", "w"))`,
    `b64 = "${innerB64}"`,
    `parts = [b64[i:i+2800] for i in range(0, len(b64), 2800)]`,
    `for idx, ch in enumerate(parts):`,
    `    op = ">" if idx == 0 else ">>"`,
    `    cmd = f"printf %s {ch} {op} /tmp/bro.b64"`,
    `    json.dump({"source": {"sourceType": "TEXT", "text": cmd}, "output": {"outputType": "TEXT"}}, open(f"/tmp/bro-c{idx}.json", "w"))`,
    `exec_cmd = "base64 -d /tmp/bro.b64 > /tmp/bro-run.sh && bash /tmp/bro-run.sh"`,
    `json.dump({"source": {"sourceType": "TEXT", "text": exec_cmd}, "output": {"outputType": "TEXT"}}, open("/tmp/bro-exec.json", "w"))`,
    `open("/tmp/bro-count.txt", "w").write(str(len(parts)))`,
    `'`,
    `oci network security-list update --security-list-id "$SL" --ingress-security-rules file:///tmp/bro-out.json --force >/dev/null`,
    `echo "OK: VCN ports ${params.relayPort}/TCP & ${params.wgPort}/UDP ready!"`,
    `run_oci() {`,
    `  local F="$1"; local TM="$2"`,
    `  local CID; CID=$(oci instance-agent command create --compartment-id "$COMP" --target "{\\"instanceId\\": \\"$INST\\"}" --content "file://$F" --timeout-in-seconds "$TM" --display-name "BroRadius-Setup" --query 'data.id' --raw-output)`,
    `  [ -z "$CID" ] && echo "ERR creating command" && return 1`,
    `  for i in $(seq 1 90); do`,
    `    ST=$(oci instance-agent command-execution get --command-id "$CID" --instance-id "$INST" --query 'data."lifecycle-state"' --raw-output 2>/dev/null || echo "IN_PROGRESS")`,
    `    [ "$ST" = "SUCCEEDED" ] && return 0`,
    `    [ "$ST" = "FAILED" ] && echo "FAILED ($F)" && return 1`,
    `    sleep 3`,
    `  done`,
    `  return 1`,
    `}`,
    `CNT=$(cat /tmp/bro-count.txt)`,
    `for idx in $(seq 0 $((CNT - 1))); do echo "Uploading part $((idx + 1))/$CNT..."; run_oci "/tmp/bro-c$idx.json" 60 || exit 1; done`,
    `echo "Installing WireGuard & Relay inside VPS (wait ~30s)..."`,
    `run_oci "/tmp/bro-exec.json" 300 && echo "=== DONE! Return to Bro Radius and click Verify ===" || echo "=== FAILED inside VPS ==="`,
  ].join('\n');
}
