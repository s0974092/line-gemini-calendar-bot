# Gemini Project Context: LINE Bot AI Calendar Assistant

## Project Overview

This project is a conversational AI assistant that functions as a LINE Bot. Its primary purpose is to help users create Google Calendar events using natural language. The bot is built with Node.js and TypeScript, and is designed for serverless deployment on Vercel.

A key feature of this bot is its ability to handle multi-turn conversations. If a user provides incomplete information (e.g., a time without a title, or a recurring event without an end condition), the bot will ask follow-up questions to gather the necessary details before creating the event. This stateful interaction is managed by an in-memory state machine.

**Core Technologies:**
- **Backend:** Node.js, Express.js, TypeScript
- **AI Model:** Google Gemini API (`gemini-1.5-flash`) for natural language understanding (NLU), including parsing event details, recurrence rules, and translating rules to human-readable text.
- **Calendar Integration:** Google Calendar API (via `googleapis` library) with OAuth 2.0.
- **Messaging Platform:** LINE Messaging API (via `@line/bot-sdk`).
- **Deployment:** Vercel (Serverless Functions).
- **Development:** `ts-node` and `nodemon` for local development.

**Architecture:**
- The application entry point is `src/index.ts`, which sets up an Express server to act as a webhook for the LINE Messaging API.
- Business logic is separated into services in the `src/services/` directory:
    - `geminiService.ts`: Handles all interactions with the Gemini API. It contains multiple specialized prompts for parsing initial commands, handling recurrence end conditions, and translating RRULEs.
    - `googleCalendarService.ts`: Manages all interactions with the Google Calendar API, including authentication, checking for duplicate events, and creating new events.
- A custom error type, `DuplicateEventError`, is used for specific flow control when an identical event already exists.
- An in-memory `Map` (`conversationStates`) in `src/index.ts` is used to manage the state of multi-turn conversations with users.

## Building and Running

### Environment Setup

1.  Copy the `.env.example` file to a new file named `.env`.
2.  Fill in the required credentials in the `.env` file:
    - `LINE_CHANNEL_SECRET`: From the LINE Developer Console.
    - `LINE_CHANNEL_ACCESS_TOKEN`: From the LINE Developer Console.
    - `GEMINI_API_KEY`: From Google AI Studio.
    - `GOOGLE_CLIENT_ID`: From Google Cloud Console OAuth credentials.
    - `GOOGLE_CLIENT_SECRET`: From Google Cloud Console OAuth credentials.
    - `GOOGLE_REFRESH_TOKEN`: Generated via the OAuth 2.0 Playground.
    - `USER_WHITELIST`: A comma-separated list of LINE User IDs authorized to use the bot.

### Key Commands

The following commands are defined in `package.json`:

-   **Run for local development:**
    ```bash
    npm run dev
    ```
    This starts a local server with hot-reloading using `nodemon`. The server listens on port 3000 by default. Use a tunneling service like `ngrok` to expose the local endpoint to the LINE platform for testing.

-   **Build for production:**
    ```bash
    npm run build
    ```
    This uses `tsc` to compile the TypeScript source files from `src/` into JavaScript files in the `dist/` directory, as configured in `tsconfig.json`.

-   **Run production build:**
    ```bash
    npm run start
    ```
    This runs the compiled JavaScript application from the `dist/` directory using Node.js.

## Development Conventions

-   **Stateful Conversations:** The bot handles multi-turn conversations by storing the user's state in the `conversationStates` map. The state includes the step (`awaiting_event_title`, `awaiting_recurrence_end_condition`) and the partial event data. This allows the bot to ask clarifying questions.
-   **Service-Oriented Structure:** Logic is modularized into services (`geminiService`, `googleCalendarService`) to keep the main webhook handler (`index.ts`) clean and focused on routing and state management.
-   **Custom Error Handling:** The `DuplicateEventError` is used to control the application flow when a user tries to create an event that already exists, allowing for a specific, user-friendly message to be sent.
-   **Duplicate Prevention:** Before creating an event, the `googleCalendarService` searches for existing events with the same title and time to prevent duplicates.
-   **User-Friendly Replies:** The bot uses LINE's `ButtonsTemplate` for confirmations and provides detailed success messages, including a human-readable summary of any recurrence rules.
