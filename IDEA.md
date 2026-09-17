# Super-Logs

## Project Specification / CLI Agent Prompt

## 1. Project Overview

Build **Super-Logs**, an open-source, self-hosted observability and incident-response platform created specifically for the F1 Fantasy application:

**Production application:** `https://f1.bortolaso.eu`

The goal is to create a lightweight alternative to existing observability/logging platforms that can be deeply integrated into the application's codebase without depending on an expensive external SaaS product.

Super-Logs should provide:

- Centralized application logs
- Server and infrastructure health monitoring
- Error, warning, and critical-event tracking
- A very simple web UI for developers/admins
- Telegram notifications for important incidents
- AI-assisted log analysis and debugging
- User-session diagnostic information when a user reports a problem
- A workflow that helps identify, reproduce, explain, and fix issues quickly
- An architecture that can eventually be extracted into a reusable open-source project

This project should be designed as a **developer-first internal observability platform**, but with clean boundaries so that it can later become a standalone open-source tool.

---

# 2. Core Vision

The central idea is:

> When something goes wrong, Super-Logs should automatically collect the relevant evidence, understand the incident, notify the developer, and help identify the fix.

Example flow:

1. A user encounters a problem in the F1 Fantasy application.
2. The frontend reports a structured error/event to Super-Logs.
3. Super-Logs correlates the event with the user/session/request.
4. The platform collects relevant technical diagnostics.
5. A developer receives a Telegram notification for incidents above a configured severity.
6. AI analyzes the error, surrounding logs, request context, recent related events, and available diagnostic information.
7. The dashboard presents a concise explanation, probable root causes, and suggested next debugging steps.
8. The developer can inspect the incident timeline and decide whether to deploy a fix.

The system should reduce the amount of time required to answer:

> "What exactly happened, why did it happen, who was affected, and what should I change?"

---

# 3. Important Product Principle

Do **not** build a generic enterprise observability clone.

Build a small, practical, opinionated system for a modern web application using the project's actual stack.

The product should optimize for:

- simplicity
- low resource usage
- self-hosting
- easy integration
- useful defaults
- excellent developer experience
- strong privacy/security
- AI-assisted diagnosis

Avoid unnecessary complexity such as a massive distributed architecture unless it becomes necessary.

---

# 4. Current Application Context

Super-Logs is being developed primarily for:

`https://f1.bortolaso.eu`

The main application is a web application built with:

- React frontend
- Node.js backend

The Super-Logs integration should therefore prioritize:

- JavaScript/TypeScript
- React browser integration
- Node.js server integration
- REST/HTTP-based ingestion
- JSON structured events

The exact existing F1 application architecture must be inspected before implementation. Do not blindly assume directory names, frameworks, deployment providers, or database technologies.

---

# 5. Main Components

Super-Logs should initially contain the following components.

## 5.1 Log Collector / Ingestion API

A small backend service that accepts structured diagnostic events.

It should support at least:

- `debug`
- `info`
- `warning`
- `error`
- `critical`

Every event should contain useful metadata such as:

- timestamp
- severity
- service
- environment
- hostname/server identifier
- application version / git commit when available
- request ID
- session ID
- user ID hash or internal identifier where appropriate
- route/page
- HTTP method
- HTTP status
- error name
- error message
- stack trace
- browser information
- OS information
- device class
- IP-derived metadata only when legally justified and necessary
- arbitrary structured metadata

The system must support structured JSON instead of plain text as the primary format.

Example conceptual event:

```json
{
  "timestamp": "2026-09-17T10:30:00.000Z",
  "level": "error",
  "service": "frontend",
  "environment": "production",
  "event": "api_request_failed",
  "message": "Failed to load championship standings",
  "requestId": "req_123",
  "sessionId": "sess_456",
  "route": "/standings",
  "httpStatus": 500,
  "error": {
    "name": "ApiError",
    "stack": "..."
  },
  "metadata": {
    "endpoint": "/api/standings"
  }
}
```

---

# 6. Frontend Monitoring SDK

Create a small frontend SDK/package for React applications.

The SDK should make logging extremely easy.

Example API concept:

