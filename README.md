# zepp-tao-watch · TAO监控 (Amazfit GTS 3)

在 Amazfit GTS 3 手表上监控任意 Bittensor coldkey 在 finney 主网的子网质押资产（原生 ι 数量、
池价 spot、τ 等值），并支持**每日 09:00 闹钟链**：手表每天早上自动亮屏显示最新余额。

- 手表端: Zepp OS 1.0 小程序（`hmUI/hmApp` 旧 API 面，GTS 3 = API_LEVEL 1.0）
- 手机侧: Zepp App 内的 Side Service 承担全部网络请求（手表端 1.0 无直接联网能力）
- 链上数据: finney JSON-RPC 直读（质押 runtime API + 池储备）+ Coinbase 折价

```
┌ 手表 GTS3 ─────────┐   BLE消息桥   ┌ 手机 Zepp App 内 ┐    HTTPS    ┌ finney RPC / Coinbase ┐
│ Device App         │ ←──────────→ │ Side Service      │ ──────────→ │ 7路并行拉取(实测1.2s)  │
│ UI/闹钟链/状态      │               │ fetch+SCALE解码   │             └────────────────────────┘
└────────────────────┘               └ settingsStorage缓存 ┘
```

## 快速开始

```bash
npm i -g @zeppos/zeus-cli          # Node >= 16

# 1) 生成你的个人常量 (shared/constants.gen.js, 已被 .gitignore, 不入库)
python3 tools/gen_constants.py <你的ss58地址> [子网号=9]

# 2) 本地出包
zeus build -t gts3                 # 产物 dist/*.zab

# 3) 真机安装
zeus login                         # console.zepp.com 注册的开发者账号
zeus preview -t gts3               # 生成二维码
# 手机 Zepp App → 关于页连点 Zepp 图标 7 次 → 开发者模式 → 扫码安装
```

## 每日提醒机制（v1.0 无持久闹钟的诚实方案）

- 「提醒 ✓」→ `hmApp.alarmNew`（delay 相对秒数）挂次日 09:00 单次唤醒；开关状态分层存
  手表 hmFS 文件（跨重启）+ SysPro 布尔（跨 Zepp App worker 重启），不依赖手机侧存储
- 闹钟唤醒 → 震两下（scene 0，v1.2.2 实测有效）→ **秒显手表端缓存**（`tao_cache` 文件，
  永不空屏）→ 8s×2 短超时拉实时 → 渲染完成后自我续挂次日 → **停屏 15s 忙等后自动退出**
- **闹钟自激循环事故（11-03 实锤）**：延时曾用 `tz.utc` 计算——该固件此字段单位不可靠（毫秒），
  归一化后仍带分钟级垃圾偏移，延时被算成"几分钟后" → 触发→唤醒→再挂→再触发的自激循环
  （症状：9 点不响、一小时内连环响十次）。修复三件套：① 延时只用 `Date.now()` +
  hour/minute 墙钟字段（保底 600s）；② **闹钟 id 持久化到文件，挂新前先跨会话取消旧条**
  （队列恒为 1 条，否则每天连环响 N 次）；③ 唤醒时开关为"关"则不震不续挂
- **GTS3 唤醒会话实测铁律：setTimeout 回调从不执行**（定时器全灭：震动延迟、超时重试、
  自动退出全部静默失效；Promise/同步代码正常）——唤醒路径的关键逻辑必须同步直调，
  延时用忙等 `busyWaitMs` 实现
- **震动（scene 0 两短）v1.2.2 起实测有效**；此前多版本无声并非传感器问题，而是 param
  解析 bug + 唤醒会话定时器全灭的叠加假象——震动代码从未被执行过
- 代价清单：手表重启丢闹钟（重开 app 点一次 ✓）；关闭后残留闹钟最多误响一次；
  唤醒拉实时需手机在旁且 Zepp App 存活，否则显示缓存（标注时间）
- 安卓建议：Zepp App 加电池白名单 + 自启动 + 锁后台

## 实现备注（踩过的坑）

- 手表端无网络能力，所有 HTTP 在手机侧 Side Service；两者经 MessageBuilder 蓝牙桥
- 固定地址的 storage key / state_call 入参都是常量，由 `tools/gen_constants.py` 在 PC 上
  算好烧进 app，端上无需 xxhash/blake2b 库
- 1.0 刷屏必须 `setProperty(hmUI.prop.MORE, {...})`，字符串属性名静默失效；
  **BUTTON 标签不接受 setProperty**，改文字需 deleteWidget 重建
- Side Service 多路 RPC 用 Promise.all 并行（串行易撞桥 60s 超时），每路失败在
  steps 字段标注上屏；settingsStorage 做存在性守卫 + 内存回退，任何异常保证回包
- SCALE compact 大整数分支：值超过 2^30 后首字节低 2 位 = 11，长度 = `(首字节>>2)+4`，
  解错会静默丢高位字节（读数缩小 16 倍且随排放每日漂移，极难察觉）
- 池价 spot = `SubnetTAO(netuid) / SubnetAlphaIn(netuid)`，键 =
  `twox128("SubtensorModule") + twox128(item) + 裸u16LE(netuid)`（NetUid 键无 hasher）；
  `SubnetMovingPrice` 为 I96F32 定点（÷2^32），与 spot 互差 <1% 可互证
- 质押查询用 `state_call StakeInfoRuntimeApi_get_stake_info_for_coldkey`
  （入参 = 裸 32B 公钥 hex）；全质押账户 free<ED 被链上 reap，System.Account 无记录 ≠ 没钱
