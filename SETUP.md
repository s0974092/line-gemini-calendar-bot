# 設定指南 (Setup Guide)

本指南將引導您完成 LINE Bot AI 日曆助手的環境設定與部署。

## 步驟 1: 前置準備

*   Node.js (v18 或更高版本)
*   npm
*   Git
*   一個 LINE Developer 帳號
*   一個 Google Cloud 帳號
*   一個 Google AI Studio 帳號 (用於 Gemini API)
*   一個 Upstash 帳號 (用於 Redis)

## 步驟 2: 取得專案程式碼

1.  複製專案：
    ```bash
    git clone https://github.com/your-repo/line-gemini-calendar-bot.git
    cd line-gemini-calendar-bot
    ```
2.  安裝依賴：
    ```bash
    npm install
    ```

## 步驟 3: 取得 LINE Channel 憑證

1.  前往 [LINE Developers Console](https://developers.line.biz/console/)。
2.  建立一個新的 Provider 和 Channel (Messaging API)。
3.  在 Channel 設定頁面，找到並記錄以下資訊：
    *   `LINE_CHANNEL_SECRET`
    *   `LINE_CHANNEL_ACCESS_TOKEN` (在 "Messaging API" 分頁下發行)
4.  設定 Webhook URL (稍後會用到，本地開發時需使用 ngrok 等工具)。

## 步驟 4: 設定 Google Cloud Project 憑證

1.  前往 [Google Cloud Console](https://console.cloud.google.com/)。
2.  建立一個新的專案。
3.  啟用以下 API：
    *   Google Calendar API
    *   Google People API (如果需要獲取用戶資訊)
4.  設定 OAuth 同意畫面：
    *   選擇 "外部" 使用者類型。
    *   填寫應用程式名稱、使用者支援電子郵件、開發人員聯絡資訊。
    *   新增測試使用者 (您的 Google 帳號)。
5.  建立 OAuth 用戶端 ID：
    *   應用程式類型選擇 "桌面應用程式"。
    *   建立後，記錄以下資訊：
        *   `GOOGLE_CLIENT_ID`
        *   `GOOGLE_CLIENT_SECRET`

## 步驟 5: 取得 Google Refresh Token

這是最關鍵的步驟，用於讓您的應用程式能夠離線存取 Google 日曆。

1.  前往 [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)。
2.  在右側設定中，勾選 "Use your own OAuth credentials"，並填入您在步驟 4 取得的 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`。
3.  在 "Step 1: Select & authorize APIs" 中，選擇以下 Scope：
    *   `https://www.googleapis.com/auth/calendar`
    *   `https://www.googleapis.com/auth/userinfo.profile` (如果需要)
4.  點擊 "Authorize APIs"，您將被導向 Google 授權頁面。
5.  登入並授權您的應用程式。
6.  授權成功後，您將被導回 OAuth 2.0 Playground。在 "Step 2: Exchange authorization code for tokens" 中，點擊 "Exchange authorization code for tokens"。
7.  您將會看到 `Access Token` 和 `Refresh Token`。**請務必記錄下 `Refresh Token`**，這就是 `GOOGLE_REFRESH_TOKEN`。

## 步驟 6: 取得 Gemini API Key

1.  前往 [Google AI Studio](https://aistudio.google.com/app/apikey)。
2.  建立一個新的 API Key。
3.  記錄下 `GEMINI_API_KEY`。

## 步驟 7: 設定 Upstash Redis (用於對話狀態持久化)

由於 Bot 支援多輪對話，為了在無伺服器環境下維持對話狀態，我們使用 Upstash Redis。

1.  前往 [Upstash](https://upstash.com/) 並註冊/登入。
2.  建立一個新的 Redis 資料庫 (選擇免費方案即可)。
3.  建立後，您將會看到連線資訊。記錄下以下資訊：
    *   `REDIS_URL` (通常包含主機、埠和密碼，例如 `rediss://default:YOUR_PASSWORD@YOUR_HOST:PORT`)

## 步驟 8: 設定環境變數 (.env 檔案)

1.  在專案根目錄下，複製 `.env.example` 檔案並重新命名為 `.env`：
    ```bash
    cp .env.example .env
    ```
2.  編輯 `.env` 檔案，填入您在前面步驟中取得的所有憑證：
    ```
    LINE_CHANNEL_SECRET=您的LINE Channel Secret
    LINE_CHANNEL_ACCESS_TOKEN=您的LINE Channel Access Token
    GEMINI_API_KEY=您的Gemini API Key
    GOOGLE_CLIENT_ID=您的Google Client ID
    GOOGLE_CLIENT_SECRET=您的Google Client Secret
    GOOGLE_REFRESH_TOKEN=您的Google Refresh Token
    REDIS_URL=您的Upstash Redis 連線 URL
    USER_WHITELIST=您的LINE User ID (多個ID用逗號分隔)
    ```
    *   `USER_WHITELIST`：這是為了安全考量，只有列入白名單的 LINE User ID 才能使用您的 Bot。您可以從 LINE Developers Console 或透過 LINE Bot 接收到的訊息中取得您的 User ID。

## 步驟 9: 本地開發與測試

1.  啟動本地伺服器：
    ```bash
    npm run dev
    ```
    伺服器預設會在 `http://localhost:3000` 啟動。
2.  使用 `ngrok` 或其他隧道服務將本地伺服器暴露到公共網路，以便 LINE 平台可以訪問您的 Webhook。
    ```bash
    ./ngrok http 3000
    ```
    複製 ngrok 提供的 HTTPS URL。
3.  回到 [LINE Developers Console](https://developers.line.biz/console/)，在您的 Channel 設定中，將 Webhook URL 設定為 ngrok 提供的 HTTPS URL，並在後面加上 `/webhook` (例如：`https://your-ngrok-url.ngrok-free.app/webhook`)。
4.  啟用 Webhook。
5.  現在您可以在 LINE 上與您的 Bot 互動了！

## 步驟 10: 部署到 Vercel (生產環境)

1.  確保您的專案已推送到 GitHub、GitLab 或 Bitbucket 等 Git 儲存庫。
2.  前往 [Vercel](https://vercel.com/) 並登入。
3.  點擊 "Add New..." -> "Project"，然後從您的 Git 儲存庫導入專案。
4.  在部署設定中，新增所有必要的環境變數 (與 `.env` 檔案中的內容相同)。
5.  點擊 "Deploy"。Vercel 將會自動構建並部署您的應用程式。
6.  部署完成後，Vercel 會提供一個公開的 URL。回到 [LINE Developers Console](https://developers.line.biz/console/)，將 Webhook URL 更新為 Vercel 提供的 URL，並在後面加上 `/webhook`。