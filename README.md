# FutureBoard Runtime

This version runs without installing packages:

```bash
npm start
```

Open:

```text
http://127.0.0.1:3000
```

## Environment

The app reads `.env` on the server. It never exposes key values in the UI.

Supported keys:

- `BAND_API_KEY`
- `BAND_BASE_URL`
- `BAND_PROJECT_ID`
- `BAND_ROOM_ID`
- `BAND_CREATE_ROOM_PATH`
- `BAND_EVENT_PATH`
- `BAND_STATE_PATH`
- `BAND_MEMORY_PATH`
- `groq_API_KEY` or `GROQ_API_KEY`
- `GROQ_BASE_URL`
- `GROQ_MODEL`
- `AIML_API_KEY`
- `AIML_BASE_URL`
- `AIML_MODEL`
- `FEATHERLESS_API_KEY`
- `FEATHERLESS_BASE_URL`
- `FEATHERLESS_MODEL`

## What Is Real Now

- `/api/run-decision` executes on the server.
- The server reads your `.env` keys.
- Agents collaborate through a `BandRoom` coordination layer.
- If `BAND_BASE_URL` and `BAND_API_KEY` are configured, every room creation, publish, handoff, disagreement, escalation, and memory event is POSTed to external Band endpoints.
- If Band endpoint calls fail or `BAND_BASE_URL` is missing, the app continues with the local Band adapter and shows that mode in the UI.
- Band manages shared room state, structured context, handoffs, disagreement, escalation, negotiation, transcript, and memory.
- Groq or AI/ML-compatible agents are called when keys are present.
- Featherless-compatible agents are called when keys and model are present.
- If a provider call fails, that agent falls back to local simulation so the demo still works.

## External Band Endpoint Mapping

Because official Band endpoint paths were not available in the project context, the runtime uses configurable paths:

```env
BAND_BASE_URL=https://your-band-host.example
BAND_CREATE_ROOM_PATH=/rooms
BAND_EVENT_PATH=/events
BAND_STATE_PATH=/state
BAND_MEMORY_PATH=/memory
```

Each request is sent as JSON with:

- `projectId`
- `roomId`
- `action`
- the action payload, such as `agent`, `payload`, `from`, `to`, `context`, `reason`, or `record`
