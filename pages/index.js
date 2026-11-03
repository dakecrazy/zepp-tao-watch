import {
  COLOR_TITLE,
  COLOR_MAIN,
  COLOR_TEXT,
  COLOR_DIM,
  COLOR_ERR,
  COLOR_OK,
  COLOR_BTN,
  COLOR_BTN_PRESS,
} from "../utils/config/constants";
import { DEVICE_WIDTH } from "../utils/config/device";
import { NETUID } from "../shared/constants.gen";

const { messageBuilder, appId, wakeParam } = getApp()._options.globalData;

// GET_DATA 冷启动(唤起 Side Service + 手机侧首次建连)给足 60s + 一次自动重试
const DATA_TIMEOUT = 60000;

function req(payload, timeout) {
  return messageBuilder.request(payload, { timeout: timeout || DATA_TIMEOUT });
}

// 1.0 更新 widget 唯一正解: setProperty(hmUI.prop.MORE, {...}); 字符串属性名静默失效
function setW(w, opts) {
  try {
    w.setProperty(hmUI.prop.MORE, opts);
  } catch (e) {
    console.log("setProperty fail " + e);
  }
}

function bridgeErr(e) {
  const m = String(e);
  if (m.indexOf("Timed out") >= 0) return "桥超时·开手机Zepp App";
  return "桥:" + m.substr(0, 55);
}

// ---------- 提醒开关: 分层持久化 ----------
// 第1层 hmFS 文件 (跨手表重启); 第2层 hmFS.SysPro 布尔 (跨 Zepp App worker 重启, 重启手表清空)
// 手机侧存储已证实隔夜易丢, 不再使用
const FLAG_PATH = "tao_daily_flag";
const SYS_KEY = "tao_daily_enabled";

// 返回 true/false/null(两层都读不到)
function flagRead() {
  // 1) 文件
  try {
    const fd = hmFS.open(FLAG_PATH, hmFS.O_RDWR | hmFS.O_CREAT);
    console.log("flagRead open fd=" + fd);
    if (fd && fd > 0) {
      const buf = new Uint8Array(1);
      const r = hmFS.read(fd, buf.buffer, 0, 1);
      hmFS.close(fd);
      console.log("flagRead r=" + r + " b=" + buf[0]);
      if (r === 0) {
        if (buf[0] === 49) return true;
        if (buf[0] === 48) return false;
      }
    }
  } catch (e) {
    console.log("flagRead file err " + e);
  }
  // 2) SysPro
  try {
    if (typeof hmFS.SysProGetBool === "function") {
      const v = hmFS.SysProGetBool(SYS_KEY);
      console.log("flagRead syspro=" + v);
      if (v === true) return true;
      if (v === false) return false;
    }
  } catch (e) {
    console.log("flagRead syspro err " + e);
  }
  return null;
}

// 返回 { fileOK, sysOK }
function flagWrite(on) {
  let fileOK = false;
  let sysOK = false;
  try {
    console.log(
      "O_WRONLY=" + hmFS.O_WRONLY + " O_RDWR=" + hmFS.O_RDWR +
      " O_CREAT=" + hmFS.O_CREAT + " O_TRUNC=" + hmFS.O_TRUNC
    );
  } catch (e) {}
  // 文件: 两种 flag 组合都试 (常量缺失时组合会退化)
  const tries = [];
  try {
    tries.push(hmFS.O_WRONLY | hmFS.O_CREAT | hmFS.O_TRUNC);
    tries.push(hmFS.O_RDWR | hmFS.O_CREAT);
  } catch (e) {}
  tries.push(2 | 64 | 512); // POSIX 数值兜底: O_RDWR|O_CREAT|O_TRUNC
  for (const fl of tries) {
    try {
      const fd = hmFS.open(FLAG_PATH, fl);
      console.log("flagWrite open(" + fl + ") fd=" + fd);
      if (fd && fd > 0) {
        const buf = new Uint8Array([on ? 49 : 48]);
        const r = hmFS.write(fd, buf.buffer, 0, 1);
        hmFS.close(fd);
        console.log("flagWrite r=" + r);
        // 真机语义: write 返回写入字节数 (r=1 即成功); 文档"0=成功"与实测不符
        if (r >= 1) {
          fileOK = true;
          break;
        }
      }
    } catch (e) {
      console.log("flagWrite try err " + e);
    }
  }
  try {
    if (typeof hmFS.SysProSetBool === "function") {
      const r = hmFS.SysProSetBool(SYS_KEY, on);
      sysOK = r === 0;
      console.log("flagWrite syspro r=" + r);
    }
  } catch (e) {
    console.log("flagWrite syspro err " + e);
  }
  return { fileOK: fileOK, sysOK: sysOK };
}

