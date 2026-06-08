# Factory Data Board

A full-stack, real-time industrial monitoring solution designed to track the operational status, telemetry, and safety metrics of X-Ray machines and other factory nodes via MQTT.

## Features

- **Real-Time Telemetry & Monitoring:** Listens to MQTT heartbeats and state changes to track device statuses (Online/Offline) and operational durations.
- **Role-Based Access Control (RBAC):** Secure authentication system supporting Admin and Technician roles. Admins have extensive privileges, including managing nodes and updating configurations.
- **Safety & Watchdog Alerts:** Background workers continuously monitor nodes. If a device goes offline or emits radiation longer than a configured threshold, the system triggers alerts.
- **Telegram Integration:** Instant notifications for critical factory alerts delivered securely via an integrated Telegram Bot.
- **Advanced Analytics & Reporting:** Interactive dashboards powered by Recharts, alongside export capabilities generating rich Excel and granular PDF telemetry reports (with multi-page footers handled elegantly).
- **Maintenance Ledger:** Keep a pristine record of all technician interventions, service events, and operational anomalies.

## Tech Stack

### Frontend

- **Framework:** React 18 with TypeScript and Vite
- **Styling:** Tailwind CSS for a highly polished, responsive interface
- **Icons & Animations:** `lucide-react` for iconography and `motion` for fluid state transitions
- **Data Visualization:** `recharts` for telemetry graphing
- **Exporting:** `jspdf`, `jspdf-autotable`, and `xlsx` for comprehensive data extraction

### Backend

- **Server:** Node.js with Express
- **Database:** SQLite (`better-sqlite3`) for robust, zero-configuration local data persistence
- **IoT / Messaging:** `mqtt` for subscribing to broker topics
- **Authentication:** `bcryptjs` and `jsonwebtoken` (JWT) integrated with `cookie-parser`
- **Notifications:** `node-telegram-bot-api`

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- A running MQTT Broker (e.g., Mosquitto)

### Installation & Execution

1. **Install Dependencies:**

   ```bash
   npm install
   ```

2. **Configure Environment:**
   Create a `.env` file based on `.env.example`.

   ```env
   # JWT Configuration
   JWT_SECRET=your_super_secret_jwt_key

   # MQTT Configuration
   MQTT_BROKER_URL=mqtt://localhost:1883
   MQTT_USERNAME=optional_username
   MQTT_PASSWORD=optional_password
   ```

   _(Note: Telegram Chat ID and Bot Token are configured directly within the Admin UI under System Configuration)_

3. **Development Mode:**
   To run both the Vite frontend and Express backend concurrently:

   ```bash
   npm run dev
   ```

   The application will be accessible at `http://localhost:3000`.

4. **Production Build:**
   Compile the Vite application and ESBuild the server:
   ```bash
   npm run build
   npm run start
   ```

## MQTT Topic Structure

The backend subscribes to the following topic formats:

- **Heartbeats:** `factory/southern_chips/nodes/+/heartbeat`
- **Machine State:** `factory/southern_chips/nodes/+/state`
  - (Expects a JSON payload like `{"event_type": "xray_status", "is_active": true}`)

## Architecture Notes

- The SQLite database (`factory.db`) is automatically initialized upon server start, migrating schema definitions directly.
- The platform uses a single-port architecture behind the scenes by mounting Vite middleware on top of the Express router during development.
- Production builds statically serve the React client output via Express alongside the API routes.