```ts
superLogs.info("User opened standings", {
  route: "/standings"
});

superLogs.error("Failed to load standings", {
  error,
  endpoint: "/api/standings"
});
```

The SDK should optionally capture:

- unhandled JavaScript exceptions
- unhandled promise rejections
- React rendering errors / Error Boundaries
- failed network requests
- slow requests
- HTTP 4xx/5xx responses
- browser/device metadata
- current route
- performance information
- console errors, only when explicitly enabled

The SDK should be lightweight and should not significantly degrade application performance.

Use batching/throttling where appropriate to avoid generating excessive traffic.

---

# 7. Backend Logging SDK

Create a corresponding Node.js logging module.

It should support structured logs with an API similar to:

```ts
superLogs.info("Fantasy league loaded", {
  userId,
  leagueId
});

superLogs.error("Database query failed", {
  error,
  queryName: "getLeague"
});
```

The backend integration should support request correlation.

A request should ideally receive a `requestId`, which is propagated across:

frontend -> API -> backend services -> database/external service calls

This allows Super-Logs to reconstruct an incident timeline.

---

# 8. Incident Management

Raw logs are not enough.

Super-Logs should group related events into **incidents**.

For example, 500 identical errors from different requests within a few minutes should ideally become one incident with:

- incident title
- severity
- first seen
- last seen
- occurrence count
- affected users
- affected routes
- affected services
- example stack traces
- recent related logs
- status
- assigned/responsible developer (future)
- AI analysis

Incident states should initially include:

- `OPEN`
- `ACKNOWLEDGED`
- `RESOLVED`
- `IGNORED`

The dashboard should make active incidents immediately visible.

---

# 9. Dashboard UI

Create a deliberately simple admin dashboard.

The UI should prioritize visibility over decoration.

Recommended initial sections:

### Overview

Show:

- server status
- application status
- database status when measurable
- uptime
- CPU usage
- RAM usage
- disk usage
- request rate
- error rate
- active incidents
- recent critical events

### Logs

A searchable/filterable log stream.

Filters:

- level
- service
- environment
- date/time
- route
- request ID
- session ID
- user
- event type

### Incidents

List all active/recent incidents with:

- severity
- title
- occurrence count
- affected users
- first/last occurrence
- current status

### Incident Details

Show a timeline containing:

- initial event
- related requests
- related errors
- stack traces
- client information
- server information
- relevant logs before/after the event
- AI analysis
- suggested actions

### Server

Simple infrastructure metrics and service health.

### Users / Sessions (diagnostic only)

Allow an administrator to find diagnostic sessions without exposing unnecessary personal information.

---

# 10. User Diagnostic / "Take a Picture" Concept

One of the most important features of Super-Logs is the ability to help debug problems experienced by real users.

However, this must **not** attempt to secretly access a user's device, camera, filesystem, desktop, or private data.

The safe implementation should use explicit user consent and browser-supported diagnostic capture.

Possible workflow:

1. User encounters a problem.
2. The application displays a diagnostic/help action such as:
   - "Report a problem"
   - "Send diagnostic information"
3. The user explicitly consents.
4. The application captures a screenshot of the relevant web page or diagnostic UI, where technically possible.
5. The app collects non-sensitive technical context such as:
   - browser name/version
   - OS family
   - viewport size
   - screen characteristics
   - route
   - current application version
   - request/session correlation ID
   - recent frontend errors
   - recent failed API calls
   - performance timings
6. The information is sent to Super-Logs.
7. AI analyzes the collected evidence.
8. The developer can inspect the resulting incident.

Do not implement unrestricted camera access or hidden device photography.

If the product later supports an uploaded photo/screenshot from the user, it must be an explicit upload initiated by the user.

All diagnostic capture must have clear privacy boundaries and configurable retention.

---

# 11. Session Replay / Diagnostic Context

A future feature may optionally capture a lightweight technical session timeline.

Potential data:

- navigation events
- clicks on important UI components
- API request failures
- frontend exceptions
- console errors
- page performance metrics
- selected application events

Do not record sensitive user input by default.

Passwords, authentication tokens, private messages, payment information, and other sensitive fields must never be captured.

Provide masking/redaction mechanisms.

---

# 12. Telegram Integration

