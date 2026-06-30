<p align="center">
  <img src="avatar.jpg" alt="BeanyCord 吉祥物" width="200">
</p>

# BeanyCord

<p align="center">
  繁體中文 · <a href="./README.md">English</a>
</p>

一個 Discord 機器人，把 Beanfun 的 **QR 登入 → OTP** 流程搬到 Node.js/TypeScript，
跑在 24/7 的 Linux 主機上，讓取 OTP 不再依賴一台會關機的 Windows 電腦。私訊機器人、
掃 QR、選遊戲與帳號，OTP 就直接回到你的 DM。

## ⚠️ 免責聲明與使用範圍

- **非官方、無隸屬關係。** BeanyCord **並非**由遊戲橘子（Gamania）或 Beanfun 開發、
  背書或與其有任何關聯。「Beanfun」與遊戲名稱為其各自所有者之商標。
- **非官方第三方存取。** 它自動化了對 Beanfun 的登入/OTP 流程，因此**極可能違反
  Beanfun 的服務條款**，使用可能使你的帳號面臨風險（停權、風控封鎖）。**請自負風險。**
- **僅供學習與個人自架。** 本專案供學習，以及個人**為自己的帳號自架使用**；不適合
  作為公開/共享服務運營，作者本身也不提供任何託管實例。
- **不提供任何擔保。** 依 MIT 授權「按現狀」提供。

> 本聲明僅說明使用意圖，**不構成法律保護傘**。你需為自己的使用，以及遵守所在地的
> 條款與法律，自行負責。

## 授權與歸屬

