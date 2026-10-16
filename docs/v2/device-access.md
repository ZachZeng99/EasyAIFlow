# 多设备与手机接入（开发版）

## 使用方式

1. 每台执行电脑安装并登录自己的 Claude / Codex CLI，启动 EAF 和网络网关。
2. 执行电脑「管理设备 → 分享访问 → 生成控制配对码」。在控制电脑的「接入电脑」填写它的网关地址和配对码；顶部选择执行设备。
3. 控制电脑生成**浏览器登录码**。手机打开控制电脑的网关地址，登录后即可切换已配对设备、发送任务、查看输出及处理审批。

配对码 5 分钟内一次有效。控制配对码只允许操作一台执行电脑；浏览器登录拥有控制端权限，包括管理已配对设备。浏览器授权 30 天有效，退出或「分享访问 → 撤销」会立即取消授权。设备控制授权持续到撤销。

## 启动网关

默认仅监听 `127.0.0.1:8887`，开发前端也仅监听本机。以下在 PowerShell 中按实际地址、证书路径填写；不会修改防火墙。

HTTPS（推荐）：

```powershell
npm run build:web
$env:HOST = '0.0.0.0'
$env:EASYAIFLOW_TLS_CERT = 'D:\EAF-certs\server-cert.pem'
$env:EASYAIFLOW_TLS_KEY = 'D:\EAF-certs\server-key.pem'
npm run start:web
```

证书须匹配访问的域名/IP，并由手机浏览器信任。控制端配对自签名设备时可填写公开的 CA / 证书 PEM，仍会校验主机名；不要填写私钥。

已经连通的加密 VPN 内，可明确允许 HTTP，并将 HOST 绑定到本机 VPN 地址：

```powershell
$env:HOST = '你的本机 VPN IP'
$env:EASYAIFLOW_TRUSTED_VPN = '1'
npm run start:web
```

控制端添加该设备时勾选「已通过加密 VPN 连接」。这项配置不会建立 VPN，也不适用于普通明文公网/局域网。

已有 HTTPS 反向代理时：网关保持监听本机，设置 `EASYAIFLOW_PUBLIC_ORIGIN=https://实际域名`，代理保留原 Host 并支持 SSE 长连接。设置该变量后，HTTP 网关的本机免登录也会关闭；用桌面客户端生成首个接入码。关闭代理缓冲，并让读超时大于 15 秒心跳间隔。

同一台电脑的桌面、网关须使用同一 EAF 数据目录；自定义时统一设置 `EASYAIFLOW_DATA_DIR`。CLI 登录信息、工作区及进程留在执行电脑，连接令牌加密保存在控制端；不要将两台电脑的数据目录复制成同一设备身份。

## 当前边界与验证

- 最多连接 32 台设备，按设备切换任务；不自动搬迁任务或同步代码。离线表示连接未知，不代表执行任务失败。
- 关闭 UI/网关不会停止设备服务。重连重新获取快照和会话记录；重试使用原操作 ID，未确认操作不会自动再执行。
- 移除连接只删除控制端记录；取消访问权限应在执行端撤销授权。
- 已通过同机两个独立服务/网关、真实 Claude/Codex 远程执行、断线重连、重复请求、HTTPS 信任/主机名校验、授权撤销及 390×844 浏览器验证。**两台物理电脑和真实手机的网络联合验收仍待完成。**
- 自动化回归：`npx tsx tests/remoteDevices.test.ts`、`npx tsx tests/deviceBridge.test.ts`、`npx tsx tests/deviceAccess.test.ts`；HTTPS 回归 `npx tsx tests/deviceTls.test.ts` 需要 OpenSSL（可设 `OPENSSL_PATH`）。真实 CLI 验证：`npm run smoke:devices`，使用隔离 EAF 数据目录。

同设备群聊可单独开启 agent 委派/等待回复；跨设备成员协作编排仍待完成。设备配对本身不会开启自主协作。
