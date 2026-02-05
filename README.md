# QuizBall Backend

Express.js + TypeScript backend for QuizBall - a real-time trivia competition platform.

## Prerequisites

- **Node.js** 20+ ([download](https://nodejs.org/))
- **Docker** & **Docker Compose** ([download](https://www.docker.com/products/docker-desktop))
- **Supabase account** with database and auth configured

## Quick Start

### 1. Environment Setup

Copy the example environment file and update with your credentials:

```bash
cp .env.example .env
```

Update `.env` with your Supabase credentials:

```env
# Database (get from Supabase dashboard)
DATABASE_URL=postgresql://user:password@host:port/postgres
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_JWT_SECRET=your-jwt-secret

# CORS origins
CORS_ORIGINS=http://localhost:3000,http://localhost:5173

# Redis (will be managed by Docker)
REDIS_PASSWORD=changeme
REDIS_URL=redis://:changeme@localhost:6379
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start with Docker (Recommended)

This command starts Redis in Docker and runs the API locally:

```bash
npm run docker:start
```

This will:
- ✅ Start Redis in Docker on port 6379
- ✅ Create a `.env` file if it doesn't exist
- ✅ Wait for services to be healthy
- ✅ Display connection information

**Outputs:**
```
✅ QuizBall Backend is running!

   API:     http://localhost:8000
   Docs:    http://localhost:8000/docs
   Health:  http://localhost:8000/health
   Redis:   localhost:6379

   To view logs:  docker compose logs -f
   To stop:       npm run docker:stop
```

### 4. Start Development Server

In a **new terminal**, start the API development server:

```bash
npm run dev
```

The API will be available at `http://localhost:8000`

## Available Scripts

### Development

```bash
npm run dev          # Start dev server with hot-reload (requires Redis running)
npm run build        # Build TypeScript to JavaScript
npm run lint         # Check TypeScript types
npm run test         # Run tests once
npm run test:watch   # Run tests in watch mode
```

### Docker

```bash
npm run docker:start    # Start Redis in Docker and show setup info
npm run docker:stop     # Stop all Docker containers
npm run docker:logs     # View container logs in real-time
```

### Database

```bash
npm run db:start                # Start local Supabase (with database)
npm run db:migrate:up           # Apply pending migrations to local DB
npm run db:migrate:up:remote    # Apply pending migrations to production DB
npm run db:reset                # Reset local database
npm run db:types                # Generate TypeScript types from schema
```

### API Documentation

```bash
npm run api:export   # Export OpenAPI schema to openapi.json
```

## Project Structure

```
src/
├── main.ts                 # Application entry point
├── core/                   # Core utilities
│   ├── config.ts          # Environment & configuration
│   ├── errors.ts          # Error definitions
│   ├── logger.ts          # Logging setup
│   └── types.ts           # Shared types
├── http/                  # HTTP layer
│   ├── server.ts          # Express app setup
│   ├── middleware/        # Express middleware
│   ├── routes/            # API routes
│   └── openapi/           # OpenAPI/Swagger setup
├── modules/               # Business logic by domain
│   ├── auth/              # Authentication
│   ├── users/             # User management
│   ├── categories/        # Quiz categories
│   ├── questions/         # Quiz questions
│   ├── matches/           # Match management
│   ├── stats/             # Player statistics
│   └── tournaments/       # Tournament logic
├── realtime/              # WebSocket & real-time
│   ├── socket.ts          # Socket.IO setup
│   ├── handlers/          # Event handlers
│   ├── services/          # Real-time logic
│   └── redis.ts           # Redis connection
└── db/                    # Database
    ├── client.ts          # Database client
    ├── types.ts           # Generated types
    └── migrations/        # SQL migrations
```

## API Documentation

Once the server is running, view API docs at:

- **Swagger UI**: http://localhost:8000/docs
- **OpenAPI JSON**: http://localhost:8000/openapi.json
- **Health Check**: http://localhost:8000/health

## Architecture

### Core Components

- **Express.js** - HTTP server & routing
- **TypeScript** - Type safety
- **Supabase** - PostgreSQL database & auth
- **Redis** - Real-time data & WebSocket adapter
- **Socket.IO** - Real-time multiplayer
- **Zod** - Request validation
- **Pino** - Structured logging

### Data Flow

```
Client → Express Routes → Modules (Service) → Database/Redis
         ↓
       Validation (Zod)
       Error Handling
       Logging
```

### Real-time (WebSocket)

```
Socket.IO Client → WebSocket Handler → Realtime Service → Redis → Broadcasting
```

## Troubleshooting

### Redis connection refused

**Problem:** `Error: connect ECONNREFUSED`

**Solution:**
```bash
# Check Docker is running
docker ps

# Restart Redis
npm run docker:stop
npm run docker:start
```

### Port already in use

**Problem:** `Error: listen EADDRINUSE :::8000`

**Solution:**
```bash
# Find and kill process using port 8000
lsof -i :8000
kill -9 <PID>

# Or use a different port
PORT=8002 npm run dev
```

### Database connection failed

**Problem:** `Error: connect ECONNREFUSED 127.0.0.1:5432`

**Solution:**
- Verify `DATABASE_URL` in `.env` is correct
- Ensure Supabase database is running and accessible
- Check network connectivity to Supabase

### Missing environment variables

**Problem:** `Error: Missing required environment variables`

**Solution:**
```bash
# Check .env file exists and has all required variables
cat .env

# Compare with .env.example
diff .env .env.example
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | Yes | `local` | `local`, `dev`, or `prod` |
| `PORT` | No | `8000` | Server port |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `SUPABASE_URL` | Yes | - | Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | - | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | - | Supabase service role key |
| `SUPABASE_JWT_SECRET` | No | - | JWT secret (if using JWKS) |
| `REDIS_URL` | Yes | - | Redis connection URL |
| `REDIS_PASSWORD` | Yes | - | Redis password |
| `CORS_ORIGINS` | No | `*` | Comma-separated CORS origins |
| `DOCS_ENABLED` | No | `true` | Enable/disable API docs |
| `DOCS_USERNAME` | No | - | Basic auth username for docs |
| `DOCS_PASSWORD` | No | - | Basic auth password for docs |

## Local Development Workflow

1. **Start Redis in Docker:**
   ```bash
   npm run docker:start
   ```

2. **In another terminal, start dev server:**
   ```bash
   npm run dev
   ```

3. **Run tests in watch mode (optional):**
   ```bash
   npm run test:watch
   ```

4. **Make changes** - server auto-reloads with hot-reload

5. **View API docs** - http://localhost:8000/docs

6. **When done, stop everything:**
   ```bash
   npm run docker:stop
   ```

## Production Deployment

### Docker Build

```bash
docker build -t quizball-backend .
```

### Docker Run

```bash
docker run -p 8000:8000 \
  -e DATABASE_URL=postgresql://... \
  -e SUPABASE_URL=https://... \
  -e REDIS_URL=redis://... \
  quizball-backend
```

### Environment for Production

- Set `NODE_ENV=prod`
- Use strong Redis password
- Protect API docs with `DOCS_USERNAME` and `DOCS_PASSWORD`
- Use HTTPS for CORS origins
- Set appropriate `LOG_LEVEL`

## Testing

```bash
# Run all tests once
npm run test

# Run tests in watch mode
npm run test:watch

# Run with coverage
npm run test -- --coverage
```

## Contributing

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make changes and test: `npm run test`
3. Lint types: `npm run lint`
4. Commit with clear message
5. Push and create pull request

## Documentation

- [Development Guidelines](./DEVELOPMENT_GUIDELINES.md)
- [API Documentation](http://localhost:8000/docs) (when running)
- [Database Migrations](./supabase/migrations/)
- [OpenAPI Schema](./openapi.json)

## Support

For issues and questions:
1. Check existing [issues](../../issues)
2. Create a new issue with clear description
3. Include logs and environment details

## License

ISC
