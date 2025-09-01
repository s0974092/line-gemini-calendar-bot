# 金鑰申請與設定標準作業流程 (SOP)

本文件詳細記錄了部署此 LINE Bot 所需的所有金鑰與憑證的申請流程。

## 目錄
1.  [LINE Bot 設定](#1-line-bot-設定)
2.  [Google Gemini API 金鑰](#2-google-gemini-api-金鑰)
3.  [Google Calendar API 憑證](#3-google-calendar-api-憑證)
4.  [`.env` 檔案總整理](#4-env-檔案總整理)

---

## 1. LINE Bot 設定

此部分用於取得 `LINE_CHANNEL_SECRET` 和 `LINE_CHANNEL_ACCESS_TOKEN`。

### 操作流程

1.  **前往 LINE Developers Console**:
    *   登入 [LINE Developers Console](https://developers.line.biz/console/)。

2.  **建立 Provider**:
    *   如果沒有 Provider，請點擊 `Create` 建立一個新的 Provider (可取名為公司或個人名稱)。

3.  **建立 Channel**:
    *   在 Provider 內，點擊 `Create a new channel`。
    *   選擇 `Messaging API`。
    *   填寫所有必填欄位 (地區、Channel name、Channel description 等)。
    *   同意服務條款後，點擊 `Create`。

4.  **取得 Channel Secret**:
    *   在建立好的 Channel 中，點擊 `Basic settings` 分頁。
    *   您會在頁面中找到 `Channel secret`，請複製此值。

5.  **取得 Channel Access Token**:
    *   點擊 `Messaging API` 分頁。
    *   滑到頁面最下方，找到 `Channel access token` 區塊。
    *   點擊 `Issue` 按鈕，即可產生一組長期的 Access Token。請複製此值。

---

## 2. Google Gemini API 金鑰

此部分用於取得 `GEMINI_API_KEY`。

### 操作流程

1.  **前往 Google AI Studio**:
    *   登入 [Google AI Studio](https://aistudio.google.com/)。

2.  **取得 API 金鑰**:
    *   點擊左側選單的 `Get API key`。
    *   點擊 `Create API key in new project`。
    *   系統會產生一組 API 金鑰，請立即複製並妥善保管。

---

## 3. Google Calendar API 憑證

此為最複雜的部分，包含兩個階段：取得 OAuth 用戶端 ID/密碼，以及產生 Refresh Token。

### 階段 A: 啟用 API 並建立 OAuth 2.0 憑證

此部分用於取得 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET`。

1.  **前往 Google Cloud Console**:
    *   登入 [Google Cloud Console](https://console.cloud.google.com/)。

2.  **建立新專案**:
    *   如果沒有現成專案，請點擊左上角的專案選單，選擇 `NEW PROJECT`，並完成建立。

3.  **啟用 Google Calendar API**:
    *   在頂端搜尋框搜尋 "Google Calendar API"，進入後點擊 `ENABLE`。

4.  **設定 OAuth 同意畫面 (OAuth consent screen)**:
    *   在左側選單 `APIs & Services` > `OAuth consent screen`。
    *   選擇 `External` (外部使用者)，點擊 `CREATE`。
    *   填寫應用程式名稱 (例如 `LINE Calendar Bot`)、使用者支援電子郵件等必填資訊。
    *   在 `Authorized domains` 不需特別設定。
    *   開發人員聯絡資訊也請填寫。點擊 `SAVE AND CONTINUE`。
    *   `Scopes` (範圍) 頁面直接點擊 `SAVE AND CONTINUE`。
    *   `Test users` (測試使用者) 頁面，點擊 `ADD USERS`，**將您要用來登入 Google 並授權的那個 Google 帳號加入**。
    *   點擊 `SAVE AND CONTINUE`，然後回到資訊主頁。

5.  **建立 OAuth 2.0 用戶端 ID**:
    *   在左側選單 `APIs & Services` > `Credentials`。
    *   點擊 `+ CREATE CREDENTIALS` > `OAuth client ID`。
    *   `Application type` 選擇 `Web application`。
    *   `Name` 可自訂，例如 `LINE Bot Web Client`。
    *   在 `Authorized redirect URIs` 下方，點擊 `+ ADD URI`，並貼上以下這個非常重要的網址：
        ```
        https://developers.google.com/oauthplayground
        ```
    *   點擊 `CREATE`。

6.  **取得 Client ID 和 Secret**:
    *   彈出視窗會顯示您的 `Your Client ID` 和 `Your Client Secret`。請分別複製它們。

### 階段 B: 產生 Refresh Token

此部分用於取得 `GOOGLE_REFRESH_TOKEN`。

1.  **前往 OAuth 2.0 Playground**:
    *   在瀏覽器中開啟 [https://developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)。

2.  **設定您的憑證**:
    *   點擊右上角的齒輪圖示 ⚙️。
    *   勾選 `Use your own OAuth credentials`。
    *   將【階段 A】取得的 `GOOGLE_CLIENT_ID` 和 `GOOGLE_CLIENT_SECRET` 填入。

3.  **授權 Calendar API**:
    *   在左側 "Step 1" 的輸入框中，找到並選擇 **Google Calendar API v3**。
    *   在下方展開的權限清單中，選擇 `https://www.googleapis.com/auth/calendar`。
    *   點擊藍色的 `Authorize APIs` 按鈕。

4.  **登入並同意授權**:
    *   畫面會跳轉到 Google 登入及授權頁面。請務必使用您在「OAuth 同意畫面」中設定的**測試使用者帳號**登入。
    *   在同意畫面上，點擊「允許」。

5.  **交換並取得權杖**:
    *   授權後，您會被導回 Playground 頁面。
    *   在左側 "Step 2" 處，點擊藍色的 `Exchange authorization code for tokens` 按鈕。
    *   右側的欄位中會出現 `Refresh token`。請完整複製此值。

---

## 4. `.env` 檔案總整理

將以上所有取得的值，填入專案根目錄的 `.env` 檔案中。

```env
# LINE Bot
LINE_CHANNEL_SECRET=【貼上您的 Channel Secret】
LINE_CHANNEL_ACCESS_TOKEN=【貼上您的 Channel Access Token】

# Google Gemini API
GEMINI_API_KEY=【貼上您的 Gemini API 金鑰】

# Google Calendar API
GOOGLE_CLIENT_ID=【貼上您的 Client ID】
GOOGLE_CLIENT_SECRET=【貼上您的 Client Secret】
GOOGLE_REFRESH_TOKEN=【貼上您的 Refresh Token】

# [Optional] The display name of the calendar to use (e.g., "家庭", "Work").
# If set, the bot will search for this calendar and use it.
# If this calendar is not found, or if this value is left empty, it will default to the "primary" calendar.
TARGET_CALENDAR_NAME=家庭

# Security
# Comma-separated list of allowed LINE User IDs
USER_WHITELIST=【貼上您的 LINE User ID】
```
