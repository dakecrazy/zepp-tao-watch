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

// ---------- 提醒开关: 手表本地文件 (hmFS), 手机侧存储隔夜易丢, 不再作为状态源 ----------
const FLAG_PATH = "tao_daily_flag";

// 返回 true/false/null(从未写入或读取失败)
function flagRead() {
  try {
    const fd = hmFS.open(FLAG_PATH, hmFS.O_RDWR | hmFS.O_CREAT);
    if (!fd) return null;
    const buf = new Uint8Array(1);
    const r = hmFS.read(fd, buf.buffer, 0, 1);
    hmFS.close(fd);
    if (r !== 0) return null;
    if (buf[0] === 49) return true; // '1'
    if (buf[0] === 48) return false; // '0'
    return null;
  } catch (e) {
    console.log("flagRead " + e);
    return null;
  }
}

function flagWrite(on) {
  try {
    const fd = hmFS.open(FLAG_PATH, hmFS.O_WRONLY | hmFS.O_CREAT | hmFS.O_TRUNC);
    if (!fd) return false;
    const buf = new Uint8Array([on ? 49 : 48]);
    const r = hmFS.write(fd, buf.buffer, 0, 1);
    hmFS.close(fd);
    return r === 0;
  } catch (e) {
    console.log("flagWrite " + e);
    return false;
  }
}

// ---------- 每日提醒: 闹钟链 (维护在手表端, 状态在手表文件, 均不依赖手机) ----------
let alarmId = 0;

function nextNineUtc() {
  try {
    const t = hmSensor.createSensor(hmSensor.id.TIME);
    const tzOff = t.hour * 3600 + t.minute * 60 - (t.utc % 86400);
    let base = Math.floor((t.utc + tzOff) / 86400) * 86400 + 9 * 3600 - tzOff;
    if (base <= t.utc + 30) base += 86400;
    return base;
  } catch (e) {
    try {
      return Math.floor(Date.now() / 1000) + 86400;
    } catch (e2) {
      return 0;
    }
  }
}

// 挂闹钟并检查返回值 (alarmNew 失败返回 0, 不检查就是盲报成功)
// url/file 两个键都发: 1.0 文档示例用 file, option 表写 url, 固件行为未知
function armDaily(enabled) {
  if (alarmId) {
    try {
      hmApp.alarmCancel(alarmId);
    } catch (e) {}
    alarmId = 0;
  }
  if (!enabled) return true;
  const t = nextNineUtc();
  if (t <= 0) return false;
  alarmId = hmApp.alarmNew({
    appid: appId,
    url: "pages/index",
    file: "pages/index",
    date: t,
    param: "daily",
  });
  console.log("alarmNew id=" + alarmId + " @" + t);
  return alarmId > 0;
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
      refresh: { x: 15, y: 318, w: 170, h: 70, size: 28, click: () => this.refresh(false) },
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
      // 闹钟唤醒: 文件明确为"关"才不续; 其余(含读取失败)一律续挂 — 链自持不依赖手机
      if (f !== false) armDaily(true);
      this.refresh(false)
        .then(() => {
          setTimeout(() => {
            try {
              hmApp.exit();
            } catch (e) {}
          }, 3000);
        })
        .catch(() => {});
    } else {
      // 手动打开: 直接拉最新数据 (失败时手机侧回包自带缓存)
      this.refresh(false).catch(() => {});
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
      let sc = COLOR_DIM;
      if (source === "实时") sc = COLOR_OK;
      setW(this.txt.status, {
        color: sc,
        text:
          (source ? source + " · " : "") +
          "#" +
          (d.height || 0) +
          (d.steps ? " · " + d.steps : ""),
      });
    }
    if (err) {
      setW(this.txt.status, { color: COLOR_ERR, text: "错误: " + err });
    }
  },

  refresh(isRetry) {
    setW(this.txt.status, { color: COLOR_DIM, text: "拉取链上…" });
    return req({ method: "GET_DATA" }, DATA_TIMEOUT)
      .then((resp) => {
        if (resp && resp.ok) {
          this.renderData(resp.data, "实时");
        } else {
          if (resp && resp.last) this.renderData(resp.last, "缓存");
          this.renderData(null, null, (resp && resp.error) || "未知");
        }
      })
      .catch((e) => {
        const m = String(e);
        // 桥超时自动重试一次 (冷启动第二击自动化), 只重试一次防打转
        if (!isRetry && m.indexOf("Timed out") >= 0) {
          setW(this.txt.status, { color: COLOR_DIM, text: "桥忙·自动重试…" });
          setTimeout(() => {
            try {
              this.refresh(true);
            } catch (e2) {}
          }, 1500);
          return;
        }
        this.renderData(null, null, bridgeErr(e));
      });
  },

  toggleDaily() {
    // 开关真值 = 手表本地文件
    const next = !(flagRead() === true);
    const saved = flagWrite(next);
    const ok = armDaily(next);
    this.state.daily = next;
    this.mkBtn("daily", next ? "提醒 ✓" : "提醒 ×");
    if (next) {
      setW(
        this.txt.status,
        !ok
          ? { color: COLOR_ERR, text: "闹钟创建失败(id=0)" }
          : saved
            ? { color: COLOR_OK, text: "每日09:00已挂闹钟" }
            : { color: COLOR_OK, text: "已挂闹钟·本地保存失败" }
      );
    } else {
      setW(
        this.txt.status,
        saved
          ? { color: COLOR_DIM, text: "已关闭" }
          : { color: COLOR_ERR, text: "已取消闹钟·保存失败" }
      );
    }
  },
});