Super-Logs should integrate with Telegram using a bot.

Telegram notifications should be configurable by severity and event type.

Example:

```text
🚨 SUPER-LOGS INCIDENT

Severity: CRITICAL
Service: backend
Environment: production

Database connection failed

Occurrences: 17
Affected users: 6
First seen: 12:42:10
Last seen: 12:43:02

Request: req_123

AI summary:
Database connectivity appears to be failing intermittently.

Dashboard:
https://f1.bortolaso.eu/super-logs/incidents/INC-102
```

Notification rules should support:

- critical only
- error + critical
- specific services
- incident creation
- incident escalation
- server offline
- abnormal error rate

Avoid sending one Telegram message per log line.

Use incident aggregation, deduplication and cooldowns.

---

# 13. AI Integration

AI should be an optional module, not a mandatory dependency for the basic logging system.

The platform should support a provider abstraction so the implementation can later work with different models/providers.

Conceptual interface:

```ts
interface AiProvider {
  analyzeIncident(input: IncidentAnalysisInput): Promise<IncidentAnalysisResult>;
}
```

The AI should receive carefully selected context, for example:

- incident metadata
- representative logs
- stack traces
- request timeline
- frontend diagnostic data
- server metrics around the incident
- recent deployments / git commits when available
- relevant application version

The AI result should contain structured fields such as:

- summary
- probable root cause
- evidence
- affected component
- confidence/uncertainty
- recommended debugging steps
- possible fix
- related incidents

Do not allow AI-generated output to automatically modify production code or deploy changes.

AI suggestions are advisory and must be reviewed by a developer.

---

# 14. AI-Assisted Root Cause Analysis

The system should eventually be able to answer questions such as:

> Why are users currently receiving HTTP 500 errors on `/api/standings`?

The analysis pipeline should attempt to correlate:

- current incident
- previous occurrences of the same issue
- recent code/deployment changes
- server resource anomalies
- related database errors
- upstream API failures
- frontend error reports

Example result concept:

```text
Summary
-------
The standings endpoint is failing because the database query is receiving an invalid league ID.

Evidence
--------
- 92% of recent failures contain the same validation error.
- The issue started immediately after deployment abc123.
- The failing route is /api/standings.

Likely component
----------------
League validation / API controller

Suggested debugging steps
-------------------------
1. Inspect commit abc123.
2. Reproduce with the affected league ID.
3. Check the league validation middleware.
4. Add regression coverage.
```

The wording must clearly distinguish observed evidence from AI inference.

---

# 15. Server Monitoring

Super-Logs should expose basic health information without attempting to become a full infrastructure monitoring product.

Initial metrics:

- uptime
- CPU usage
- RAM usage
- disk usage
- load average where available
- process status
- application response status
- network/request rate
- error rate

The platform should support health checks for:

- frontend
- backend API
- database
- selected external services

Use thresholds with sensible defaults and allow customization.

---

# 16. Health Check System

Each monitored service should expose or register a health check.

Example:

```json
{
  "service": "backend",
  "status": "healthy",
  "latencyMs": 34,
  "timestamp": "2026-09-17T10:30:00Z"
}
```

Possible states:

- healthy
- degraded
- unhealthy
- unknown

Health checks should be visible on the dashboard.

---

# 17. Alerting Engine

Create a small rules engine.

Examples:

```text
IF severity == critical
THEN notify telegram
```

```text
IF error_rate > threshold for N minutes
THEN create incident
```

```text
IF backend health == unhealthy
THEN notify telegram
```

```text
IF same error occurs > 20 times in 5 minutes
THEN group into incident
```

Rules should be data-driven where practical instead of hardcoded.

---

# 18. Storage

Use a simple persistent database appropriate for the project's expected scale.

Do not introduce distributed databases unless the existing application architecture requires it.

The storage model should support:

- logs
- incidents
- health checks
- alert rules
- notification history
- diagnostic sessions
- AI analyses

Retention should be configurable.

For example:

- raw logs: short retention
- incidents: longer retention
- aggregated metrics: longer retention

Provide cleanup jobs so the observability database cannot grow indefinitely.

---

# 19. Security Requirements

Security is a first-class requirement.

