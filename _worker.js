export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const params = url.searchParams;

    // 获取 URL 参数，默认使用 Python 脚本中的默认值
    const bid = params.get('bid') || 'Mac-27AD2F918AE68F61';
    const sn = params.get('sn') || '0000000000000000';
    const osType = params.get('os') || 'default';
    const action = params.get('action') || 'redirect'; // 默认直接重定向到 dmg，也可选 json 查看详情

    try {
      // 1. 获取苹果恢复服务器的 Session Cookie
      const sessionCookie = await getAppleSession();
      if (!sessionCookie) {
        return new Response(JSON.stringify({ error: 'Failed to obtain session from Apple' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 2. 请求恢复镜像信息
      const imageInfo = await getIosImageInfo(sessionCookie, bid, sn, osType);
      
      if (!imageInfo['AU'] || !imageInfo['AT']) {
        return new Response(JSON.stringify({ error: 'Missing image link or session from Apple response', raw: imageInfo }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const dmgUrl = imageInfo['AU'];
      const assetToken = imageInfo['AT'];

      // 如果 action=json，则返回解析出的所有苹果原始响应字段
      if (action === 'json') {
        return new Response(JSON.stringify({
          success: true,
          board_id: bid,
          mlb: sn,
          os_type: osType,
          info: imageInfo,
          dmg_url: dmgUrl,
          asset_token: assetToken
        }, null, 2), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 3. 构造带 AssetToken Cookie 的请求去代理下载或直接 302 重定向
      // 注意：苹果的 dmg 下载链接通常强制需要对应的 Cookie 验证
      const targetHeaders = {
        'User-Agent': 'InternetRecovery/1.0',
        'Cookie': `AssetToken=${assetToken}`
      };

      if (action === 'proxy') {
        // 方案 A：通过 Worker 流式代理下载（消耗 Worker 流量和 CPU 时间）
        const appleResponse = await fetch(dmgUrl, { headers: targetHeaders });
        return new Response(appleResponse.body, {
          status: appleResponse.status,
          headers: {
            'Content-Type': appleResponse.headers.get('Content-Type') || 'application/octet-stream',
            'Content-Disposition': appleResponse.headers.get('Content-Disposition') || 'attachment; filename="recovery.dmg"'
          }
        });
      } else {
        // 方案 B（推荐）：返回一个带有 AssetToken 校验说明的页面，或者由于浏览器限制 302 无法携带 Cookie，
        // 如果直接 302 会因为缺少 Cookie 导致苹果拒绝下载。
        // 因此推荐使用流式代理（proxy），或者向客户端返回下载地址及带 Cookie 的 curl 命令。
        return new Response(
          JSON.stringify({
            message: "Direct 302 redirect cannot pass 'AssetToken' cookie to Apple CDN. Please use 'action=proxy' to stream download, or use the following curl command:",
            curl_command: `curl -H "Cookie: AssetToken=${assetToken}" -H "User-Agent: InternetRecovery/1.0" "${dmgUrl}" -o recovery.dmg`,
            dmg_url: dmgUrl
          }, null, 2),
          { headers: { 'Content-Type': 'application/json' } }
        );
      }

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

// 辅助函数：获取 Session
async function getAppleSession() {
  const response = await fetch('http://osrecovery.apple.com/', {
    headers: {
      'Host': 'osrecovery.apple.com',
      'User-Agent': 'InternetRecovery/1.0'
    },
    redirect: 'manual'
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const cookies = setCookie.split('; ');
    for (const cookie of cookies) {
      if (cookie.startsWith('session=')) {
        return cookie;
      }
    }
  }
  return null;
}

// 辅助函数：向苹果请求镜像信息
async function getIosImageInfo(session, bid, sn, osType) {
  const postData = new URLSearchParams({
    'cid': generateId(16),
    'sn': sn,
    'bid': bid,
    'k': generateId(64),
    'fg': generateId(64),
    'os': osType
  });

  const response = await fetch('http://osrecovery.apple.com/InstallationPayload/RecoveryImage', {
    method: 'POST',
    headers: {
      'Host': 'osrecovery.apple.com',
      'User-Agent': 'InternetRecovery/1.0',
      'Cookie': session,
      'Content-Type': 'text/plain'
    },
    body: postData.toString()
  });

  const text = await response.text();
  const info = {};
  for (const line of text.split('\n')) {
    const parts = line.split(': ');
    if (parts.length >= 2) {
      info[parts[0].trim()] = parts.slice(1).join(': ').trim();
    }
  }
  return info;
}

// 随机 ID 生成器（对应 Python 的 generate_id）
function generateId(length) {
  const chars = '0123456789ABCDEF';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}