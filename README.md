# LINE Bot AI Calendar Assistant

[English](#english) | [繁體中文](#traditional-chinese) | [简体中文](#simplified-chinese)

---

<a name="english"></a>

## 🇬🇧 English

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

A conversational AI assistant that functions as a LINE Bot. Its primary purpose is to help users create Google Calendar events using natural language.

This bot is built with Node.js and TypeScript, and is designed for serverless deployment on Vercel. A key feature is its ability to handle multi-turn conversations. If a user provides incomplete information (e.g., a time without a title, or a recurring event without an end condition), the bot will ask follow-up questions to gather the necessary details before creating the event.

### ✨ Features

-   **Natural Language Understanding**: Powered by the Google Gemini API to parse complex sentences, dates, times, and recurrence rules.
-   **Google Calendar Integration**: Securely creates events in your Google Calendar using the official Google Calendar API.
-   **Conversational UI**: Handles incomplete commands by asking for clarification (e.g., event title, recurrence end date).
-   **Duplicate Event Prevention**: Checks your calendar to prevent creating identical events.
-   **Access Control**: Utilizes a whitelist to ensure only authorized users can interact with the bot.

### 🛠️ Tech Stack

-   **Backend**: Node.js, Express.js, TypeScript
-   **AI Model**: Google Gemini API (`gemini-1.5-flash`)
-   **Calendar Integration**: Google Calendar API v3
-   **Messaging Platform**: LINE Messaging API
-   **Testing**: Jest, ts-jest
-   **Deployment**: Vercel

### 🚀 Setup and Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/s0974092/line-gemini-calendar-bot.git
    cd line-gemini-calendar-bot
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up environment variables:**
    -   Copy the `.env.example` file to a new file named `.env`.
    -   Fill in the required credentials in the `.env` file. You will need keys from the LINE Developer Console, Google Cloud Console (for Gemini and Calendar APIs), and your own LINE User ID for the whitelist.

### 🏃 Running Locally

This project is designed to run as a webhook service, which requires a public HTTPS URL for the LINE platform to send events to.

1.  **Start the local server:**
    ```bash
    npm run dev
    ```
    The server will start on `http://localhost:3000`.

2.  **Expose the local server:**
    -   Use a tunneling service like [ngrok](https://ngrok.com/) to create a public URL for your local server.
    ```bash
    ngrok http 3000
    ```

3.  **Configure LINE Webhook:**
    -   Copy the HTTPS URL provided by ngrok (e.g., `https://xxxx-xxxx.ngrok-free.app`).
    -   Append the webhook path: `https://xxxx-xxxx.ngrok-free.app/api/webhook`.
    -   Paste this full URL into the "Webhook URL" field in your LINE Developer Console's "Messaging API" settings.

### ✅ Running Tests

An extensive suite of unit tests has been set up using Jest to ensure code quality and stability. To run the tests:

```bash
npm test
```

### ☁️ Deployment

This application is optimized for deployment on [Vercel](https://vercel.com/).

1.  Connect your GitHub repository to a new Vercel project.
2.  In the Vercel project settings, add all the environment variables from your `.env` file.
3.  Trigger a deployment. Vercel will automatically detect the configuration and deploy the service.
4.  Once deployed, use the Vercel production URL as your permanent LINE webhook URL.

---

<a name="traditional-chinese"></a>

## 🇹🇼 繁體中文

[![授權條款: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

一個可對話的 AI 助理，以 LINE Bot 的形式運作。其主要目的是幫助使用者透過自然語言，輕鬆地建立 Google 日曆活動。

這個機器人由 Node.js 和 TypeScript 構建，並為 Vercel 的無伺服器 (Serverless) 環境進行了優化設計。其核心特色是能夠處理「多輪對話」。如果使用者提供的資訊不完整 (例如：有時間但沒有標題，或是有重複規則但缺少結束條件)，Bot 會主動反問，以收集建立活動所需的全部細節。

### ✨ 主要功能

-   **自然語言理解**: 由 Google Gemini API 驅動，可解析複雜的語句、日期、時間和重複規則。
-   **整合 Google 日曆**: 使用官方 Google Calendar API，安全地在您的 Google 日曆中建立活動。
-   **對話式介面**: 可處理不完整的指令，並反問以尋求澄清 (例如：活動標題、重複結束日期)。
-   **防止重複事件**: 在建立活動前，會先檢查您的日曆，以避免新增相同的活動。
-   **權限控制**: 透過白名單機制，確保只有被授權的使用者可以與 Bot 互動。

### 🛠️ 技術棧

-   **後端**: Node.js, Express.js, TypeScript
-   **AI 模型**: Google Gemini API (`gemini-1.5-flash`)
-   **日曆服務**: Google Calendar API v3
-   **訊息平台**: LINE Messaging API
-   **測試框架**: Jest, ts-jest
-   **部署平台**: Vercel

### 🚀 設定與安裝

1.  **複製專案倉庫:**
    ```bash
    git clone https://github.com/s0974092/line-gemini-calendar-bot.git
    cd line-gemini-calendar-bot
    ```

2.  **安裝依賴套件:**
    ```bash
    npm install
    ```

3.  **設定環境變數:**
    -   將 `.env.example` 檔案複製一份，並重新命名為 `.env`。
    -   在 `.env` 檔案中，填入所有必要的憑證。您將需要來自 LINE Developer Console、Google Cloud Console (用於 Gemini 和 Calendar API) 的金鑰，以及您自己的 LINE User ID 白名單。

### 🏃 本地端執行

本專案被設計為一個 Webhook 服務，需要一個公開的 HTTPS URL 以便接收來自 LINE 平台的事件。

1.  **啟動本地伺服器:**
    ```bash
    npm run dev
    ```
    伺服器將會啟動在 `http://localhost:3000`。

2.  **暴露本地服務:**
    -   使用如 [ngrok](https://ngrok.com/) 的通道服務，為您的本地伺服器建立一個公開網址。
    ```bash
    ngrok http 3000
    ```

3.  **設定 LINE Webhook:**
    -   複製 ngrok 提供的 HTTPS 網址 (例如：`https://xxxx-xxxx.ngrok-free.app`)。
    -   在其後附加 Webhook 路徑：`https://xxxx-xxxx.ngrok-free.app/api/webhook`。
    -   將此完整網址，貼到您在 LINE Developer Console 中該機器人的「Messaging API」設定頁的「Webhook URL」欄位。

### ✅ 執行測試

專案使用 Jest 建立了一套完整的單元測試，以確保程式碼的品質與穩定性。執行測試：

```bash
npm test
```

### ☁️ 部署

本應用程式已為 [Vercel](https://vercel.com/) 平台進行優化。

1.  將您的 GitHub 倉庫，與一個新的 Vercel 專案連結。
2.  在 Vercel 專案的設定頁面中，將您 `.env` 檔案中的所有環境變數，一一加入。
3.  觸發部署。Vercel 將會自動偵測設定，並將服務部署上去。
4.  部署成功後，使用 Vercel 提供的產品網址，作為您永久的 LINE Webhook URL。

---

<a name="simplified-chinese"></a>

## 🇨🇳 简体中文

[![许可证: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)

一个可对话的 AI 助理，以 LINE Bot 的形式运作。其主要目的是帮助用户透过自然语言，轻松地建立 Google 日历活动。

这个机器人由 Node.js 和 TypeScript 构建，并为 Vercel 的无服务器 (Serverless) 环境进行了优化设计。其核心特色是能够处理「多轮对话」。如果用户提供的信息不完整 (例如：有时间但没有标题，或是有重复规则但缺少结束条件)，Bot 会主动反问，以收集建立活动所需的全部细节。

### ✨ 主要功能

-   **自然语言理解**: 由 Google Gemini API 驱动，可解析复杂的语句、日期、时间和重复规则。
-   **整合 Google 日历**: 使用官方 Google Calendar API，安全地在您的 Google 日历中建立活动。
-   **对话式界面**: 可处理不完整的指令，并反问以寻求澄清 (例如：活动标题、重复结束日期)。
-   **防止重复事件**: 在建立活动前，会先检查您的日历，以避免新增相同的活动。
-   **权限控制**: 透过白名单机制，确保只有被授权的用户可以与 Bot 互动。

### 🛠️ 技术栈

-   **后端**: Node.js, Express.js, TypeScript
-   **AI 模型**: Google Gemini API (`gemini-1.5-flash`)
-   **日历服务**: Google Calendar API v3
-   **消息平台**: LINE Messaging API
-   **测试框架**: Jest, ts-jest
-   **部署平台**: Vercel

### 🚀 设置与安装

1.  **克隆项目仓库:**
    ```bash
    git clone https://github.com/s0974092/line-gemini-calendar-bot.git
    cd line-gemini-calendar-bot
    ```

2.  **安装依赖套件:**
    ```bash
    npm install
    ```

3.  **设置环境变量:**
    -   将 `.env.example` 文件复制一份，并重新命名为 `.env`。
    -   在 `.env` 文件中，填入所有必要的凭证。您将需要来自 LINE Developer Console、Google Cloud Console (用于 Gemini 和 Calendar API) 的密钥，以及您自己的 LINE User ID 白名单。

### 🏃 本地端运行

本專案被設計為一個 Webhook 服務，需要一個公開的 HTTPS URL 以便接收來自 LINE 平台的事件。

1.  **启动本地服务器:**
    ```bash
    npm run dev
    ```
    服务器将会启动在 `http://localhost:3000`。

2.  **暴露本地服务:**
    -   使用如 [ngrok](https://ngrok.com/) 的通道服务，为您的本地服务器建立一个公开网址。
    ```bash
    ngrok http 3000
    ```

3.  **设置 LINE Webhook:**
    -   复制 ngrok 提供的 HTTPS 网址 (例如：`https://xxxx-xxxx.ngrok-free.app`)。
    -   在其后附加 Webhook 路径：`https://xxxx-xxxx.ngrok-free.app/api/webhook`。
    -   将此完整网址，贴到您在 LINE Developer Console 中该机器人的「Messaging API」设定页的「Webhook URL」字段。

### ✅ 运行测试

项目使用 Jest 建立了一套完整的单元测试，以确保代码的质量与稳定性。运行测试：

```bash
npm test
```

### ☁️ 部署

本应用程序已为 [Vercel](https://vercel.com/) 平台进行优化。

1.  将您的 GitHub 仓库，与一个新的 Vercel 项目連結。
2.  在 Vercel 项目的设定页面中，将您 `.env` 文件中的所有环境变量，一一加入。
3.  触发部署。Vercel 将会自动侦測设定，并将服务部署上去。
4.  部署成功后，使用 Vercel 提供的产品网址，作为您永久的 LINE Webhook URL。