The dashboard must not be publicly exposed without authentication.

At minimum implement:

- authentication
- authorization
- secure session handling
- API authentication for log ingestion
- configurable API keys/tokens
- rate limiting
- request validation
- input sanitization
- audit logging for administrative actions

Never place secret credentials in frontend code.

Never store raw authentication tokens/passwords in logs.

Sensitive fields should support automatic redaction.

---

# 20. Privacy Requirements

Super-Logs may process user-generated diagnostic information. Treat this as sensitive operational data.

The implementation should follow privacy-by-design principles.

Important requirements:

- explicit user consent for screenshots or diagnostic uploads
- no hidden camera access
- no hidden desktop/device capture
- no arbitrary filesystem access
- configurable retention
- data minimization
- sensitive-field redaction
- clear separation between diagnostic data and application data
- ability to delete diagnostic records

The system should collect only what is required to diagnose the issue.

---

# 21. Repository Structure

The final structure may evolve after inspecting the existing application, but a reasonable starting point is:

```text
super-logs/
├── apps/
│   ├── dashboard/
│   └── api/
├── packages/
│   ├── core/
│   ├── react-sdk/
│   ├── node-sdk/
│   ├── ai/
│   └── shared/
├── workers/
│   ├── incident-worker/
│   ├── alert-worker/
│   └── cleanup-worker/
├── docs/
├── examples/
├── docker/
├── scripts/
├── .env.example
├── docker-compose.yml
└── README.md
```

This is a suggested structure, not a strict requirement. Inspect the current project and choose the simplest architecture that fulfills the requirements.

---

# 22. Development Philosophy

Prioritize a working MVP over an over-engineered architecture.

Do not start by building every feature.

The MVP should demonstrate the complete path:

```text
React app
   ↓
Frontend SDK
   ↓
Super-Logs API
   ↓
Storage
   ↓
Incident engine
   ↓
Dashboard
   ↓
Telegram notification
```

Then add:

```text
Incident
   ↓
AI analysis
   ↓
Root-cause explanation
```

Then add:

```text
User diagnostic report
   ↓
Screenshot / technical context
   ↓
Incident correlation
   ↓
AI analysis
```

---

# 23. Suggested MVP Milestones

## Phase 1 — Logging Core

Implement:

- structured event format
- ingestion API
- Node SDK
- React SDK
- persistent storage
- log dashboard
- filtering
- authentication

Definition of success:

A frontend or backend error appears in the dashboard within seconds with complete structured context.

## Phase 2 — Incidents and Alerts

Implement:

- error grouping
- incident creation
- severity handling
- health checks
- alert rules
- Telegram integration
- deduplication/cooldowns

Definition of success:

A real production error automatically becomes a single incident and produces a useful Telegram notification.

## Phase 3 — AI Analysis

Implement:

- AI provider abstraction
- incident analysis pipeline
- structured AI results
- incident AI view
- evidence-based analysis

Definition of success:

Given a real incident, AI can summarize the problem and identify useful evidence-backed debugging directions.

## Phase 4 — User Diagnostics

Implement:

- "Report a problem" flow
- explicit consent
- screenshot capture where technically possible
- technical browser context
- diagnostic bundle
- incident correlation

Definition of success:

A developer can inspect a user's diagnostic report and correlate it with the server-side error without requiring a long manual exchange with the user.

## Phase 5 — Open-Source Hardening

Implement:

- documentation
- Docker deployment
- environment configuration
- setup scripts
- SDK documentation
- security review
- privacy documentation
- example integrations
- contribution guide
- license selection

---

# 24. CLI Agent Instructions

You are the implementation agent responsible for designing and building Super-Logs.

Before writing significant code:

1. Inspect the existing F1 Fantasy repository.
2. Identify its frontend, backend, database, deployment environment, authentication mechanism, and current logging behavior.
3. Identify where Super-Logs can be integrated with minimal disruption.
4. Produce a short architecture proposal based on the actual repository.
5. Prefer reusing the project's existing technologies when reasonable.
6. Avoid adding dependencies that duplicate functionality already present.

Then implement incrementally.

For each major feature:

- write tests where practical
- handle failures explicitly
- avoid swallowing errors
- document environment variables
- update README/documentation
- keep APIs backward-compatible when possible

