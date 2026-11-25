import crypto from 'crypto';
import dgram from 'dgram';
import { assertSafeDeviceHost } from './rfTelemetry.ts';

// RFC 2865 / RFC 5176 RADIUS CoA (Code 43) & Disconnect-Request (Code 40) over UDP 3799 (#46)
const CODE_DISCONNECT_REQUEST = 40;
const CODE_DISCONNECT_ACK = 41;
const CODE_COA_REQUEST = 43;
const CODE_COA_ACK = 44;

const ATTR_USER_NAME = 1;
const ATTR_VENDOR_SPECIFIC = 26;
const VENDOR_MIKROTIK = 14988;
const MIKROTIK_RATE_LIMIT = 8;

function buildRadiusAttr(type: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type, 2 + value.length]), value]);
}

function buildMikrotikRateLimitVsa(rateLimit: string): Buffer {
  const valBuf = Buffer.from(rateLimit, 'utf8');
  const vendorAttr = Buffer.concat([
    Buffer.from([MIKROTIK_RATE_LIMIT, 2 + valBuf.length]),
    valBuf,
  ]);
  const vendorIdBuf = Buffer.alloc(4);
  vendorIdBuf.writeUInt32BE(VENDOR_MIKROTIK, 0);
  return buildRadiusAttr(ATTR_VENDOR_SPECIFIC, Buffer.concat([vendorIdBuf, vendorAttr]));
}

function buildCoaPacket(params: {
  code: number;
  identifier: number;
  secret: string;
  username: string;
  rateLimit?: string;
}): Buffer {
  const attrs: Buffer[] = [buildRadiusAttr(ATTR_USER_NAME, Buffer.from(params.username, 'utf8'))];
  if (params.rateLimit) {
    attrs.push(buildMikrotikRateLimitVsa(params.rateLimit));
  }
  const attrBuf = Buffer.concat(attrs);
  const len = 20 + attrBuf.length;
  const pkt = Buffer.alloc(len);
  pkt[0] = params.code;
  pkt[1] = params.identifier & 0xff;
  pkt.writeUInt16BE(len, 2);
  // RFC 5176 Request Authenticator = MD5(Code + ID + Length + 16*0x00 + Attributes + Secret)
  pkt.fill(0, 4, 20);
  attrBuf.copy(pkt, 20);
  const authHash = crypto
    .createHash('md5')
    .update(Buffer.concat([pkt, Buffer.from(params.secret, 'utf8')]))
    .digest();
  authHash.copy(pkt, 4);
  return pkt;
}

export async function sendRadiusCoaOrDisconnect(params: {
  nasHost: string;
  port?: number;
  secret: string;
  username: string;
  action: 'disconnect' | 'coa-rate-limit';
  rateLimit?: string;
}): Promise<{ acked: boolean; responseCode: number; message: string }> {
  const safeHost = assertSafeDeviceHost(params.nasHost);
  const port = params.port || 3799;
  const identifier = Math.floor(Math.random() * 255);
  const code = params.action === 'disconnect' ? CODE_DISCONNECT_REQUEST : CODE_COA_REQUEST;
  const packet = buildCoaPacket({
    code,
    identifier,
    secret: params.secret,
    username: params.username,
    rateLimit: params.rateLimit,
  });

  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      try {
        sock.close();
      } catch {
        // ignore
      }
      reject(new Error(`لم يستجب NAS (${safeHost}:${port}) لطلب RADIUS CoA — تأكد من تفعيل Incoming RADIUS على UDP ${port}`));
    }, 3500);

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
      const respCode = msg[0] || 0;
      const acked = respCode === CODE_DISCONNECT_ACK || respCode === CODE_COA_ACK;
      resolve({
        acked,
        responseCode: respCode,
        message: acked
          ? 'تم تنفيذ RADIUS CoA/Disconnect بنجاح'
          : `رفض NAS الطلب (RADIUS Code ${respCode})`,
      });
    });

    sock.send(packet, port, safeHost);
  });
}

// ============================================================================
// Line-by-Line Config Diff Engine for .rsc Backups (#74)
// ============================================================================
export function computeRscLineDiff(
  prevText: string,
  nextText: string
): {
  addedCount: number;
  removedCount: number;
  diffLines: Array<{ type: 'add' | 'del' | 'ctx'; text: string }>;
} {
  const clean = (t: string) =>
    t
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l && !l.startsWith('# '));
  const a = clean(prevText);
  const b = clean(nextText);
  const aSet = new Set(a);
  const bSet = new Set(b);

  const diffLines: Array<{ type: 'add' | 'del' | 'ctx'; text: string }> = [];
  let addedCount = 0;
  let removedCount = 0;

  for (const line of a) {
    if (!bSet.has(line)) {
      removedCount++;
      diffLines.push({ type: 'del', text: line });
    }
  }
  for (const line of b) {
    if (!aSet.has(line)) {
      addedCount++;
      diffLines.push({ type: 'add', text: line });
    } else if (diffLines.length < 180) {
      diffLines.push({ type: 'ctx', text: line });
    }
  }

  return {
    addedCount,
    removedCount,
    diffLines: diffLines.slice(0, 220),
  };
}
