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
    // 闹钟唤醒时 options.param === 'daily'
    this.globalData.wakeParam = (options && options.param) || "";
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
