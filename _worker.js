/**
 * macrecovery -> Cloudflare Worker
 * 代理下载 Apple 网络恢复镜像中的 dmg（只要 dmg，跳过 chunklist 与验签）。
 *
 * 用法（URL 传参）：
 *   https://<your-worker>.workers.dev/?mlb=<17位主板序列号>&bid=<board-id>&os=<default|latest>
 *   - mlb  : 必填。macrecovery 协议里填给 sn 字段的 17 位逻辑板序列号（即 sn）。
 *   - bid  : 选填，board-id，默认 Mac-27AD2F918AE68F61（MacPro7,1）。
 *   - os   : 选填，default | latest，默认 default。
 * 例：
 *   https://<your-worker>.workers.dev/?mlb=F5K105303J9K3F71M&bid=Mac-27AD2F918AE68F61&os=latest
 */

const APPLE_HOST = 'osrecovery.apple.com';
const UA = 'InternetRecovery/1.0';
const DEFAULT_BID = 'Mac-27AD2F918AE68F61'; // MacPro7,1

// 生成 len 位大写十六进制随机串（对应原脚本 generate_id）
function genId(len) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  const HEX = '0123456789ABCDEF';
  let s = '';
  for (let i = 0; i < len; i++) s += HEX[buf[i] & 0x0f];
  return s;
}

// 解析 "Key: Value" 文本为对象（恰好一个 ': ' 才算，仿原脚本行为）
function parseKeyValue(text) {
  const info = {};
  for (const line of text.split('\n')) {
    const parts = line.split(': ');
    if (parts.length === 2) info[parts[0]] = parts[1];
  }
  return info;
}

// 1) 获取 session cookie
async function getSession() {
  const resp = await fetch('http://' + APPLE_HOST + '/', {
    method: 'GET',
    headers: { 'User-Agent': UA },
  });
  if (!resp.ok) throw new Error('session request failed: ' + resp.status);
  // Set-Cookie 可能是多行，找出含 session= 的那段
  const raw = resp.headers.get('Set-Cookie') || resp.headers.get('set-cookie') || '';
  const m = raw.match(/session=[^;]+/);
  if (!m) throw new Error('No session in headers: ' + raw);
  return m[0];
}

// 2) 获取镜像信息（返回 AU/AT/CU/CT/AP 等）
async function getImageInfo(session, bid, mlb, osType) {
  const post = [
    ['cid', genId(16)],
    ['sn', mlb],
    ['bid', bid],
    ['k', genId(64)],
    ['fg', genId(64)],
    ['os', osType],
  ];
  const body = post.map((p) => p[0] + '=' + p[1]).join('\n');
  const resp = await fetch('http://' + APPLE_HOST + '/InstallationPayload/RecoveryImage', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'text/plain',
      'Cookie': session,
    },
    body,
  });
  const text = await resp.text();
  const info = parseKeyValue(text);
  const required = ['AP', 'AU', 'AH', 'AT', 'CU', 'CH', 'CT'];
  for (const k of required) {
    if (!(k in info)) throw new Error('Missing key ' + k + ' in response:\n' + text);
  }
  return info;
}

// 3) 用 AssetToken 流式代理下载 dmg
async function downloadDmg(info) {
  const resp = await fetch(info['AU'], {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Cookie': 'AssetToken=' + info['AT'],
    },
  });
  if (!resp.ok || !resp.body) {
    throw new Error('dmg fetch failed: ' + resp.status);
  }

  let fname = info['AU'].split('/').pop().split('?')[0];
  if (!fname) fname = (info['AP'] || 'Recovery') + '.dmg';

  const headers = new Headers();
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Disposition', 'attachment; filename="' + fname + '"');
  const cl = resp.headers.get('Content-Length');
  if (cl) headers.set('Content-Length', cl);

  return new Response(resp.body, { status: 200, headers });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 简单用法说明页
    if (request.method === 'GET' && !url.searchParams.get('mlb')) {
      return new Response(
        'Usage: ?mlb=<17-char MLB/sn>&bid=<board-id>&os=<default|latest>\n' +
        'Example: ?mlb=F5K105303J9K3F71M&bid=Mac-27AD2F918AE68F61&os=latest\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    try {
      const mlb = url.searchParams.get('mlb') || '';
      const bid = url.searchParams.get('bid') || DEFAULT_BID;
      const osType = url.searchParams.get('os') === 'latest' ? 'latest' : 'default';

      if (mlb.length !== 17) {
        return new Response('ERROR: mlb (sn) must be 17 characters.\n', { status: 400 });
      }

      const session = await getSession();
      const info = await getImageInfo(session, bid, mlb, osType);
      // 只下载 dmg（AU/AT），忽略 chunklist（CU/CT）与验签
      return await downloadDmg(info);
    } catch (e) {
      return new Response('ERROR: ' + (e && e.message ? e.message : String(e)) + '\n', { status: 500 });
    }
  },
};
