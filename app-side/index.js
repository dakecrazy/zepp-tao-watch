import { MessageBuilder } from "../shared/message";

// 个人地址派生常量由 tools/gen_constants.py 生成 (gitignored), 模板见 constants.gen.example.js
import {
  PUB_HEX,
  STOR_KEY,
  KEY_TAO,
  KEY_ALP,
  NETUID,
} from "../shared/constants.gen";

const ENDPOINTS = [
  "https://entrypoint-finney.opentensor.ai",
  "https://bittensor-rpc.dwellir.com",
];
const PRICE_URL = "https://api.coinbase.com/v2/prices/TAO-USD/spot";

const messageBuilder = new MessageBuilder();

// ============ 基础工具 ============
function hexBytes(hex) {
  const h = hex && hex.startsWith("0x") ? hex.slice(2) : hex || "";
  const out = [];
  for (let i = 0; i + 1 < h.length; i += 2) {
    out.push(parseInt(h.substr(i, 2), 16));
  }
  return out;
}

function u64le(b, off = 0) {
  // rao 余额远小于 2^53, double 足够精确
  let v = 0;
  for (let i = 7; i >= 0; i--) v = v * 256 + b[off + i];
  return v;
}

function compact(b, off) {
  const f = b[off] & 3;
  if (f === 0) return [b[off] >> 2, off + 1];
  if (f === 1) {
    let v = b[off + 1] * 256 + b[off];
    return [v >> 2, off + 2];
  }
  if (f === 2) {
    let v = 0;
    for (let i = 3; i >= 0; i--) v = v * 256 + b[off + i];
    return [v >> 2, off + 4];
  }
  // 大整数形式: 首字节高6位+4 = 值字节数 (SCALE 标准)
  const big = (b[off] >> 2) + 4;
  let v = 0;
  for (let i = big; i >= 1; i--) v = v * 256 + b[off + i];
  return [v, off + 1 + big];
}

