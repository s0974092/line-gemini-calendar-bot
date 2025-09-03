# 貢獻指南

感謝您對本專案的興趣！我們非常歡迎您的貢獻。在您開始之前，請花一些時間閱讀本指南。

## 行為準則

請務必閱讀並遵守我們的 [行為準則](CODE_OF_CONDUCT.md)。

## 如何貢獻

### 報告 Bug

如果您發現任何 Bug，請透過 GitHub Issues 提交。在提交之前，請先搜尋現有的 Issues，以避免重複。
請盡可能提供詳細的資訊，包括：
*   重現步驟
*   預期行為
*   實際行為
*   錯誤訊息截圖 (如果適用)
*   您的環境資訊 (Node.js 版本, npm 版本, 作業系統等)

### 建議新功能

如果您有任何功能建議，也請透過 GitHub Issues 提交。請詳細描述您的想法，以及它將如何改善專案。

### 提交程式碼 (Pull Request)

1.  **Fork 本專案**：點擊 GitHub 頁面右上角的 "Fork" 按鈕。
2.  **Clone 您的 Fork**：
    ```bash
    git clone https://github.com/您的GitHub使用者名稱/line-gemini-calendar-bot.git
    cd line-gemini-calendar-bot
    ```
3.  **安裝依賴**：
    ```bash
    npm install
    ```
4.  **建立新分支**：為您的功能或 Bug 修正建立一個新的分支。
    ```bash
    git checkout -b feature/your-feature-name
    # 或
    git checkout -b bugfix/fix-description
    ```
5.  **進行修改**：
    *   請遵循專案現有的程式碼風格。
    *   為您的修改編寫測試（如果適用）。
    *   確保所有現有測試通過。
    *   運行 Linting 和格式化工具。
6.  **提交修改**：
    ```bash
    git add .
    git commit -m "feat: Add your feature" # 或 "fix: Fix your bug"
    ```
    請使用清晰且描述性的提交訊息。
7.  **推送到您的 Fork**：
    ```bash
    git push origin feature/your-feature-name
    ```
8.  **建立 Pull Request (PR)**：
    *   前往您的 Fork 頁面，您會看到一個提示，引導您建立 PR。
    *   請詳細描述您的 PR，包括您所做的更改、為什麼這樣做，以及如何測試。

### 程式碼風格

*   我們使用 TypeScript。
*   請遵循專案中現有的程式碼風格和命名約定。
*   在提交之前，請運行 `npm run lint` 和 `npm run format` (如果專案有定義這些腳本)。

### 測試

*   在提交 PR 之前，請確保所有測試都已通過。
*   運行測試：`npm test`

再次感謝您的貢獻！
