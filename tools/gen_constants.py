#!/usr/bin/env python3
"""由 ss58 地址生成手表端烧录常量 shared/constants.gen.js (已被 .gitignore).

用法:
    python3 tools/gen_constants.py <ss58地址> [netuid=9]

生成内容 (均为该地址派生的常量, 手表端无需实现任何哈希/编码库):
    PUB_HEX    账户 32B 公钥 hex
    NETUID     子网号
    STOR_KEY   System.Account 存储键 (twox128 x2 + blake2_128concat)
    KEY_TAO    SubtensorModule.SubnetTAO 键 (池 TAO 储备, 裸 u16LE netuid, 无 hasher)
    KEY_ALP    SubtensorModule.SubnetAlphaIn 键 (池 α 储备)

纯标准库, 无第三方依赖。
"""
import hashlib
import json
import os
import struct
import sys
import urllib.request

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
M = (1 << 64) - 1
P1, P2, P3, P4, P5 = (0x9E3779B185EBCA87, 0xC2B2AE3D27D4EB4F, 0x165667B19E3779F9,
                      0x85EBCA77C2B2AE63, 0x27D4EB2F165667C5)


def b58dec(s: str) -> bytes:
    n = 0
    for ch in s:
        n = n * 58 + B58.index(ch)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return b"\x00" * (len(s) - len(s.lstrip("1"))) + body


def ss58_decode(addr: str) -> bytes:
    raw = b58dec(addr)
    assert raw[0] == 42, f"ss58 prefix={raw[0]}, bittensor=42"
    assert hashlib.blake2b(b"SS58PRE" + raw[:-2], digest_size=64).digest()[:2] == raw[-2:], "校验和错"
    pub = raw[1:-2]
    assert len(pub) == 32
    return pub


def _rol(x, r):
    return ((x << r) | (x >> (64 - r))) & M


def _rnd(acc, lane):
    acc = (acc + (lane * P2 & M)) & M
    acc = _rol(acc, 31)
    return acc * P1 & M


def xxh64(data: bytes, seed: int = 0) -> int:
    n = len(data)
    i = 0
    if n >= 32:
        v1 = (seed + P1 + P2) & M
        v2 = (seed + P2) & M
        v3 = seed & M
        v4 = (seed - P1) & M
        while i + 32 <= n:
            v1 = _rnd(v1, int.from_bytes(data[i:i+8], "little"))
            v2 = _rnd(v2, int.from_bytes(data[i+8:i+16], "little"))
            v3 = _rnd(v3, int.from_bytes(data[i+16:i+24], "little"))
            v4 = _rnd(v4, int.from_bytes(data[i+24:i+32], "little"))
            i += 32
        h = (_rol(v1, 1) + _rol(v2, 7) + _rol(v3, 12) + _rol(v4, 18)) & M
        for v in (v1, v2, v3, v4):
            h ^= _rnd(0, v)
            h = (h * P1 + P4) & M
    else:
        h = (seed + P5) & M
    h = (h + n) & M
    while i + 8 <= n:
        h ^= _rnd(0, int.from_bytes(data[i:i+8], "little"))
        h = (_rol(h, 27) * P1 + P4) & M
        i += 8
    if i + 4 <= n:
        h ^= (int.from_bytes(data[i:i+4], "little") * P1 & M)
        h = (_rol(h, 23) * P2 + P3) & M
        i += 4
    while i < n:
        h ^= (data[i] * P5 & M)
        h = (_rol(h, 11) * P1) & M
        i += 1
    h ^= h >> 33
    h = h * P2 & M
    h ^= h >> 29
    h = h * P3 & M
    h ^= h >> 32
    return h


def twox128(b: bytes) -> bytes:
    return xxh64(b, 0).to_bytes(8, "little") + xxh64(b, 1).to_bytes(8, "little")


def blake2_128concat(b: bytes) -> bytes:
    return hashlib.blake2b(b, digest_size=16).digest() + b


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    addr = sys.argv[1].strip()
    netuid = int(sys.argv[2]) if len(sys.argv) > 2 else 9

    pub = ss58_decode(addr)
    key = twox128(b"System") + twox128(b"Account") + blake2_128concat(pub)
    key_tao = twox128(b"SubtensorModule") + twox128(b"SubnetTAO") + struct.pack("<H", netuid)
    key_alp = twox128(b"SubtensorModule") + twox128(b"SubnetAlphaIn") + struct.pack("<H", netuid)

    js = (
        "// 自动生成, 勿手改: python3 tools/gen_constants.py <ss58地址> %d\n" % netuid
        + "// 含个人地址派生常量, 已 .gitignore, 勿提交仓库\n"
        + 'export const PUB_HEX = "%s";\n' % pub.hex()
        + 'export const NETUID = %d;\n' % netuid
        + 'export const STOR_KEY =\n  "0x%s";\n' % key.hex()
        + 'export const KEY_TAO = "0x%s";\n' % key_tao.hex()
        + 'export const KEY_ALP = "0x%s";\n' % key_alp.hex()
    )
    out = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "shared", "constants.gen.js"))
    with open(out, "w") as f:
        f.write(js)
    print("已生成", out, "(netuid=%d, pub=%s...)" % (netuid, pub.hex()[:12]))


if __name__ == "__main__":
    main()