// ---------- 每日提醒: 闹钟链 (维护在手表端, 状态在手表文件, 均不依赖手机) ----------
let alarmId = 0;

// 挂闹钟并检查返回值 (失败返回 0 或 0xFFFFFFFF); 用 delay 相对秒数调度, 规避 date 绝对时间戳的单位/语义坑
// 唤醒场景下固件可能对 alarmNew 有限制甚至抛异常 → 必须 try/catch, 不许它杀死 build
function mkAlarm(delaySec, param) {
  let id = 0;
  try {
    id = hmApp.alarmNew({
      appid: appId,
      url: "pages/index",
      file: "pages/index",
      delay: delaySec,
      param: param,
    });
  } catch (e) {
    console.log("alarmNew threw " + e);
    return { ok: false, id: 0 };
  }
  const ok = id !== 0 && id < 4294967290;
  console.log(
    "alarmNew delay=" + delaySec + " param=" + param + " id=" + id + " ok=" + ok
  );
  return { ok: ok, id: id };
}

// 距下一班 09:00 的秒数 (保底 600s 防自激循环)
// 教训: tz.utc 在该固件单位不可靠(曾为毫秒), 归一化后仍带几分钟级垃圾偏移,
// 算出的延时可能只有几分钟 → 闹钟自触发循环(9点不响、一小时内连响十次)。
// 因此只用 Date.now()(实测可靠) + 时钟的 hour/minute 墙钟字段(无单位歧义), 不再碰 tz.utc
function nextNineDelay() {
  let nowSec = 0;
  try {
    nowSec = Math.floor(Date.now() / 1000);
  } catch (e) {}
  let wallMin = -1;
  try {
    const tz = hmSensor.createSensor(hmSensor.id.TIME);
    wallMin = tz.hour * 60 + tz.minute;
  } catch (e) {}
  if (nowSec <= 0 || wallMin < 0) return 86400;
  const wallNowSec = wallMin * 60 + (nowSec % 60); // 秒位取自 epoch 秒(与时区无关)
  let deltaSec = 9 * 3600 - wallNowSec;
  while (deltaSec <= 120) deltaSec += 86400; // 已过/正处9点(±2分钟) → 明天, 保底>2分钟防即时重触发
  return Math.max(600, Math.min(200000, deltaSec));
}

// 到点显示 "HH:MM": 本地墙钟 + delta 分钟, 不依赖传感器 utc 的单位
function fmtWakeTime(utcSec) {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const tz = hmSensor.createSensor(hmSensor.id.TIME);
    const deltaMin = Math.round((utcSec - nowSec) / 60);
    if (deltaMin < 0 || deltaMin > 200000) return "";
    const total = (tz.hour * 60 + tz.minute + deltaMin) % 1440;
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    function p(n) {
      return n < 10 ? "0" + n : "" + n;
    }
    return p(hh) + ":" + p(mm);
  } catch (e) {
    return "";
  }
}

// ---------- 手表端数据缓存: 拉到实时数据就存, 桥/手机连不上时显示缓存 ----------
const CACHE_PATH = "tao_cache";

function cacheSave(d) {
  try {
    const s = JSON.stringify({
      taoValue: d.taoValue,
      poolPrice: d.poolPrice,
      price: d.price,
      height: d.height,
      ts: Date.now(),
    });
    const fd = hmFS.open(CACHE_PATH, hmFS.O_WRONLY | hmFS.O_CREAT | hmFS.O_TRUNC);
    if (!fd) return false;
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
    const r = hmFS.write(fd, buf.buffer, 0, buf.length);
    hmFS.close(fd);
    return r >= buf.length;
  } catch (e) {
    console.log("cacheSave err " + e);
    return false;
  }
}

function cacheLoad() {
  try {
    const fd = hmFS.open(CACHE_PATH, hmFS.O_RDWR | hmFS.O_CREAT);
    if (!fd) return null;
    const buf = new Uint8Array(256);
    const r = hmFS.read(fd, buf.buffer, 0, 256);
    hmFS.close(fd);
    if (r < 1) return null;
    let s = "";
    for (let i = 0; i < r; i++) s += String.fromCharCode(buf[i]);
    const d = JSON.parse(s);
    return d && d.taoValue != null ? d : null;
  } catch (e) {
    return null;
  }
}