本專案以 **MIT 授權**（見 `LICENSE`），是一個衍生著作：其 Beanfun 協定邏輯源自
**Kai Hao** 以 MIT 釋出的原始 C#/WPF 客戶端
（[`kevin940726/BeanfunLogin`](https://github.com/kevin940726/BeanfunLogin), © 2015），
並參照 [`pungin/Beanfun`](https://github.com/pungin/Beanfun) 比對。完整衍生鏈與須保留
的上游 MIT 聲明見 [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)。

## 設定與執行

```sh
npm install
cp .env.example .env        # 填入 DISCORD_TOKEN 等設定（見檔內註解）
npm test                    # 離線對照測試
```

> **DES 注意：** OTP 解密用舊式 `des-ecb`，OpenSSL 3 預設停用。npm scripts 已設
> `NODE_OPTIONS=--openssl-legacy-provider`；以其他方式（systemd/pm2/Docker）執行時
> 也要設，否則解密會拋 `wcdes.legacy_provider_required`。

**一次性 Discord 設定**

1. https://discord.com/developers/applications → **New Application**。
2. **Bot** → **Reset Token** → 填到 `.env` 的 `DISCORD_TOKEN`（不需任何 privileged intents）。
3. **General Information** → **Application ID** → `DISCORD_CLIENT_ID`。
4. **Install** / OAuth2：scope 選 `bot` + `applications.commands`，邀請到一個你與朋友
   共用的伺服器。

斜線指令要能在 DM 出現，必須**全域註冊**（`DISCORD_GUILD_ID` 留空）；第一次最多
~1 小時生效。若想免共用伺服器，可開 `DISCORD_USER_INSTALL=1`（需先在 Developer
Portal 啟用 User Install），詳見 `.env.example`。

**執行**

```sh
npm run register            # 發佈 /login /logout /status（改 commands.ts 後要重跑）
npm run bot                 # 啟動機器人
```

接著私訊機器人並執行 `/login`，QR 與 OTP 都在你的 DM 內送達。

## 使用流程

全程在與機器人的 1:1 私訊內進行（在伺服器執行 `/login` 時，機器人會把你導到私訊），
所以 QR 與 OTP 不會出現在公開頻道。

1. **`/login`** — 第一次使用、且管理者設了存取碼時，改用 `/login code:<存取碼>`（只需一次，
   之後會記住你）。
2. **掃 QR** — 機器人私訊一張 QR（約 2 分鐘有效），用 **Gama Play** App（原 Beanfun App）掃描核准。可按「取消」，
   逾時則出現「重新產生 QR」。（若你已登入，會略過這步直接進遊戲選單。）
3. **選遊戲** — 從「選擇遊戲」下拉選單挑一個；選完選單即收合，顯示「🎮 已選擇 ⟨遊戲⟩，
   載入帳號中…」。
4. **選帳號** — 從「選擇帳號」下拉選單挑一個；選完該選單就地變成 OTP 結果。
5. **取得 OTP** — 訊息顯示遊戲、帳號名、帳號（sid）與 OTP，並附三顆按鈕（皆免重新 `/login`）：
   - **🔄 重新產生 OTP** — 同一帳號刷新一組新 OTP。
   - **👤 換帳號** — 回到目前遊戲的帳號選單。
   - **🎮 換遊戲** — 回到遊戲選單。

每一步選完都會收掉上一個選單／按鈕，所以畫面上永遠只有一個「目前可操作」的對象，不會殘留
過期的舊選單。

**其他指令**

- `/status` — 查看你的登入狀態，以及機器人目前維持多少個帳號 session、已運行多久。
- `/logout` — 登出並清除你的 session（不會刪訊息）。
- `/clear` — 刪除機器人在這個 DM 發過的**所有**訊息（OTP／選單等），按下需再確認。只能刪
  機器人這側——你自己打的訊息 Discord 不允許機器人刪除；此指令也不會登出。

## 存取控制與安全

機器人會發送 Beanfun OTP，請務必正確設定。已內建的保護：每位使用者以 Discord 身分
隔離（偽造他人 `sid` 也拿不到對方 OTP）、QR/OTP 僅送 1:1 DM、session 以 AES-256-GCM
加密存於 SQLite、log 會遮蔽機密。

你必須在主機上設定：

- **存取閘門**（擋陌生人用你的主機/IP 跑登入）。符合任一即放行：
  - `ACCESS_CODE`（建議）：共用邀請碼。新朋友執行一次 `/login code:<碼>` 即被登記，
    之後免再輸入。加朋友 = 給一次碼，不用改設定、不用重啟、不用加入伺服器。
  - `REQUIRED_GUILD_ID`（選用）：指定伺服器的成員自動通過。
  - `ALLOWED_DISCORD_IDS`（選用）：靜態允許名單。
  - 三者全空 = 對任何能接觸到它的人開放。
- **金鑰與檔案權限**：`SESSION_ENCRYPTION_KEY`（`openssl rand -hex 32`）啟用持久化，
  **務必保持穩定**（換掉＝所有 session 失效需重掃）。加密金鑰與 DB 同主機，故加密只防
  DB **單獨**外洩、**不防主機入侵**；請 `chmod 600 .env`、別把 `.env` 與 DB 一起備份。
- `SESSION_MAX_AGE_DAYS`（預設 30）：限制外洩 DB 的可用時效。時效從**最後一次寫入**
  （登入或換遊戲）起算——keep-alive ping 與取 OTP **都不會**延長它；且清除只在
  **行程重啟／重新部署載入時** lazy 觸發，沒有常駐計時器。

## 部署到 Fly.io

長時間執行的 **worker**（無對內 port），以**單一機器** + 一顆 volume（存加密 DB）運行。

```sh
fly apps create beanycord                              # 名稱需全域唯一；被佔用就改 fly.toml 的 app
fly volumes create beanycord_data --region nrt --size 1
fly secrets set DISCORD_TOKEN=xxx \
  SESSION_ENCRYPTION_KEY=$(openssl rand -hex 32) ACCESS_CODE=your-code
fly deploy
fly scale count 1                                      # 維持單一實例
npm run register                                       # 本機跑一次註冊指令
```

- **必須維持單一實例**：Discord 一 token 一條 gateway 連線、volume 只能掛一台、session
  狀態在記憶體。勿 `scale count > 1` 或開 autoscaling。
- **Beanfun 風控對 Fly 的 IP 未驗證**：原海外主機可用，但 Fly 東京（`nrt`）是不同 IP。
  若被擋，可試 `BEANFUN_PROXY`，但這是**未經實測的應急選項**：它只在問題是「地理/
  region」時可能有效；若是「機房 IP 信譽」被擋，台灣**機房** proxy 通常一樣無效，需
  住宅/行動出口。且流量會經第三方（含 session/OTP），請只用你信任的 proxy。

## 診斷 CLI

`npm run m0` 會在**不啟動 Discord** 的情況下，直接對實機跑一遍
QR 登入 → 選遊戲 → 選帳號 → 印 OTP。換主機/IP 或懷疑協定變動時，用它最快確認
「協定層 + 這台主機的 IP」是否可用。
