// 复制本文件为 shared/constants.gen.js, 然后运行:
//   python3 tools/gen_constants.py <你的ss58地址> [netuid]
// 生成的 constants.gen.js 已被 .gitignore (含个人地址派生常量, 不入库)
export const PUB_HEX = "<你的32字节公钥hex>";
export const NETUID = 9;
export const STOR_KEY = "0x<System.Account完整存储键, twox128x2+blake2_128concat(pub)>";
export const KEY_TAO = "0x<SubtensorModule.SubnetTAO + 裸u16LE(netuid)>";
export const KEY_ALP = "0x<SubtensorModule.SubnetAlphaIn + 裸u16LE(netuid)>";
