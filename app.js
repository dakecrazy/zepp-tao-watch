import "./shared/device-polyfill";
import { MessageBuilder } from "./shared/message";

App({
  globalData: {
    messageBuilder: null,
    appId: 0,
    wakeParam: "",
  },
  onCreate(options) {
    console.log("app on create invoke");
    // 实测(v1.2.1): 固件把 param 作为启动参数本身传回 —— options 是字符串 "test",
    // 不是官方样例假设的 {param:...} 对象; 两种形态都兼容
    try {
      console.log("launch options=" + JSON.stringify(options));
    } catch (e) {
      console.log("launch options unserializable " + e);
    }
    let wp = "";
    if (options) {
      if (typeof options === "string") {
        wp = options;
      } else if (typeof options.param === "string") {
        wp = options.param;
      }
    }
    this.globalData.wakeParam = wp;
    let appId;
    if (!hmApp.packageInfo) {
      appId = 662601; // 与 app.json 一致
    } else {
      appId = hmApp.packageInfo().appId;
    }
    this.globalData.appId = appId;
    this.globalData.messageBuilder = new MessageBuilder({ appId });
    this.globalData.messageBuilder.connect();
  },

  onDestroy(options) {
    console.log("app on destroy invoke");
    if (this.globalData.messageBuilder) {
      this.globalData.messageBuilder.disConnect();
    }
  },
});