Do not rewrite the entire application simply to integrate Super-Logs.

---

# 25. Reverse-Engineering / Competitive Research Direction

The inspiration for Super-Logs comes from existing observability and debugging products.

The goal is **not** to copy proprietary source code or reproduce protected implementation details.

Instead:

- study the publicly observable product behavior
- identify useful concepts
- understand common architectures
- identify which features are genuinely valuable
- implement an original open-source design

Focus on reproducing the **useful developer workflow**, not proprietary code.

Examples of concepts worth studying:

- log ingestion
- structured logging
- error aggregation
- issue grouping
- session context
- performance monitoring
- alerting
- incident timelines
- AI-assisted diagnosis
- user-reported diagnostics

---

# 26. API Design Principles

The APIs should be small and predictable.

Potential endpoints:

```text
POST   /api/events
POST   /api/errors
POST   /api/diagnostics
POST   /api/health
GET    /api/logs
GET    /api/incidents
GET    /api/incidents/:id
POST   /api/incidents/:id/acknowledge
POST   /api/incidents/:id/resolve
POST   /api/incidents/:id/analyze
GET    /api/metrics
GET    /api/server/health
```

These are examples only. Adapt them to the final architecture.

---

# 27. Event Correlation

Correlation is one of the most important technical features.

A single user action should ideally be traceable across the application.

Example:

```text
Browser click
   ↓
frontend event
   ↓ requestId
API request
   ↓ requestId
backend service
   ↓ requestId
DB query
   ↓
error
```

Super-Logs should make this relationship visible in the UI.

---

# 28. Error Fingerprinting

Implement a deterministic fingerprint for recurring errors.

A fingerprint may be derived from a normalized combination of:

- service
- error name
- error message template
- stack trace location
- route
- endpoint

The purpose is to group recurring occurrences of essentially the same problem.

Avoid including highly variable data such as timestamps or user IDs in the fingerprint.

---

# 29. Performance Constraints

Super-Logs must remain lightweight.

The monitored application should not suffer noticeable performance degradation because of logging.

Client-side logging should therefore use:

- batching
- async transmission
- sampling where configurable
- payload limits
- local queueing where useful
- backoff after ingestion failures

Logging must never make an already-failing application significantly worse.

---

# 30. Failure Handling

Observability software must continue to be safe when the observability server itself is unavailable.

If Super-Logs is down:

- the F1 application should continue working
- frontend logging should fail silently or degrade gracefully
- backend logging should not block user requests
- queued telemetry should have strict size/time limits

The application must never depend synchronously on Super-Logs for core business functionality.

---

# 31. Configuration

All sensitive or environment-specific configuration should use environment variables.

Potential configuration values:

```text
SUPER_LOGS_URL
SUPER_LOGS_API_KEY
SUPER_LOGS_ENVIRONMENT
SUPER_LOGS_SERVICE_NAME
SUPER_LOGS_LOG_LEVEL
SUPER_LOGS_TELEGRAM_BOT_TOKEN
SUPER_LOGS_TELEGRAM_CHAT_ID
SUPER_LOGS_AI_PROVIDER
SUPER_LOGS_AI_API_KEY
SUPER_LOGS_RETENTION_DAYS
SUPER_LOGS_DIAGNOSTIC_RETENTION_DAYS
```

Provide `.env.example` files.

Never commit real secrets.

---

# 32. Observability of Super-Logs Itself

Super-Logs must monitor itself.

At minimum, expose:

- ingestion request rate
- ingestion failures
- processing latency
- database health
- worker health
- Telegram delivery failures
- AI provider failures
- queue size

The observability system should not become a black box.

---

# 33. Developer Experience

The integration should eventually feel as simple as:

```ts
import { createSuperLogs } from "@super-logs/node";

const logs = createSuperLogs({
  service: "f1-backend",
  environment: "production"
});

logs.error(error, {
  route: req.path,
  requestId: req.id
});
```

And for React:

```ts
import { createSuperLogs } from "@super-logs/react";

const logs = createSuperLogs({
  endpoint: "/api/events"
});
```

The final SDK APIs should be intuitive and strongly typed.

