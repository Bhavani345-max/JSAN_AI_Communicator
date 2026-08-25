# Production architecture

```text
Developers / Browser / Codex / Claude Code
                    |
             Railway Edge + TLS
                    |
          ai.jsanconsulting.com
                    |
             JSAN Dev AI portal
             |              |
          UI/API          /v1 edge
             |              |
             +------ private network ------+
                                            |
                                         LiteLLM
                                            |
             +------------------------------+------------------+
             |          |          |        |       |          |
           Gemini      Kimi      Claude   OpenAI   Groq    Cerebras
                                                    |       OpenRouter
                                                    +------- NVIDIA

Portal ---------------- attached volume ---------------- SQLite
LiteLLM --------------- private network ---------------- Postgres
```

## Trust boundaries
- Public: portal only.
- Private: LiteLLM and PostgreSQL.
- Portal state: SQLite on a volume only that service can reach, never over the network.
- Developer credentials: LiteLLM virtual keys.
- Provider credentials: LiteLLM/Railway secrets only.
- Owner credential: LiteLLM master key; never issued to developers.
- Portal encrypts the retrievable developer virtual key at rest with `KEY_ENCRYPTION_SECRET`.
