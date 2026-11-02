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

// 距下一班 09:00 的秒数 (夹紧 30..200000)
function nextNineDelay() {
  let nowSec = 0;
  try {
    nowSec = Math.floor(Date.now() / 1000);
  } catch (e) {}
  let t = 0;
  try {
    const tz = hmSensor.createSensor(hmSensor.id.TIME);
    const tzOff = tz.hour * 3600 + tz.minute * 60 - (tz.utc % 86400);
    t = Math.floor((tz.utc + tzOff) / 86400) * 86400 + 9 * 3600 - tzOff;
    while (t > nowSec + 90000 && t > 1e11) t = Math.floor(t / 1000); // 毫秒型 utc 归一化
  } catch (e) {
    t = 0;
  }
  if (nowSec <= 0) return 86400;
  if (t < nowSec + 60 || t > nowSec + 200000) t = nowSec + 86400;
  return Math.max(30, Math.min(200000, t - nowSec));
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

// scene 9 = 高强度四连震(1200ms, 同闹钟反馈), 唤醒场景必须醒目; 规则: start 后必须 stop, 否则下次 start 不震
function buzz() {
  // 唤醒启动瞬间传感器服务可能未就绪: 延迟 600ms 再震, 全程留日志
  setTimeout(() => {
    try {
      console.log("vib id=" + hmSensor.id.VIBRATE);
      if (!vibrate) {
        vibrate = hmSensor.createSensor(hmSensor.id.VIBRATE);
        console.log("vib created");
      }
      try {
        vibrate.stop();
      } catch (e) {}
      vibrate.scene = 9;
      vibrate.start();
      console.log("vib start scene=9");
      setTimeout(() => {
        try {
          vibrate.stop();
        } catch (e) {}
      }, 2000);
    } catch (e) {
      console.log("vibrate err " + e);
    }
  }, 600);
}

// 挂/撤每日闹钟主链, 返回 {ok, delaySec}
function armDaily(enabled) {
  if (alarmId) {
    try {
      hmApp.alarmCancel(alarmId);
    } catch (e) {}
    alarmId = 0;
  }
  if (!enabled) return { ok: true, delaySec: 0 };
  const d = nextNineDelay();
  const r = mkAlarm(d, "daily");
  if (r.ok) alarmId = r.id;
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

    if (wakeParam === "daily" || wakeParam === "test") {
      // 闹钟唤醒: 先渲染缓存和震动(保证可见), 再续挂主链(不许它杀死流程), 最后拉实时
      const isTest = wakeParam === "test";
      this.showCache();
      buzz();
      try {
        armDaily(true);
      } catch (e) {
        console.log("rearm threw " + e);
      }
      this.fetchWithRetry(2, 8000).then(() => {
        if (isTest) {
          setW(this.txt.status, {
            color: COLOR_OK,
            text: "测试唤醒成功 " + fmtWakeTime(Date.now() / 1000),
          });
        }
        setTimeout(() => {
          try {
            hmApp.exit();
          } catch (e) {}
        }, isTest ? 6000 : 3000);
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
      this.renderBig();
      if (source === "实时") {
        // 成功拉到实时数据 → 存手表缓存
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
      // 2 分钟后自测唤醒: 区分"创建成功但固件不触发" vs "机制可用"
      const test = mkAlarm(120, "test");
      if (test.ok) {
        setW(this.txt.status, {
          color: COLOR_OK,
          text: "已挂09:00·2分钟后自测唤醒",
        });
      } else {
        setW(this.txt.status, {
          color: COLOR_OK,
          text:
            "已挂09:00·" + fmtWakeTime(Date.now() / 1000 + main.delaySec),
        });
      }
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