---

# 34. UI Design Principles

Keep the dashboard visually simple.

The primary screen should answer immediately:

- Is the application healthy?
- Is something currently broken?
- How many users are affected?
- What happened recently?
- What needs attention?

Use clear severity indicators and compact information density.

Avoid building an unnecessarily complex analytics dashboard.

---

# 35. AI Safety and Reliability

AI analysis can be wrong.

Therefore:

- never represent speculation as fact
- display evidence separately from inference
- expose uncertainty
- provide links to the underlying logs
- never automatically deploy AI-generated code
- never automatically execute destructive commands
- never grant the AI unrestricted server access

A future controlled automation layer may exist, but it must be explicit, permissioned, and auditable.

---

# 36. Future Automation Possibilities

Potential future capabilities:

- automatically create GitHub issues
- attach incident context to issues
- compare incidents with recent commits
- suggest code patches
- generate regression tests
- run diagnostics in a sandbox
- automatically verify a proposed fix
- send incident summaries to Telegram
- create daily/weekly health reports

These are future features and should not block the MVP.

---

# 37. Example End-to-End Scenario

A user opens F1 Fantasy standings.

The frontend calls:

```text
GET /api/standings
```

The backend throws a database error.

Super-Logs receives:

```text
frontend request failed
backend 500
DB exception
requestId=req_abc
sessionId=sess_xyz
```

The incident engine groups the events into one incident.

Telegram receives:

```text
🚨 Backend incident detected
GET /api/standings
500 errors: 12
Affected users: 8
```

The developer opens the incident.

Super-Logs displays:

```text
Timeline
12:41:01 frontend request
12:41:01 backend request
12:41:01 database error
12:41:02 frontend 500
...
```

The user presses:

```text
Report a problem
```

The app asks for consent and collects a screenshot plus technical diagnostics.

AI analyzes the incident and reports:

```text
Observed evidence:
- 12 requests failed with the same database exception.
- All failures originated from /api/standings.
- The issue began shortly after deployment X.

Likely cause:
A change in standings query parameters may be incompatible with the current database schema.

Recommended verification:
Inspect deployment X and compare the query with the current schema.
```

The developer fixes the issue and deploys a new version.

The incident becomes:

```text
RESOLVED
```

---

# 38. Definition of Done for the First Production Version

The first usable production version should satisfy all of the following:

- [ ] Frontend can send structured logs
- [ ] Backend can send structured logs
- [ ] Logs are persisted
- [ ] Dashboard is authenticated
- [ ] Logs are searchable
- [ ] Errors are grouped into incidents
- [ ] Incidents have severity and status
- [ ] Basic server health is visible
- [ ] Telegram notifications work
- [ ] Notifications are deduplicated
- [ ] Request IDs correlate frontend/backend events
- [ ] Basic retention/cleanup exists
- [ ] Sensitive fields are redacted
- [ ] Super-Logs failure does not break the F1 application
- [ ] AI analysis can be triggered for an incident
- [ ] AI results distinguish evidence from inference
- [ ] User diagnostic reporting requires explicit consent
- [ ] Screenshot/diagnostic data can be linked to an incident
- [ ] Documentation exists for installation and integration
- [ ] Environment variables are documented
- [ ] No production secrets are committed

---

# 39. Final Instruction to the CLI Agent

Treat this document as the product vision and engineering specification for Super-Logs.

Start by inspecting the real F1 Fantasy codebase and deployment environment.

Do not assume infrastructure details that have not been verified.

Do not over-engineer the system.

Build a small, reliable, secure, self-hosted observability platform that can grow into an open-source project.

The most important success criterion is not the number of features.

The most important success criterion is this workflow:

```text
USER PROBLEM
    ↓
AUTOMATIC DIAGNOSTIC COLLECTION
    ↓
STRUCTURED LOGS
    ↓
CORRELATED INCIDENT
    ↓
TELEGRAM ALERT
    ↓
AI ANALYSIS
    ↓
DEVELOPER UNDERSTANDS ROOT CAUSE
    ↓
FIX
    ↓
INCIDENT RESOLVED
```

Build the system around making that loop fast, reliable, secure, and easy to understand.