function fmtCacheTime(ts) {
  try {
    const d = new Date(ts);
    function p(n) {
      return n < 10 ? "0" + n : "" + n;
    }
    return (
      p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes())
    );
  } catch (e) {
    return "";
  }
}

// ---------- 震动提醒 ----------
let vibrate = null;

// scene 0 = 两短震 (同手表消息通知); 唤醒会话定时器全灭, 必须同步直调 (v1.2.2 实测有效)
function buzz() {
  try {
    console.log("vib id=" + hmSensor.id.VIBRATE);
    if (!vibrate) {
      vibrate = hmSensor.createSensor(hmSensor.id.VIBRATE);
      console.log("vib created");
    }
    try {
      vibrate.stop();
    } catch (e) {}
    vibrate.scene = 0;
    vibrate.start();
    console.log("vib start scene=0");
  } catch (e) {
    console.log("vibrate err " + e);
  }
}

// 唤醒会话定时器全灭: 延时只能忙等(阻塞式; 调用时页面已渲染完毕, 无其他任务)
function busyWaitMs(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {}
}

// 挂/撤每日闹钟主链, 返回 {ok, delaySec}
// 跨会话取消: 闹钟 id 存文件, 每次先取消上一条再新建——否则每次唤醒各挂一条,
// 队列积累 N 条同刻闹钟, 每天连环响 N 次
const ALARM_ID_PATH = "tao_alarm_id";

function alarmIdRead() {
  try {
    const fd = hmFS.open(ALARM_ID_PATH, hmFS.O_RDWR | hmFS.O_CREAT);
    if (!fd) return 0;
    const buf = new Uint8Array(12);
    const r = hmFS.read(fd, buf.buffer, 0, 12);
    hmFS.close(fd);
    if (r < 1) return 0;
    let s = "";
    for (let i = 0; i < r; i++) s += String.fromCharCode(buf[i]);
    const v = parseInt(s, 10);
    return isNaN(v) ? 0 : v;
  } catch (e) {
    return 0;
  }
}

function alarmIdWrite(id) {
  try {
    const s = String(id);
    const fd = hmFS.open(ALARM_ID_PATH, hmFS.O_WRONLY | hmFS.O_CREAT | hmFS.O_TRUNC);
    if (!fd) return;
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
    hmFS.write(fd, buf.buffer, 0, buf.length);
    hmFS.close(fd);
  } catch (e) {}
}

function armDaily(enabled) {
  const stored = alarmIdRead();
  if (stored > 0 && stored < 4294967290) {
    try {
      hmApp.alarmCancel(stored);
      console.log("cancelled stored alarm " + stored);
    } catch (e) {}
  }
  if (alarmId) {
    try {
      hmApp.alarmCancel(alarmId);
    } catch (e) {}
    alarmId = 0;
  }
  if (!enabled) {
    alarmIdWrite(0);
    return { ok: true, delaySec: 0 };
  }
  const d = nextNineDelay();
  const r = mkAlarm(d, "daily");
  if (r.ok) {
    alarmId = r.id;
    alarmIdWrite(r.id);
  } else {
    alarmIdWrite(0);
  }
  return { ok: r.ok, delaySec: d };
}

