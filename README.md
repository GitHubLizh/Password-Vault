# Password-Vault · 本地密码库

一个只跑在本机的密码管理应用：凭据加密保存在你自己的磁盘上，没有云同步、没有第三方服务，浏览器打开 `http://127.0.0.1:47821` 即可使用。

## 两种启动方式

两条入口是并行设计，不分新旧：按使用者选，不按习惯选。

| 使用者 | 入口 | 前置条件 |
| --- | --- | --- |
| 技术人员（改代码、跑测试） | 仓库里的 `启动密码库.cmd`，或 `npm run build && npm start` | 本机装 Node.js 24，项目目录执行过 `npm install` |
| 非技术用户（只用密码库） | 绿色包里的 `启动密码库.bat` | 不需要装任何东西，包内自带 Node 运行时 |

两条路最终执行的都是同一个服务端入口 `dist-server/server/index.js`，界面、加密和数据位置完全一致；`npm run package` 在组装前会断言 `dist/index.html` 与 `dist-server/server/index.js` 存在，产物缺失就直接失败，因此两边不会悄悄分叉。`VAULT_PORT`（1024–65535）和 `VAULT_DATA_DIR`（绝对路径）对两条入口都生效；服务只监听 `127.0.0.1`，不对外网开放。

重复启动不再弹错误窗口：第二次启动会探到已在运行的实例（`server/instance.ts` 按 `/api/status` 的响应形状认定是自家进程，而不是「端口能连上就算」），打印「密码库已在运行」并打开页面后以 0 退出；只有端口真被别的程序占用时才报「被其他程序占用」并提示换 `VAULT_PORT`。

### 技术人员：从仓库启动

1. 安装 Node.js 24（项目要求 `>=24.0.0 <25`）。
2. 在项目目录执行 `npm install`。
3. 双击 `启动密码库.cmd`——`scripts/launch.mjs` 会检查环境和依赖、缺产物时按需构建，然后启动本地服务并打开浏览器。

手动启动：

```bash
npm run build   # 类型检查 + 构建前端与服务端
npm start       # 启动本地服务（默认 http://127.0.0.1:47821）
```

### 非技术用户：免安装绿色包

拿到 `PasswordVault-win-x64.zip` 的人只要三步：解压到一个固定位置 → 双击 `启动密码库.bat` → 浏览器自动打开 `http://127.0.0.1:47821`。包里的 `使用说明.txt` 就是写给这类读者的，涵盖主密码不可找回、数据实际存放位置和常见问题。

**下载入口**：压缩包作为 GitHub Release 附件发布，不需要自己构建——最新版直链 <https://github.com/GitHubLizh/Password-Vault/releases/latest/download/PasswordVault-win-x64.zip>，发布页 <https://github.com/GitHubLizh/Password-Vault/releases> 有各版本记录。绿色包不入库（`release/` 已被 `.gitignore` 忽略），仓库里只有生成它的脚本。

技术人员制作这个包：

```bash
npm run package                   # 完整构建 + 组装目录 + 生成 zip
node scripts/package.mjs --no-build   # 产物已是最新时，跳过构建只重组装
npm run precheck                  # 发布前结构自检，通过才挂 Release
npm run test:package              # 用包内 node.exe 起服务，真浏览器跑一遍绿色包流程
```

发版顺序是 `npm run package && npm run precheck && npm run test:package && gh release create …`，两条闸门失败都返回非 0 退出码，可直接串进 `&&`。`scripts/precheck-release.mjs` 只读不写，专查人容易漏的几件事：`dist-server` 与 `server/`+`shared/` 的源码是否一一对应（源码删了而旧 `.js` 还躺在产物里，就会被打进包）、产物有没有比源码旧、包内 `.bat` 是不是 CRLF 且入口路径正确、包内 `node.exe` 主版本与构建机是否一致、生产依赖齐而开发依赖零混入、zip 有没有早于最近一次**影响包内容**的提交（`package.json` 只算 version 行的改动，改 npm scripts 不算；`scripts/` 下只有 `package.mjs` 计入，另外两个脚本不进包）、以及 `package.json` 的版本号是否已经被同名 tag 用过。`tests/package.spec.ts` 补的是行为层：它不跑仓库构建，而是用**包内自带的运行时**、从包内 `app/` 目录起服务，在真浏览器里走完建库 → 存条目 → 显示/复制秘密 → 导出备份 → 锁定重解锁 → 窄屏布局，并要求零外部域名请求、零页面报错。发布后再 `gh release download` 取回附件比对 sha256，并确认 latest 直链返回 200。

包结构（实测 zip 37.3 MB，解压后 103.1 MB）：

