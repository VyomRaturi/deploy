[![Review Assignment Due Date](https://classroom.github.com/assets/deadline-readme-button-22041afd0340ce965d47ae6ef1cefeee28c7c493a6346c4f15d667ab976d596c.svg)](https://classroom.github.com/a/AZ80UqO2)
# Fullstack Developer Hiring – Coding Assignment

## Real-Time Trading Platform (Testnet)

### Objective

Build a full-stack real-time trading platform that demonstrates:
- Backend architecture (message-driven, async execution)
- Real-time data handling (WebSocket streams)
- Frontend engineering (trading UI, charts, state management)
- System design (separation of concerns, scalability)

This assignment evaluates your understanding of distributed systems, not just code output. You will be asked to explain architectural decisions during the interview.

**Important:** This is a testnet assignment for evaluation purposes only. It is not a real trading system and should not be used with real funds or production exchanges.

---

## Deadline

**Sunday, December 21, 2025 at 11:59 PM**

Submit via GitHub Classroom before the deadline. Late submissions will not be accepted.

---

## LLM Usage Policy

LLM assistance is acceptable for up to 20% of the work. You must:
- Understand every line of code you submit
- Be prepared to explain and modify code during the interview
- Clearly document any LLM-generated code sections
- Demonstrate your understanding of the architecture and design decisions

Inability to explain your code or architecture will result in automatic rejection.

---

## Tech Stack Requirements

**Backend:**
- Node.js with Express.js
- Redis (for message bus)
- PostgreSQL or SQLite (Prisma preferred)
- JWT authentication
- Binance Testnet API

**Frontend:**
- Next.js (mandatory)
- TypeScript
- lightweight-charts (TradingView) — mandatory for fullstack
- WebSocket client
- Tailwind CSS (for styling)

**Repository Structure:**
- Monorepo architecture (both backend and frontend in same repository)
- Use a monorepo tool (Turborepo, Nx, or simple workspace structure)

**Deployment:**
- Deploy both backend and frontend
- Provide GitHub repo + live URLs

---

## Submission Method

- Submit via GitHub Classroom
- Repository must be a monorepo containing both backend and frontend
- Both applications must be deployable from the same repository

---

## System Architecture Overview

Your system must follow this architecture pattern:

```
Frontend → API Gateway (JWT auth) → Redis (command bus) → Order Execution
                                                              ↓
Frontend ← WebSocket ← Event Service (subscribes to Redis) ← Order Events
```

**Key principles:**
1. API Gateway does not execute orders directly
2. Orders are published to Redis as commands
3. A separate service consumes Redis events and executes orders
4. Order events flow back through Redis → Event Service → Frontend
5. All order commands and events are logged to a database

---

## Milestone 1: Trade Panel (Core Evaluation)

### Backend Requirements

#### 1. Authentication System

Implement:
- `POST /auth/register`
  - Accepts: `{ email, password, binanceApiKey, binanceSecretKey }`
  - Stores user with hashed password (bcrypt)
  - Stores Binance keys securely (encrypted in DB)
  - Returns JWT token

- `POST /auth/login`
  - Accepts: `{ email, password }`
  - Validates credentials
  - Returns: `{ token, user: { id, email } }`

- JWT middleware for protected routes
- All trading endpoints require valid JWT

#### 2. API Gateway - Order Endpoints

Implement in your Express.js API Gateway:

- `POST /api/trading/orders`
  - **Request:**
    ```json
    {
      "symbol": "BTCUSDT",
      "side": "BUY" | "SELL",
      "type": "MARKET",
      "quantity": 0.001
    }
    ```
  - **Flow:**
    1. Validate JWT token
    2. Extract user ID from token
    3. Validate request body
    4. **Publish command to Redis** (do NOT call Binance directly)
    5. Return: `{ orderId, status: "PENDING" }`

  - **Redis command format:**
    ```
    Channel: commands:order:submit
    Message: {
      "orderId": "uuid",
      "userId": "user-id-from-token",
      "symbol": "BTCUSDT",
      "side": "BUY",
      "type": "MARKET",
      "quantity": 0.001,
      "timestamp": "2024-01-01T00:00:00Z"
    }
    ```

- `GET /api/trading/orders`
  - Returns all orders for authenticated user
  - Fetch from database (orders logged by Event Service)

- `GET /api/trading/positions`
  - Returns current positions for authenticated user
  - Calculate from filled orders

#### 3. Order Execution Service (Separate Service)

Create a separate service/process that:

1. **Subscribes to Redis:**
   - Channel: `commands:order:submit`
   - Consumes order commands

2. **Executes orders:**
   - For each command:
     - Extract user's Binance API keys from database
     - Call Binance Testnet REST API to place order
     - Handle success/failure

3. **Publishes events to Redis:**
   - Channel: `events:order:status`
   - Message format:
     ```json
     {
       "orderId": "uuid",
       "userId": "user-id",
       "status": "FILLED" | "REJECTED" | "PARTIALLY_FILLED",
       "symbol": "BTCUSDT",
       "side": "BUY",
       "quantity": 0.001,
       "price": 67200.12,
       "timestamp": "2024-01-01T00:00:00Z"
     }
     ```

4. **Logs to database:**
   - Store all order commands in `order_commands` table
   - Store all order events in `order_events` table
   - Schema:
     ```sql
     order_commands:
       id, userId, orderId, symbol, side, type, quantity, status, createdAt
     
     order_events:
       id, orderId, userId, status, price, quantity, timestamp, createdAt
     ```

#### 4. Event Broadcasting Service (Separate Service)

Create another service that:

1. **Subscribes to Redis events:**
   - Channel: `events:order:status`

2. **Broadcasts to frontend via WebSocket:**
   - Maintain WebSocket connections per user
   - When order event received, broadcast to user's WebSocket
   - Message format:
     ```json
     {
       "type": "ORDER_UPDATE",
       "data": {
         "orderId": "uuid",
         "status": "FILLED",
         "symbol": "BTCUSDT",
         "price": 67200.12
       }
     }
     ```

3. **WebSocket endpoint:**
   - `ws://your-backend/prices`
   - Requires JWT token in connection handshake
   - Associate WebSocket with user ID

### Frontend Requirements

#### Design Language

Follow the provided trading platform design structure exactly. The UI should match the reference design in:
- Layout structure (header, left panel for order entry, right panel for chart/positions)
- Color scheme and styling
- Component placement and spacing
- Typography and visual hierarchy
- Responsive breakpoints

Use Tailwind CSS for styling to match the design system.

#### 1. Login & Register Pages

- **Login Page:**
  - Email + password form
  - Store JWT token securely (explain your storage strategy)
  - Redirect to trade panel on success
  - Match the design language

- **Register Page:**
  - Form fields:
    - Email
    - Password
    - Binance API Key (Testnet)
    - Binance Secret Key (Testnet)
  - On submit, call `/auth/register`
  - Auto-login after registration
  - Match the design language

#### 2. Trade Panel UI

Build a trading interface matching the provided design:

- **Header Section:**
  - Logo/branding
  - User profile indicator
  - Trading status indicator
  - Theme toggle (if applicable)

- **Left Panel - Order Entry:**
  - Symbol selector (dropdown/search)
  - Buy/Sell tabs
  - Order type selector (Market, Limit, Stop Market)
  - Quantity input field
  - Price input (for limit orders)
  - Total calculation display
  - Available balance display
  - Place order button
  - Account information section (margin ratio, maintenance margin, etc.)

- **Right Panel - Chart & Positions:**
  - Trading pair display
  - Current price with change indicator
  - **Candlestick Chart (MANDATORY for Fullstack):**
    - Use `lightweight-charts` library
    - Fetch historical candles from Binance Testnet
    - Update chart with real-time data via WebSocket
    - Chart must update smoothly without full re-renders
    - Timeframe selector (1m, 5m, 1h, 1d, 1w)
    - **Symbol selection from frontend must automatically update the chart**
    - When user changes symbol in the symbol selector, the chart should:
      - Fetch new historical data for the selected symbol
      - Update WebSocket subscription to new symbol
      - Update chart display without page reload
  - Positions/Orders/Trades table:
    - Tabs for Positions, Orders, Trades
    - Table columns: Transaction, Size, Entry price, Market price, Realized PnL, Unrealized PnL
    - Real-time updates via WebSocket
    - Status indicators with appropriate colors

- **Responsive Design:**
  - Works on desktop, tablet, mobile
  - Chart should be responsive
  - Layout adapts to screen size while maintaining design integrity

---

## Monorepo Structure Requirements

Your repository must follow this structure:

```
your-repo/
├── apps/
│   ├── backend/          # Express.js API Gateway
│   │   ├── src/
│   │   ├── package.json
│   │   └── ...
│   ├── execution-service/ # Order execution service
│   │   ├── src/
│   │   ├── package.json
│   │   └── ...
│   ├── event-service/    # Event broadcasting service
│   │   ├── src/
│   │   ├── package.json
│   │   └── ...
│   └── frontend/         # Next.js frontend
│       ├── src/
│       ├── package.json
│       └── ...
├── packages/             # Shared packages (optional)
│   └── shared/
│       └── types/
├── package.json          # Root package.json with workspace config
├── README.md
└── .gitignore
```

**Requirements:**
- All services must be runnable from the monorepo root
- Shared types/utilities can be in packages directory
- Each app should have its own package.json
- Root package.json should configure workspaces

---

## Technical Evaluation Criteria

### Backend Architecture (Critical)

**Strong Signal:**
- API Gateway publishes to Redis, does NOT call Binance directly
- Separate service handles order execution
- Event-driven architecture (Redis pub/sub)
- Proper JWT validation and user isolation
- Database logging of all commands/events
- WebSocket broadcasting service is separate

**Red Flags:**
- Calling Binance API directly from API Gateway
- Synchronous order execution
- No separation between API and execution
- Storing execution state in API controller
- One WebSocket per user per symbol (should be one per user)

### Frontend Architecture (Critical)

**Strong Signal:**
- Efficient WebSocket handling (single connection, proper cleanup)
- Chart updates without full re-renders (memoization)
- Proper state management (price data vs UI state)
- Optimistic UI updates for orders
- Error boundaries and loading states
- Responsive design that works on mobile
- Design matches provided reference
- Chart automatically updates when symbol changes

**Red Flags:**
- Chart re-renders on every price update
- Multiple WebSocket connections
- No cleanup on component unmount
- Storing sensitive data in localStorage incorrectly
- Design does not match reference structure
- Chart does not update when symbol changes

### Code Quality

- Clean, readable code
- Proper error handling
- TypeScript types (no `any`)
- Consistent code style
- Meaningful commit messages
- Proper monorepo structure

---

## What You Must Explain During Interview

You will be asked to explain:

1. **Why orders are published to Redis instead of executed directly in API**
2. **How your WebSocket fan-out works (one connection per user, not per symbol)**
3. **How you prevent memory leaks in WebSocket connections**
4. **How chart updates are optimized (why memoization is needed)**
5. **How the chart automatically updates when symbol changes**
6. **How you'd scale this to 1000+ concurrent users**
7. **What breaks first if Redis goes down**
8. **How you handle Binance Testnet API rate limits**
9. **Your JWT storage strategy and why it's secure**
10. **Your monorepo structure and why you chose it**

---

## Submission Requirements

1. **GitHub Classroom Repository:**
   - Submit via GitHub Classroom link provided
   - Clean commit history
   - Monorepo structure with both backend and frontend
   - README at root with:
     - Architecture overview (diagram preferred)
     - Setup instructions for all services
     - API documentation
     - Trade-offs made
     - What you'd improve with more time
     - Any LLM-generated code sections clearly marked

2. **Live Deployment:**
   - Backend deployed (Railway, Fly.io, EC2, etc.)
   - Frontend deployed (Vercel preferred)
   - Both URLs working
   - Include deployment URLs in README

3. **Environment Variables:**
   - Document all required env vars
   - Provide `.env.example` files for each service
   - Do NOT commit actual secrets

4. **Demo Video:**
   - Create a 2-minute quick recording demonstrating the system working
   - Show key features:
     - User registration/login
     - Symbol selection and chart updates
     - Placing an order
     - Real-time order status updates
     - Positions table updates
   - Upload to YouTube (unlisted) or similar platform
   - Include video link in README

---

## Bonus Features (Strongly Weighted)

- Input validation (Zod or similar)
- Rate limiting on API endpoints
- Graceful WebSocket reconnection
- Order cancellation functionality
- Price alerts/notifications
- Dark/light theme toggle
- URL-based routing (e.g., `/trade/BTCUSDT`)
- Keyboard shortcuts for trading
- Virtualized tables for large datasets
- Unit tests for critical logic
- Docker setup for local development

---

## Important Notes

- **This is a testnet assignment for evaluation purposes only**
- **This is NOT a real trading system and should not be used with real funds**
- **You may use LLMs for assistance (up to 20% of work)**, but:
  - You must understand every line of code
  - We will ask you to modify code live
  - We will question architectural decisions
  - Inability to explain = automatic rejection

- **This assignment mirrors real trading systems**
- **We evaluate engineering judgment, not just output**
- **Focus on correctness and architecture over fancy UI**
- **Design must match the provided reference structure**

---

## Getting Started

1. **Set up Binance Testnet account:**
   - Go to https://testnet.binance.vision/
   - Generate API keys
   - Use these in registration

2. **Binance Testnet Endpoints:**
   - REST API: `https://testnet.binance.vision/api`
   - WebSocket: `wss://testnet.binance.vision/ws`

3. **Redis Setup:**
   - Use Redis Cloud (free tier) or local Redis
   - Document connection string

4. **Database:**
   - Use PostgreSQL (Railway, Supabase) or SQLite for local dev

5. **Monorepo Setup:**
   - Initialize with your preferred tool (Turborepo, Nx, or npm/pnpm workspaces)
   - Set up workspace configuration
   - Create apps for backend, execution-service, event-service, and frontend

---

## Deadline

**Sunday, December 21, 2025 at 11:59 PM**

Submit via GitHub Classroom before the deadline. Late submissions will not be accepted.

---
<img width="766" height="539" alt="Screenshot 2025-12-19 at 7 56 33 PM" src="https://github.com/user-attachments/assets/a00a54dd-bf48-4a6d-8ab5-35a6a14788d1" />

Good luck! We're looking forward to seeing your solution.