Page({
  state: { daily: false, unit: "τ", last: null },

  build() {
    const W = DEVICE_WIDTH; // 390

    this.txt = {
      title: hmUI.createWidget(hmUI.widget.TEXT, {
        x: 0, y: 16, w: W, h: 28,
        color: COLOR_TITLE, text_size: 22,
        align_h: hmUI.align.CENTER_H,
        text: "子网" + NETUID + " · TAO监控",
      }),
      big: hmUI.createWidget(hmUI.widget.TEXT, {
        x: 0, y: 64, w: W, h: 120,
        color: COLOR_MAIN, text_size: 88,
        align_h: hmUI.align.CENTER_H, align_v: hmUI.align.CENTER_V,
        text: "--",
      }),
      unit: hmUI.createWidget(hmUI.widget.TEXT, {
        x: 322, y: 104, w: 62, h: 44,
        color: COLOR_TEXT, text_size: 34,
        align_h: hmUI.align.LEFT,
        text: "τ",
      }),
      price: hmUI.createWidget(hmUI.widget.TEXT, {
        x: 0, y: 196, w: W, h: 30,
        color: COLOR_DIM, text_size: 22,
        align_h: hmUI.align.CENTER_H,
        text: "",
      }),
      status: hmUI.createWidget(hmUI.widget.TEXT, {
        x: 0, y: 238, w: W, h: 30,
        color: COLOR_DIM, text_size: 20,
        align_h: hmUI.align.CENTER_H,
        text: "",
      }),
    };

    // 点大数字切换单位 τ ↔ ι
    this.txt.big.addEventListener(hmUI.event.CLICK_DOWN, () => {
      this.state.unit = this.state.unit === "τ" ? "ι" : "τ";
      this.renderBig();
    });

    // 1.0 的 BUTTON 不支持 setProperty 更新文字 → 删除重建
    this.btnCfg = {
      refresh: { x: 15, y: 318, w: 170, h: 70, size: 28, click: () => this.refresh() },
      daily: { x: 205, y: 318, w: 170, h: 70, size: 26, click: () => this.toggleDaily() },
    };

    // 开关状态 = 手表本地文件, 即时显示, 不发任何请求、不再出现"?"
    const f = flagRead();
    this.state.daily = f === true;
    this.mkBtn("refresh", "刷新");
    this.mkBtn(
      "daily",
      f === true ? "提醒 ✓" : f === false ? "提醒 ×" : "提醒 ?"
    );

    if (wakeParam === "daily") {
      // 闹钟唤醒: 秒显缓存 → (开关开启才)震两下+续挂主链 → 拉实时 → 停屏15s → 退出
      // (唤醒会话定时器全灭: 延时用忙等, 关键逻辑全部同步直调)
      this.showCache();
      if (flagRead() !== false) {
        buzz();
        try {
          armDaily(true);
        } catch (e) {
          console.log("rearm threw " + e);
        }
      }
      this.fetchWithRetry(2, 8000).then(() => {
        busyWaitMs(15000);
        try {
          hmApp.exit();
        } catch (e) {
          console.log("exit err " + e);
        }
      });
    } else {
      // 手动打开: 秒显缓存 + 20s×2 拉实时; 开关是开的状态则顺手续挂闹钟链
      if (flagRead() === true) {
        try {
          armDaily(true);
        } catch (e) {}
      }
      this.refresh();
    }
  },

  mkBtn(key, text) {
    const c = this.btnCfg[key];
    if (this[key]) {
      try {
        hmUI.deleteWidget(this[key]);
      } catch (e) {}
    }
    this[key] = hmUI.createWidget(hmUI.widget.BUTTON, {
      x: c.x, y: c.y, w: c.w, h: c.h,
      text: text, text_size: c.size,
      radius: 14,
      normal_color: COLOR_BTN, press_color: COLOR_BTN_PRESS,
      text_color: COLOR_TEXT,
      click_func: c.click,
    });
  },

  fmt3(v) {
    if (v == null) return "--";
    return String(Number(v.toPrecision(3)));
  },

  renderBig() {
    const d = this.state.last;
    if (!d) return;
    const numText =
      this.state.unit === "τ"
        ? this.fmt3(d.taoValue != null ? d.taoValue : null)
        : this.fmt3(d.stake ? d.stake.stake / 1e9 : null);
    setW(this.txt.big, { text: numText });

    // 单位贴在数字右侧: 量取数字宽定位, 失败退回固定位
    let ux = 322;
    try {
      const lay = hmUI.getTextLayout({
        text: numText,
        text_size: 88,
        width: DEVICE_WIDTH,
        height: 120,
      });
      if (lay && lay.width && lay.width > 0) {
        ux = Math.min(DEVICE_WIDTH - 62, DEVICE_WIDTH / 2 + lay.width / 2 + 6);
      }
    } catch (e) {}
    setW(this.txt.unit, { x: ux, text: this.state.unit });

    const parts = [];
    if (this.state.unit === "τ" && d.taoValue != null && d.price) {
      parts.push("$" + (d.taoValue * d.price).toFixed(2));
    }
    if (d.poolPrice) parts.push("1ι=" + d.poolPrice.toFixed(5) + "τ");
    setW(this.txt.price, { text: parts.join(" · ") });
  },

  renderData(d, source, err) {
    if (d) {
      this.state.last = d;
      // 七路并行里个别 RPC 失败时(状态行会标"质押X/价格X"), 用缓存补齐缺失字段,
      // 避免 ok:true 但大数字"--"或 $ 行消失
      const c = cacheLoad();
      if (c) {
        if (d.taoValue == null && c.taoValue != null) d.taoValue = c.taoValue;
        if (!d.price && c.price) d.price = c.price;
        if (!d.poolPrice && c.poolPrice) d.poolPrice = c.poolPrice;
      }
      this.renderBig();
      if (source === "实时") {
        // 成功拉到实时数据 → 存手表缓存(含补齐后的完整字段)
        cacheSave(d);
        setW(this.txt.status, {
          color: COLOR_OK,
          text:
            "实时 · #" +
            (d.height || 0) +
            (d.steps ? " · " + d.steps : ""),
        });
      } else {
        setW(this.txt.status, {
          color: COLOR_DIM,
          text:
            (source ? source + " · " : "") +
            "#" +
            (d.height || 0) +
            (d.steps ? " · " + d.steps : ""),
        });
      }
    }
    if (err) {
      // 手机/桥连不上 → 回退显示手表端最后一次成功的数据 (标注时间)
      const c = cacheLoad();
      if (c) {
        this.state.last = {
          taoValue: c.taoValue,
          poolPrice: c.poolPrice,
          price: c.price,
          height: c.height,
          steps: "",
        };
        this.renderBig();
        setW(this.txt.status, {
          color: COLOR_DIM,
          text: "缓存 " + fmtCacheTime(c.ts),
        });
      } else {
        setW(this.txt.status, { color: COLOR_ERR, text: "错误: " + err });
      }
    }
  },

  // 秒显手表缓存 (若有), 返回缓存对象或 null
  showCache() {
    const c = cacheLoad();
    if (c) {
      this.state.last = {
        taoValue: c.taoValue,
        poolPrice: c.poolPrice,
        price: c.price,
        height: c.height,
        steps: "",
      };
      this.renderBig();
    }
    return c;
  },

  // N 次尝试的拉取; promise 在最终渲染完成后才 resolve (唤醒退出依赖它, 不与 exit 竞争)
  fetchWithRetry(left, timeout) {
    return req({ method: "GET_DATA" }, timeout).then(
      (resp) => {
        if (resp && resp.ok) {
          this.renderData(resp.data, "实时");
          return true;
        }
        if (left > 0) {
          return this.fetchWithRetry(left - 1, timeout);
        }
        if (resp && resp.last) {
          this.renderData(resp.last, "缓存");
        } else {
          this.renderData(null, null, (resp && resp.error) || "未知");
        }
        return false;
      },
      (e) => {
        if (left > 0) {
          setW(this.txt.status, {
            color: COLOR_DIM,
            text: "桥忙·自动重试…",
          });
          return this.fetchWithRetry(left - 1, timeout);
        }
        this.renderData(null, null, bridgeErr(e));
        return false;
      }
    );
  },

  refresh() {
    const c = this.showCache();
    if (c) {
      setW(this.txt.status, {
        color: COLOR_DIM,
        text: "缓存 " + fmtCacheTime(c.ts) + " · 更新中…",
      });
    } else {
      setW(this.txt.status, { color: COLOR_DIM, text: "拉取链上…" });
    }
    return this.fetchWithRetry(1, 20000);
  },

  // 退出前停震 (文档规则: start 后须 stop, 否则下次 start 不震)
  onDestroy() {
    if (vibrate) {
      try {
        vibrate.stop();
      } catch (e) {}
    }
  },

  toggleDaily() {
    // 开关真值 = 手表分层持久化 (文件 > SysPro)
    const next = !(flagRead() === true);
    const res = flagWrite(next);
    const main = armDaily(next);
    this.state.daily = next;
    this.mkBtn("daily", next ? "提醒 ✓" : "提醒 ×");
    if (next) {
      if (!main.ok) {
        setW(this.txt.status, {
          color: COLOR_ERR,
          text: "闹钟创建失败(0xFFFFFFFF)",
        });
        return;
      }
      setW(this.txt.status, {
        color: COLOR_OK,
        text: "已挂明日09:00",
      });
    } else {
      setW(
        this.txt.status,
        res.fileOK || res.sysOK
          ? { color: COLOR_DIM, text: "已关闭" }
          : { color: COLOR_ERR, text: "已取消闹钟·保存失败" }
      );
    }
  },
});