// ============ JSON-RPC (端点轮询) ============
async function rpc(method, params) {
  let lastErr = null;
  for (let i = 0; i < ENDPOINTS.length; i++) {
    try {
      const res = await fetch({
        url: ENDPOINTS[i],
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
      if (j.error) throw new Error("rpc:" + JSON.stringify(j.error).substr(0, 100));
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ============ SCALE 定长解码 (布局与 tao_balance.py 实测一致) ============
// AccountInfo: 16B refs + free/resv/frozen(+flags) u64le @16/24/32
function parseAccount(hex) {
  if (!hex || hex === "0x") return { exists: false, free: 0, resv: 0, froz: 0 };
  const b = hexBytes(hex);
  if (b.length < 40) throw new Error("AccountInfo len=" + b.length);
  return {
    exists: true,
    free: u64le(b, 16),
    resv: u64le(b, 24),
    froz: u64le(b, 32),
  };
}

// stake: compact(n) + [hot32 cold32 compact(netuid) compact(stake) 尾字段]*
// 仅 n==1 精确 (本地址实测单笔); n>1 取首笔并标记
function parseStake(hex) {
  if (!hex || hex === "0x" || hex === "") return null;
  const b = hexBytes(hex);
  let off;
  let n;
  const r = compact(b, 0);
  n = r[0];
  off = r[1];
  if (n < 1) return null;
  off += 32 + 32; // hot + cold
  const n2 = compact(b, off);
  const netuid = n2[0];
  off = n2[1];
  const s2 = compact(b, off);
  const stake = s2[0];
  off = s2[1];
  return { n, single: n === 1, netuid, stake, restBytes: b.length - off };
}

async function fetchPrice() {
  const res = await fetch({ url: PRICE_URL, method: "GET" });
  const j = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
  return parseFloat(j.data.amount);
}

async function pullAll() {
  let ts = 0;
  try {
    ts = Date.now();
  } catch (e) {
    ts = 0;
  }
  const out = {
    height: 0,
    free: 0,
    resv: 0,
    froz: 0,
    accountExists: false,
    stake: null,
    price: null,
    ts: ts,
    steps: "",
  };
  const notes = [];
  // 四路并行 (串行 4×RTT 易撞桥 60s 超时); 仅"账户"为致命步, 其余降级并在 steps 标注
  const pAcc = rpc("state_getStorage", [STOR_KEY])
    .then((r) => {
      const a = parseAccount(r);
      out.free = a.free;
      out.resv = a.resv;
      out.froz = a.froz;
      out.accountExists = a.exists;
    })
    .catch((e) => {
      throw new Error("账户:" + String(e).substr(0, 70));
    });
  const pStake = rpc("state_call", [
    "StakeInfoRuntimeApi_get_stake_info_for_coldkey",
    PUB_HEX,
  ])
    .then((r) => {
      out.stake = parseStake(r);
    })
    .catch(() => {
      notes.push("质押X");
    });
  const pPrice = fetchPrice()
    .then((p) => {
      out.price = p;
    })
    .catch(() => {
      notes.push("价格X");
    });
  const pHead = rpc("chain_getHeader", [])
    .then((h) => {
      out.height = parseInt(h.number, 16);
    })
    .catch(() => {
      notes.push("头X");
    });
  // 池价: spot = SubnetTAO(netuid) / SubnetAlphaIn(netuid), 非致命步
  const pPool = Promise.all([
    rpc("state_getStorage", [KEY_TAO]),
    rpc("state_getStorage", [KEY_ALP]),
  ])
    .then(([t, a]) => {
      const taoIn = u64le(hexBytes(t));
      const alphaIn = u64le(hexBytes(a));
      if (alphaIn > 0) {
        out.poolPrice = taoIn / alphaIn;
        if (out.stake && out.stake.stake > 0) {
          // 先除后乘避免 double 溢出 (rao 乘积会超 2^53)
          out.taoValue = (out.stake.stake / alphaIn) * taoIn / 1e9;
        }
      }
    })
    .catch(() => {
      notes.push("池价X");
    });
  await pAcc;
  await Promise.all([pStake, pPrice, pHead, pPool]);
  out.steps = notes.join(",");
  return out;
}

// ============ 缓存 (settingsStorage, 手机侧持久化; 不存在时内存回退) ============
// v1.0.7: 部分手机运行时无 settingsStorage(尤其未声明设置页的 app) → 访问即抛异常,
// GET_DAILY/SET_DAILY/GET_LAST 全部静默死掉 → 手表"提醒?"超时。守卫 + 内存回退。
let memLast = null;
let memDaily = false;
let ssChecked = false;
let ssOK = false;

function ss() {
  if (!ssChecked) {
    ssChecked = true;
    try {
      ssOK =
        typeof settingsStorage !== "undefined" &&
        !!settingsStorage &&
        typeof settingsStorage.setItem === "function";
    } catch (e) {
      ssOK = false;
    }
    console.log("side settingsStorage available=" + ssOK);
  }
  return ssOK;
}

function saveLast(d) {
  memLast = d;
  if (ss()) {
    try {
      settingsStorage.setItem("tao_last", JSON.stringify(d));
    } catch (e) {
      console.log("saveLast fail " + e);
    }
  }
}
function readLast() {
  if (ss()) {
    try {
      const s = settingsStorage.getItem("tao_last");
      if (s) return JSON.parse(s);
    } catch (e) {}
  }
  return memLast;
}
function setDaily(enabled) {
  memDaily = enabled;
  if (ss()) {
    try {
      settingsStorage.setItem("daily_enabled", enabled ? "1" : "0");
    } catch (e) {}
  }
}
function getDaily() {
  if (ss()) {
    try {
      return settingsStorage.getItem("daily_enabled") === "1";
    } catch (e) {}
  }
  return memDaily;
}

// ============ 消息路由 ============
AppSideService({
  onInit() {
    messageBuilder.listen(() => {});

    messageBuilder.on("request", (ctx) => {
      let req;
      try {
        req = messageBuilder.buf2Json(ctx.request.payload);
      } catch (e) {
        return;
      }
      console.log("side recv " + req.method);
      try {
        if (req.method === "GET_DATA") {
          pullAll()
            .then((d) => {
              saveLast(d);
              ctx.response({ data: { ok: true, data: d } });
            })
            .catch((e) => {
              ctx.response({
                data: { ok: false, error: String(e).substr(0, 90), last: readLast() },
              });
            });
        } else if (req.method === "GET_LAST") {
          ctx.response({ data: { ok: true, data: readLast() } });
        } else if (req.method === "SET_DAILY") {
          setDaily(req.enabled);
          ctx.response({ data: { ok: true, enabled: req.enabled } });
        } else if (req.method === "GET_DAILY") {
          ctx.response({ data: { ok: true, enabled: getDaily() } });
        }
      } catch (e) {
        // 任何同步异常也要回包, 否则手表端干等到超时
        ctx.response({
          data: { ok: false, error: "side:" + String(e).substr(0, 80) },
        });
      }
    });
  },
  onRun() {},
  onDestroy() {},
});