```
PasswordVault\
  启动密码库.bat      切到 app 目录、用内置 node.exe 拉起服务并打开浏览器
  使用说明.txt        面向非技术用户的四段式说明（用法 / 数据位置 / 备份 / 常见问题）
  runtime\node.exe    内置 Node 24 运行时，用户无需安装 Node
  app\                dist、dist-server、生产依赖闭包（按 package-lock 计算，共 67 个包）与 type:module 清单
```

绿色包只是运行环境的搬运，不改变任何行为：密码库仍写在 `%LOCALAPPDATA%\PasswordVault`，与解压位置无关，换机或删包都不影响数据。压缩包用 PowerShell `Compress-Archive` 生成，它按 UTF-8 记录条目名，中文名的启动脚本和解压后一致。

尚未做的是代码签名：未签名的包从网上下载会触发 Windows SmartScreen「未知发布者」提示，`使用说明.txt` 里已给出「右键属性 → 解除锁定」的绕法。

## 功能

- **三类凭据**：网站与应用、服务器（含端口）、API 凭据（API Key / Secret）。
- **身份档**：同一个人可建多个互相隔离的密码库，各自持有主密码；全局同一时刻只解锁一个档，解锁期间看不到其他档的任何内容。
- **加密存储**：每个身份档对应一个 `vault.pvlt` 信封加密文件——scrypt（N=131072, r=8, p=1）派生密钥 + AES-256-GCM。忘记主密码无法找回数据。
- **会话与锁定**：1 / 5 / 15 分钟无操作自动锁定（可自定义）；手动或自动锁定都会丢弃未保存的草稿。秘密显示 30 秒后自动重新隐藏。
- **备份与恢复**：导出当前身份档的加密备份；从备份恢复时整库替换，覆盖前自动留下安全副本。
- **存储位置迁移**：在设置中把密码库文件搬到其他本机目录（不支持网络共享路径），迁移前校验目标目录并保留原文件。
- **修改主密码**：需提供当前主密码；成功后立即锁定，旧备份仍需各自旧密码解密。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19 + TypeScript，Vite 构建，石墨黑 + 青色强调的深色界面 |
| 后端 | Fastify 5，仅监听回环地址，无外部依赖服务 |
| 加密 | Node `crypto`：scrypt KDF + AES-256-GCM 信封格式（`local-password-vault` v1） |
| 测试 | `node:test` 单元/接口测试 + Playwright 端到端浏览器测试 |

## 开发

```bash
npm run dev         # 构建后以 tsx watch 启动服务端，改动即重启
npm run typecheck   # 前端 / 服务端 / 测试三套 tsconfig 全量类型检查
npm run build       # 清空产物 + typecheck + Vite 构建 + 编译服务端
npm run clean       # 删除 dist/ 与 dist-server/（tsc 不清理孤立产物，删源码后需靠它）
npm test            # 单元与接口测试（tests/*.test.ts）
npm run test:browser # 构建后跑 Playwright 端到端套件
npm run package      # 构建并组装 release/ 免安装绿色包
npm run precheck     # 发布前自检，非 0 退出即不该挂 Release
npm run test:package # 用包内 node.exe 起服务，真浏览器跑一遍绿色包流程（需先 package）
```

## 目录结构

```
src/        前端（React 组件、样式、入口）
server/     Fastify 服务：加密、身份档、存储迁移、目录选择、已运行实例探活
shared/     前后端共享的类型定义
tests/      单元测试与 Playwright 端到端测试
docs/       规格说明（specs/）与架构决策记录（adr/）
scripts/    启动脚本 launch.mjs、打包脚本 package.mjs、发布前自检 precheck-release.mjs
```

## 安全边界（请先读）

- 主密码不落盘、不可找回；忘记即数据永久不可解密。
- 秘密内容原样保存，不会去除首尾空格。
- 复制到剪贴板的内容可能留在系统剪贴板历史中，本应用不会自动擦除。
- 存储位置只支持本机绝对路径，不支持网络共享或 UNC 路径。
- 删除身份档只需要该档处于已解锁状态，没有二次确认以外的刹车——删除前请确认加密副本已转移到安全位置。

## 已知限制

- 单文件 `vault.pvlt` 为整库读写，条目很多时保存开销会上升。
- 不做跨设备同步——这是设计边界而非待补功能（ADR 0006）：换机器需手动迁移存储目录或导入备份。
- 界面为简体中文，暂无其他语言。
- 分发只有 Windows x64 绿色包：靠 `.bat` 启动、控制台窗口即服务进程，没有安装向导、托盘和代码签名。
